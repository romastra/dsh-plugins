const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical membership only; neither raw Session fields nor paths/titles identify a Workspace. */
export function readWorkspaceMembership(workspaceSnapshot, id) {
  if (typeof id !== 'string' || !id) return { workspaceId: null, workspaceTitle: null };
  const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];
  for (const workspace of items) {
    if (!isRecord(workspace) || !Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(id)) continue;
    // Native array order wins, even when the first matching id/title is unavailable.
    return {
      workspaceId: typeof workspace.workspaceId === 'string' && workspace.workspaceId.length > 0 ? workspace.workspaceId : null,
      workspaceTitle: typeof workspace.title === 'string' ? workspace.title.trim() || null : null,
    };
  }
  return { workspaceId: null, workspaceTitle: null };
}

function cardGoalCaption(value) {
  // Native `goal` wire view is the latest retained goal, NOT checkpoint.current
  // or a goal on another chat/ancestor. Clearing it must not revive old history.
  if (!isRecord(value) || !isRecord(value.goal)) return null;
  const goal = value.goal;
  if (!['active', 'paused', 'blocked', 'complete'].includes(goal.phase)) return null;
  return typeof goal.objective === 'string' ? goal.objective.trim() || null : null;
}

function activeTask(projection) {
  if (!isRecord(projection) || !isRecord(projection.values)) return null;
  const todos = projection.values.todos;
  // Keep the legacy presentation field name; a missing/empty TODO list may now
  // display the same-session goal. Nonempty and corrupt lists do not fall back.
  if (todos == null || (Array.isArray(todos) && todos.length === 0)) return cardGoalCaption(projection.values.goal);
  if (!Array.isArray(todos)) return null;
  for (const item of todos) {
    if (!isRecord(item) || typeof item.content !== 'string'
      || !['pending', 'in_progress', 'completed'].includes(item.status)) return null;
    // Never skip a malformed/empty first active task in favor of a later one.
    if (item.status === 'in_progress') return item.content.trim() || null;
  }
  return null;
}

/** Read candidate-only card labels from existing native snapshots; no I/O or retention. */
export function readCardMeta(sessionSnapshot, workspaceSnapshot,
  ids = Object.keys(isRecord(sessionSnapshot?.byId) ? sessionSnapshot.byId : {})) {
  const result = new Map();
  if (!Array.isArray(ids)) return result;
  const byId = isRecord(sessionSnapshot?.byId) ? sessionSnapshot.byId : null;
  const projections = isRecord(sessionSnapshot?.projectionsBySession) ? sessionSnapshot.projectionsBySession : null;
  for (const id of ids) {
    const metadata = { workspaceId: null, workspaceTitle: null, activeTask: null };
    if (typeof id === 'string' && byId && Object.hasOwn(byId, id) && isRecord(byId[id])) {
      Object.assign(metadata, readWorkspaceMembership(workspaceSnapshot, id));
      if (projections && Object.hasOwn(projections, id)) metadata.activeTask = activeTask(projections[id]);
    }
    result.set(id, metadata);
  }
  return result;
}
