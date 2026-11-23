import { chatIndicator } from './status.js';
import { readWorkspaceMembership } from './card-meta.js';

// No session retain, history request, transcript render, or acknowledgement here.

// The controller catalog also contains projected/retained subagent rows.
// Only root chats are switchable, regardless of pin, activity or attention.
function isMainChat(row) {
  return row.origin !== 'subagent' && row.parentId == null;
}

/** Metadata-only union of openable pinned, working, and attention-bearing root chats. */
export function readCandidates(sessions, workspaces, statusMap = new Map(), attentionMap = new Map(), currentId = null, recentIds = new Set()) {
  const list = sessions.list.getSnapshot();
  const workspace = workspaces.list.getSnapshot();
  const pinned = new Set(workspace.pinnedSessionIds ?? []);
  const archived = new Set(workspace.archivedSessionIds ?? []);
  const ids = new Set([...pinned, ...(list.ids ?? []), ...Object.keys(list.byId)]);
  const candidates = [];
  for (const id of ids) {
    const row = list.byId[id];
    // Archived sessions cannot stay open: navigation clears their main view.
    // Never silently restore one merely because its status/notice is still live.
    if (!row || !isMainChat(row) || archived.has(id)) continue;
    const status = statusMap.get(id);
    const notice = attentionMap.get(id);
    // Use the same live facts as the card, not catalog presence, retention or MRU.
    // Idle rows need an explicit current/last-hour witness, never old MRU alone.
    if (id === currentId || recentIds.has(id) || pinned.has(id) || chatIndicator(row, status, notice).kind !== 'idle') {
      candidates.push({ ...row, workspaceId: readWorkspaceMembership(workspace, id).workspaceId, pinned: pinned.has(id), eligible: true });
    }
  }
  return candidates;
}

export function readPinned(sessions, workspaces) {
  const list = sessions.list.getSnapshot();
  const workspace = workspaces.list.getSnapshot();
  const archived = new Set(workspace.archivedSessionIds ?? []);
  return (workspace.pinnedSessionIds ?? []).flatMap(id => {
    const row = list.byId[id];
    return row && isMainChat(row) && !archived.has(id) ? [{ ...row, pinned: true }] : [];
  });
}
export function currentSession(sessions) {
  const list = sessions.list.getSnapshot();
  return Object.values(list.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null;
}
export function isSwitchKey(event) {
  return (event.code === 'Tab' || event.key === 'Tab') && event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing;
}
// Keep keydown and keyup in one ordered DOM stream. Native shortcut IPC is
// keydown-only and may arrive after the DOM Control keyup on a quick tap.
export function bindKeys({ target, document, enabled, controller, hasCycle, getMode = () => 'hold' }) {
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = event => {
    // Browse mode also exists in ordinary phone/Web pages. Escape is local to
    // our dialog; Tab and Enter on its native Close button keep their defaults.
    if (hasCycle() && getMode() === 'browse' && event.key === 'Escape') {
      consume(event); controller.abort(); return;
    }
    if (!enabled()) return;
    if (isSwitchKey(event)) {
      if (!hasCycle() && document.querySelector('dialog[open]:not([data-chat-switcher]),[aria-modal="true"]:not([data-chat-switcher])')) return;
      consume(event);
      if (!event.repeat) controller.next(event.shiftKey);
    } else if (hasCycle() && getMode() === 'hold') {
      if (event.key === 'Escape') { consume(event); controller.abort(); }
      else if (event.key === 'Enter') { consume(event); controller.release(); }
      else if (!['Control', 'Shift', 'Tab'].includes(event.key)) { consume(event); controller.abort(); }
    }
  };
  const up = event => {
    if (hasCycle() && getMode() === 'hold' && !event.ctrlKey) { consume(event); controller.release(); }
  };
  const blur = () => controller.abort();
  const visibility = () => { if (document.visibilityState === 'hidden') controller.abort(); };
  target.addEventListener('keydown', down, true);
  target.addEventListener('keyup', up, true);
  target.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    target.removeEventListener('keydown', down, true);
    target.removeEventListener('keyup', up, true);
    target.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
    controller.abort();
  };
}
