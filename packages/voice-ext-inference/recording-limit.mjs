// One cap shared by the DSH Host's WAV validation and the browser recorder.
export const RIG_MAX_RECORDING_SECONDS = 240;
// Polaris uses fixed 20s windows for interactive jobs (preview and final).
export const RIG_WINDOW_SECONDS = 20;

export function createRecordingBudget(sampleRate, advertisedSeconds) {
  const configured = Number(advertisedSeconds);
  const seconds = configured > 0 ? Math.min(configured, RIG_MAX_RECORDING_SECONDS) : 120;
  const maxSamples = Math.floor(sampleRate * seconds);
  let count = 0;
  return {
    seconds,
    take(samples) {
      const remaining = maxSamples - count;
      const accepted = samples.length > remaining ? samples.subarray(0, remaining) : samples;
      count += accepted.length;
      return accepted;
    },
    full: () => count >= maxSamples,
  };
}

export function recordingLimitLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
