"""Regenerate browser fixtures directly from the approved M Python reference.
Run with the bundled Python; never imported by the browser or Node tests.
"""
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'mosaic-lab'))
from generate import HashRandom, demo_ids
from unified import build_scene, make_scene, parameters

ids = demo_ids() + ['', 'abc', 'сессия/東京/🎨', '<script>&"session</script>', 'a' * 257]
records = [build_scene(sid) for sid in ids]
combinations = []
for axes in range(7):
    for count in range(3, 10):
        p, controls = parameters('mosaic-structural-fixture')
        p['axes'] = axes
        p['polygonCount'] = count
        combinations.append(make_scene(p, controls))
streams = []
for sid in ids[-5:]:
    rng = HashRandom(sid, 'fixture/UTF8')
    streams.append({'sessionId': sid, 'domain': 'fixture/UTF8',
                    'words': [str(rng.word()) for _ in range(16)]})
result = {'reference': 'mosaic-lab/unified.py; dsh-unified-mosaic/v1',
          'sourceSha256': {name: hashlib.sha256((ROOT / 'mosaic-lab' / name).read_bytes()).hexdigest()
                           for name in ['unified.py', 'generate.py', 'round2.py', 'verify_round2.py']},
          'records': records, 'combinations': combinations, 'streams': streams}
path = Path(__file__).with_name('mosaic-python.json')
path.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf8')
print(f'{path}: {len(records)} scenes, {len(combinations)} structural combinations, {len(streams)} RNG streams')
