import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('quota fallback stays inline in its own native dock when optional stats marker is absent',async()=>{const s=await readFile(new URL('../src/client.js',import.meta.url),'utf8');assert.ok(!s.includes('[data-composer-dock]:has(.cn-usage)'));assert.ok(s.includes("'data-composer-stat': 'codex-native'"));assert.ok(s.includes("ReactDOM.createPortal(badge, target)"));assert.ok(!s.includes("document.querySelector('[data-composer-stats]')"));});
