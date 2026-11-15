/// <reference types="chrome" />

// Google Drive client shared by the background worker and extension pages.
// Everything lives under one app-created save folder (`Pramana/` unless the user picks another).
// The drive.file scope only shows folders Pramana created, so the save folder is always one of
// those. It is remembered by ID: the user can rename it or move it anywhere in Drive.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DEFAULT_SAVE_FOLDER = 'Pramana';
export const SAVE_FOLDER_KEY = 'drive_save_folder';
const MAX_FOLDER_NAME = 100;
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,thumbnailLink,webViewLink,shared';

// Files above this size use a resumable upload instead of a single multipart request
export const MULTIPART_LIMIT = 5 * 1024 * 1024;
// Resumable chunks must be a multiple of 256 KiB
export const UPLOAD_CHUNK_SIZE = 32 * 256 * 1024;

export const SUBFOLDERS = {
  screenshot: 'Screenshots',
  recording: 'Recordings',
  other: 'Other',
} as const;

export type FileKind = keyof typeof SUBFOLDERS;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  thumbnailLink?: string;
  webViewLink?: string;
  shared?: boolean;
  folder: string;
}

export interface DriveFolder {
  id: string;
  name: string;
  webViewLink?: string;
}

/** Remembers which folder captures are saved to. */
export interface SaveFolderStore {
  get(): Promise<{ id: string; name: string } | null>;
  set(folder: { id: string; name: string }): Promise<void>;
}

const chromeSaveFolderStore: SaveFolderStore = {
  async get() {
    const data = await chrome.storage.local.get([SAVE_FOLDER_KEY]);
    return data?.[SAVE_FOLDER_KEY] || null;
  },
  async set(folder) {
    await chrome.storage.local.set({ [SAVE_FOLDER_KEY]: folder });
  },
};

export interface StorageQuota {
  usage: number;
  // null when the account has unlimited storage
  limit: number | null;
  available: number | null;
  status: 'normal' | 'warning' | 'full';
}

/** Returns a token; `refresh` asks for a new one because the previous one was rejected. */
export type TokenProvider = (refresh?: boolean) => Promise<string | null>;

export class DriveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

const LOW_SPACE_BYTES = 500 * 1024 * 1024;

