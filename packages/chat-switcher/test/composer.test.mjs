import test from 'node:test';
import assert from 'node:assert/strict';
import { composerHasSecondLine, composerHasVerticalScrollbar, composerIdentityCss, composerMenuVisibilityCss, readComposerAppearance } from '../src/composer.js';
import { getMosaicDataUrl } from '../src/mosaic.js';

const rules = css => Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), ([, selector, declarations]) => ({ selector, declarations }));
const action = 'button.GRgSLq_primary[aria-busy]';

test('composer mosaic uses theme-radius geometry without zoom scaling', () => {
  const css = composerIdentityCss('chat-a');
  assert.ok(css.includes('background-image:url("' + getMosaicDataUrl('chat-a') + '")'));
  for (const declaration of ['zoom:1!important','width:calc(var(--dsw-radius-panel) * 0.75 * 5)!important','height:calc(var(--dsw-radius-panel) * 0.75 * 4.4)!important','border-radius:calc(var(--dsw-radius-panel) * 0.75) 0 0 0!important','filter:none!important','box-shadow:none!important','background-size:100% auto!important','visibility:hidden!important','content:none!important']) assert.ok(css.includes(declaration),declaration);
  assert.doesNotMatch(css,/gradient|cs-mosaic-shade|1\.5625|53\.125px/);
  assert.ok(css.includes('button.GRgSLq_primary[aria-busy]'),'auxiliary interrupt button is untouched');
  assert.equal(composerIdentityCss('chat-a'),css);
  assert.notEqual(composerIdentityCss('chat-b'),css);
});

test('native action is out of toolbar height flow and flush with the bottom-right card edge', () => {
  const css = composerIdentityCss('chat-a');
  const main = rules(css).find(rule => rule.selector.endsWith(' ' + action));
  assert.ok(main, 'style the existing native action, not a replacement');
  assert.ok(main.declarations.includes('position:absolute!important;'));
  assert.ok(main.declarations.includes('inset:auto 0 0 auto!important;'));
  assert.ok(main.declarations.includes('zoom:1!important;'));
  assert.ok(main.declarations.includes('margin:0!important;'));
  for (const declaration of ['margin:0!important;', 'transform:none!important;', 'z-index:2!important;']) assert.ok(main.declarations.includes(declaration), declaration);
  assert.doesNotMatch(main.declarations, /(?:^|;)(?:outline|pointer-events|display):/, 'native focus and pointer behavior are not replaced');
  const anchors = rules(css).find(rule => rule.selector.includes('.GRgSLq_row:has('));
  assert.ok(anchors.selector.includes('.GRgSLq_trailing:has('));
  assert.equal(anchors.declarations, 'position:static!important;', 'neither flex group becomes the absolute containing block');
});

