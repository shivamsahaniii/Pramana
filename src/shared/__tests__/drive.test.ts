import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { createDriveClient, summarizeQuota, MULTIPART_LIMIT, UPLOAD_CHUNK_SIZE } from '../drive';
import type { SaveFolderStore, TokenProvider } from '../drive';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function folderLookups(fetchMock: ReturnType<typeof vi.fn>) {
  // Pramana root, then the subfolder
  fetchMock.mockResolvedValueOnce(json({ files: [{ id: 'root' }] }));
  fetchMock.mockResolvedValueOnce(json({ files: [{ id: 'shots' }] }));
}

describe('summarizeQuota', () => {
  it('classifies plenty of space as normal', () => {
    expect(summarizeQuota({ limit: '16106127360', usage: '5000000000' })).toEqual({
      usage: 5000000000,
      limit: 16106127360,
      available: 11106127360,
      status: 'normal',
    });
  });

  it('warns when under 500 MB is left', () => {
    expect(summarizeQuota({ limit: '1000000000', usage: '700000000' }).status).toBe('warning');
  });

  it('reports full when nothing is left', () => {
    expect(summarizeQuota({ limit: '100', usage: '120' })).toMatchObject({ status: 'full', available: 0 });
  });

  it('handles unlimited accounts that have no limit', () => {
    expect(summarizeQuota({ usage: '42' })).toEqual({ usage: 42, limit: null, available: null, status: 'normal' });
  });
});

