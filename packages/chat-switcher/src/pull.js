// Horizontal touch gestures on our own Conversation frame/dialog. Native
// taps, vertical scrolling, editing, pinch and direct-manipulation controls stay native.
const PULL_CONTROLS = 'input,textarea,select,[role="slider"],[role="scrollbar"],[role="spinbutton"],[role="combobox"],[role="switch"],[role="checkbox"],[role="radio"],[role="menu"],[role="menubar"],[data-chat-switcher-no-swipe]';
const PULL_TEXT = '[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const PULL_COMPOSER = '[data-composer-seat],[data-conversation-region="composer"]';
const PULL_FOREIGN = '[role="listbox"],dialog,[aria-modal="true"],[data-slot="tool.view.cordis"]';
const PULL_EDITING = PULL_CONTROLS + ',' + PULL_TEXT;
const PULL_COMPOSER_BUTTONS = 'button,a[href],summary,[role="button"]';
const PULL_MODAL = 'dialog[open]:not([data-chat-switcher]),[aria-modal="true"]:not([data-chat-switcher])';
export const PULL_THRESHOLD = 80;
export const PULL_EDITOR_INTENT_MS = 300;

/** Clickable message content is not a gesture owner: a tap remains untouched,
 * while a claimed drag suppresses its compatibility click instead of invoking it.
 * Do not maintain widget-specific allowlists for files, disclosures or images. */

function nativeComposer(nodes) {
  const cardIndex = nodes.findIndex(node => node?.hasAttribute?.('data-composer-card'));
  const seatIndex = nodes.findIndex(node => node?.hasAttribute?.('data-composer-seat'));
  if (cardIndex < 0 || seatIndex <= cardIndex) return null;
  if (cardIndex !== 0 && !nodes.slice(0, cardIndex).some(node => node?.hasAttribute?.('data-input-scroll'))) return null;
  const card = nodes[cardIndex], seat = nodes[seatIndex];
  const input = card.querySelector?.('[data-composer-input]');
  if (!input || input.closest?.('[data-composer-card]') !== card || input.closest?.('[data-composer-seat]') !== seat) return null;
  return { card, seat, input };
}
function chatAdmission(scroller, body, target, sessionId, composer = null) {
  if (!sessionId && !composer) return 'no-current-chat';
  if (scroller.isConnected === false) return 'detached';
  if (scroller.closest('[data-cs-pull-frame]') !== target) return 'nested-frame';
  if (!body || (body.dataset.conversationSession || null) !== (sessionId || null)) return 'other-session';
  if (composer) {
    const { card, seat, input } = composer;
    if (target.closest?.('[data-rightbar-col]')) return 'embedded-composer';
    if (card.isConnected === false || input.isConnected === false || card.closest?.('[data-composer-seat]') !== seat
      || input.closest?.('[data-composer-card]') !== card || seat.closest?.('[data-conversation-scroll]') !== scroller) return 'changed-composer';
    if (body.dataset.contentPhase === 'hero') return null;
  }
  if (body.dataset.contentPhase !== 'active') return 'not-active';
  const chat = scroller.querySelector('[data-slot="conversation.chat.flow"]');
  if (!chat || chat.closest('[data-conversation-scroll]') !== scroller || chat.closest('[data-conversation-content]') !== body) return 'not-chat-view';
  // Only the native composer is an extra surface, not takeover forms or other Views.
  return null;
}

