/// <reference types="chrome" />

import { useState, useEffect } from 'react';
import { formatDuration, recordedSeconds } from '../shared/utils';
import { StorageMeter } from '../shared/StorageMeter';
import { copyImageToClipboard } from '../shared/clipboard';
import { shortcutLabels } from '../shared/platform';
import { MAX_RECORDING_MINUTES, MAX_RECORDING_SECONDS } from '../shared/limits';
import { DEFAULT_SAVE_FOLDER, SAVE_FOLDER_KEY } from '../shared/drive';
import type { StorageQuota } from '../shared/drive';

type RecordingState = { startedAt: number; source: 'tab' | 'screen'; pausedAt?: number | null; pausedMs?: number };
type Notice = { kind: 'success' | 'error' | 'info'; text: string };

const MIC_PREF_KEY = 'record_mic';
const FORMAT_PREF_KEY = 'record_format';
const FLOAT_PREF_KEY = 'record_float';
// The floating timer is a Document Picture-in-Picture window (Chrome 116 and later)
const CAN_FLOAT = 'documentPictureInPicture' in window;
type RecordingFormat = 'mp4' | 'webm';
const SHORTCUTS = shortcutLabels();

function sendMessage<T = any>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

/**
 * The floating controls can only open in answer to a click. This passes the popup's click on to
 * the recorder window the background just opened, retrying while that window loads.
 */
