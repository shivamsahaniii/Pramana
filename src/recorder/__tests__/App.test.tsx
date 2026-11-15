import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const recorder = vi.hoisted(() => ({ recordStream: vi.fn() }));
vi.mock('../../shared/captureRecorder', () => recorder);

import App from '../App';

describe('Screen recorder window', () => {
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;
  let resume: ReturnType<typeof vi.fn>;
  let onSessionChange: (changes: object) => void;
  let onMessage: (message: object) => void;
  const display = { getTracks: () => [{ stop: vi.fn() }] };

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/?mic=1&max=600000&format=mp4');
    getDisplayMedia = vi.fn().mockResolvedValue(display);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    stop = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    recorder.recordStream.mockResolvedValue({ stop, pause, resume });
    (chrome.storage.session.onChanged.addListener as any) = vi.fn((fn: typeof onSessionChange) => (onSessionChange = fn));
    (chrome.runtime as any).sendMessage = vi.fn().mockResolvedValue({ success: true, recording: { startedAt: Date.now(), source: 'screen' } });
    (chrome.runtime.onMessage as any).addListener = vi.fn((fn: typeof onMessage) => (onMessage = fn));
    (chrome.runtime.onMessage as any).removeListener = vi.fn();
  });

  it("opens Chrome's share picker on Entire screen without an extra click and starts recording", async () => {
    render(<App />);

    await screen.findByText('⏹️ Stop recording');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: true, selfBrowserSurface: 'exclude', video: expect.objectContaining({ displaySurface: 'monitor' }) })
    );
    expect(recorder.recordStream).toHaveBeenCalledWith(display, { playCapturedAudio: false, mic: true, maxDurationMs: 600000, format: 'mp4' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'RECORDING_STARTED' });
    expect(screen.getByRole('timer')).toHaveTextContent('0:00 / 10:00');
  });

  it('records WebM when that format was chosen', async () => {
    window.history.replaceState(null, '', '/?mic=0&max=600000&format=webm');
    render(<App />);
    await screen.findByText('⏹️ Stop recording');
    expect(recorder.recordStream).toHaveBeenCalledWith(display, expect.objectContaining({ format: 'webm', mic: false }));
  });

  it('falls back to a button when Chrome wants a click before showing the picker', async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException('needs activation', 'InvalidStateError'));
    render(<App />);

    fireEvent.click(await screen.findByText('Choose what to record'));
    await screen.findByText('⏹️ Stop recording');
    expect(screen.queryByText(/Nothing was shared/)).toBeNull();
  });

  it('lets the user choose again after cancelling the picker', async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    render(<App />);

    expect(await screen.findByText(/^Nothing was shared\./)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Choose again'));
    await screen.findByText('⏹️ Stop recording');
  });

  it('says when the operating system blocked screen sharing', async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException('Permission denied by system', 'NotAllowedError'));
    render(<App />);
    expect(await screen.findByText(/Your system did not allow screen sharing/)).toBeInTheDocument();
  });

  it('explains which Share buttons to click while the pickers are open', async () => {
    getDisplayMedia.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/In Chrome's window/)).toHaveTextContent("In Chrome's window, Entire screen is selected: click Share.");
    // jsdom's user agent says Linux, so the desktop step is shown
    expect(screen.getByText(/If your system asks too/)).toBeInTheDocument();
  });

  it('stops from the popup', async () => {
    render(<App />);
    await screen.findByText('⏹️ Stop recording');

    act(() => onMessage({ target: 'recorder', type: 'RECORDER_STOP' }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(screen.getByText('Saving your recording…')).toBeInTheDocument();
  });

  it('pauses and resumes when the background says so, and shows it', async () => {
    const startedAt = Date.now() - 30_000;
    render(<App />);
    await screen.findByText('⏹️ Stop recording');

    act(() => onMessage({ target: 'recorder', type: 'RECORDER_PAUSE' }));
    expect(pause).toHaveBeenCalled();
    act(() => onSessionChange({ recording_state: { newValue: { startedAt, source: 'screen', pausedAt: Date.now() - 10_000, pausedMs: 0 } } }));
    await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('❚❚ 0:20 / 10:00'));
    expect(screen.getByText('▶️ Resume')).toBeInTheDocument();

    act(() => onMessage({ target: 'recorder', type: 'RECORDER_RESUME' }));
    expect(resume).toHaveBeenCalled();
  });

  it('asks the background to pause, so the toolbar icon shows it too', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText('⏸️ Pause'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'PAUSE_RECORDING' });
    expect(pause).not.toHaveBeenCalled();
  });

  it('stops from its own button', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText('⏹️ Stop recording'));
    expect(stop).toHaveBeenCalled();
  });

  it('warns before the window is closed mid-recording', async () => {
    render(<App />);
    await screen.findByText('⏹️ Stop recording');

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not record when the background refuses to start', async () => {
    (chrome.runtime as any).sendMessage = vi.fn().mockResolvedValue({ success: false, error: 'busy' });
    render(<App />);
    expect(await screen.findByText('Recording failed: busy')).toBeInTheDocument();
    expect(recorder.recordStream).not.toHaveBeenCalled();
  });
});

