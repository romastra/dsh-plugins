// MSX fixed palette, verbatim sRGB values from the user's reference.
// Index 0 means transparent, not a second black: represented by reset (null).
export const PALETTE_SOURCE = 'https://paulwratt.github.io/programmers-palettes/HW-MSX/HW-MSX-palettes.html';
export const PALETTE = Object.freeze([
  { index: 1, hex: '#010101', name: 'black' },
  { index: 2, hex: '#3eb849', name: 'mediumGreen' },
  { index: 3, hex: '#74d07d', name: 'lightGreen' },
  { index: 4, hex: '#5955e0', name: 'darkBlue' },
  { index: 5, hex: '#8076f1', name: 'lightBlue' },
  { index: 6, hex: '#b95e51', name: 'darkRed' },
  { index: 7, hex: '#65dbef', name: 'cyan' },
  { index: 8, hex: '#db6559', name: 'mediumRed' },
  { index: 9, hex: '#ff897d', name: 'lightRed' },
  { index: 10, hex: '#ccc35e', name: 'darkYellow' },
  { index: 11, hex: '#ded087', name: 'lightYellow' },
  { index: 12, hex: '#3aa241', name: 'darkGreen' },
  { index: 13, hex: '#b766b5', name: 'magenta' },
  { index: 14, hex: '#cccccc', name: 'gray' },
  { index: 15, hex: '#ffffff', name: 'white' },
].map(Object.freeze));

export function isColor(value) {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= 15);
}

// CSS string escaping, independent of window.CSS; no arbitrary CSS values enter rules.
export function cssString(value) {
  return '"' + String(value).replace(/[\u0000-\u001f\u007f"\\<>]/g, c => `\\${c.codePointAt(0).toString(16)} `) + '"';
}

export function workspaceColorRules(colors) {
  return Object.entries(colors).flatMap(([id, index]) => {
    const color = PALETTE.find(item => item.index === index);
    if (!color) return [];
    const selector = `[data-sidebar-list-area] [data-row-key=${cssString(`workspace:${id}`)}]`;
    // Version-pinned bridge: rc.3 has no additive Workspace row appearance slot.
    // Leave native background-color/hover, geometry, outline and text untouched.
    return [`${selector}{background-image:linear-gradient(color-mix(in srgb, ${color.hex} 12%, transparent),color-mix(in srgb, ${color.hex} 12%, transparent));box-shadow:inset 3px 0 0 ${color.hex},inset 4px 0 0 var(--dsw-alias-border-l2);}`];
  }).join('\n');
}