/** Resolve the owning Chat from the event path, at ANY vertical scroll position. */
export function pullContext(event, target, view, sessionId, rejected = () => {}) {
  const reject = reason => { rejected(reason); return null; };
  const path = event.composedPath();
  const boundary = path.indexOf(target);
  if (boundary < 0) return reject('outside-frame');
  const inside = path.slice(0, boundary);
  const index = inside.findIndex(node => node?.hasAttribute?.('data-conversation-scroll'));
  if (index < 0) return reject('no-scroll-owner');
  const scroller = inside[index], body = scroller.closest('[data-conversation-content]');
  const nodes = inside.slice(0, index), composer = nativeComposer(nodes);
  const reason = chatAdmission(scroller, body, target, sessionId, composer);
  if (reason) return reject(reason);
  for (const node of nodes) {
    if (node?.matches?.(PULL_CONTROLS + ',' + PULL_FOREIGN)) return reject('interactive');
    if (node?.matches?.(PULL_TEXT) && node !== composer?.input) return reject('interactive');
    if (node?.matches?.(PULL_COMPOSER) && node !== composer?.seat) return reject('interactive');
    if (composer && node?.matches?.(PULL_COMPOSER_BUTTONS)) return reject('composer-control');
    if (!node?.matches || node.scrollWidth <= node.clientWidth + 1) continue;
    const style = view.getComputedStyle(node);
    // display:contents slot anchors have no layout box: their dimensions are
    // NOT evidence that they own overflow. Respect only real horizontal panes.
    if (style.display !== 'contents' && /^(auto|scroll|overlay)$/.test(style.overflowX)) return reject('horizontal-pane');
  }
  return { scroller, body, sessionId, composer };
}

