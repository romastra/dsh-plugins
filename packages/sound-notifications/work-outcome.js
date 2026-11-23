// Host-only classification. A normal turn end is not proof that its work is done.
// `null` todos is the shipped projection's known pre-write/cleared value;
// `undefined` means the authoritative projection could not be read.
export function classifyWorkOutcome({ reason, goal, todos }) {
  const goalPhase = goal == null ? null : typeof goal.phase === 'string' ? goal.phase : 'unknown';
  const knownTodos = todos === null || (Array.isArray(todos) && todos.every(todo =>
    todo && typeof todo === 'object' && ['pending', 'in_progress', 'completed'].includes(todo.status)));
  const openTodos = knownTodos ? (todos ?? []).filter(todo => todo.status !== 'completed').length : null;
  return {
    outcome: reason === 'completed' && (goalPhase === null || goalPhase === 'complete') && openTodos === 0 ? 'success' : 'attention',
    goalPhase,
    openTodos,
  };
}
