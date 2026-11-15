/// <reference types="chrome" />

// Full-page capture: scrolls the page a screen at a time, asks the background for a screenshot
// of each screen, and stitches them into one tall image. Runs in the page (content script).

// Chrome allows two captureVisibleTab calls a second
const CAPTURE_GAP_MS = 550;
// Time for lazy-loaded images and scroll effects to settle after each scroll
const SETTLE_MS = 250;
// A canvas can be 32,767 px on a side and about 268 million pixels in all
const MAX_CANVAS_SIDE = 32000;
const MAX_CANVAS_PIXELS = 250_000_000;
const BLOCKER_ID = 'pramana-capture-blocker';

/** Scroll offsets that cover `total` px of content through a `viewport` px window; the last one is the very end. */
export function scrollPositions(total: number, viewport: number): number[] {
  if (viewport <= 0 || total <= viewport) return [0];
  const positions: number[] = [];
  for (let y = 0; y < total - viewport; y += viewport) positions.push(y);
  positions.push(total - viewport);
  return positions;
}

/** Tallest image (in image pixels) that fits in a canvas of this width. */
export function maxImageHeight(widthPx: number): number {
  return Math.floor(Math.min(MAX_CANVAS_SIDE, MAX_CANVAS_PIXELS / Math.max(1, widthPx)));
}

interface Scroller {
  /** null: the page itself scrolls */
  element: HTMLElement | null;
  /** The scrolling area inside the viewport, in CSS px */
  top: number;
  left: number;
  width: number;
  height: number;
  contentHeight: number;
}

/**
 * What to scroll: the page, or (in apps whose page doesn't scroll, like mail or dashboards)
 * the largest scrolling panel inside it.
 */
function findScroller(): Scroller {
  const viewportHeight = window.innerHeight;
  const page = document.scrollingElement || document.documentElement;
  const whole = { element: null, top: 0, left: 0, width: window.innerWidth, height: viewportHeight };
  if (page.scrollHeight > viewportHeight + 4) return { ...whole, contentHeight: page.scrollHeight };

  let best: { element: HTMLElement; area: number } | null = null;
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (element.scrollHeight <= element.clientHeight + 40) continue;
    const area = element.clientWidth * element.clientHeight;
    if (area < window.innerWidth * viewportHeight * 0.25 || (best && area <= best.area)) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') best = { element, area };
  }
  if (!best) return { ...whole, contentHeight: viewportHeight };
  const rect = best.element.getBoundingClientRect();
  return {
    element: best.element,
    top: rect.top + best.element.clientTop,
    left: rect.left + best.element.clientLeft,
    width: best.element.clientWidth,
    height: best.element.clientHeight,
    contentHeight: best.element.scrollHeight,
  };
}

type Restore = () => void;

function setStyle(element: HTMLElement, property: string, value: string): Restore {
  const previous = element.style.getPropertyValue(property);
  const priority = element.style.getPropertyPriority(property);
  element.style.setProperty(property, value, 'important');
  return () => {
    if (previous) element.style.setProperty(property, previous, priority);
    else element.style.removeProperty(property);
  };
}

interface Pinned {
  element: HTMLElement;
  /** Fixed to the bottom half of the window (cookie bars, chat buttons) */
  atBottom: boolean;
}

/**
 * Headers, toolbars and banners that stay put while the page scrolls would repeat in every
 * screen. Sticky ones are returned to the page flow for the whole capture; fixed ones are
 * returned so they can be shown once: top ones in the first screen, bottom ones in the last.
 */
function unpin(restores: Restore[]): Pinned[] {
  const fixed: Pinned[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (element.id === BLOCKER_ID) continue;
    const position = getComputedStyle(element).position;
    if (position === 'sticky') {
      // Back in the flow, and without the offset it sticks at (which `relative` would shift it by)
      restores.push(setStyle(element, 'position', 'relative'));
      restores.push(setStyle(element, 'inset', 'auto'));
    } else if (position === 'fixed') {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) fixed.push({ element, atBottom: rect.top > window.innerHeight / 2 });
    }
  }
  return fixed;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function captureScreen(step: number, steps: number): Promise<ImageBitmap> {
  for (let attempt = 0; ; attempt++) {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', payload: { step, steps } });
    if (response?.success && response.base64) {
      const blob = await (await fetch(`data:image/png;base64,${response.base64}`)).blob();
      return createImageBitmap(blob);
    }
    // Asked too soon after the last one: wait and ask again
    const tooFast = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(response?.error || '');
    if (!tooFast || attempt >= 3) throw new Error(response?.error || 'Capture failed');
    await sleep(CAPTURE_GAP_MS);
  }
}

export interface FullPageResult {
  canvas: HTMLCanvasElement;
  /** The page was too long for one image, so it stops early */
  truncated: boolean;
}

