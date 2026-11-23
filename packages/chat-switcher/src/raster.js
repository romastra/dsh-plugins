import { getMosaicCanvasColor } from './mosaic.js';
import { waitForMosaicArt, getMosaicArtStore } from './art-store.js';
import { mosaicWallpaper } from './backdrop.js';

// Intentionally independent of viewport size, devicePixelRatio and theme.
// Lossless PNG preserves the exact canvas color; only background edges soften.
const RASTER_WALLPAPER_SIZE = 512;
const RASTER_CACHE_LIMIT = 16;
const rasterWallpaperCache = new Map();
const activeRasterStores = new Map();
const pendingRasterStores = new Map();
const queuedRasterStores = new Set();
let rasterJobRunning = false;

function retainRasterStore(sessionId, store) {
  rasterWallpaperCache.delete(sessionId); rasterWallpaperCache.set(sessionId, store);
  if (rasterWallpaperCache.size > RASTER_CACHE_LIMIT) rasterWallpaperCache.delete(rasterWallpaperCache.keys().next().value);
}
function drainRasterQueue() {
  if (rasterJobRunning || !queuedRasterStores.size) return;
  const store = queuedRasterStores.values().next().value;
  queuedRasterStores.delete(store); rasterJobRunning = true;
  const release = () => { rasterJobRunning = false; drainRasterQueue(); };
  Promise.resolve(store.run()).then(release, release);
}
function checkRasterNeeded(needed) {
  if (!needed()) { const error = new Error('Background no longer visible'); error.name = 'AbortError'; throw error; }
}
const emptyWallpaperStore = { getSnapshot: () => null, subscribe: () => () => {} };

export async function prepareRasterWallpaper(sessionId, environment = globalThis, needed = () => true) {
  checkRasterNeeded(needed);
  const color = getMosaicCanvasColor(sessionId);
  const uri = await waitForMosaicArt(sessionId, environment, needed);
  checkRasterNeeded(needed);
  if (!uri) throw new Error('Hybrid mosaic render unavailable');
  const image = new environment.Image(RASTER_WALLPAPER_SIZE, RASTER_WALLPAPER_SIZE);
  image.src = uri;
  await image.decode();
  checkRasterNeeded(needed); // departed chats never reach drawImage/PNG encoding
  const canvas = environment.document.createElement('canvas');
  canvas.width = canvas.height = RASTER_WALLPAPER_SIZE;
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    if (!png.startsWith('data:image/png;base64,')) throw new Error('PNG encoding failed');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="' + color + '"/><image x="10%" y="10%" width="80%" height="80%" preserveAspectRatio="xMidYMid meet" href="' + png + '"/></svg>';
    return Object.freeze({ color, image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), kind: 'raster', resolution: RASTER_WALLPAPER_SIZE });
  } finally {
    // Do not keep a GPU/CPU canvas allocation per cache entry.
    canvas.width = canvas.height = 0;
  }
}

/** One lazy, shared external store per cached chat; late work cannot paint a new chat. */
export function getRasterWallpaperStore(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return emptyWallpaperStore;
  const existing = activeRasterStores.get(sessionId) ?? pendingRasterStores.get(sessionId) ?? rasterWallpaperCache.get(sessionId);
  if (existing) { retainRasterStore(sessionId, existing); return existing; }
  const color = getMosaicCanvasColor(sessionId);
  // First paint is a solid, correctly blended canvas, never a full-size vector.
  let snapshot = Object.freeze({ color, image: '', kind: 'pending' });
  let started = false;
  const listeners = new Set();
  const store = {
    getSnapshot: () => snapshot,
    async run() {
      let next;
      try {
        if (!listeners.size) { started = false; return; }
        next = await prepareRasterWallpaper(sessionId, globalThis, () => listeners.size > 0);
        if (!listeners.size) { started = false; return; }
      } catch (error) {
        started = false;
        if (!listeners.size || error?.name === 'AbortError') return;
        next = Object.freeze({ ...mosaicWallpaper(sessionId, getMosaicArtStore(sessionId).getSnapshot().uri), kind: 'vector-fallback' });
        // A later mount can retry a transient decode/encoding failure.
      } finally {
        if (pendingRasterStores.get(sessionId) === store) pendingRasterStores.delete(sessionId);
      }
      snapshot = next;
      retainRasterStore(sessionId, store);
      for (const notify of [...listeners]) notify();
    },
    subscribe(listener) {
      listeners.add(listener); activeRasterStores.set(sessionId, store);
      if (!started) {
        started = true;
        pendingRasterStores.set(sessionId, store); queuedRasterStores.add(store);
        drainRasterQueue();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          if (activeRasterStores.get(sessionId) === store) activeRasterStores.delete(sessionId);
          if (queuedRasterStores.delete(store)) {
            started = false;
            if (pendingRasterStores.get(sessionId) === store) pendingRasterStores.delete(sessionId);
          }
        }
      };
    },
  };
  retainRasterStore(sessionId, store);
  return store;
}
