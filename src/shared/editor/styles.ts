// The editor injects its own styles so it looks the same in the extension's editor tab
// and inside the shadow root it gets on a web page (where page CSS can't reach it).
export const EDITOR_CSS = `
.pe-root, .pe-root * { box-sizing: border-box; margin: 0; }
.pe-root {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: #0e0d14; color: #ececf1;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.pe-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px; background: #1e1d29; border-bottom: 1px solid #34334a; flex-shrink: 0;
}
.pe-title { font-size: 15px; font-weight: 600; }
.pe-header-actions { display: flex; gap: 8px; }
.pe-btn {
  padding: 7px 14px; border-radius: 6px; font: inherit; font-weight: 500; cursor: pointer;
  background: #272634; border: 1px solid #34334a; color: #d9d9e3; transition: background 0.15s, border-color 0.15s;
}
.pe-btn:hover:not(:disabled) { background: #34334a; border-color: #f26b1d; }
.pe-btn:disabled { opacity: 0.6; cursor: progress; }
.pe-btn-primary { background: linear-gradient(135deg, #f97316, #e2560f); border-color: #f26b1d; color: #fff; font-weight: 600; }
.pe-btn-primary:hover:not(:disabled) { background: linear-gradient(135deg, #ff8a2b, #f26b1d); }
.pe-body { flex: 1; display: flex; min-height: 0; }
.pe-toolbar {
  width: 248px; flex-shrink: 0; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 12px;
  background: #1e1d29; border-right: 1px solid #34334a;
}
.pe-tool-group, .pe-history-group { display: flex; flex-wrap: wrap; gap: 4px; }
.pe-tool-btn {
  display: flex; align-items: center; justify-content: center; width: 36px; height: 36px;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: #9a9bb0; cursor: pointer; transition: all 0.15s;
}
.pe-tool-btn:hover:not(:disabled) { background: #272634; color: #ececf1; }
.pe-tool-btn.active { background: #f26b1d; border-color: #f26b1d; color: #fff; }
.pe-tool-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.pe-divider { height: 1px; background: #34334a; }
.pe-section { display: flex; flex-direction: column; gap: 8px; }
.pe-section[hidden] { display: none; }
.pe-label { font-size: 11px; color: #9a9bb0; text-transform: uppercase; letter-spacing: 0.5px; }
.pe-hint { font-size: 12px; color: #9a9bb0; }
.pe-swatches, .pe-emoji-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.pe-swatch {
  width: 24px; height: 24px; border-radius: 4px; border: 2px solid transparent; cursor: pointer;
}
.pe-swatch.active { border-color: #fff; box-shadow: 0 0 0 2px #f26b1d; }
.pe-row { display: flex; align-items: center; gap: 8px; }
.pe-row input[type=range] { flex: 1; min-width: 0; accent-color: #f26b1d; }
.pe-row span { font-size: 11px; color: #9a9bb0; min-width: 28px; }
.pe-row span:last-child { text-align: right; }
.pe-stepper { display: flex; align-items: center; gap: 6px; }
.pe-step-btn {
  width: 44px; height: 34px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700;
  background: #272634; border: 1px solid #34334a; color: #ececf1; transition: all 0.15s;
}
.pe-step-large { font-size: 17px; }
.pe-step-btn:hover:not(:disabled) { border-color: #f26b1d; background: #f26b1d22; }
.pe-step-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.pe-step-value { flex: 1; text-align: center; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pe-emoji-btn {
  width: 32px; height: 32px; font-size: 18px; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: 4px;
}
.pe-emoji-btn:hover { background: #272634; }
.pe-emoji-btn.active { border-color: #f26b1d; background: #f26b1d22; }
.pe-stage {
  flex: 1; min-width: 0; display: flex; overflow: auto; padding: 16px;
}
/* margin: auto centres the image, and still lets a tall one scroll from its top */
.pe-canvas-wrap { position: relative; margin: auto; flex: none; line-height: 0; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
.pe-canvas-wrap canvas { display: block; }
.pe-text-input {
  position: absolute; min-width: 40px; padding: 0 2px; line-height: 1.2;
  background: rgba(14,13,20,0.6); border: 1px dashed #f26b1d; outline: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
`;
