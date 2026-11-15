/// <reference types="chrome" />

import { useCallback, useEffect, useRef, useState } from 'react';
import { recordStream } from '../shared/captureRecorder';
import type { ActiveRecording, RecordingFormat } from '../shared/captureRecorder';
import { formatDuration, recordedSeconds } from '../shared/utils';
import { detectOS, shortcutLabels } from '../shared/platform';
import { MAX_RECORDING_MS } from '../shared/limits';
import { floatingSupported, openFloatingControls } from './floating';
import type { FloatingControls } from './floating';

// Screen recording needs a visible page: Chrome's share picker can't open from the background
// worker, and the stream it returns only works in the page that asked for it.
//
// For a tab recording (?mode=tab) the recording itself runs in the offscreen document; this
// window is only opened to own the floating controls, and sits minimized.

// How long to wait for the popup to pass its click on (RECORDER_FLOAT) before carrying on without
const FLOAT_WAIT_MS = 1000;

async function updateOwnWindow(update: chrome.windows.UpdateInfo) {
  try {
    const current = await chrome.windows.getCurrent();
    if (current?.id !== undefined) await chrome.windows.update(current.id, update);
  } catch {
    // Not essential
  }
}


// On Linux, the desktop (e.g. Ubuntu on Wayland) shows its own Share Screen dialog after Chrome's
const os = detectOS();
const isLinux = os === 'linux';
const keys = shortcutLabels(os);

