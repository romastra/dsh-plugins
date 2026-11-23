import test from 'node:test';
import assert from 'node:assert/strict';
import { mosaicWallpaper, chatBackdropCss } from '../src/backdrop.js';
import { buildMosaicScene, getMosaicDataUrl } from '../src/mosaic.js';

test('wallpaper extends exactly the SVG background and contains unchanged art inside ten percent insets', () => {
  for (const id of ['a','b','chat-a','chat-b','Привет 😀','x"{};/*']) {
    const wallpaper=mosaicWallpaper(id);
    assert.equal(wallpaper.color,buildMosaicScene(id).palette[0]);
    const svg=decodeURIComponent(wallpaper.image.slice(wallpaper.image.indexOf(',')+1));
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="'+wallpaper.color+'"/>'));
    const original=decodeURIComponent(getMosaicDataUrl(id).split(',')[1]);
    const inset=original.replace('width="272" height="272"','x="10%" y="10%" width="80%" height="80%" preserveAspectRatio="xMidYMid meet"');
    assert.ok(svg.endsWith(inset+'</svg>'),'all original geometry, defs and masks are retained');
    assert.equal(svg.includes('preserveAspectRatio="none"'),false);
    assert.deepEqual(mosaicWallpaper(id),wallpaper);
  }
});

test('only the canvas background receives the live 85 percent theme veil, never content opacity', () => {
  const css=chatBackdropCss('a');
  assert.ok(css.includes('linear-gradient(color-mix(in srgb,var(--dsw-alias-bg-base,#171c23) 85%,transparent)'));
  assert.ok(css.includes('background-size:100% 100%'));
  assert.ok(css.includes('[data-conversation-session="\\61 "]'));
  assert.ok(css.includes(':has([data-conversation-scroll]>[data-composer-seat] style[data-cs-composer-image="\\61 "])'));
  assert.ok(css.includes('[data-composer-seat]{background:transparent'));
  assert.equal(/(?:^|[;{])opacity:/.test(css),false);
  assert.equal(css.includes('filter:'),false);
  assert.notEqual(chatBackdropCss('b'),css);
});

test('rc.3 hero wrappers may separate canvas and scroller without weakening the session witness', () => {
  const css=chatBackdropCss('a');
  const key='\\61 ';
  const owner='[data-conversation-content][data-conversation-session="'+key+'"]';
  const scroll='[data-conversation-scroll]:has(>[data-composer-seat] style[data-cs-composer-image="'+key+'"])';
  const area=owner+':has([data-conversation-scroll]>[data-composer-seat] style[data-cs-composer-image="'+key+'"])';
  assert.ok(css.startsWith(area+'{'));
  assert.ok(css.includes(area+' '+scroll+'{background-color:transparent'));
  assert.ok(css.includes(area+' '+scroll+'>[data-composer-seat]{background:transparent'));
  assert.equal(css.includes(owner+':has(>[data-conversation-scroll]'),false,'no direct canvas-to-scroll dependency');
  assert.equal(css.includes(area+' [data-conversation-scroll]{'),false,'do not recolor foreign nested scroll regions');
});

test('unbound composer leaves the canvas native and identifiers cannot inject CSS', () => {
  for (const id of ['',null,undefined,1]) assert.equal(chatBackdropCss(id),'');
  const css=chatBackdropCss('x"]{opacity:0}/*');
  assert.equal(css.includes('opacity:0'),false);
});