// Waits between attempts when an upload chunk fails (connection dropped, Drive busy)
const UPLOAD_RETRY_DELAYS_MS = [1000, 3000, 8000, 15000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A value inside a Drive search query's quotes. */
const quoted = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function summarizeQuota(raw: { limit?: string; usage?: string }): StorageQuota {
  const usage = Number(raw.usage || 0);
  if (raw.limit === undefined) {
    return { usage, limit: null, available: null, status: 'normal' };
  }
  const limit = Number(raw.limit);
  const available = Math.max(0, limit - usage);
  const status = available > LOW_SPACE_BYTES ? 'normal' : available > 0 ? 'warning' : 'full';
  return { usage, limit, available, status };
}

export function createDriveClient(
  getToken: TokenProvider,
  { saveFolderStore = chromeSaveFolderStore, uploadRetryDelaysMs = UPLOAD_RETRY_DELAYS_MS }: { saveFolderStore?: SaveFolderStore; uploadRetryDelaysMs?: number[] } = {}
) {
  const folderCache = new Map<string, string>();
  // The save folder this client has already checked still exists
  let verifiedSaveFolder: string | undefined;

  async function request(url: string, init: RequestInit = {}, refresh = false): Promise<Response> {
    const token = await getToken(refresh);
    if (!token) throw new DriveError('Not signed in to Google', 401);
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    // An expired token gets one retry with a fresh token
    if (response.status === 401 && !refresh) return request(url, init, true);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new DriveError(data.error?.message || `Drive request failed (${response.status})`, response.status);
    }
    return response;
  }

  async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    return (await request(url, init)).json();
  }

  async function listAll<T>(q: string, fields: string): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await requestJson<{ files?: T[]; nextPageToken?: string }>(`${API}/files?${params}`);
      results.push(...(data.files || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return results;
  }

  async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const cacheKey = `${parentId || ''}/${name}`;
    const cached = folderCache.get(cacheKey);
    if (cached) return cached;

    let q = `name='${quoted(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const [existing] = await listAll<{ id: string }>(q, 'id');

    let id = existing?.id;
    if (!id) {
      const created = await requestJson<{ id?: string }>(`${API}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId && { parents: [parentId] }) }),
      });
      if (!created.id) throw new DriveError(`Could not create the ${name} folder`, 500);
      id = created.id;
    }
    folderCache.set(cacheKey, id);
    return id;
  }

  async function folderExists(id: string): Promise<boolean> {
    try {
      const folder = await requestJson<{ trashed?: boolean }>(`${API}/files/${id}?fields=id,trashed`);
      return !folder.trashed;
    } catch (error) {
      if (error instanceof DriveError && error.status === 404) return false;
      throw error;
    }
  }

  /** The folder captures are saved to: the user's choice, or `Pramana/` (also when the chosen one was deleted). */
  async function getRootFolder(): Promise<string> {
    const chosen = await saveFolderStore.get();
    if (chosen?.id) {
      if (chosen.id === verifiedSaveFolder) return chosen.id;
      if (await folderExists(chosen.id)) {
        verifiedSaveFolder = chosen.id;
        return chosen.id;
      }
    }
    const id = await findOrCreateFolder(DEFAULT_SAVE_FOLDER);
    await saveFolderStore.set({ id, name: DEFAULT_SAVE_FOLDER });
    verifiedSaveFolder = id;
    return id;
  }

  /** Folders Pramana created, without the Screenshots/Recordings/Other folders inside them. */
  async function listSaveFolders(): Promise<DriveFolder[]> {
    const all = await listAll<DriveFolder & { parents?: string[] }>(
      `mimeType='${FOLDER_MIME}' and trashed=false`,
      'id,name,parents,webViewLink'
    );
    const ids = new Set(all.map((f) => f.id));
    return all
      .filter((f) => !(f.parents || []).some((parent) => ids.has(parent)))
      .map(({ id, name, webViewLink }) => ({ id, name, webViewLink }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function uploadMultipart(blob: Blob, metadata: object): Promise<string> {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);
    const result = await requestJson<{ id: string }>(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
      method: 'POST',
      body: form,
    });
    return result.id;
  }

  async function uploadResumable(blob: Blob, metadata: object, onProgress?: (fraction: number) => void): Promise<string> {
    const session = await request(`${UPLOAD_API}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadata),
    });
    const location = session.headers.get('Location');
    if (!location) throw new DriveError('Drive did not start the upload', 500);

    // The session URL authorizes the upload itself, so chunks are sent without a token.
    // After a failed chunk, Drive says how much it has so the upload carries on from there.
    async function resumePoint(): Promise<number | string> {
      const response = await fetch(location!, { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` } });
      if (response.status === 308) {
        const range = response.headers.get('Range');
        return range ? Number(range.split('-')[1]) + 1 : 0;
      }
      if (response.ok) return (await response.json()).id as string;
      throw new DriveError(`Upload failed (${response.status})`, response.status);
    }

    let offset = 0;
    let failures = 0;
    for (;;) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, blob.size);
      let response: Response | null = null;
      try {
        response = await fetch(location, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` },
          body: blob.slice(offset, end),
        });
      } catch {
        // The connection dropped; retried below
      }
      if (response?.status === 308) {
        failures = 0;
        const range = response.headers.get('Range');
        offset = range ? Number(range.split('-')[1]) + 1 : end;
        onProgress?.(offset / blob.size);
        continue;
      }
      if (response?.ok) {
        onProgress?.(1);
        return (await response.json()).id;
      }

      const temporary = !response || response.status >= 500 || response.status === 429;
      if (!temporary || failures >= uploadRetryDelaysMs.length) {
        const data = response ? await response.json().catch(() => ({})) : {};
        const fallback = response ? `Upload failed (${response.status})` : 'The connection was lost during the upload';
        throw new DriveError(data.error?.message || fallback, response?.status ?? 0);
      }
      await sleep(uploadRetryDelaysMs[failures++]);
      try {
        const point = await resumePoint();
        if (typeof point === 'string') {
          onProgress?.(1);
          return point;
        }
        offset = point;
      } catch (error) {
        // Still offline: the next attempt sends the same chunk. Anything else ended the upload.
        if (error instanceof DriveError) throw error;
      }
    }
  }

  return {
    async upload(
      blob: Blob,
      { name, kind }: { name: string; kind: FileKind },
      onProgress?: (fraction: number) => void
    ): Promise<string> {
      const root = await getRootFolder();
      const folderId = await findOrCreateFolder(SUBFOLDERS[kind] || SUBFOLDERS.other, root);
      const metadata = { name, parents: [folderId] };
      return blob.size > MULTIPART_LIMIT
        ? uploadResumable(blob, metadata, onProgress)
        : uploadMultipart(blob, metadata);
    },

    async listFiles(): Promise<DriveFile[]> {
      const root = await getRootFolder();
      const subfolders = await listAll<{ id: string; name: string }>(
        `'${root}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
        'id,name'
      );
      const perFolder = await Promise.all(
        subfolders.map(async (folder) => {
          const files = await listAll<Omit<DriveFile, 'folder'>>(
            `'${folder.id}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`,
            FILE_FIELDS
          );
          return files.map((file) => ({ ...file, folder: folder.name }));
        })
      );
      return perFolder
        .flat()
        .sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
    },

    async fetchBlob(fileId: string): Promise<Blob> {
      return (await request(`${API}/files/${fileId}?alt=media`)).blob();
    },

    async rename(fileId: string, name: string): Promise<void> {
      await request(`${API}/files/${fileId}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    // Moves to Drive's trash rather than deleting, so the user can still restore it
    async trash(fileId: string): Promise<void> {
      await request(`${API}/files/${fileId}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
    },

    /** Makes the file viewable by anyone with the link and returns that link. */
    async share(fileId: string): Promise<string> {
      await request(`${API}/files/${fileId}/permissions?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      });
      const file = await requestJson<{ webViewLink: string }>(`${API}/files/${fileId}?fields=webViewLink`);
      return file.webViewLink;
    },

    async unshare(fileId: string): Promise<void> {
      await request(`${API}/files/${fileId}/permissions/anyoneWithLink`, { method: 'DELETE' });
    },

    /** The folder captures are saved to, with its current name (the user may have renamed it in Drive). */
    async getSaveFolder(): Promise<DriveFolder> {
      const id = await getRootFolder();
      return requestJson<DriveFolder>(`${API}/files/${id}?fields=id,name,webViewLink`);
    },

    listSaveFolders,

    /** Saves to `folder` from now on. */
    async useSaveFolder(folder: DriveFolder): Promise<void> {
      await saveFolderStore.set({ id: folder.id, name: folder.name });
      verifiedSaveFolder = undefined;
    },

    /** Creates a folder in My Drive (or reuses one with that name) and saves to it from now on. */
    async createSaveFolder(rawName: string): Promise<DriveFolder> {
      const name = rawName.trim().slice(0, MAX_FOLDER_NAME);
      if (!name) throw new DriveError('Give the folder a name', 400);
      const existing = (await listSaveFolders()).find((f) => f.name.toLowerCase() === name.toLowerCase());
      const folder =
        existing ||
        (await requestJson<DriveFolder>(`${API}/files?fields=id,name,webViewLink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
        }));
      if (!folder.id) throw new DriveError(`Could not create the ${name} folder`, 500);
      await saveFolderStore.set({ id: folder.id, name: folder.name });
      verifiedSaveFolder = undefined;
      return folder;
    },

    async getQuota(): Promise<StorageQuota> {
      const data = await requestJson<{ storageQuota: { limit?: string; usage?: string } }>(
        `${API}/about?fields=storageQuota`
      );
      return summarizeQuota(data.storageQuota);
    },
  };
}

export type DriveClient = ReturnType<typeof createDriveClient>;

/** Drive client for extension pages, which borrow the background worker's Google token. */
export function createPageDriveClient(): DriveClient {
  return createDriveClient(async (refresh) => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN', payload: { refresh } });
    return response?.token ?? null;
  });
}
