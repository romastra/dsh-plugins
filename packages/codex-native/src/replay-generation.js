import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code) { const error = new Error(code); error.code = code; throw error; }

/**
 * A process owns its runtime lease, not the account's durable replay epoch.
 * ACP borrows the desktop authorization owner's generation READ-ONLY. No token
 * is copied, no epoch is invented, and old/mismatched replay is never relabelled.
 * Omitting the owner directory preserves the original standalone behavior.
 */
export async function bindReplayGeneration(runtime, ownerDirectory) {
  const external = ownerDirectory !== undefined;
  if (external && (typeof ownerDirectory !== 'string' || !isAbsolute(ownerDirectory))) {
    fail('CODEX_REPLAY_OWNER_DIRECTORY_REQUIRED');
  }
  const path = external ? join(resolve(ownerDirectory), 'grant-generation.json') : null;
  const state = { ...runtime, external };
  state.refresh = async () => {
    if (!external) return state.generation;
    let data;
    try {
      const raw = await readFile(path, 'utf8');
      if (raw.length > 256) fail('CODEX_REPLAY_OWNER_INVALID');
      data = JSON.parse(raw);
    } catch { fail('CODEX_REPLAY_OWNER_UNAVAILABLE'); }
    if (data?.version !== 1 || !UUID.test(data.generation ?? '')) fail('CODEX_REPLAY_OWNER_INVALID');
    state.generation = data.generation;
    return state.generation;
  };
  await state.refresh();
  return state;
}