// One contact machine per receiver. Choose its physical direction/action only
// after dominant horizontal slop; a captured contact never changes its intent.
function bindHorizontalTouch({ target, eventTarget = target, document, view, choose, admit, valid, beforeComplete = () => undefined, complete, changed, subscribe = () => () => {}, trace = () => {} }) {
  let gesture = null, consumedId = null, feedback = false;
  const slop = 6;
  const stamp = event => {
    const value = event.timeStamp ?? view.performance?.now?.() ?? Date.now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const reset = reason => {
    if (gesture && reason) trace({ phase: 'cancel', reason });
    gesture = null;
    if (feedback) { feedback = false; changed(null); }
  };
  const allowed = () => {
    if (document.visibilityState === 'hidden') return 'hidden';
    if ((view.visualViewport?.scale ?? 1) > 1.01) return 'pinch-zoom';
    if (document.getSelection?.()?.isCollapsed === false) return 'text-selection';
    if (document.querySelector(PULL_MODAL)) return 'other-modal';
    return null;
  };
  const check = () => allowed() || valid(gesture);
  const start = event => {
    // A fresh single contact cannot inherit click suppression from a cancelled
    // contact. A second finger must leave the first claimed contact consumed.
    if (event.touches.length === 1) consumedId = null;
    reset('new-contact');
    trace({ phase: 'start', reason: 'received' });
    const reason = event.defaultPrevented ? 'already-consumed' : event.touches.length !== 1 ? 'multi-touch' : allowed();
    if (reason) { trace({ phase: 'reject', reason }); return; }
    const context = admit(event, reason => trace({ phase: 'reject', reason }));
    if (!context) return;
    const touch = event.touches[0];
    gesture = { ...context, id: touch.identifier, x: touch.clientX, y: touch.clientY, captured: false, startedAt: context.composer ? stamp(event) : null };
    if (context.composer) trace({ phase: 'composer', reason: null });
    trace({ phase: 'armed', reason: null });
  };
  const move = event => {
    if (!gesture) return;
    trace({ phase: 'move', reason: event.cancelable ? 'cancelable' : 'non-cancelable' });
    const reason = event.touches.length !== 1 || event.touches[0].identifier !== gesture.id ? 'multi-touch'
      : event.defaultPrevented ? 'already-consumed' : check();
    if (reason) { reset(reason); return; }
    if (gesture.composer && !gesture.captured) {
      const at = stamp(event), age = at === null || gesture.startedAt === null ? null : at - gesture.startedAt;
      if (age === null || age < 0 || age >= PULL_EDITOR_INTENT_MS) { reset('editing-hold'); return; }
    }
    const touch = event.touches[0];
    const delta = touch.clientX - gesture.x, cross = Math.abs(touch.clientY - gesture.y);
    const direction = gesture.direction ?? (delta < 0 ? -1 : 1), distance = direction * delta;
    if ((cross >= slop && cross >= Math.abs(delta)) || (gesture.captured && distance < 0)) { reset('other-direction'); return; }
    if (!gesture.captured && (distance < slop || distance <= cross * 1.4)) return;
    if (!event.cancelable) { reset('native-gesture-owned'); return; }
    let intent = null;
    if (!gesture.captured) {
      let rejection = 'other-direction';
      intent = choose(gesture, direction, reason => { rejection = reason; });
      if (!intent) { reset(rejection); return; }
    }
    event.preventDefault();
    if (!event.defaultPrevented) { reset('prevent-default-ignored'); return; }
    if (!gesture.captured) {
      gesture = { ...gesture, ...intent, direction, captured: true };
      if (gesture.action) trace({ phase: 'intent', reason: gesture.action });
    }
    consumedId = gesture.id; feedback = true;
    const ready = distance >= PULL_THRESHOLD && distance > cross * 1.4;
    trace({ phase: ready ? 'ready' : 'drag', reason: null });
    changed({ distance: Math.max(0, distance), ready,
      ...(gesture.action ? { action: gesture.action, targetId: gesture.targetId } : {}) });
  };
  const end = event => {
    const wasPrevented = event.defaultPrevented;
    const consumed = [...event.changedTouches].some(touch => touch.identifier === consumedId);
    if (consumed) { if (event.cancelable) event.preventDefault(); consumedId = null; }
    if (!gesture) return;
    const touch = [...event.changedTouches].find(touch => touch.identifier === gesture.id);
    const distance = touch && gesture.captured ? gesture.direction * (touch.clientX - gesture.x) : 0;
    const cross = touch ? Math.abs(touch.clientY - gesture.y) : 0;
    const reason = check();
    const ready = gesture.captured && touch && !wasPrevented && event.touches.length === 0 && !reason
      && distance >= PULL_THRESHOLD && distance > cross * 1.4;
    const finished = ready && event.defaultPrevented ? { ...gesture, distance, ready: true } : null;
    let prepared;
    if (finished) {
      // Read-only visual preparation must happen while the feedback still owns
      // its mounted circle. A visual failure must never block navigation.
      try { prepared = beforeComplete(finished); } catch {}
    }
    reset();
    if (finished) { trace({ phase: 'complete', reason: finished.action === 'quick' ? 'quick' : null }); complete(finished, prepared); }
    else trace({ phase: 'cancel', reason: reason || (ready ? 'non-cancelable-end' : 'short-or-unclaimed') });
  };
  const cancelTouch = () => reset('touchcancel');
  const extraTouch = event => { if (gesture && event.touches.length !== 1) reset('multi-touch'); };
  const visibility = () => { if (document.visibilityState === 'hidden') reset('hidden'); };
  const blur = () => reset('blur');
  const offState = subscribe(() => { if (gesture) { const reason = check(); if (reason) reset(reason); } });
  const passive = { passive: true, capture: true }, active = { passive: false, capture: true };
  // Use the native scrollport's box for touch dispatch. The display:contents
  // HOC remains the admission/lifetime boundary, not the listener receiver.
  eventTarget.addEventListener('touchstart', start, active);
  eventTarget.addEventListener('touchmove', move, active);
  eventTarget.addEventListener('touchend', end, active);
  eventTarget.addEventListener('touchcancel', cancelTouch, passive);
  // Cancellation only: never intercept a second finger outside the owned surface.
  document.addEventListener('touchstart', extraTouch, passive);
  view.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    eventTarget.removeEventListener('touchstart', start, active);
    eventTarget.removeEventListener('touchmove', move, active);
    eventTarget.removeEventListener('touchend', end, active);
    eventTarget.removeEventListener('touchcancel', cancelTouch, passive);
    document.removeEventListener('touchstart', extraTouch, passive);
    view.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
    offState(); reset(); consumedId = null;
  };
}

/** Physical right-to-left opens browse; left-to-right commits its previewed
 * next-priority chat on release. Neither action depends on scroll position.
 * Optional beforeComplete reads mounted feedback and returns a visual snapshot;
 * open/quick receive that snapshot only after changed(null) clears feedback. */
