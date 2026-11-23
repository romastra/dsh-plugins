/** Order an already-filtered candidate list by MRU; preserve unvisited input order. */
export function orderCandidates(items, visits) {
  const candidates = new Map();
  for (const item of items) {
    if (!candidates.has(item.id)) candidates.set(item.id, item);
  }
  const ordered = [];
  for (const id of visits) {
    if (!candidates.has(id)) continue;
    ordered.push(candidates.get(id));
    candidates.delete(id);
  }
  return [...ordered, ...candidates.values()];
}

/** Legacy strict pinned-only ordering. */
export function orderPinned(items, visits) {
  return orderCandidates(items.filter(item => item.pinned === true), visits);
}

/** Return a new, deduplicated history with this visit first. */
export function visit(history, id) {
  return [...new Set([id, ...history])];
}

/**
 * Pure hold/browse controller: no DOM, storage, navigation, or MRU writes.
 * getItems supplies eligible items in MRU order. Each cycle freezes that
 * order until release/abort; reconcile only removes items, never adds/reorders.
 * changed receives detached { items, index, visible, mode, keyboardSelection }
 * snapshots, or null on end. An unselected browse keeps its index internal only.
 */
export function createSwitcher({
  getItems,
  getCurrent,
  commit,
  beforeCommit = () => null,
  changed,
  delay = () => 250,
  later = setTimeout,
  cancel = clearTimeout,
}) {
  let cycle = null;
  let timer = null;

  function snapshot() {
    return cycle && {
      items: cycle.items.slice(),
      index: cycle.index,
      visible: cycle.visible,
      mode: cycle.mode,
      keyboardSelection: cycle.keyboardSelection,
    };
  }

  function publish() {
    const value = snapshot();
    changed(value);
    return value;
  }

  function clear() {
    if (timer !== null) cancel(timer);
    timer = null;
    cycle = null;
  }

  function abort() {
    if (!cycle) return;
    clear();
    changed(null);
  }

  function move(step) {
    if (!cycle) return null;
    const count = cycle.items.length;
    // The first arrow starts at an edge, not at the invisible browse cursor.
    cycle.index = cycle.keyboardSelection
      ? (cycle.index + step % count + count) % count
      : (step < 0 ? count - 1 : 0);
    cycle.keyboardSelection = true;
    return publish();
  }

  function select(index) {
    if (!cycle) return null;
    cycle.index = Math.max(0, Math.min(index, cycle.items.length - 1));
    cycle.keyboardSelection = true;
    return publish();
  }

  function indexAfterCurrent(items, reverse) {
    const currentIndex = items.findIndex(item => item.id === getCurrent());
    return currentIndex < 0
      ? (reverse ? items.length - 1 : 0)
      : (currentIndex + (reverse ? -1 : 1) + items.length) % items.length;
  }

  function begin(mode, reverse = false) {
    const items = [...new Map(getItems().map(item => [item.id, item])).values()];
    if (!items.length) return false;
    cycle = {
      items,
      index: indexAfterCurrent(items, reverse),
      visible: mode === 'browse',
      mode,
      keyboardSelection: mode === 'hold',
    };
    return true;
  }

  // A pull opens the same frozen cards immediately without a keyboard selection.
  // Releasing the finger (or an unrelated Control key) must never commit a card.
  function browse({ pointer = false } = {}) {
    if (cycle) {
      if (!pointer) return snapshot();
      if (timer !== null) cancel(timer);
      timer = null;
      cycle.mode = 'browse'; cycle.visible = true; cycle.keyboardSelection = false;
      return publish();
    }
    return begin('browse') ? publish() : null;
  }

  function next(reverse = false) {
    if (cycle) {
      cycle.mode = 'hold';
      if (!cycle.keyboardSelection) {
        // Browse's internal cursor is not a selection: start from actual current.
        cycle.index = indexAfterCurrent(cycle.items, reverse);
        cycle.keyboardSelection = true;
        return publish();
      }
      return move(reverse ? -1 : 1);
    }
    if (!begin('hold', reverse)) return null;
    const started = cycle;
    const milliseconds = delay();
    timer = later(() => {
      // Ignore a stale callback even if a custom scheduler already dequeued it.
      if (cycle !== started) return;
      timer = null;
      cycle.visible = true;
      publish();
    }, Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : 250);
    return publish();
  }

  function release() {
    if (!cycle || (cycle.mode === 'browse' && !cycle.keyboardSelection)) return;
    const id = cycle.items[cycle.index].id;
    const eligible = getItems().some(item => item.id === id);
    let prepared = null;
    // Presentation may snapshot its own visible card BEFORE clear unmounts it.
    // A failed/missing visual must never delay or prevent the ordinary commit.
    if (eligible && cycle.visible) { try { prepared = beforeCommit(id, snapshot()); } catch { /* Optional visual only. */ } }
    clear();
    changed(null);
    if (eligible) commit(id, prepared);
  }

  function reconcile() {
    if (!cycle) return null;
    const eligible = new Set(getItems().map(item => item.id));
    const selected = cycle.items[cycle.index].id;
    const remaining = cycle.items.filter(item => eligible.has(item.id));
    if (!remaining.length) {
      abort();
      return null;
    }
    const selectedIndex = remaining.findIndex(item => item.id === selected);
    // If selection disappeared, keep its slot (or the final remaining slot).
    cycle.index = selectedIndex < 0
      ? Math.min(cycle.index, remaining.length - 1)
      : selectedIndex;
    cycle.items = remaining;
    return publish();
  }

  return { next, browse, move, select, release, abort, reconcile };
}
