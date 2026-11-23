import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composerIdentityCss } from '../src/composer.js';
import { chatBackdropCss } from '../src/backdrop.js';
import { getMosaicDataUrl } from '../src/mosaic.js';

// Evaluate only the pure CSS/art generators of the user's exact reference.
// Never mount React, simulate glyph/layout rendering, or invoke UI operations.
function generators(url) {
  const original = fs.readFileSync(url, 'utf8');
  const tail = "return createPlugin(require('react'));";
  assert.equal(original.split(tail).length, 2, 'one explicit factory export');
  const exposed = original.replace(tail, 'return { composerIdentityCss, chatBackdropCss, getMosaicDataUrl };');
  let definition;
  vm.runInNewContext(exposed, { TextEncoder, TextDecoder, window: { __ModuleLoader__: { load: value => { definition = value; } } } });
  return definition.factory(() => { throw new Error('CSS comparison must not import or run React'); });
}
const reference = generators(new URL('../../chat-switcher-backups/before-bidirectional-menu-1.10.4-client.js', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const deployed = generators(new URL('../' + manifest.exports['./client'].replace(/^\.\//, ''), import.meta.url));
const examples = [['chat-a','chat-a'],['chat-b','salted-mosaic-seed'],['x"\\\n😀','another-seed']];

// The authorized change is limited to the two bottom margins. Their new
// selectors are tested in composer.test.mjs; everything else stays exact.
const withoutBottomSpacing = css => css.replace(/[^{}]+\{margin-bottom:(?:14|47)px!important;\}/g, '');
test('composer source and generated bundle retain the reference CSS except the requested bottom margins',()=>{
  for(const [id,seed] of examples){
    const expected=withoutBottomSpacing(reference.composerIdentityCss(id,seed));
    const actual=composerIdentityCss(id,seed);
    assert.equal(withoutBottomSpacing(actual),expected);
    assert.equal(deployed.composerIdentityCss(id,seed),actual);
    assert.equal(actual.match(/margin-bottom:14px!important;/g)?.length,1);
    assert.equal(actual.match(/margin-bottom:47px!important;/g)?.length,1);
  }
});
test('composer backdrop/seat styling retains the exact reference, with or without supplied wallpaper',()=>{
  for(const [id,seed] of examples)for(const wallpaper of [undefined,{color:'#123456',image:'data:image/png;base64,fixture'}]){
    const expected=reference.chatBackdropCss(id,wallpaper,seed);
    assert.equal(chatBackdropCss(id,wallpaper,seed),expected);
    assert.equal(deployed.chatBackdropCss(id,wallpaper,seed),expected);
  }
});
test('the send-button mosaic generator still emits the reference artwork for the same seed',()=>{
  for(const [,seed]of examples){assert.equal(getMosaicDataUrl(seed),reference.getMosaicDataUrl(seed));assert.equal(deployed.getMosaicDataUrl(seed),reference.getMosaicDataUrl(seed));}
});
