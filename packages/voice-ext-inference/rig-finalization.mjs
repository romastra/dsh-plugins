// Pure browser coordination. This module is inlined with the recorder; no DOM
// dependency and no direct calls to Polaris from the browser.
export function createPreviewBarrier() {
  let active;
  let closed = false;
  return {
    pending: () => active !== undefined,
    start(send) {
      if (closed || active) throw new Error('Preview is not admissible');
      const job = Promise.resolve().then(send);
      active = job;
      const clear = () => { if (active === job) active = undefined; };
      void job.then(clear, clear);
      return job;
    },
    async close() {
      closed = true;
      // A preview failure is never a final failure. On normal stop, wait for
      // the last request; do not abort a healthy inference to free the worker.
      await active?.catch(() => {});
    },
  };
}

function isNativeEmpty(error) {
  return error?.status === 502 && error.code === 'native_empty';
}

// These replies describe a terminal job, not a failed upload or a network
// timeout. An explicit retry must not replay the same stored error forever.
const terminalAsrCodes = new Set([
  'native_empty', 'native_http', 'native_protocol', 'native_incomplete', 'native_transport',
  'interrupted', 'worker_unavailable', 'processing_failed', 'result_erased', 'delivery_full', 'cancelled',
]);

export async function splitFinalWav(wav, windowSeconds) {
  const header = await wav.slice(0, 44).arrayBuffer();
  const view = new DataView(header);
  const rate = view.getUint32(24, true);
  const bytes = view.getUint32(40, true);
  // Input is the recorder's own canonical mono PCM16 WAV (not an arbitrary
  // file). Mirror Polaris's fixed windows; do not run a browser VAD or trim.
  if (rate < 8000 || rate > 16000 || !bytes || bytes % 2 || bytes + 44 !== wav.size ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) throw new Error('Invalid final WAV');
  const stride = rate * 2 * windowSeconds;
  if (bytes <= stride) return [wav];
  const windows = [];
  for (let offset = 0; offset < bytes; offset += stride) {
    const size = Math.min(stride, bytes - offset);
    const segmentHeader = header.slice(0);
    const segmentView = new DataView(segmentHeader);
    // The Host requires a minimum 512 bytes. Preserve even a sub-frame tail
    // from the last audio callback; fill only the missing bytes with zeroes.
    const padded = Math.max(512 - 44, size);
    segmentView.setUint32(4, 36 + padded, true);
    segmentView.setUint32(40, padded, true);
    windows.push(new Blob([segmentHeader, wav.slice(44 + offset, 44 + offset + size), new Uint8Array(padded - size)], { type: 'audio/wav' }));
  }
  return windows;
}

export function createFinalTranscription(wav, { send, signal, windowSeconds }) {
  let windows;
  let index = 0;
  let attempt = 0;
  let uncertain = false;
  const transcripts = [];
  const check = () => signal?.throwIfAborted();
  const run = async (body, segment = null) => {
    check();
    try {
      const result = await send(body, { segment, attempt });
      check();
      return String(result?.text ?? '').trim();
    } catch (error) {
      if (terminalAsrCodes.has(error?.code)) attempt += 1;
      throw error;
    }
  };
  return {
    async finish() {
      if (!windows) {
        try {
          return { text: await run(wav), recovered: false, uncertain: false };
        } catch (error) {
          if (!isNativeEmpty(error)) throw error;
          const candidates = await splitFinalWav(wav, windowSeconds);
          if (candidates.length === 1) throw error;
          check();
          windows = candidates;
          attempt = 0;
        }
      }
      // The whole result cannot be delivered if one window produces no text.
      // Re-decode the same PCM in order, retaining each successful delivery in
      // the browser. An unrelated error must not be treated as a quiet window.
      while (index < windows.length) {
        try {
          const text = await run(windows[index], index);
          if (text) transcripts.push(text);
        } catch (error) {
          if (isNativeEmpty(error) || (error?.status === 422 && error.code === 'empty')) uncertain = true;
          else throw error;
        }
        index += 1;
        attempt = 0;
      }
      return { text: transcripts.join(' '), recovered: true, uncertain };
    },
  };
}