export function bindPullGesture({ target, document, view, enabled, getSession, canOpen, open,
  getNext = () => null, isEligible = () => true, quick = () => {}, beforeComplete, changed, subscribe, trace }) {
  const policy = () => !enabled() ? 'disabled' : !canOpen() ? 'no-candidates-or-cycle' : null;
  const eventTarget = target.querySelector?.('[data-conversation-scroll]') ?? target;
  return bindHorizontalTouch({ target, eventTarget, document, view, beforeComplete, changed, subscribe, trace,
    choose(gesture, direction, rejected) {
      if (direction < 0) return { action: 'browse', targetId: null };
      const targetId = getNext();
      if (!targetId || targetId === gesture.sessionId) { rejected('no-quick-target'); return null; }
      if (!isEligible(targetId)) { rejected('ineligible-quick-target'); return null; }
      return { action: 'quick', targetId };
    },
    complete: (finished, prepared) => finished.action === 'quick' ? quick(finished.targetId, prepared) : open(prepared),
    admit(event, rejected) {
      const reason = policy();
      if (reason) { rejected(reason); return null; }
      return pullContext(event, target, view, getSession(), rejected);
    },
    valid: gesture => policy() || (getSession() !== gesture.sessionId ? 'changed-session' : chatAdmission(gesture.scroller, gesture.body, target, gesture.sessionId, gesture.composer))
      || (gesture.action === 'quick' && !isEligible(gesture.targetId) ? 'ineligible-quick-target' : null),
  });
}

/** Physical left-to-right dismisses browse; vertical directions scroll its grid. */
export function bindDismissGesture({ target, document, view, close, canClose = () => true, beforeComplete, changed, trace }) {
  return bindHorizontalTouch({ target, document, view, beforeComplete, changed, trace, complete: (finished, prepared) => close(prepared),
    choose: (gesture, direction) => direction > 0 ? {} : null,
    admit(event, rejected) {
      if (!canClose()) { rejected('dialog-busy'); return null; }
      if (event.target.closest?.(PULL_EDITING)) { rejected('interactive'); return null; }
      return {};
    },
    valid: () => !canClose() ? 'dialog-busy' : target.isConnected === false ? 'detached' : null,
  });
}

/** Read-only aggregate diagnostics; no text, session ids, titles or touch coordinates. */
export function createSwipeDiagnostics() {
  const frames = new Set(), counts = Object.create(null), reasons = Object.create(null);
  let last = null;
  return {
    trace(surface, event) {
      const key = surface + ':' + event.phase;
      counts[key] = (counts[key] ?? 0) + 1;
      if (event.reason) { const reasonKey = key + ':' + event.reason; reasons[reasonKey] = (reasons[reasonKey] ?? 0) + 1; }
      last = { surface, ...event };
    },
    observe(frame) { frames.add(frame); return () => frames.delete(frame); },
    status(view, currentId) {
      return { mountedFrames: frames.size, counts: { ...counts }, reasons: { ...reasons }, last,
        frames: [...frames].slice(0, 4).map(frame => {
          const scroller = frame.querySelector('[data-conversation-scroll]');
          const body = scroller?.closest('[data-conversation-content]');
          return { connected: frame.isConnected, scrollOwner: !!scroller,
            admission: scroller ? chatAdmission(scroller, body, frame, currentId) : 'no-scroll-owner',
            phase: body?.dataset.contentPhase ?? null,
            scrollTop: scroller?.scrollTop ?? null, clientHeight: scroller?.clientHeight ?? null, scrollHeight: scroller?.scrollHeight ?? null };
        }),
        touchPoints: view.navigator?.maxTouchPoints ?? 0,
        visualScale: view.visualViewport?.scale ?? 1,
      };
    },
  };
}

/** Keyboard accessibility for the persistent listbox, not the Close button. */
export function browseKey(event, controller, count) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (step) controller.move(step);
  else if (event.key === 'Home') controller.select(0);
  else if (event.key === 'End') controller.select(count - 1);
  else if (event.key === 'Enter' || event.key === ' ') controller.release();
  else return;
  event.preventDefault(); event.stopPropagation();
}
