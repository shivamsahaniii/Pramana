/// <reference types="chrome" />

export async function handleCapture(
  payload: { mode: 'full' | 'tab' | 'area' | 'start' | 'stop'; tabId?: number; source?: string; mic?: boolean },
  sender: chrome.runtime.MessageSender
) {
  switch (payload.mode) {
    case 'tab': {
      const tabId = payload.tabId || sender.tab?.id;
      if (!tabId) return { success: false, error: 'No tab ID' };
      try {
        const tab = await chrome.tabs.get(tabId);
        return await captureTab(tab.windowId);
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
    default:
      console.warn('Capture mode not handled in background:', payload.mode);
      return { success: false, error: 'Use popup for capture' };
  }
}

export async function handleCaptureArea(
  area: { x: number; y: number; width: number; height: number },
  sender: chrome.runtime.MessageSender
) {
  try {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (!tabId || !windowId) return { success: false, error: 'No tab/window info' };

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const base64 = dataUrl.split(',')[1];

    return { success: true, base64, area };
  } catch (error) {
    console.error('Area capture failed:', error);
    return { success: false, error: String(error) };
  }
}

// While a full-page capture scrolls through the page, the toolbar icon counts the screens
async function setCaptureBadge(text: string) {
  const { recording_state: recording } = await chrome.storage.session.get(['recording_state']);
  if (recording) return; // the recording badge stays
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: '#f26b1d' });
}

/** One screen of a full-page capture, asked for by the content script as it scrolls. */
export async function handleCaptureVisible(payload: { step?: number; steps?: number } | undefined, sender: chrome.runtime.MessageSender) {
  try {
    const windowId = sender.tab?.windowId;
    if (!windowId) return { success: false, error: 'No tab/window info' };
    if (payload?.step && payload.steps && payload.steps > 1) await setCaptureBadge(`${payload.step}/${payload.steps}`);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { success: true, base64: dataUrl.split(',')[1] };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function handleCaptureDone() {
  await setCaptureBadge('');
  return { success: true };
}

async function captureTab(windowId?: number) {
  if (!windowId) return { success: false, error: 'No window ID' };
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { success: true, dataUrl, type: 'screenshot' };
  } catch (error) {
    console.error('Tab capture failed:', error);
    return { success: false, error: String(error) };
  }
}
