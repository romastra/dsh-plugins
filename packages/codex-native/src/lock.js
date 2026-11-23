import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_LOCK_BYTES = 4096;
const error = code => { const value = new Error(code); value.code = code; throw value; };

/** Only a verified-dead owner is reclaimable. EPERM and malformed files fail closed. */
function ownerIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (cause) {
    if (cause?.code === 'ESRCH') return false;
    error('CODEX_STATE_ALREADY_OWNED');
  }
}

async function createLock(lockPath) {
  const handle = await open(lockPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    return handle;
  } catch (cause) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw cause;
  }
}

async function readLock(lockPath) {
  let raw;
  try { raw = await readFile(lockPath, 'utf8'); }
  catch { error('CODEX_STATE_ALREADY_OWNED'); }
  if (raw.length > MAX_LOCK_BYTES) error('CODEX_STATE_ALREADY_OWNED');
  let value;
  try { value = JSON.parse(raw); }
  catch { error('CODEX_STATE_ALREADY_OWNED'); }
  if (!value || !Number.isInteger(value.pid) || value.pid < 1) error('CODEX_STATE_ALREADY_OWNED');
  return value.pid;
}

/**
 * Acquire the one per-profile lease. A live owner always wins. If the recorded
 * process is verified dead, retain its lock as an evidence file and atomically
 * replace it; a crash therefore cannot permanently disable the route. A race
 * between two recoverers still leaves exactly one exclusive lock.
 */
export async function acquireOwnerLock(stateDirectory) {
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) error('CODEX_STATE_DIRECTORY_REQUIRED');
  const absolute = resolve(stateDirectory);
  await mkdir(absolute, { recursive: true });
  const lockPath = join(absolute, 'owner.lock');
  let handle, staleLock = null;
  try {
    handle = await createLock(lockPath);
  } catch (cause) {
    if (cause?.code !== 'EEXIST') error('CODEX_STATE_ALREADY_OWNED');
    if (ownerIsAlive(await readLock(lockPath))) error('CODEX_STATE_ALREADY_OWNED');
    const backup = join(absolute, `owner.lock.stale-${Date.now()}-${randomBytes(4).toString('hex')}`);
    try { await rename(lockPath, backup); }
    catch { error('CODEX_STATE_ALREADY_OWNED'); }
    staleLock = backup;
    try { handle = await createLock(lockPath); }
    catch { error('CODEX_STATE_ALREADY_OWNED'); }
  }
  let released = false;
  return {
    path: lockPath,
    staleLock,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath).catch(cause => { if (cause?.code !== 'ENOENT') throw cause; });
    },
  };
}
