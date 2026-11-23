export const MICROPHONE_PREFERENCE_KEY = 'local-parakeet.microphone.v1';

function isPhysicalInput(id) {
  // Chromium's default and communications entries are OS aliases, not pins.
  return typeof id === 'string' && id.length > 0 && id !== 'default' && id !== 'communications';
}

export function microphoneCatalog(entries) {
  const devices = new Map();
  let defaultLabel = '';
  let hidden = false;
  for (const { kind, deviceId, label } of entries) {
    if (kind !== 'audioinput') continue;
    const name = label?.trim() || '';
    if (deviceId === 'default') { defaultLabel = name; hidden ||= !name; continue; }
    if (deviceId === 'communications') continue;
    if (!isPhysicalInput(deviceId) || !name) { hidden = true; continue; }
    if (!devices.has(deviceId)) devices.set(deviceId, name);
  }
  const counts = new Map();
  const positions = new Map();
  for (const name of devices.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const inputs = [...devices].map(([id, name]) => {
    if (counts.get(name) === 1) return { id, label: name };
    const index = (positions.get(name) ?? 0) + 1;
    positions.set(name, index);
    return { id, label: `${name} (${index})` };
  });
  return { inputs, defaultLabel, hidden };
}

function microphoneCaptureError(error, pinned) {
  switch (error?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return 'error.micDenied';
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': case 'ConstraintNotSatisfiedError':
      return pinned ? 'error.micSelectedMissing' : 'error.micMissing';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError':
      return 'error.micBusy';
    default:
      return 'error.micOpen';
  }
}

function stopMicrophoneTracks(stream) {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* Already stopped. */ }
  }
}

export async function openMicrophone(media, preference) {
  if (typeof media?.getUserMedia !== 'function') throw new Error('error.micUnsupported');
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const id = preference?.id;
  if (preference != null) {
    if (!isPhysicalInput(id) || (typeof media.getSupportedConstraints === 'function' && !media.getSupportedConstraints().deviceId)) {
      throw new Error('error.micPinUnsupported');
    }
    audio.deviceId = { exact: id };
  }
  let stream;
  try {
    stream = await media.getUserMedia({ audio });
  } catch (error) {
    // Never retry a failed exact constraint with the system default.
    throw new Error(microphoneCaptureError(error, Boolean(id)));
  }
  try {
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error(id ? 'error.micSelectedMissing' : 'error.micMissing');
    if (id) {
      const actualId = track.getSettings?.()?.deviceId;
      if (!actualId) throw new Error('error.micPinUnsupported');
      if (actualId !== id) throw new Error('error.micPinMismatch');
    }
    return { stream, label: track.label?.trim() || '' };
  } catch (error) {
    stopMicrophoneTracks(stream);
    throw error;
  }
}

function enumerateWhileAllowed(media, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cancel = () => finish(reject, new Error('cancelled'));
    const timer = setTimeout(() => finish(reject, new Error('error.micList')), timeoutMs);
    function finish(settle, value) {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      settle(value);
    }
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      if (!signal.aborted) return media.enumerateDevices();
    }).then(entries => finish(resolve, entries), () => finish(reject, new Error('error.micList')));
  });
}

export function createMicrophoneSelection(media, getStorage, { probeTimeoutMs = 2500 } = {}) {
  const listeners = new Set();
  const enumerable = typeof media?.enumerateDevices === 'function';
  const canReveal = enumerable && typeof media?.getUserMedia === 'function';
  const empty = microphoneCatalog([]);
  let state = { preference: null, storageFailed: false, catalog: empty, status: 'idle', revealing: false, revealError: '' };
  let readSequence = 0;
  let probe = null;
  let disposed = false;
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function loadPreference() {
    try {
      const stored = getStorage().getItem(MICROPHONE_PREFERENCE_KEY);
      let parsed;
      try { parsed = stored && JSON.parse(stored); } catch { /* Ignore an obsolete value. */ }
      publish({ preference: isPhysicalInput(parsed?.id) && typeof parsed.label === 'string' ? { id: parsed.id, label: parsed.label } : null });
    } catch { /* The in-memory choice remains usable even if storage is blocked. */ }
  }
  loadPreference();

  async function refresh() {
    if (disposed || probe) return;
    const sequence = ++readSequence;
    if (!enumerable) { publish({ status: 'unsupported' }); return; }
    if (state.status !== 'ready') publish({ status: 'loading' });
    try {
      const catalog = microphoneCatalog(await media.enumerateDevices());
      if (sequence === readSequence && !disposed) publish({ catalog, status: 'ready' });
    } catch {
      if (sequence === readSequence && !disposed) publish({ catalog: empty, status: 'error' });
    }
  }

  async function reveal(owner) {
    if (disposed || probe || !canReveal) return;
    const run = { owner, abort: new AbortController() };
    probe = run;
    ++readSequence;
    publish({ revealing: true, revealError: '' });
    let stream;
    try {
      // The user explicitly requested device names. No audio samples are read or sent.
      try { stream = await media.getUserMedia({ audio: true }); }
      catch (error) { throw new Error(microphoneCaptureError(error, false)); }
      if (run.abort.signal.aborted) return;
      const catalog = microphoneCatalog(await enumerateWhileAllowed(media, run.abort.signal, probeTimeoutMs));
      if (probe === run) publish({ catalog, status: 'ready', revealError: catalog.inputs.length ? '' : 'mic.namesUnavailable' });
    } catch (error) {
      if (probe === run) publish({ revealError: error.message });
    } finally {
      stopMicrophoneTracks(stream);
      if (probe === run) { probe = null; publish({ revealing: false }); }
    }
  }

  function cancelReveal(owner) {
    if (!probe || probe.owner !== owner) return;
    const run = probe;
    probe = null;
    run.abort.abort();
    publish({ revealing: false, status: state.status === 'loading' ? 'idle' : state.status });
  }

  function select(id) {
    if (disposed) return false;
    const preference = id === null ? null : state.catalog.inputs.find(input => input.id === id);
    if (preference === undefined) return false;
    let storageFailed = false;
    try {
      const storage = getStorage();
      if (preference) storage.setItem(MICROPHONE_PREFERENCE_KEY, JSON.stringify(preference));
      else storage.removeItem(MICROPHONE_PREFERENCE_KEY);
    } catch { storageFailed = true; }
    publish({ preference, storageFailed, revealError: '' });
    return true;
  }

  return {
    canReveal,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    loadPreference, refresh, reveal, cancelReveal, select,
    dispose() {
      disposed = true;
      listeners.clear();
      probe?.abort.abort();
      probe = null;
    },
  };
}
