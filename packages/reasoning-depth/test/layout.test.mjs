import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
// Source-contract checks only: these do not claim to measure browser geometry.
test('white high-contrast stops and thumb keep blue outlines', () => {
  assert.match(source, /--rds-white:var\(--dsw-static-white, #fff\)/);
  for (const pseudo of ['webkit-slider-thumb', 'moz-range-thumb']) {
    const rule = source.match(new RegExp('\\.rds-input::-' + pseudo + ' \\{([^}]+)\\}'))?.[1];
    assert.ok(rule);
    assert.match(rule, /background:var\(--rds-white\)/);
    assert.match(rule, /border:2px solid var\(--rds-blue\)/);
  }
  assert.match(source, /\.rds-stop \{[^}]*background:var\(--rds-white\); opacity:1;/);
});
test('blank-session slider uses shared directory and a separate Hero contribution', () => {
  assert.match(source, /function HeroDock\(props\)/);
  assert.match(source, /session\.blank && !session\.removed && session\.subagent === null/);
  assert.match(source, /id: 'reasoning-depth-hero-1\.0\.6'/);
  assert.match(source, /className: 'rds-hero'[^\n]*h\(Dock, props\)/);
  assert.match(source, /\.rds-hero \{ order:100;/);
  assert.match(source, /:has\(\[data-composer-dock\] \.rds-wrap\) > \.rds-hero \{ display:none; \}/);
});
test('value sizing reserves all model labels, not only the changing selected label', () => {
  assert.match(source, /className: 'rds-value rds-value-size', 'aria-hidden': true/);
  assert.match(source, /\.\.\.view\.choices\.map\(choice => h\('span', \{ key: choice\.id \?\? 'provider-default' \}, choice\.name\)\)/);
  assert.match(source, /\.rds-value-wrap \{ display:grid; grid-template-areas:"value";/);
  assert.match(source, /\.rds-value \{ grid-area:value;/);
  assert.match(source, /\.rds-value-size > span \{ grid-area:1 \/ 1;/);
});
test('hidden sizing labels retain layout but are neither visible nor interactive', () => {
  assert.match(source, /\.rds-value-size \{ display:grid; visibility:hidden; pointer-events:none; user-select:none; \}/);
  assert.match(source, /max-width:132px;/);
  assert.match(source, /max-width:92px;/);
  assert.match(source, /className: 'rds-value', htmlFor: id, title: current\.description \?\? current\.name/);
});