/** Captures the whole page. Resolves with null if the user pressed Escape. */
export async function captureFullPage(): Promise<FullPageResult | null> {
  const restores: Restore[] = [];
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
  };

  // Invisible, so it isn't in the screenshots: keeps clicks and scrolling away from the page meanwhile
  const blocker = document.createElement('div');
  blocker.id = BLOCKER_ID;
  blocker.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; cursor: progress; background: transparent;';
  blocker.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  document.body.appendChild(blocker);
  document.addEventListener('keydown', onKey, true);
  restores.push(() => {
    blocker.remove();
    document.removeEventListener('keydown', onKey, true);
  });

  try {
    // No scrollbar in the pictures, and scrolling that jumps instead of gliding
    restores.push(setStyle(document.documentElement, 'scrollbar-width', 'none'));
    restores.push(setStyle(document.documentElement, 'scroll-behavior', 'auto'));
    const scroller = findScroller();
    const target = scroller.element;
    if (target) {
      restores.push(setStyle(target, 'scrollbar-width', 'none'));
      restores.push(setStyle(target, 'scroll-behavior', 'auto'));
    }
    const scrollTo = (y: number) => (target ? target.scrollTo(0, y) : window.scrollTo(0, y));
    const scrolled = () => (target ? target.scrollTop : window.scrollY);
    const startedAt = scrolled();
    restores.push(() => scrollTo(startedAt));

    const fixed = unpin(restores);
    const show = (when: (pinned: Pinned) => boolean) => {
      const undo = fixed.filter((pinned) => !when(pinned)).map((pinned) => setStyle(pinned.element, 'visibility', 'hidden'));
      return () => undo.forEach((restore) => restore());
    };

    const viewportHeight = window.innerHeight;
    const below = viewportHeight - (scroller.top + scroller.height);
    let positions = scrollPositions(scroller.contentHeight, scroller.height);
    let canvas: HTMLCanvasElement | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let ratio = 1;
    let truncated = false;
    let lastCapture = 0;

    for (let i = 0; i < positions.length; i++) {
      if (cancelled) return null;
      const first = i === 0;
      const last = i === positions.length - 1;
      scrollTo(positions[i]);
      const restoreFixed = show((pinned) => (positions.length === 1 ? true : first ? !pinned.atBottom : last ? pinned.atBottom : false));
      await nextFrame();
      await sleep(Math.max(SETTLE_MS, lastCapture + CAPTURE_GAP_MS - Date.now()));
      const y = scrolled();
      let shot: ImageBitmap;
      try {
        shot = await captureScreen(i + 1, positions.length);
      } finally {
        restoreFixed();
      }
      lastCapture = Date.now();

      if (!canvas || !context) {
        ratio = shot.width / window.innerWidth;
        // The whole first screen, then the scrolling area continues below it
        const wanted = Math.round((scroller.top + scroller.contentHeight + below) * ratio);
        const allowed = maxImageHeight(shot.width);
        if (wanted > allowed) {
          truncated = true;
          const fits = Math.max(1, Math.floor((allowed / ratio - scroller.top) / scroller.height));
          positions = positions.slice(0, fits);
        }
        canvas = document.createElement('canvas');
        canvas.width = shot.width;
        canvas.height = truncated ? Math.round((scroller.top + positions.length * scroller.height) * ratio) : wanted;
        context = canvas.getContext('2d');
        if (!context) throw new Error('Could not build the image');
        context.fillStyle = getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : getComputedStyle(document.body).backgroundColor;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(shot, 0, 0);
        // What sits under the scrolling area belongs at the end of the image, not after the first screen
        if (positions.length > 1 && below > 0) {
          context.fillRect(0, Math.floor((scroller.top + scroller.height) * ratio), canvas.width, canvas.height);
        }
      } else {
        // Only the scrolling area of this screen, placed where that content sits in the page
        // Rounded so neighbouring screens overlap by a pixel at most, and never leave a gap
        const sx = Math.round(scroller.left * ratio);
        const sy = Math.floor(scroller.top * ratio);
        const sw = Math.round(scroller.width * ratio);
        const sh = Math.ceil(scroller.height * ratio);
        context.drawImage(shot, sx, sy, sw, sh, sx, Math.floor((scroller.top + y) * ratio), sw, sh);
        // Anything under the scrolling area (a footer bar) goes at the very end
        if (last && below > 0 && !truncated) {
          const by = Math.round((scroller.top + scroller.height) * ratio);
          context.drawImage(shot, 0, by, shot.width, shot.height - by, 0, canvas.height - (shot.height - by), shot.width, shot.height - by);
        }
      }
      shot.close();
    }
    return canvas ? { canvas, truncated } : null;
  } finally {
    restores.reverse().forEach((restore) => restore());
    void Promise.resolve(chrome.runtime.sendMessage({ type: 'CAPTURE_DONE' })).catch(() => {});
  }
}
