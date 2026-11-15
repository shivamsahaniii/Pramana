import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { DriveClient, DriveFolder } from '../shared/drive';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Picks the Drive folder that screenshots and recordings are saved to, or makes a new one. */
export function SaveFolderDialog({
  drive,
  current,
  onChanged,
  onClose,
}: {
  drive: DriveClient;
  current: DriveFolder | null;
  onChanged: (folder: DriveFolder) => void;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    drive
      .listSaveFolders()
      .then((list) => !cancelled && setFolders(list))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [drive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const change = async (action: () => Promise<DriveFolder>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const choose = (folder: DriveFolder) =>
    change(async () => {
      await drive.useSaveFolder(folder);
      return folder;
    });

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) change(() => drive.createSaveFolder(name));
  };

  return (
    <div className="preview-overlay confirm-overlay" onClick={onClose}>
      <div className="confirm-dialog folder-dialog" role="dialog" aria-labelledby="folder-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="folder-title">Save folder</h2>
        <p>New screenshots and recordings are saved to this folder in your Google Drive. The Library shows what is in it.</p>

        {folders === null && !error ? (
          <p className="help-note">Loading your folders…</p>
        ) : (
          <ul className="folder-list">
            {(folders || []).map((folder) => {
              const selected = folder.id === current?.id;
              return (
                <li key={folder.id}>
                  <button className={`folder-option${selected ? ' selected' : ''}`} onClick={() => choose(folder)} disabled={busy || selected} aria-pressed={selected}>
                    <span>📁 {folder.name}</span>
                    {selected && <span className="folder-current">Saving here</span>}
                  </button>
                  {folder.webViewLink && (
                    <a className="folder-link" href={folder.webViewLink} target="_blank" rel="noreferrer" title={`Open ${folder.name} in Google Drive`}>
                      Open in Drive
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form className="folder-new" onSubmit={create}>
          <input
            className="search-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New folder name, e.g. Client audit"
            aria-label="New folder name"
            maxLength={100}
            disabled={busy}
          />
          <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
            Create and use
          </button>
        </form>

        {error && <p className="error-message">{error}</p>}

        <p className="help-note">
          Google only lets Pramana use folders it created itself, so your other Drive folders are not listed. To keep a folder somewhere
          else, create it here, then move it in Google Drive: Pramana keeps saving to it wherever it is, even if you rename it.
        </p>

        <div className="confirm-actions">
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