const openHelp = (section: string) => chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html?help=${section}`) });

function ShareSteps() {
  return (
    <ol className="share-steps">
      <li>
        In Chrome's window, <strong>Entire screen</strong> is selected: click <strong>Share</strong>.
      </li>
      {isLinux && (
        <li>
          If your system asks too (Ubuntu's <strong>Share Screen</strong> window), pick your display and click <strong>Share</strong>.{' '}
          <a href="#" className="recorder-help-link" onClick={(e) => {
              e.preventDefault();
              openHelp('ubuntu');
            }}>
            Stop seeing these windows
          </a>
        </li>
      )}
    </ol>
  );
}

function cancelMessage(error: DOMException) {
  // Chrome reports a denial by the operating system as "Permission denied by system"
  if (/system/i.test(error.message)) {
    return os === 'mac'
      ? 'macOS did not allow screen recording. In System Settings → Privacy & Security → Screen Recording, turn on Google Chrome, then restart Chrome.'
      : 'Your system did not allow screen sharing. Click Share in its window when it asks.';
  }
  return isLinux ? 'Nothing was shared. Click Share in both windows to start recording.' : 'Nothing was shared. Click Share in Chrome\'s window to start recording.';
}

type Phase =
  | { name: 'picking' }
  | { name: 'choose'; error?: string }
  | { name: 'recording'; warning?: string }
  | { name: 'saving' };

function App() {
  const params = new URLSearchParams(window.location.search);
  const mic = params.get('mic') === '1';
  const maxDurationMs = Number(params.get('max')) || MAX_RECORDING_MS;
  const format: RecordingFormat = params.get('format') === 'webm' ? 'webm' : 'mp4';
  const tabMode = params.get('mode') === 'tab';
  const wantsFloat = params.get('float') === '1';

  const [phase, setPhase] = useState<Phase>(tabMode ? { name: 'recording' } : { name: 'picking' });
  const [elapsed, setElapsed] = useState(0);
  const [timing, setTiming] = useState<{ startedAt: number; pausedAt?: number | null; pausedMs?: number } | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const autoStarted = useRef(false);
  const paused = !!timing?.pausedAt;
  const floatingRef = useRef<FloatingControls | null>(null);
  const [floatingOpen, setFloatingOpen] = useState(false);
  // What is being recorded: the floating bar is part of a video of the entire screen
  const [entireScreen, setEntireScreen] = useState(false);

  // Needs a click to answer: the popup's (passed on by RECORDER_FLOAT) or one on this page's button
  const openFloating = useCallback(async () => {
    if (floatingRef.current?.isOpen()) return true;
    const controls = await openFloatingControls({
      onTogglePause: () => chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE_RECORDING' }).catch(() => {}),
      onStop: () => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {}),
      onClosed: () => {
        floatingRef.current = null;
        setFloatingOpen(false);
      },
    });
    floatingRef.current = controls;
    setFloatingOpen(!!controls);
    return !!controls;
  }, []);

  // Timing comes from the background's state, which also changes on shortcuts and the popup
  useEffect(() => {
    const onSessionChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.recording_state?.newValue) setTiming(changes.recording_state.newValue);
    };
    chrome.storage.session?.onChanged?.addListener(onSessionChange);
    // A tab recording is already running when this window opens
    if (tabMode) {
      chrome.storage.session
        ?.get(['recording_state'])
        .then((data) => data?.recording_state && setTiming(data.recording_state))
        .catch(() => {});
    }
    return () => chrome.storage.session?.onChanged?.removeListener(onSessionChange);
  }, [tabMode]);

  useEffect(() => {
    const maxSeconds = Math.round(maxDurationMs / 1000);
    floatingRef.current?.update(
      phase.name === 'recording' && timing
        ? { seconds: elapsed, maxSeconds, paused }
        : { note: phase.name === 'saving' ? 'Saving your recording…' : 'Choose what to share…', seconds: 0, maxSeconds, paused: false }
    );
  }, [phase, timing, elapsed, paused, maxDurationMs, floatingOpen]);

  useEffect(() => () => floatingRef.current?.close(), []);

  // Closing this window would lose a screen recording, so ask first
  useEffect(() => {
    if (phase.name !== 'recording' || !timing) return;
    const warn = (e: BeforeUnloadEvent) => !tabMode && e.preventDefault();
    window.addEventListener('beforeunload', warn);
    const update = () => setElapsed(recordedSeconds(timing));
    update();
    const tick = setInterval(update, 500);
    return () => {
      window.removeEventListener('beforeunload', warn);
      clearInterval(tick);
    };
  }, [phase, timing, tabMode]);

  const choose = useCallback(async () => {
    setPhase({ name: 'picking' });
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        // Opens the picker on "Entire screen"; the user can still switch to a window or tab
        video: { frameRate: 30, displaySurface: 'monitor' },
        monitorTypeSurfaces: 'include',
        audio: true,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      // InvalidStateError: Chrome wants a click before showing the picker
      const message =
        name === 'InvalidStateError' ? undefined : name === 'NotAllowedError' ? cancelMessage(error as DOMException) : `Could not start: ${error}`;
      setPhase({ name: 'choose', error: message });
      return;
    }

    // Claim the recording slot before recording, so a refused start leaves nothing behind
    const response = await chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' }).catch((error) => ({ success: false, error }));
    if (!response?.success) {
      display.getTracks().forEach((t) => t.stop());
      setPhase({ name: 'choose', error: `Recording failed: ${response?.error || 'Pramana could not start the recording'}` });
      return;
    }

    // Entire screen: the floating bar stays, but it is on the screen, so it is in the video too
    const surface = display.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
    setEntireScreen(surface === 'monitor');

    try {
      const recording = await recordStream(display, { playCapturedAudio: false, mic, maxDurationMs, format });
      recordingRef.current = recording;
      recording.onFinishing = () => setPhase({ name: 'saving' });
      setTiming(response.recording);
      setPhase({ name: 'recording', warning: recording.warning });
    } catch (error) {
      display.getTracks().forEach((t) => t.stop());
      const message = `Recording failed: ${error instanceof Error ? error.message : error}`;
      chrome.runtime.sendMessage({ type: 'RECORDING_FAILED', payload: { error: message } });
      setPhase({ name: 'choose', error: message });
    }
  }, [mic, maxDurationMs, format]);

  // Through the background, so the badge and popup show the pause too
  const togglePause = () => chrome.runtime.sendMessage({ type: paused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING' }).catch(() => {});

  const stop = () => {
    setPhase({ name: 'saving' });
    recordingRef.current?.stop();
  };

  // Starts by itself: Chrome's picker for a screen recording (the button is only needed if Chrome
  // wants a click first), or just the floating bar for a tab recording. When floating controls
  // are wanted, the popup's click arrives first as RECORDER_FLOAT.
  const begun = useRef(false);
  const begin = useCallback(
    async (withClick: boolean) => {
      if (begun.current) {
        if (withClick) await openFloating();
        return;
      }
      begun.current = true;
      const floating = withClick && (await openFloating());
      if (tabMode) {
        // Only here to keep the floating bar open: out of the way, or gone when there is no bar
        if (floating) await updateOwnWindow({ state: 'minimized' });
        else window.close();
        return;
      }
      if (wantsFloat) await updateOwnWindow({ focused: true });
      choose();
    },
    [choose, openFloating, tabMode, wantsFloat]
  );

  // The popup's Stop button reaches the recording through the background
  useEffect(() => {
    const onMessage = (message: { target?: string; type?: string }, _sender?: unknown, sendResponse?: (response: unknown) => void) => {
      if (message.target !== 'recorder') return false;
      if (message.type === 'RECORDER_STOP') stop();
      if (message.type === 'RECORDER_PAUSE') recordingRef.current?.pause();
      if (message.type === 'RECORDER_RESUME') recordingRef.current?.resume();
      if (message.type === 'RECORDER_FLOAT') {
        begin(true).then(() => sendResponse?.({ handled: true }));
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [begin]);

  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (!wantsFloat) {
      begin(false);
      return;
    }
    const timer = setTimeout(() => begin(false), FLOAT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [begin, wantsFloat]);

  const showFloatingButton = floatingSupported() && !floatingOpen && (
    <button className="btn-ghost" onClick={openFloating} title={entireScreen ? 'It will be visible in the video, because the entire screen is being recorded' : undefined}>
      Show floating controls
    </button>
  );

  if (tabMode) {
    return (
      <div className="recorder-window">
        <h1>Recording this tab</h1>
        <p className={`recorder-timer${paused ? ' paused' : ''}`} role="timer">
          {paused ? '❚❚' : '●'} {formatDuration(elapsed)} / {formatDuration(Math.round(maxDurationMs / 1000))}
        </p>
        <p>
          This window keeps the floating controls open, so leave it minimized. Closing it only removes the floating controls: the
          recording carries on, with the controls on the Pramana icon ({keys.pause} pauses, {keys.stop} stops).
        </p>
        {showFloatingButton}
        <button className="btn-ghost" onClick={togglePause}>
          {paused ? '▶️ Resume' : '⏸️ Pause'}
        </button>
        <button className="btn-record recording" onClick={() => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {})}>
          ⏹️ Stop recording
        </button>
      </div>
    );
  }

  return (
    <div className="recorder-window">
      <h1>Record your screen</h1>
      {phase.name === 'picking' && <ShareSteps />}
      {phase.name === 'choose' && (
        <>
          <ShareSteps />
          <p>You can also pick a window or tab instead, and include its audio in Chrome's window.</p>
          {mic && <p className="record-note">Your microphone will be recorded too.</p>}
          {phase.error && <p className="error-message">{phase.error}</p>}
          <button className="btn-primary" onClick={choose} autoFocus>
            {phase.error ? 'Choose again' : 'Choose what to record'}
          </button>
          <button className="btn-ghost" onClick={() => window.close()}>
            Cancel
          </button>
        </>
      )}
      {phase.name === 'recording' && (
        <>
          <p className={`recorder-timer${paused ? ' paused' : ''}`} role="timer">
            {paused ? '❚❚' : '●'} {formatDuration(elapsed)} / {formatDuration(Math.round(maxDurationMs / 1000))}
          </p>
          {phase.warning && <p className="notice notice-info">{phase.warning}</p>}
          <p>
            Controls are on the Pramana icon in Chrome's toolbar, or use {keys.pause} (pause) and {keys.stop} (stop). Keep this
            window open (minimized is fine): closing it discards the recording.
          </p>
          {entireScreen && floatingOpen && (
            <p className="record-note">
              You are recording the entire screen, so the floating controls are in the video too. Drag them to a corner, or close
              them and use the shortcuts.
            </p>
          )}
          {showFloatingButton}
          <button className="btn-ghost" onClick={togglePause}>
            {paused ? '▶️ Resume' : '⏸️ Pause'}
          </button>
          <button className="btn-record recording" onClick={stop}>
            ⏹️ Stop recording
          </button>
        </>
      )}
      {phase.name === 'saving' && <p>Saving your recording…</p>}
    </div>
  );
}

export default App;