async function passClickToRecorder() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const reply = await chrome.runtime.sendMessage({ target: 'recorder', type: 'RECORDER_FLOAT' }).catch(() => null);
    if (reply?.handled) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function App() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  // Until the background answers, show neither the sign-in button nor the tools (no flash of "Sign in")
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [useMic, setUseMic] = useState(false);
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [saveFolder, setSaveFolder] = useState(DEFAULT_SAVE_FOLDER);
  const [useFloat, setUseFloat] = useState(true);

  const showError = (text: string) => setNotice({ kind: 'error', text });

  useEffect(() => {
    checkAuthStatus();
    refreshRecordingState();
    chrome.storage.local.get([MIC_PREF_KEY, FORMAT_PREF_KEY, SAVE_FOLDER_KEY, FLOAT_PREF_KEY]).then((data) => {
      setUseMic(!!data?.[MIC_PREF_KEY]);
      if (data?.[FLOAT_PREF_KEY] === false) setUseFloat(false);
      if (data?.[FORMAT_PREF_KEY] === 'webm') setFormat('webm');
      if (data?.[SAVE_FOLDER_KEY]?.name) setSaveFolder(data[SAVE_FOLDER_KEY].name);
    });
    // Follow the recording live: started in the recorder window, paused by a shortcut, stopped…
    const onSessionChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('recording_state' in changes) setRecording(changes.recording_state.newValue || null);
    };
    chrome.storage.session?.onChanged?.addListener(onSessionChange);
    return () => chrome.storage.session?.onChanged?.removeListener(onSessionChange);
  }, []);

  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.min(MAX_RECORDING_SECONDS, recordedSeconds(recording)));
    tick();
    const interval = setInterval(() => {
      tick();
      // The recorder stops itself at the limit; pick up the new state
      if (recordedSeconds(recording) >= MAX_RECORDING_SECONDS) refreshRecordingState();
    }, 1000);
    return () => clearInterval(interval);
  }, [recording]);

  const refreshRecordingState = async () => {
    try {
      const state = await sendMessage({ type: 'GET_RECORDING_STATE' });
      setRecording(state?.recording || null);
      if (state?.error) showError(state.error);
    } catch {
      // Background not ready yet
    }
  };

  const checkAuthStatus = () => {
    // A background that doesn't answer still ends up at the sign-in button
    const fallback = setTimeout(() => setAuthChecked(true), 1500);
    chrome.runtime.sendMessage({ type: 'AUTH_STATUS' }, (response) => {
      clearTimeout(fallback);
      setAuthChecked(true);
      if (response?.signedIn) {
        setIsSignedIn(true);
        setUserEmail(response.email);
        setUserName(response.name);
        checkStorageQuota();
      }
    });
  };

  const checkStorageQuota = () => {
    chrome.runtime.sendMessage({ type: 'CHECK_STORAGE_QUOTA' }, (response) => {
      if (response?.success) setQuota(response);
    });
  };

  const handleSignIn = () => {
    setLoading(true);
    setNotice(null);
    chrome.runtime.sendMessage({ type: 'AUTH_REQUEST', payload: { type: 'LOGIN' } }, (response) => {
      setLoading(false);
      if (response?.success) {
        setIsSignedIn(true);
        setUserEmail(response.email);
        setUserName(response.name);
        checkStorageQuota();
      } else {
        showError(response?.error || 'Sign in failed');
      }
    });
  };

  const handleSignOut = () => {
    chrome.runtime.sendMessage({ type: 'AUTH_REQUEST', payload: { type: 'LOGOUT' } }, () => {
      setIsSignedIn(false);
      setUserEmail(null);
      setUserName(null);
      setQuota(null);
    });
  };

  const handleCaptureTab = async () => {
    setNotice(null);
    try {
      const tab = await getActiveTab();
      if (!tab?.id) return showError('No active tab found.');
      const response = await sendMessage({ type: 'CAPTURE_SCREENSHOT', payload: { mode: 'tab', tabId: tab.id } });
      if (response?.success && response.dataUrl) {
        setPreview(response.dataUrl.split(',')[1]);
      } else {
        showError(response?.error || 'Capture failed');
      }
    } catch (err) {
      showError('Capture failed: ' + String(err));
    }
  };

  // Select Area and Full Page run in the page itself, so the popup hands over and closes
  const captureInPage = async (type: 'CAPTURE_AREA_SELECT' | 'CAPTURE_FULL_PAGE') => {
    setNotice(null);
    const tab = await getActiveTab();
    if (!tab?.id) return showError('No active tab found.');
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      return showError('Cannot capture on browser pages. Open a regular website first.');
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type });
      window.close();
    } catch (err) {
      console.error('Capture in page failed:', err);
      showError(type === 'CAPTURE_FULL_PAGE' ? 'Cannot capture this page. Try another website.' : 'Cannot select an area on this page. Try another website.');
    }
  };
  const handleSelectArea = () => captureInPage('CAPTURE_AREA_SELECT');
  const handleFullPage = () => captureInPage('CAPTURE_FULL_PAGE');

  // Uploads go through the background so they finish even if the popup closes
  const saveScreenshot = async (base64: string) => {
    setSaving(true);
    try {
      const response = await sendMessage({
        type: 'UPLOAD_FILE',
        payload: { fileBase64: base64, metadata: { name: `screenshot-${Date.now()}.png`, type: 'screenshot' } },
      });
      if (!response?.success) throw new Error(response?.error || 'Unknown error');
      setPreview(null);
      setNotice({ kind: 'success', text: 'Screenshot saved to Google Drive.' });
      checkStorageQuota();
    } catch (err) {
      showError('Upload failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const copyScreenshot = async (base64: string) => {
    try {
      await copyImageToClipboard(fetch(`data:image/png;base64,${base64}`).then((r) => r.blob()));
      setNotice({ kind: 'success', text: 'Screenshot copied. Paste it anywhere with Ctrl+V.' });
    } catch (err) {
      showError('Copy failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const openEditor = (base64: string) => {
    const storageKey = `pending_edit_${Date.now()}`;
    chrome.storage.local.set({ [storageKey]: base64 }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/index.html?storageKey=${storageKey}`) });
    });
    setPreview(null);
  };

  const toggleMic = async (enabled: boolean) => {
    setUseMic(enabled);
    chrome.storage.local.set({ [MIC_PREF_KEY]: enabled });
    if (!enabled) return;
    // The recorder runs without UI and can't ask for the mic, so ask once from a visible page
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).catch(() => null);
    if (status?.state !== 'granted') {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/index.html?grant=microphone') });
    }
  };

  const startRecording = async (source: 'tab' | 'screen') => {
    setNotice(null);
    try {
      const tab = await getActiveTab();
      const float = CAN_FLOAT && useFloat;
      const response = await sendMessage({
        type: 'START_RECORDING',
        payload: { source, mic: useMic, tabId: tab?.id, format, ...(float && { float: true }) },
      });
      if (!response?.success) return showError(response?.error || 'Recording failed to start');
      if (float) await passClickToRecorder();
      // Get out of the way so the popup isn't in the recording; the toolbar icon has the controls
      if (response.pending) return window.close();
      setRecording(response.recording);
      if (response.warning) setNotice({ kind: 'info', text: response.warning });
      else window.close();
    } catch (err) {
      showError('Recording failed: ' + String(err));
    }
  };

  const togglePause = async () => {
    const response = await sendMessage({ type: recording?.pausedAt ? 'RESUME_RECORDING' : 'PAUSE_RECORDING' }).catch(() => null);
    if (response?.recording) setRecording(response.recording);
    else if (response?.error) showError(response.error);
  };

  const stopRecording = async () => {
    await sendMessage({ type: 'STOP_RECORDING' }).catch(() => null);
    setRecording(null);
    setNotice({ kind: 'info', text: 'Recording stopped. It will open in your Library to review and save.' });
  };

  const openDashboard = (query = '') => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html${query}`) });
  };

  const noticeEl = notice && (
    <div className={notice.kind === 'error' ? 'error-message' : `notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </div>
  );

  if (!isSignedIn && !authChecked) {
    return (
      <div className="popup-container" aria-busy="true">
        <div className="logo">
          <h1>Pramana</h1>
          <p>Capture. Edit. Share.</p>
        </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="popup-container">
        <div className="logo">
          <h1>Pramana</h1>
          <p>Capture. Edit. Share.</p>
        </div>
        {noticeEl}
        <button className="btn-primary" onClick={handleSignIn} disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in with Google'}
        </button>
      </div>
    );
  }

  if (preview) {
    return (
      <div className="popup-container">
        <div className="preview-header">
          <button className="btn-back" onClick={() => setPreview(null)}>
            &larr; Back
          </button>
          <span className="preview-title">Preview</span>
        </div>
        {noticeEl}
        <div className="preview-image">
          <img src={`data:image/png;base64,${preview}`} alt="Screenshot" />
        </div>
        <div className="preview-actions popup-preview-actions">
          <button className="btn-primary" onClick={() => saveScreenshot(preview)} disabled={saving}>
            {saving ? 'Saving…' : 'Save to Drive'}
          </button>
          <button className="btn-secondary" onClick={() => copyScreenshot(preview)} disabled={saving}>
            Copy
          </button>
          <button className="btn-secondary" onClick={() => openEditor(preview)} disabled={saving}>
            Edit
          </button>
        </div>
      </div>
    );
  }

  const initial = (userName || userEmail || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="popup-container popup-main">
      <header className="popup-header">
        <div className="popup-avatar" aria-hidden="true">
          {initial}
        </div>
        <div className="popup-account">
          <span className="user-name">{userName || 'Pramana'}</span>
          {userEmail && <span className="user-email">{userEmail}</span>}
        </div>
        <button className="btn-icon" onClick={handleSignOut} title="Sign out" aria-label="Sign out">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
        </button>
      </header>

      {/* Space is reserved while loading so the buttons below don't jump */}
      <div className="storage-info">
        {quota ? (
          <StorageMeter quota={quota} />
        ) : (
          <>
            <span className="storage-text">Drive: checking storage…</span>
            <div className="storage-bar" />
          </>
        )}
      </div>

      {noticeEl}

      <section className="popup-section">
        <h2>Capture</h2>
        <div className="tile-grid">
          <button className="tile" onClick={handleCaptureTab} title="Capture everything visible in this tab">
            <span className="tile-icon">🖥️</span>
            <span className="tile-text">
              <span className="tile-title">Visible Tab</span>
              <span className="tile-hint">What you see now</span>
            </span>
          </button>
          <button className="tile" onClick={handleSelectArea} title="Drag to choose part of the page">
            <span className="tile-icon">✂️</span>
            <span className="tile-text">
              <span className="tile-title">Select Area</span>
              <span className="tile-hint">Drag to crop</span>
            </span>
          </button>
          <button className="tile tile-wide" onClick={handleFullPage} title="Scrolls through the page and captures all of it, top to bottom">
            <span className="tile-icon">📜</span>
            <span className="tile-text">
              <span className="tile-title">Full Page</span>
              <span className="tile-hint">Scrolls and captures the whole page</span>
            </span>
          </button>
        </div>
      </section>

      <section className="popup-section">
        <h2>Record</h2>
        {recording ? (
          <>
            <p className={`record-status${recording.pausedAt ? ' paused' : ''}`} role="timer">
              {recording.pausedAt ? '❚❚ Paused' : '● Recording'} {formatDuration(elapsed)} / {formatDuration(MAX_RECORDING_SECONDS)}
            </p>
            <div className="tile-grid">
              <button className="tile" onClick={togglePause} title={SHORTCUTS.pause}>
                <span className="tile-icon">{recording.pausedAt ? '▶️' : '⏸️'}</span>
                <span className="tile-text">
                  <span className="tile-title">{recording.pausedAt ? 'Resume' : 'Pause'}</span>
                  <span className="tile-hint">{SHORTCUTS.pause}</span>
                </span>
              </button>
              <button className="tile tile-stop" onClick={stopRecording} title={SHORTCUTS.stop}>
                <span className="tile-icon">⏹️</span>
                <span className="tile-text">
                  <span className="tile-title">Stop</span>
                  <span className="tile-hint">{SHORTCUTS.stop}</span>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tile-grid">
              <button className="tile" onClick={() => startRecording('tab')} title={`Keeps recording if you close this popup. Up to ${MAX_RECORDING_MINUTES} minutes.`}>
                <span className="tile-icon">🎬</span>
                <span className="tile-text">
                  <span className="tile-title">Record Tab</span>
                  <span className="tile-hint">Only this tab</span>
                </span>
              </button>
              <button className="tile" onClick={() => startRecording('screen')} title={`Keeps recording if you close this popup. Up to ${MAX_RECORDING_MINUTES} minutes.`}>
                <span className="tile-icon">🖥️</span>
                <span className="tile-text">
                  <span className="tile-title">Record Screen</span>
                  <span className="tile-hint">Screen or window</span>
                </span>
              </button>
            </div>
            <div className="record-options">
              <label className="mic-toggle">
                <input type="checkbox" role="switch" checked={useMic} onChange={(e) => toggleMic(e.target.checked)} />
                Include microphone
              </label>
              <label className="format-select">
                Format
                <select
                  title="MP4 plays everywhere; WebM is smaller"
                  value={format}
                  onChange={(e) => {
                    const next = e.target.value as RecordingFormat;
                    setFormat(next);
                    chrome.storage.local.set({ [FORMAT_PREF_KEY]: next });
                  }}
                >
                  <option value="mp4">MP4</option>
                  <option value="webm">WebM</option>
                </select>
              </label>
            </div>
            {CAN_FLOAT && (
              <label className="mic-toggle" title="A small always-on-top window with the timer, Pause and Stop. It is not in tab or window recordings. A recording of the entire screen shows it, like everything else on screen.">
                <input
                  type="checkbox"
                  role="switch"
                  checked={useFloat}
                  onChange={(e) => {
                    setUseFloat(e.target.checked);
                    chrome.storage.local.set({ [FLOAT_PREF_KEY]: e.target.checked });
                  }}
                />
                Floating timer and controls
              </label>
            )}
          </>
        )}
      </section>

      <div className="popup-footer">
        <button className="btn-library" onClick={() => openDashboard()}>
          <span>📚 Open Library</span>
          <span aria-hidden="true">→</span>
        </button>
        <button className="save-folder" onClick={() => openDashboard('?folder')} title="Choose the Google Drive folder to save to">
          <span className="save-folder-name">📁 Saves to {saveFolder}</span>
          <span className="save-folder-change">Change</span>
        </button>
      </div>
    </div>
  );
}

export default App;