describe('Floating controls', () => {
  let onMessage: (message: object, sender?: unknown, sendResponse?: (r: unknown) => void) => unknown;
  let requestWindow: ReturnType<typeof vi.fn>;
  let pip: { document: Document; addEventListener: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  const displayOf = (displaySurface: string) => ({
    getTracks: () => [{ stop: vi.fn() }],
    getVideoTracks: () => [{ getSettings: () => ({ displaySurface }) }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    pip = { document: document.implementation.createHTMLDocument('pip'), addEventListener: vi.fn(), close: vi.fn() };
    requestWindow = vi.fn().mockResolvedValue(pip);
    (window as any).documentPictureInPicture = { requestWindow };
    getDisplayMedia = vi.fn().mockResolvedValue(displayOf('window'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    recorder.recordStream.mockResolvedValue({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn() });
    (chrome.storage.session.onChanged.addListener as any) = vi.fn();
    (chrome.storage.session.get as any) = vi.fn().mockResolvedValue({ recording_state: { startedAt: Date.now() - 12_000, source: 'tab', pausedAt: null, pausedMs: 0 } });
    (chrome.runtime as any).sendMessage = vi.fn().mockResolvedValue({ success: true, recording: { startedAt: Date.now(), source: 'screen' } });
    (chrome.runtime.onMessage as any).addListener = vi.fn((fn: typeof onMessage) => (onMessage = fn));
    (chrome.runtime.onMessage as any).removeListener = vi.fn();
    (chrome.windows.update as any) = vi.fn().mockResolvedValue({ id: 99 });
    vi.spyOn(window, 'close').mockImplementation(() => {});
  });

  const passClick = async () => {
    const sendResponse = vi.fn();
    let keepsChannelOpen: unknown;
    act(() => {
      keepsChannelOpen = onMessage({ target: 'recorder', type: 'RECORDER_FLOAT' }, {}, sendResponse);
    });
    expect(keepsChannelOpen).toBe(true);
    await waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ handled: true }));
  };

  it('opens over a tab recording when the popup passes its click on, then minimizes its window', async () => {
    window.history.replaceState(null, '', '/?mode=tab&float=1&max=1800000');
    render(<App />);
    expect(screen.getByText('Recording this tab')).toBeInTheDocument();

    await passClick();

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(chrome.windows.update).toHaveBeenCalledWith(99, { state: 'minimized' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    await waitFor(() => expect(pip.document.body.querySelector('.time')!.textContent).toBe('0:12/ 30:00'));
    await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('● 0:12 / 30:00'));
  });

  it('its Pause and Stop go through the background, so the icon and popup follow', async () => {
    window.history.replaceState(null, '', '/?mode=tab&float=1&max=1800000');
    render(<App />);
    await passClick();

    pip.document.body.querySelector<HTMLButtonElement>('.pause')!.click();
    pip.document.body.querySelector<HTMLButtonElement>('.stop')!.click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TOGGLE_PAUSE_RECORDING' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STOP_RECORDING' });
  });

  it('closes the helper window when no click arrives, leaving the tab recording running', async () => {
    window.history.replaceState(null, '', '/?mode=tab&float=1&max=1800000');
    render(<App />);
    await waitFor(() => expect(window.close).toHaveBeenCalled(), { timeout: 3000 });
    expect(requestWindow).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'STOP_RECORDING' });
  });

  it('closes the helper window when Chrome refuses the floating window', async () => {
    requestWindow.mockRejectedValue(new DOMException('no activation', 'NotAllowedError'));
    window.history.replaceState(null, '', '/?mode=tab&float=1&max=1800000');
    render(<App />);
    await passClick();
    expect(window.close).toHaveBeenCalled();
  });

  it('does not warn about losing the recording when the tab helper window is closed', async () => {
    window.history.replaceState(null, '', '/?mode=tab&float=1&max=1800000');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('0:12'));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens before the share picker for a screen recording, and stays for a window recording', async () => {
    window.history.replaceState(null, '', '/?mic=0&max=1800000&format=mp4&float=1');
    render(<App />);
    expect(getDisplayMedia).not.toHaveBeenCalled(); // waiting for the popup's click

    await passClick();

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(chrome.windows.update).toHaveBeenCalledWith(99, { focused: true });
    await screen.findByText('⏹️ Stop recording');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(pip.close).not.toHaveBeenCalled();
  });

  it('stays open when the entire screen is recorded, and says it is in the video', async () => {
    getDisplayMedia.mockResolvedValue(displayOf('monitor'));
    window.history.replaceState(null, '', '/?mic=0&max=1800000&format=mp4&float=1');
    render(<App />);
    await passClick();

    await screen.findByText('⏹️ Stop recording');
    expect(pip.close).not.toHaveBeenCalled();
    expect(screen.getByText(/the floating controls are in the video too/)).toBeInTheDocument();
  });

  it('starts the screen recording anyway when the popup closed before passing its click on', async () => {
    window.history.replaceState(null, '', '/?mic=0&max=1800000&format=mp4&float=1');
    render(<App />);
    await screen.findByText('⏹️ Stop recording', {}, { timeout: 3000 });
    expect(requestWindow).not.toHaveBeenCalled();
  });

  it('can be brought back with a button, whose click Chrome accepts', async () => {
    window.history.replaceState(null, '', '/?mic=0&max=1800000&format=mp4');
    render(<App />);
    await screen.findByText('⏹️ Stop recording');

    fireEvent.click(screen.getByText('Show floating controls'));

    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Show floating controls')).toBeNull());
  });
});