test('toolbar reserves image width but no image height and keeps the auxiliary interrupt seat', () => {
  const cssRules = rules(composerIdentityCss('chat-a'));
  const spacer = cssRules.find(rule => rule.selector.endsWith('.GRgSLq_trailing:has(' + action + ')::after'));
  assert.ok(spacer, 'width reservation exists only while the native main action exists');
  for (const declaration of ['content:""!important;', 'display:block!important;', 'flex:0 0 calc(var(--dsw-radius-panel) * 0.75 * 5)!important;', 'width:calc(var(--dsw-radius-panel) * 0.75 * 5)!important;', 'height:0!important;', 'pointer-events:none!important;']) assert.ok(spacer.declarations.includes(declaration), declaration);
  assert.doesNotMatch(spacer.declarations, /(?:^|;)(?:position|gap|margin|padding):/, 'the native flex layout and gaps still separate accessory controls');
  const selectors = cssRules.map(rule => rule.selector).join('\n');
  const actionSelectors = cssRules.filter(rule => rule.selector.includes(action)).map(rule => rule.selector).join('\n');
  assert.doesNotMatch(actionSelectors, /textarea|\[contenteditable|\.GRgSLq_(?:input|scroll)|:disabled|:focus/, 'native action disabled/focus rules are untouched');
  assert.doesNotMatch(selectors, /button\.GRgSLq_primary(?!\[aria-busy\])/, 'the separate interrupt action keeps its native appearance and dimensions');
});

test('opacity eases from half to full on hover and back over half a second', () => {
  const cssRules = rules(composerIdentityCss('chat-a'));
  const main = cssRules.find(rule => rule.selector.endsWith(' ' + action));
  const hover = cssRules.find(rule => rule.selector.endsWith(' ' + action + ':hover'));
  assert.ok(main.declarations.includes('opacity:0.5!important;'));
  assert.ok(main.declarations.includes('transition:opacity 0.5s ease!important;'));
  assert.equal(hover.declarations,'opacity:1!important;');
  assert.equal(cssRules.filter(rule => rule.selector.includes(':hover')).length,1,'only the native main action gets the hover override');
});

test('last paragraph receives the requested inline spacer without bottom padding', () => {
  const css = composerIdentityCss('chat-a');
  const editorRules = rules(css).filter(rule => rule.selector.includes('[data-composer-input]'));
  const spacer = editorRules.find(rule => rule.selector.endsWith('::after'));
  assert.ok(spacer.selector.startsWith('[data-composer-card]:has(style[data-cs-composer-image='),'only this composer is affected');
  assert.ok(spacer.selector.endsWith(' [data-composer-input]>p:last-child:not(:has(>br:last-child))::after'));
  assert.equal(spacer.declarations,'content:"";display:inline-block;width:calc(var(--dsw-radius-panel) * 0.75 * 4.5);');
  assert.doesNotMatch(css,/padding-bottom|:placeholder-shown/,'bottom padding is not reintroduced');
});

test('each bottom margin depends only on its own layout flag in the scoped native composer', () => {
  const css = composerIdentityCss('chat-a');
  const marginRules = rules(css).filter(rule => rule.declarations.includes('margin-bottom:'));
  assert.equal(marginRules.length, 2);
  assert.equal(marginRules[0].declarations, 'margin-bottom:14px!important;');
  assert.ok(marginRules[0].selector.endsWith('[data-cs-composer-multiline])>[data-input-scroll] [data-composer-input]'));
  assert.equal(marginRules[1].declarations, 'margin-bottom:47px!important;');
  assert.ok(marginRules[1].selector.endsWith('[data-cs-composer-scrollbar])>[data-input-scroll]'));
  for (const { selector } of marginRules) {
    assert.ok(selector.startsWith('[data-composer-card]:has(>[data-composer-overlay] style[data-cs-composer-image='));
    assert.doesNotMatch(selector, /:focus|:empty|:only-child/);
  }
});

test('a second laid-out line counts even when only the spacer wraps or the hero field stays at its minimum', () => {
  for (const lineHeight of [20, 24, 25.4, 32]) {
    assert.equal(composerHasSecondLine(0, lineHeight), false, 'absent or hidden paragraph');
    assert.equal(composerHasSecondLine(Math.round(lineHeight), lineHeight), false, 'single line including the caret BR');
    assert.equal(composerHasSecondLine(Math.round(lineHeight) + 5, lineHeight), false, 'a slightly taller inline chip is not a wrap');
    assert.equal(composerHasSecondLine(Math.round(2 * lineHeight), lineHeight), true, 'soft wrap (text or spacer) or a native BR');
    assert.equal(composerHasSecondLine(Math.round(lineHeight), lineHeight, Math.round(lineHeight)), true, 'separate paragraphs, including a blank caret line');
    assert.equal(composerHasSecondLine(Math.round(lineHeight), lineHeight, 0), false, 'empty or hidden extra block with no layout');
  }
  assert.equal(composerHasSecondLine(36, NaN), false, 'unknown line metrics never invent a wrap');
});

test('47px tracks the vertical scroll range, not the gutter width or a horizontal/hidden bar', () => {
  const read = patch => composerHasVerticalScrollbar({ clientHeight: 336, scrollHeight: 337, overflowY: 'auto', scrollbarWidth: 'auto', ...patch });
  assert.equal(read({}), true);
  assert.equal(read({ scrollbarWidth: 'thin' }), true);
  assert.equal(read({ overflowY: 'overlay' }), true);
  assert.equal(read({ scrollHeight: 336 }), false, 'fits exactly');
  assert.equal(read({ scrollHeight: 328 }), false, 'no leftover margin after shortening the draft');
  assert.equal(read({ clientHeight: 0 }), false, 'unmounted or hidden');
  assert.equal(read({ overflowY: 'hidden' }), false);
  assert.equal(read({ overflowY: 'clip' }), false);
  assert.equal(read({ scrollbarWidth: 'none' }), false);
  assert.equal(read({ webkitBar: { display: 'none', width: '5px' } }), false);
  assert.equal(read({ webkitBar: { width: '0px' } }), false);
  assert.equal(read({ webkitBar: { width: '5px' } }), true);
});

test('native rounded card clips the custom-shaped action without imposing a taller editor', () => {
  const css = composerIdentityCss('chat-a');
  const cssRules = rules(css);
  const main = cssRules.find(rule => rule.selector.endsWith(' ' + action));
  assert.ok(main.declarations.includes('border-radius:calc(var(--dsw-radius-panel) * 0.75) 0 0 0!important;'));
  const clipping = cssRules.filter(rule => rule.declarations.includes('overflow:'));
  assert.equal(clipping.length,1);
  assert.ok(clipping[0].selector.startsWith('[data-composer-card]:has(style[data-cs-composer-image='));
  assert.ok(clipping[0].selector.endsWith(':has(' + action + ')'));
  assert.equal(clipping[0].declarations,'overflow:clip!important;overflow-clip-margin:0!important;');
  assert.doesNotMatch(clipping[0].declarations,/border-radius|height|position|display/,'native card geometry is preserved');
  assert.doesNotMatch(css,/min-height:|overflow:hidden|clip-path:/,'no artificial minimum height or new scrolling container');
});

test('trailing BR paragraphs get no spacer or BR-hiding override that could add a blank line', () => {
  const css = composerIdentityCss('chat-a');
  const spacerRules = rules(css).filter(rule => rule.selector.includes('[data-composer-input]') && rule.selector.endsWith('::after'));
  assert.equal(spacerRules.length,1);
  assert.ok(spacerRules[0].selector.includes(':not(:has(>br:last-child))'));
  assert.doesNotMatch(css,/\bbr(?::[\w-]+)*\s*\{/, 'native caret BR is neither removed nor hidden');
});

test('a separate mosaic seed changes only artwork, never the session CSS scope', () => {
  const sessionId = 'chat-a';
  const mosaicSeed = 'private-mosaic-seed';
  const css = composerIdentityCss(sessionId, mosaicSeed);
  const unsalted = composerIdentityCss(sessionId);
  assert.ok(css.includes('background-image:url("' + getMosaicDataUrl(mosaicSeed) + '")'));
  assert.notEqual(css, unsalted);
  assert.deepEqual(rules(css).map(rule => rule.selector), rules(unsalted).map(rule => rule.selector));
  assert.equal(css.includes(mosaicSeed), false);
  assert.equal(composerIdentityCss(sessionId, undefined), unsalted);
  const otherSession = composerIdentityCss('chat-b', mosaicSeed);
  assert.ok(otherSession.includes(getMosaicDataUrl(mosaicSeed)));
  assert.notDeepEqual(rules(otherSession).map(rule => rule.selector), rules(css).map(rule => rule.selector));
});

test('no session means the native action is left alone', () => {
  for (const id of [undefined,null,'',17,{}]) {
    assert.equal(composerIdentityCss(id),'');
    assert.equal(composerIdentityCss(id, 'separate-seed'),'');
  }
});

test('native menu compatibility is session-scoped and changes appearance only while either menu shell exists', () => {
  const css=composerMenuVisibilityCss('chat-a'),items=rules(css);
  assert.equal(items.length,2);
  for(const item of items)assert.ok(item.selector.includes(':has(button.GRgSLq_primary[aria-busy]):has([data-trigger-menu], [data-composer-overlay] input[type="text"][aria-label])'));
  assert.equal(items[0].declarations,'overflow:visible!important;');
  assert.equal(items[1].declarations,'border-bottom-right-radius:var(--dsw-radius-panel)!important;max-height:100%!important;');
  assert.doesNotMatch(css,/opacity|margin|padding|position:|width:|font|pointer-events|display:|outline|z-index/);
  assert.notEqual(css,composerMenuVisibilityCss('chat-b'));
  for(const id of [undefined,null,'',7])assert.equal(composerMenuVisibilityCss(id),'');
  assert.equal(composerMenuVisibilityCss('x"]{};body{display:none}').includes('body{display:none}'),false);
});
test('composer appearance diagnostics read style only and ignore unrelated cards without draft access', () => {
  const button={}, input={get textContent(){throw new Error('draft read');}};
  const marker={hasAttribute:name=>['data-cs-composer-multiline','data-cs-composer-scrollbar'].includes(name)};
  const scroll={querySelector:()=>input,clientHeight:336,scrollHeight:345};
  const card={querySelector(selector){
    if(selector===':scope > [data-composer-overlay] style[data-cs-composer-image]')return marker;
    if(selector===':scope > [data-input-scroll]')return scroll;
    if(selector==='button.GRgSLq_primary[aria-busy]')return button;
    return null;
  }};
  const styles=new Map([[card,{overflowX:'clip',overflowY:'clip'}],[button,{width:'60px',height:'52.8px',borderRadius:'12px 0px 0px',maxHeight:'none',position:'absolute',right:'0px',bottom:'0px',opacity:'0.5',backgroundSize:'100% auto'}],[input,{marginBottom:'14px'}],[scroll,{marginBottom:'47px'}]]);
  const result=readComposerAppearance({querySelectorAll:()=>[card,{querySelector:()=>null}]},{getComputedStyle:node=>styles.get(node)});
  assert.equal(result.length,1);assert.equal(result[0].openMenu,false);assert.equal(result[0].overflowX,'clip');assert.equal(result[0].action.width,'60px');
  assert.equal(result[0].inputMarginBottom,'14px');assert.equal(result[0].inputMultiline,true);
  assert.equal(result[0].scrollMarginBottom,'47px');assert.equal(result[0].scrollHasScrollbar,true);
  assert.equal(result[0].scrollClientHeight,336);assert.equal(result[0].scrollHeight,345);
});

test('arbitrary session IDs are completely escaped in scoped selectors', () => {
  const id = 'x"]{};body{display:none}/*\n😀';
  const css = composerIdentityCss(id);
  assert.ok(css.includes('\\1f600 '));
  assert.equal(css.includes('body{display:none}'),false);
  assert.ok(css.startsWith('[data-composer-card]:has(style[data-cs-composer-image="\\78 '));
  assert.ok(css.includes(getMosaicDataUrl(id)));
});