describe('createDriveClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getToken: Mock<TokenProvider>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getToken = vi.fn<TokenProvider>(async (refresh) => (refresh ? 'fresh-token' : 'old-token'));
  });

  it('retries once with a fresh token after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: 'Invalid Credentials' } }, 401))
      .mockResolvedValueOnce(json({ storageQuota: { limit: '100', usage: '10' } }));

    const quota = await createDriveClient(getToken).getQuota();

    expect(quota.usage).toBe(10);
    expect(getToken).toHaveBeenLastCalledWith(true);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('surfaces the Drive error message when a request fails', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'Rate limit exceeded' } }, 403));
    await expect(createDriveClient(getToken).getQuota()).rejects.toThrow('Rate limit exceeded');
  });

  it('fails clearly when signed out', async () => {
    await expect(createDriveClient(async () => null).getQuota()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists files from every subfolder across pages, newest first', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ files: [{ id: 'root' }] }))
      .mockResolvedValueOnce(json({ files: [{ id: 'shots', name: 'Screenshots' }, { id: 'recs', name: 'Recordings' }] }))
      .mockImplementation(async (url: string) => {
        const params = new URL(url).searchParams;
        if (params.get('q')!.includes("'shots'")) {
          return params.get('pageToken')
            ? json({ files: [{ id: 'b', name: 'b.png', createdTime: '2026-01-02T00:00:00Z' }] })
            : json({ files: [{ id: 'a', name: 'a.png', createdTime: '2026-01-01T00:00:00Z' }], nextPageToken: 'p2' });
        }
        return json({ files: [{ id: 'c', name: 'c.webm', createdTime: '2026-01-03T00:00:00Z' }] });
      });

    const files = await createDriveClient(getToken).listFiles();

    expect(files.map((f) => [f.id, f.folder])).toEqual([
      ['c', 'Recordings'],
      ['b', 'Screenshots'],
      ['a', 'Screenshots'],
    ]);
  });

  it('creates the Pramana folder when it is missing and fails if Drive returns no id', async () => {
    fetchMock.mockResolvedValueOnce(json({ files: [] })).mockResolvedValueOnce(json({}));
    await expect(createDriveClient(getToken).listFiles()).rejects.toThrow('Could not create the Pramana folder');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ name: 'Pramana' });
  });

  it('uploads small files in a single multipart request', async () => {
    folderLookups(fetchMock);
    fetchMock.mockResolvedValueOnce(json({ id: 'new-file' }));

    const id = await createDriveClient(getToken).upload(new Blob(['png'], { type: 'image/png' }), { name: 'a.png', kind: 'screenshot' });

    expect(id).toBe('new-file');
    expect(fetchMock.mock.calls[2][0]).toContain('uploadType=multipart');
  });

  it('uploads large files in resumable chunks and reports progress', async () => {
    folderLookups(fetchMock);
    const size = MULTIPART_LIMIT + UPLOAD_CHUNK_SIZE;
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: 'https://upload.example/session' } }))
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const [, end] = (init.headers as Record<string, string>)['Content-Range'].match(/bytes \d+-(\d+)/)!;
        return Number(end) + 1 < size
          ? new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } })
          : json({ id: 'big-file' });
      });
    const progress = vi.fn();

    const id = await createDriveClient(getToken).upload(
      new Blob([new Uint8Array(size)], { type: 'video/webm' }),
      { name: 'r.webm', kind: 'recording' },
      progress
    );

    expect(id).toBe('big-file');
    expect(fetchMock.mock.calls[2][0]).toContain('uploadType=resumable');
    const chunkCalls = fetchMock.mock.calls.slice(3);
    expect(chunkCalls.length).toBe(Math.ceil(size / UPLOAD_CHUNK_SIZE));
    expect(chunkCalls.every(([url]) => url === 'https://upload.example/session')).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('moves files to the trash instead of deleting them', async () => {
    fetchMock.mockResolvedValue(json({ id: 'f1' }));
    await createDriveClient(getToken).trash('f1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/files/f1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ trashed: true });
  });

  it('shares with anyone who has the link and returns the link', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'perm' })).mockResolvedValueOnce(json({ webViewLink: 'https://drive.google.com/file/d/f1/view' }));

    const link = await createDriveClient(getToken).share('f1');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ role: 'reader', type: 'anyone' });
    expect(link).toBe('https://drive.google.com/file/d/f1/view');
  });

  it('stops sharing by removing the anyone-with-link permission', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await createDriveClient(getToken).unshare('f1');
    expect(fetchMock.mock.calls[0][0]).toContain('/files/f1/permissions/anyoneWithLink');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  describe('save folder', () => {
    function memoryStore(initial: { id: string; name: string } | null = null) {
      let value = initial;
      const store: SaveFolderStore = {
        get: vi.fn(async () => value),
        set: vi.fn(async (folder) => {
          value = folder;
        }),
      };
      return store;
    }

    it('saves into the folder the user chose, found by its ID', async () => {
      const saveFolderStore = memoryStore({ id: 'audit', name: 'Client audit' });
      fetchMock
        .mockResolvedValueOnce(json({ id: 'audit', trashed: false })) // the chosen folder still exists
        .mockResolvedValueOnce(json({ files: [{ id: 'audit-shots' }] })) // its Screenshots folder
        .mockResolvedValueOnce(json({ id: 'new-file' }));

      await createDriveClient(getToken, { saveFolderStore }).upload(new Blob(['png']), { name: 'a.png', kind: 'screenshot' });

      expect(fetchMock.mock.calls[0][0]).toContain('/files/audit?');
      expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('q')).toContain("'audit' in parents");
    });

    it('checks the chosen folder once, not on every upload', async () => {
      const saveFolderStore = memoryStore({ id: 'audit', name: 'Client audit' });
      fetchMock
        .mockResolvedValueOnce(json({ id: 'audit' }))
        .mockResolvedValueOnce(json({ files: [{ id: 'audit-shots' }] }))
        .mockImplementation(async () => json({ id: 'new-file' }));
      const client = createDriveClient(getToken, { saveFolderStore });

      await client.upload(new Blob(['a']), { name: 'a.png', kind: 'screenshot' });
      await client.upload(new Blob(['b']), { name: 'b.png', kind: 'screenshot' });

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('goes back to the Pramana folder when the chosen one was deleted', async () => {
      const saveFolderStore = memoryStore({ id: 'gone', name: 'Old case' });
      fetchMock
        .mockResolvedValueOnce(json({ error: { message: 'File not found' } }, 404))
        .mockResolvedValueOnce(json({ files: [{ id: 'root' }] }))
        .mockResolvedValueOnce(json({ id: 'root', name: 'Pramana' }));

      const folder = await createDriveClient(getToken, { saveFolderStore }).getSaveFolder();

      expect(folder.name).toBe('Pramana');
      expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('q')).toContain("name='Pramana'");
      expect(saveFolderStore.set).toHaveBeenCalledWith({ id: 'root', name: 'Pramana' });
    });

    it('treats a folder in the trash as deleted', async () => {
      const saveFolderStore = memoryStore({ id: 'binned', name: 'Old case' });
      fetchMock
        .mockResolvedValueOnce(json({ id: 'binned', trashed: true }))
        .mockResolvedValueOnce(json({ files: [{ id: 'root' }] }))
        .mockResolvedValueOnce(json({ id: 'root', name: 'Pramana' }));
      expect((await createDriveClient(getToken, { saveFolderStore }).getSaveFolder()).id).toBe('root');
    });

    it('lists the folders Pramana created, without the folders inside them', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          files: [
            { id: 'root', name: 'Pramana', parents: ['my-drive'] },
            { id: 'shots', name: 'Screenshots', parents: ['root'] },
            { id: 'recs', name: 'Recordings', parents: ['root'] },
            // Moved by the user into one of their own folders, which Pramana can't see
            { id: 'audit', name: 'Client audit', parents: ['someone-elses-folder'], webViewLink: 'https://drive/audit' },
          ],
        })
      );

      const folders = await createDriveClient(getToken, { saveFolderStore: memoryStore() }).listSaveFolders();

      expect(folders).toEqual([
        { id: 'audit', name: 'Client audit', webViewLink: 'https://drive/audit' },
        { id: 'root', name: 'Pramana', webViewLink: undefined },
      ]);
    });

    it('creates a folder in My Drive and remembers it', async () => {
      const saveFolderStore = memoryStore();
      fetchMock.mockResolvedValueOnce(json({ files: [] })).mockResolvedValueOnce(json({ id: 'new', name: "Tom's case" }));

      const folder = await createDriveClient(getToken, { saveFolderStore }).createSaveFolder("  Tom's case ");

      expect(folder).toEqual({ id: 'new', name: "Tom's case" });
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body).toEqual({ name: "Tom's case", mimeType: 'application/vnd.google-apps.folder' });
      expect(saveFolderStore.set).toHaveBeenCalledWith({ id: 'new', name: "Tom's case" });
    });

    it('reuses a folder with the same name instead of making a second one', async () => {
      const saveFolderStore = memoryStore();
      fetchMock.mockResolvedValueOnce(json({ files: [{ id: 'audit', name: 'Client Audit', parents: ['x'] }] }));

      const folder = await createDriveClient(getToken, { saveFolderStore }).createSaveFolder('client audit');

      expect(folder.id).toBe('audit');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses an empty folder name', async () => {
      await expect(createDriveClient(getToken, { saveFolderStore: memoryStore() }).createSaveFolder('   ')).rejects.toThrow('Give the folder a name');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("escapes quotes in a folder name when searching Drive", async () => {
      const saveFolderStore = memoryStore({ id: 'audit', name: "Tom's case" });
      fetchMock.mockResolvedValueOnce(json({ id: 'audit' })).mockImplementation(async () => json({ files: [] }));
      await createDriveClient(getToken, { saveFolderStore }).listFiles();
      expect(fetchMock.mock.calls.every(([url]) => !/name='[^']*'[^ )]/.test(decodeURIComponent(String(url))))).toBe(true);
    });
  });

  describe('large uploads', () => {
    const size = MULTIPART_LIMIT + UPLOAD_CHUNK_SIZE;
    const big = () => new Blob([new Uint8Array(size)], { type: 'video/mp4' });
    const startSession = () => new Response(null, { status: 200, headers: { Location: 'https://upload.example/session' } });
    const range = (init: RequestInit) => (init.headers as Record<string, string>)['Content-Range'];

    it('carries on from where Drive got to after the connection drops', async () => {
      folderLookups(fetchMock);
      const sent: string[] = [];
      let dropped = false;
      fetchMock.mockResolvedValueOnce(startSession()).mockImplementation(async (_url: string, init: RequestInit) => {
        sent.push(range(init));
        // Drive is asked how much it has: the first chunk only
        if (range(init).startsWith('bytes */')) return new Response(null, { status: 308, headers: { Range: `bytes=0-${UPLOAD_CHUNK_SIZE - 1}` } });
        const [, start, end] = range(init).match(/bytes (\d+)-(\d+)/)!;
        if (Number(start) === UPLOAD_CHUNK_SIZE && !dropped) {
          dropped = true;
          throw new TypeError('Failed to fetch');
        }
        return Number(end) + 1 < size ? new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } }) : json({ id: 'big-file' });
      });
      const progress = vi.fn();

      const id = await createDriveClient(getToken, { uploadRetryDelaysMs: [0, 0] }).upload(big(), { name: 'r.mp4', kind: 'recording' }, progress);

      expect(id).toBe('big-file');
      // First chunk, second chunk fails, status check, second chunk again, then the rest
      expect(sent.slice(0, 4)).toEqual([
        `bytes 0-${UPLOAD_CHUNK_SIZE - 1}/${size}`,
        `bytes ${UPLOAD_CHUNK_SIZE}-${size - 1}/${size}`,
        `bytes */${size}`,
        `bytes ${UPLOAD_CHUNK_SIZE}-${size - 1}/${size}`,
      ]);
      expect(progress).toHaveBeenLastCalledWith(1);
    });

    it('retries when Drive is temporarily unavailable', async () => {
      folderLookups(fetchMock);
      let failed = false;
      fetchMock.mockResolvedValueOnce(startSession()).mockImplementation(async (_url: string, init: RequestInit) => {
        if (range(init).startsWith('bytes */')) return new Response(null, { status: 308 });
        if (!failed) {
          failed = true;
          return json({ error: { message: 'Backend Error' } }, 503);
        }
        const [, end] = range(init).match(/bytes \d+-(\d+)/)!;
        return Number(end) + 1 < size ? new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } }) : json({ id: 'big-file' });
      });

      expect(await createDriveClient(getToken, { uploadRetryDelaysMs: [0] }).upload(big(), { name: 'r.mp4', kind: 'recording' })).toBe('big-file');
    });

    it('finishes when the dropped request had in fact completed the upload', async () => {
      folderLookups(fetchMock);
      fetchMock.mockResolvedValueOnce(startSession()).mockImplementation(async (_url: string, init: RequestInit) => {
        if (range(init).startsWith('bytes */')) return json({ id: 'big-file' });
        throw new TypeError('Failed to fetch');
      });
      expect(await createDriveClient(getToken, { uploadRetryDelaysMs: [0] }).upload(big(), { name: 'r.mp4', kind: 'recording' })).toBe('big-file');
    });

    it('gives up with a clear message when the connection stays down', async () => {
      folderLookups(fetchMock);
      fetchMock.mockResolvedValueOnce(startSession()).mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(createDriveClient(getToken, { uploadRetryDelaysMs: [0, 0] }).upload(big(), { name: 'r.mp4', kind: 'recording' })).rejects.toThrow(
        'The connection was lost during the upload'
      );
      // 3 attempts at the chunk, with a status check after each of the first two
      expect(fetchMock.mock.calls.slice(3).length).toBe(5);
    });

    it('does not retry an error that will not go away', async () => {
      folderLookups(fetchMock);
      fetchMock.mockResolvedValueOnce(startSession()).mockImplementation(async () => json({ error: { message: 'The user has exceeded their Drive storage quota' } }, 403));
      await expect(createDriveClient(getToken, { uploadRetryDelaysMs: [0, 0] }).upload(big(), { name: 'r.mp4', kind: 'recording' })).rejects.toThrow(
        'exceeded their Drive storage quota'
      );
      expect(fetchMock.mock.calls.slice(3).length).toBe(1);
    });
  });
});
