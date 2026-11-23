// A bounded search driven by the actual owned text box, never character counts
// or canvas/font approximations. All measurements use CSS layout units.
export function largestTaskFont({ fits, min = 1, max, precision = .25 }) {
  if (typeof fits !== 'function' || !Number.isFinite(max) || max <= 0) return null;
  let low = Math.min(max, Math.max(.25, Number.isFinite(min) ? min : 1)), high = max;
  if (!fits(low)) return low;
  if (fits(high)) return high;
  const step = Number.isFinite(precision) && precision > 0 ? precision : .25;
  for (let i = 0; i < 24 && high - low > step; i++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle; else high = middle;
  }
  return low;
}

export function bindTaskFit({ frame, text, view, document }) {
  if (!frame || !text) return () => {};
  let disposed = false, raf = null, signature = null;
  const fit = (force = false) => {
    if (disposed) return;
    const width = frame.clientWidth, height = frame.clientHeight;
    if (!(width > 0 && height > 0)) { signature = null; return; }
    const style = view.getComputedStyle?.(text);
    const key = [width, height, text.textContent, style?.fontFamily, style?.fontWeight, style?.fontStyle, style?.letterSpacing, style?.wordSpacing].join('\u0001');
    if (!force && key === signature) return;
    signature = key;
    // One line cannot fit higher than the available region (line-height:1.12).
    const fits = size => {
      text.style.fontSize = size + 'px';
      return text.scrollHeight <= height && text.scrollWidth <= width;
    };
    const size = largestTaskFont({ fits, max: height / 1.12 });
    if (size === null) return;
    text.style.fontSize = size + 'px';
    const overflow = text.scrollHeight > height || text.scrollWidth > width;
    frame.style.overflow = overflow ? 'auto' : 'hidden';
    frame.style.alignItems = overflow ? 'flex-start' : 'center';
    frame.style.pointerEvents = overflow ? 'auto' : 'none';
    frame.dataset.taskOverflow = overflow ? 'true' : 'false';
    frame.tabIndex = overflow ? 0 : -1;
    if (overflow) frame.dataset.chatSwitcherNoSwipe = ''; else delete frame.dataset.chatSwitcherNoSwipe;
    text.dataset.taskFit = overflow ? 'overflow' : 'fitted';
  };
  const schedule = () => {
    if (disposed || raf !== null) return;
    if (typeof view.requestAnimationFrame !== 'function') { fit(); return; }
    raf = view.requestAnimationFrame(() => { raf = null; fit(); });
  };
  fit();
  let observer = null;
  if (typeof view.ResizeObserver === 'function') {
    observer = new view.ResizeObserver(schedule);
    observer.observe(frame); observer.observe(text);
  }
  view.addEventListener?.('resize', schedule);
  const fonts = document?.fonts;
  const fontsChanged = () => { signature = null; schedule(); };
  fonts?.addEventListener?.('loadingdone', fontsChanged);
  if (fonts?.ready) Promise.resolve(fonts.ready).then(() => { if (!disposed) fontsChanged(); }, () => {});
  return () => {
    disposed = true;
    if (raf !== null) view.cancelAnimationFrame?.(raf);
    observer?.disconnect();
    view.removeEventListener?.('resize', schedule);
    fonts?.removeEventListener?.('loadingdone', fontsChanged);
  };
}

// Relative HSL is evaluated from the actual current text color on every theme
// update: light text yields pure black, dark text yields pure white.
export const TASK_SHADOW_COLOR = 'hsl(from currentColor 0 0 clamp(0,calc((50 - l) * 1000),100))';
export const TASK_FIT_CSS = `
.cs-task-area{position:relative;flex:1 1 0;align-self:stretch;min-height:0;min-width:0;background:transparent}
.cs-task-fit{position:absolute;inset:6px 7px;display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;min-height:0}
.cs-active-task{display:block;opacity:0.5;flex:0 0 auto;box-sizing:border-box;width:100%;min-width:0;margin:0;padding:max(4px,.12em);color:var(--dsw-alias-label-primary);--cs-task-shadow:#000;text-shadow:0 0 max(2px,.08em) var(--cs-task-shadow),0 0 max(1px,.024em) var(--cs-task-shadow);font-size:12px;font-weight:600;line-height:1.12;text-align:center;white-space:normal;overflow-wrap:anywhere;word-break:normal}
.cs-dialog .cs-preview-statuses{flex:0 0 auto}
@supports (color:${TASK_SHADOW_COLOR}){.cs-active-task{--cs-task-shadow:${TASK_SHADOW_COLOR}}}
`;
