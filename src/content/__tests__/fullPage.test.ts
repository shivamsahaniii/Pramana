import { describe, it, expect } from 'vitest';
import { maxImageHeight, scrollPositions } from '../fullPage';

describe('full-page capture plan', () => {
  it('takes one screen when the page fits in the window', () => {
    expect(scrollPositions(600, 800)).toEqual([0]);
    expect(scrollPositions(800, 800)).toEqual([0]);
  });

  it('steps a screen at a time and ends exactly at the bottom of the page', () => {
    // 2,500 px of page through an 800 px window: three full screens, then the last 100 px
    expect(scrollPositions(2500, 800)).toEqual([0, 800, 1600, 1700]);
  });

  it('does not repeat the last screen when the page is a whole number of screens', () => {
    expect(scrollPositions(2400, 800)).toEqual([0, 800, 1600]);
  });

  it('covers every pixel of the page', () => {
    for (const [total, viewport] of [[2500, 800], [801, 800], [10_000, 733], [1599, 800]]) {
      const positions = scrollPositions(total, viewport);
      expect(positions[0]).toBe(0);
      expect(positions.at(-1)).toBe(total - viewport);
      for (let i = 1; i < positions.length; i++) expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(viewport);
    }
  });

  it('survives a window with no height', () => {
    expect(scrollPositions(1000, 0)).toEqual([0]);
  });

  it('keeps the image inside what a canvas can hold', () => {
    // Narrow images are limited by the longest side, wide ones by the total number of pixels
    expect(maxImageHeight(1280)).toBe(32000);
    expect(maxImageHeight(10_000)).toBe(25_000);
    expect(maxImageHeight(3840) * 3840).toBeLessThanOrEqual(268_435_456);
  });
});
