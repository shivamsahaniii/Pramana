// A small always-on-top bar with the recording timer, Pause and Stop, in the top left corner.
//
// It is a Document Picture-in-Picture window: the only always-on-top window an extension can
// open. It is a separate window, so it is not in a tab or window recording. A recording of the
// entire screen would include it, like anything else on screen, so there it is in the video.
//
// Chrome only opens it in answer to a user's click. The click happens in the popup, which
// passes it on by messaging this page (see RECORDER_FLOAT).

import { formatDuration } from '../shared/utils';

// About the smallest window Chrome opens
const WIDTH = 240;
const HEIGHT = 52;

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; gap: 6px; padding: 0 8px; overflow: hidden;
    background: #15141c; color: #ececf1; user-select: none;
    font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
  }
  .time { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; animation: pulse 1.4s infinite; }
  .paused .dot { background: #9ca3af; animation: none; border-radius: 2px; }
  .limit { color: #9a9bb0; font-size: 11px; font-weight: 500; }
  .note { flex: 1; color: #9a9bb0; font-weight: 500; }
  button {
    flex: none; width: 34px; height: 34px; padding: 0; border-radius: 8px; cursor: pointer; font: inherit; font-size: 11px;
    background: #272634; border: 1px solid #34334a; color: #ececf1;
  }
  button:hover { border-color: #f26b1d; }
  .stop { background: #ef4444; border-color: #ef4444; color: #fff; }
  .stop:hover { background: #dc2626; border-color: #dc2626; }
  [hidden] { display: none !important; }
  @keyframes pulse { 50% { opacity: 0.35; } }
`;

export interface FloatingState {
  /** Shown instead of the timer before the recording starts */
  note?: string;
  seconds: number;
  maxSeconds: number;
  paused: boolean;
}

export interface FloatingControls {
  update(state: FloatingState): void;
  close(): void;
  isOpen(): boolean;
}

interface PictureInPicture {
  requestWindow(options: { width: number; height: number; disallowReturnToOpener?: boolean }): Promise<Window>;
}

export function floatingSupported(scope: Window = window): boolean {
  return 'documentPictureInPicture' in scope;
}

/**
 * Chrome opens the bar bottom right and a page can't move it, but the extension's windows API
 * can: it is the one always-on-top window. Top left is out of the way of most content.
 */
async function moveToTopLeft(scope: Window): Promise<void> {
  try {
    const bar = (await chrome.windows.getAll()).find((w) => w.alwaysOnTop && w.id !== undefined);
    if (!bar) return;
    const area = scope.screen as (Screen & { availLeft?: number; availTop?: number }) | undefined;
    await chrome.windows.update(bar.id!, { left: area?.availLeft ?? 0, top: area?.availTop ?? 0 });
  } catch {
    // Stays where Chrome put it
  }
}

/** Opens the bar. Null when Chrome refuses (no click to answer, or a Chrome too old to have it). */
export async function openFloatingControls(
  handlers: { onTogglePause: () => void; onStop: () => void; onClosed?: () => void },
  scope: Window = window
): Promise<FloatingControls | null> {
  const api = (scope as unknown as { documentPictureInPicture?: PictureInPicture }).documentPictureInPicture;
  if (!api) return null;
  let pip: Window;
  try {
    pip = await api.requestWindow({ width: WIDTH, height: HEIGHT, disallowReturnToOpener: true });
  } catch {
    return null;
  }

  void moveToTopLeft(scope);

  const doc = pip.document;
  doc.title = 'Pramana recording';
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const note = el('span', 'note');
  const time = el('span', 'time');
  const elapsed = el('span', '');
  const limit = el('span', 'limit');
  time.append(el('span', 'dot'), elapsed, limit);
  // Symbols, to keep the bar small; the words are in the tooltips
  const pause = el('button', 'pause', '❚❚');
  const stop = el('button', 'stop', '■');
  pause.title = 'Pause';
  stop.title = 'Stop recording';
  stop.setAttribute('aria-label', 'Stop recording');
  pause.addEventListener('click', handlers.onTogglePause);
  stop.addEventListener('click', handlers.onStop);
  doc.body.append(note, time, pause, stop);

  let open = true;
  pip.addEventListener('pagehide', () => {
    if (!open) return;
    open = false;
    handlers.onClosed?.();
  });

  return {
    update(state) {
      if (!open) return;
      const waiting = !!state.note;
      note.textContent = state.note || '';
      note.hidden = !waiting;
      time.hidden = pause.hidden = stop.hidden = waiting;
      doc.body.classList.toggle('paused', state.paused);
      elapsed.textContent = formatDuration(state.seconds);
      limit.textContent = `/ ${formatDuration(state.maxSeconds)}`;
      pause.textContent = state.paused ? '▶' : '❚❚';
      pause.title = state.paused ? 'Resume' : 'Pause';
      pause.setAttribute('aria-label', pause.title);
    },
    close() {
      if (!open) return;
      open = false;
      pip.close();
    },
    isOpen: () => open,
  };
}
