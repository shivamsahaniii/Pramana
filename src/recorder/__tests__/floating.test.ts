import { describe, it, expect, vi } from 'vitest';
import { floatingSupported, openFloatingControls } from '../floating';

function fakeScope(requestWindow?: () => Promise<unknown>) {
  return (requestWindow ? { documentPictureInPicture: { requestWindow } } : {}) as unknown as Window;
}

function fakePip() {
  const listeners: Record<string, () => void> = {};
  return {
    document: document.implementation.createHTMLDocument('pip'),
    addEventListener: vi.fn((type: string, fn: () => void) => (listeners[type] = fn)),
    close: vi.fn(),
    fire: (type: string) => listeners[type]?.(),
  };
}

describe('floating recording controls', () => {
  it('is unavailable in a Chrome without Document Picture-in-Picture', async () => {
    expect(floatingSupported(fakeScope())).toBe(false);
    expect(await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn() }, fakeScope())).toBeNull();
  });

  it('gives up quietly when Chrome refuses to open it (no click to answer)', async () => {
    const scope = fakeScope(() => Promise.reject(new DOMException('requires user activation', 'NotAllowedError')));
    expect(await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn() }, scope)).toBeNull();
  });

  it('shows the timer with Pause and Stop that reach the recording', async () => {
    const pip = fakePip();
    const requestWindow = vi.fn().mockResolvedValue(pip);
    const onTogglePause = vi.fn();
    const onStop = vi.fn();

    const controls = (await openFloatingControls({ onTogglePause, onStop }, fakeScope(requestWindow)))!;
    controls.update({ seconds: 75, maxSeconds: 1800, paused: false });

    expect(requestWindow).toHaveBeenCalledWith(expect.objectContaining({ width: 240, height: 52, disallowReturnToOpener: true }));
    const body = pip.document.body;
    expect(body.querySelector('.time')!.textContent).toBe('1:15/ 30:00');
    expect(body.querySelector<HTMLElement>('.note')!.hidden).toBe(true);
    body.querySelector<HTMLButtonElement>('.pause')!.click();
    body.querySelector<HTMLButtonElement>('.stop')!.click();
    expect(onTogglePause).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('moves the bar to the top left corner of the screen', async () => {
    const getAll = vi.fn().mockResolvedValue([{ id: 1 }, { id: 7, alwaysOnTop: true }]);
    const update = vi.fn().mockResolvedValue({});
    Object.assign(chrome.windows, { getAll, update });
    await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn() }, fakeScope(async () => fakePip()));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(7, { left: 0, top: 0 }));
  });

  it('shows the pause, and offers Resume', async () => {
    const pip = fakePip();
    const controls = (await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn() }, fakeScope(async () => pip)))!;
    controls.update({ seconds: 5, maxSeconds: 1800, paused: true });
    expect(pip.document.body.classList.contains('paused')).toBe(true);
    expect(pip.document.body.querySelector<HTMLElement>('.pause')!.title).toBe('Resume');
  });

  it('shows a note instead of the timer before the recording starts', async () => {
    const pip = fakePip();
    const controls = (await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn() }, fakeScope(async () => pip)))!;
    controls.update({ note: 'Choose what to share…', seconds: 0, maxSeconds: 1800, paused: false });
    const body = pip.document.body;
    expect(body.querySelector('.note')!.textContent).toBe('Choose what to share…');
    expect(body.querySelector<HTMLElement>('.time')!.hidden).toBe(true);
    expect(body.querySelector<HTMLElement>('.stop')!.hidden).toBe(true);
  });

  it('reports when the user closes it, and when it is closed for them', async () => {
    const pip = fakePip();
    const onClosed = vi.fn();
    const controls = (await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn(), onClosed }, fakeScope(async () => pip)))!;
    expect(controls.isOpen()).toBe(true);

    pip.fire('pagehide');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(controls.isOpen()).toBe(false);

    const second = fakePip();
    const closedByUs = vi.fn();
    const other = (await openFloatingControls({ onTogglePause: vi.fn(), onStop: vi.fn(), onClosed: closedByUs }, fakeScope(async () => second)))!;
    other.close();
    second.fire('pagehide');
    expect(second.close).toHaveBeenCalled();
    expect(closedByUs).not.toHaveBeenCalled();
  });
});
