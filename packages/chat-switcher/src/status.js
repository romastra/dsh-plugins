// Observation only: a completion-unread flag is not proof of successful work.
export function liveInteractionKind(request) {
  try {
    if (request?.kind === 'approval') return request.answerable === true ? 'approval' : null;
    if ((request?.kind === 'question' || request?.kind === 'plan-review') && request.review === undefined && typeof request.getSnapshot === 'function') {
      const value = request.getSnapshot();
      return value?.closed === false && (value.channel === 'rpc' || value.channel === 'waterfall') ? request.kind : null;
    }
  } catch { /* a disposed interaction is no longer actionable */ }
  return null;
}

export function chatIndicator(item = {}, status, notice) {
  const pending = liveInteractionKind(status?.pendingInteraction);
  if (pending) return { kind: pending, reminderActive: notice?.kind === pending && notice.reminderActive === true };
  if (['approval', 'question', 'plan-review', 'attention', 'completion'].includes(notice?.kind)) {
    return { kind: notice.kind === 'attention' && notice.reason === 'error' ? 'failed' : notice.kind, reminderActive: notice.reminderActive === true };
  }
  if (item.running === true || status?.running === true) return { kind: 'running', reminderActive: false };
  if (status?.completionUnread === true || item.completionUnread === true) return { kind: 'unread', reminderActive: false };
  return { kind: 'idle', reminderActive: false };
}
