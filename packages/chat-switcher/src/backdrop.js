import { getMosaicDataUrl } from './mosaic.js';

// Only a handful of chat backgrounds are normally active. Keep this derived
// cache smaller than the shared 128-entry mosaic URI cache; never retain scenes.
const WALLPAPER_CACHE_LIMIT = 16;
const wallpaperCache = new Map();

/** Reframe the exact cached chat SVG, extending only its solid background. */
export function mosaicWallpaper(sessionId, imageOverride) {
  if (imageOverride === undefined && wallpaperCache.has(sessionId)) {
    const cached = wallpaperCache.get(sessionId);
    wallpaperCache.delete(sessionId); wallpaperCache.set(sessionId, cached);
    return cached;
  }
  const uri = imageOverride ?? getMosaicDataUrl(sessionId);
  const svg = decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
  // This is our own generator's canvas rect, never session metadata or a guess.
  const color = svg.match(/<rect x="-1" y="-1" width="2" height="2" fill="(#[0-9a-f]{6})"\/>/i)?.[1];
  if (!color) throw new Error('Chat mosaic canvas color is missing');
  const inset = svg.replace('width="272" height="272"', 'x="10%" y="10%" width="80%" height="80%" preserveAspectRatio="xMidYMid meet"');
  // No outer viewBox: this viewport follows the chat's actual aspect ratio.
  // Only the nested square art is contained, so the canvas fills every edge.
  const wallpaper = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="' + color + '"/>' + inset + '</svg>';
  const cached = Object.freeze({ color, image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(wallpaper) });
  if (imageOverride === undefined) wallpaperCache.set(sessionId, cached);
  if (wallpaperCache.size > WALLPAPER_CACHE_LIMIT) wallpaperCache.delete(wallpaperCache.keys().next().value);
  return cached;
}

export function chatBackdropCss(sessionId, wallpaper, mosaicSeed = sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  const key = Array.from(sessionId, ch => '\\' + ch.codePointAt(0).toString(16) + ' ').join('');
  const owner = '[data-conversation-content][data-conversation-session="' + key + '"]';
  // rc.3 wraps the scroller in conversation.hero.frame. Do not assume its
  // depth below the canvas; keep the session witness on the owning scroller.
  const scroll = '[data-conversation-scroll]:has(>[data-composer-seat] style[data-cs-composer-image="' + key + '"])';
  // :has() cannot be nested; keep the owner witness a simple descendant path.
  const area = owner + ':has([data-conversation-scroll]>[data-composer-seat] style[data-cs-composer-image="' + key + '"])';
  const { color, image } = wallpaper ?? mosaicWallpaper(mosaicSeed);
  const veil = 'color-mix(in srgb,var(--dsw-alias-bg-base,#171c23) 85%,transparent)';
  return area + '{background-color:' + color + '!important;' +
    'background-image:linear-gradient(' + veil + ',' + veil + ')' + (image ? ',url("' + image + '")' : '') + '!important;' +
    'background-size:100% 100%!important;background-position:center!important;background-repeat:no-repeat!important;}' +
    area + ' ' + scroll + '{background-color:transparent!important;}' +
    // The sticky seat otherwise adds a second, fully opaque theme gradient.
    area + ' ' + scroll + '>[data-composer-seat]{background:transparent!important;}';
}
