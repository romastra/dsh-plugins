import { isZoomPercent } from './scale.js';

/** Physical codes keep Shift+Minus / Shift+0 working as _ / ) in every layout. */
export function zoomAction(event, mac = false) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === 'Dead'
      || event.altKey || event.getModifierState?.('AltGraph') || !event.shiftKey) return undefined;
  if (mac ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return undefined;
  if (event.code === 'Equal' || event.code === 'NumpadAdd') return 'in';
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') return 'out';
  if (event.code === 'Digit0' || event.code === 'Numpad0') return 'reset';
  return undefined;
}

/** Root zoom includes body-portaled dialogs; percentages preserve the full-height shell. */
export function zoomStyle(percent) {
  if (!isZoomPercent(percent)) throw new RangeError('Invalid zoom percentage.');
  const factor = percent / 100;
  // Positioning adapters consume both values in this SAME style commit. Visible
  // content stays zoomed; only a screen-coordinate positioning layer is normalized.
  const variables = `--dsh-ui-zoom-factor: ${factor}; --dsh-ui-zoom-inverse: ${1 / factor};`;
  return `:root { ${percent === 100 ? '' : `zoom: ${factor} !important; `}${variables} }`;
}
