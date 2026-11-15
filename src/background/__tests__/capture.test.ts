import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCapture, handleCaptureArea, handleCaptureDone, handleCaptureVisible } from '../capture';

describe('handleCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures tab when mode is tab', async () => {
    const mockCaptureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,TEST');
    (globalThis.chrome as any).tabs.captureVisibleTab = mockCaptureVisibleTab;
    (globalThis.chrome as any).tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 1 });

    const sender = { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender;
    const result = await handleCapture({ mode: 'tab' } as any, sender);

    expect(result.success).toBe(true);
    expect(result.dataUrl).toBe('data:image/png;base64,TEST');
    expect(mockCaptureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
  });

  it('returns error when no tab id', async () => {
    const sender = { tab: undefined } as chrome.runtime.MessageSender;
    const result = await handleCapture({ mode: 'tab' } as any, sender);
    expect(result.success).toBe(false);
  });

  it('returns error for unhandled modes', async () => {
    const sender = {} as chrome.runtime.MessageSender;
    const result = await handleCapture({ mode: 'full' } as any, sender);
    expect(result.success).toBe(false);
  });
});

describe('handleCaptureArea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures visible tab and returns base64 with area', async () => {
    const mockCaptureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,AREA');
    (globalThis.chrome as any).tabs.captureVisibleTab = mockCaptureVisibleTab;

    const sender = { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender;
    const area = { x: 10, y: 20, width: 100, height: 50 };
    const result = await handleCaptureArea(area, sender);

    expect(result.success).toBe(true);
    expect(result.base64).toBe('AREA');
    expect(result.area).toEqual(area);
    expect(mockCaptureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
  });

  it('returns error when no tab/window info', async () => {
    const sender = { tab: undefined } as chrome.runtime.MessageSender;
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const result = await handleCaptureArea(area, sender);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No tab/window info');
  });

  it('returns error on capture failure', async () => {
    const mockCaptureVisibleTab = vi.fn().mockRejectedValue(new Error('Capture failed'));
    (globalThis.chrome as any).tabs.captureVisibleTab = mockCaptureVisibleTab;

    const sender = { tab: { id: 1, windowId: 1 } } as chrome.runtime.MessageSender;
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const result = await handleCaptureArea(area, sender);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Capture failed');
  });
});

describe('full-page capture screens', () => {
  const sender = { tab: { id: 1, windowId: 5 } } as chrome.runtime.MessageSender;
  const c = () => globalThis.chrome as any;

  beforeEach(() => {
    vi.clearAllMocks();
    c().tabs.captureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,SCREEN');
    c().storage.session.get = vi.fn().mockResolvedValue({});
  });

  it('returns each screen and counts them on the toolbar icon', async () => {
    expect(await handleCaptureVisible({ step: 2, steps: 5 }, sender)).toEqual({ success: true, base64: 'SCREEN' });
    expect(c().tabs.captureVisibleTab).toHaveBeenCalledWith(5, { format: 'png' });
    expect(c().action.setBadgeText).toHaveBeenCalledWith({ text: '2/5' });
  });

  it('shows no count for a page that fits in one screen', async () => {
    await handleCaptureVisible({ step: 1, steps: 1 }, sender);
    expect(c().action.setBadgeText).not.toHaveBeenCalled();
  });

  it('leaves the recording badge alone while a recording is running', async () => {
    c().storage.session.get = vi.fn().mockResolvedValue({ recording_state: { startedAt: 1, source: 'tab' } });
    await handleCaptureVisible({ step: 2, steps: 5 }, sender);
    await handleCaptureDone();
    expect(c().action.setBadgeText).not.toHaveBeenCalled();
  });

  it('clears the count when the capture ends', async () => {
    await handleCaptureDone();
    expect(c().action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it("passes on Chrome's too-many-captures error so the page can wait and retry", async () => {
    c().tabs.captureVisibleTab = vi.fn().mockRejectedValue(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'));
    const result = await handleCaptureVisible({ step: 1, steps: 3 }, sender);
    expect(result).toEqual({ success: false, error: expect.stringContaining('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') });
  });
});
