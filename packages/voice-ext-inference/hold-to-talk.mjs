// Pure state machines plus a behavioral-only, rc.3 native-button event adapter.
// No host DOM is changed, no geometry/CSS/React internals are inspected.
export function createReviewCountdown({ read, current, submit, publish, now = Date.now, setInterval, clearInterval, seconds = 30 }) {
  let active;
  let timer;
  let disposed = false;
  function cancel(reason = 'cancelled') {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const previous = active;
    active = undefined;
    if (previous) publish({ active: false, reason });
  }
  function tick() {
    if (!active || disposed) return;
    const snapshot = read();
    const attachments = snapshot.attachmentIds ?? [];
    if (!current() || snapshot.draftRev !== active.revision || snapshot.draft !== active.text || snapshot.phase !== 'plain' ||
        attachments.length !== active.attachments.length || attachments.some((id, index) => id !== active.attachments[index])) {
      cancel('changed');
      return;
    }
    const remaining = Math.max(0, Math.ceil((active.deadline - now()) / 1000));
    if (remaining === 0) {
      const args = active.args;
      cancel('sent'); // Clear ownership before the native send can publish again.
      submit(...args);
    } else publish({ active: true, remaining, deadline: active.deadline });
  }
  return {
    arm(args = ['queue', 'click']) {
      cancel();
      const snapshot = read();
      if (disposed || !current() || snapshot.targetKind === 'question' || snapshot.phase !== 'plain' || !snapshot.draft.trim() || snapshot.draft.trimStart().startsWith('/')) return false;
      active = { text: snapshot.draft, revision: snapshot.draftRev, attachments: [...(snapshot.attachmentIds ?? [])], deadline: now() + seconds * 1000, args };
      timer = setInterval(tick, 250);
      tick();
      return true;
    },
    cancel,
    check: tick,
    active: () => Boolean(active),
    dispose() { disposed = true; cancel('disposed'); },
  };
}

// A deliberate new hold replaces a failed take just like the microphone button.
// Global browser focus belongs to auto-send safety, not to capture eligibility.
export function canBeginHold({ current, guardReady, locked = false, recording, starting, finishing, phase }) {
  return Boolean(current && guardReady && !locked && !recording && !starting && !finishing && ['plain', 'claimed'].includes(phase));
}

export function createHoldGesture({ start, stop, cancel, hasCapture, reviewed, allowed = () => true, unavailable, captureOwner = () => null, setTimeout, clearTimeout, delay = 300 }) {
  let press;
  let generation = 0;
  let alive = true;
  function abort() {
    generation += 1;
    const previous = press;
    press = undefined;
    if (previous) clearTimeout(previous.timer);
    if (previous?.held && !previous.denied && previous.owner === captureOwner()) void cancel();
  }
  return {
    down(id, args) {
      if (!alive || press) return false;
      const own = { id, args, held: false, generation: ++generation };
      press = own;
      own.timer = setTimeout(() => {
        if (!alive || press !== own) return;
        own.held = true;
        if (!allowed()) { own.denied = true; try { unavailable?.(); } catch {} return; }
        try { void Promise.resolve(start()).catch(() => {}); } catch { /* A failed start cannot authorize a send. */ }
        own.owner = captureOwner();
      }, delay);
      return true;
    },
    up(id, args) {
      const own = press;
      if (!own || own.id !== id) return false;
      press = undefined;
      clearTimeout(own.timer);
      if (!own.held) return false; // Preserve an ordinary native tap.
      if (own.denied) return true; // Explain the refusal without executing native Stop/Continue.
      if (args !== undefined) own.args = args;
      if (own.owner !== captureOwner()) return true; // Never finish a different take.
      const captured = hasCapture();
      let result;
      try { result = stop(); } catch { return true; }
      void Promise.resolve(result).then(ok => {
        if (ok === true && captured && alive && generation === own.generation) reviewed(own.args);
      }).catch(() => {});
      return true;
    },
    held: () => Boolean(press?.held),
    pressed: () => Boolean(press),
    abort,
    dispose() { alive = false; abort(); },
  };
}

export const TOUCH_HOLD_SLOP_FRACTION = 0.15;

export function touchHoldRadius(view) {
  // Compare client coordinates to the visible CSS viewport, not physical pixels
  // or the zoomed dimensions of the button. Freeze the radius at pointerdown.
  const vv = view.visualViewport;
  const valid = (width, height) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  const size = vv && valid(vv.width, vv.height) ? vv : { width: view.innerWidth, height: view.innerHeight };
  return valid(size.width, size.height) ? Math.min(size.width, size.height) * TOUCH_HOLD_SLOP_FRACTION : 90;
}

export function bindNativeHold({ root, input, labels, allowed, start, stop, cancel, hasCapture, captureOwner, reviewed, focus, changed, unavailable, trace = () => {}, document: doc, window: win }) {
  let point;
  let echo;
  const consume = event => { event.preventDefault(); event.stopPropagation(); };
  const rememberRelease = (contact, blockClick) => {
    echo = { button: contact.button, id: contact.id, touch: contact.touch, blockClick, until: Date.now() + 1500 };
  };
  const isEcho = (event, button) => {
    if (!echo || Date.now() > echo.until) { echo = undefined; return false; }
    if (echo.touch && event.pointerType === 'touch' && event.pointerId >= 0) return event.pointerId === echo.id;
    if (event.detail === 0) return false; // Keyboard/programmatic clicks did not come from this press.
    return button === echo.button;
  };
  const gesture = createHoldGesture({ start, stop, cancel, hasCapture, captureOwner, reviewed, allowed, unavailable,
    setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) });
  const card = () => root()?.closest('[data-composer-card]');
  function buttonIntent(button) {
    const parent = card();
    if (!parent || !button || button.closest('[data-composer-card]') !== parent || button.getAttribute('aria-busy') === 'true' || button.hasAttribute('data-sending')) return;
    const label = button.getAttribute('aria-label');
    const index = labels().indexOf(label);
    if (index < 0) return;
    return { button, args: [index === 2 ? 'steer' : 'queue', 'click'] };
  }
  const nativeButton = event => buttonIntent(event.target?.closest?.('button'));
  const isEditor = target => card()?.contains(target) && target?.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]');
  const onDown = event => {
    if (isEditor(event.target)) focus();
    if (event.button !== 0 || event.isPrimary === false || point || gesture.pressed()) return;
    const native = nativeButton(event);
    if (!native || !gesture.down(event.pointerId, native.args)) return;
    echo = undefined;
    const touch = event.pointerType === 'touch';
    const activeElement = doc.activeElement;
    point = { button: native.button, x: event.clientX, y: event.clientY, id: event.pointerId,
      touch, radius: touch ? touchHoldRadius(win) : null, dragCancelled: false,
      editor: isEditor(activeElement) ? activeElement : null };
    // Prevent focus transfer before it happens. Cancelling PointerDown suppresses
    // compatibility mouse focus, but still allows an ordinary native short click.
    event.preventDefault();
  };
  const beyond = (contact, sample, radius) => Math.hypot(sample.clientX - contact.x, sample.clientY - contact.y) > radius;
  const report = (contact, outcome) => {
    if (!contact.touch) return;
    try { trace({ outcome, editorWasFocused: Boolean(contact.editor), editorFocused: Boolean(isEditor(doc.activeElement)),
      focusPreserved: contact.editor ? doc.activeElement === contact.editor : !isEditor(doc.activeElement) }); } catch { /* Diagnostics are not behavior. */ }
  };
  const cancelTouchDrag = contact => {
    if (!contact.dragCancelled) {
      contact.dragCancelled = true;
      gesture.abort();
      focus(); // Invalidate pending auto-send, without calling any DOM focus API.
    }
  };
  const onUp = event => {
    const contact = point;
    if (!contact || contact.id !== event.pointerId) return;
    const held = gesture.held();
    if (contact.touch && beyond(contact, event, contact.radius)) cancelTouchDrag(contact);
    point = undefined;
    const consumed = contact.dragCancelled || gesture.up(event.pointerId, buttonIntent(contact.button)?.args);
    rememberRelease(contact, consumed);
    if (contact.dragCancelled || held) report(contact, contact.dragCancelled ? 'drag-cancelled' : 'released');
    if (consumed) consume(event);
  };
  const onMove = event => {
    const contact = point;
    if (!contact || contact.id !== event.pointerId) return;
    if (contact.touch) {
      // A canceled drag remains owned until lift, even after a long pause or a
      // return to the button. Neither a late release nor its click can send.
      if (!contact.dragCancelled && (beyond(contact, event, contact.radius) ||
          event.getCoalescedEvents?.().some(sample => beyond(contact, sample, contact.radius)))) cancelTouchDrag(contact);
      event.preventDefault();
    } else if (beyond(contact, event, gesture.held() ? 90 : 20)) {
      if (gesture.held()) rememberRelease(contact, true);
      gesture.abort(); point = undefined;
    } else if (gesture.held()) event.preventDefault();
  };
  const onClick = event => {
    if (!isEcho(event, event.target?.closest?.('button'))) return;
    const { blockClick } = echo;
    echo = undefined;
    if (blockClick) consume(event);
  };
  const onContext = event => {
    if ((point?.touch && (event.target?.closest?.('button') === point.button || event.pointerId === point.id)) ||
        (gesture.held() && nativeButton(event))) consume(event);
  };
  const onFocus = event => { if (isEditor(event.target)) focus(); };
  const onKeyDown = event => { if (isEditor(event.target)) focus(); };
  const onMouseDown = event => {
    // Fallback for compatibility events a browser still emits: native
    // keepDraftFocus() would unconditionally open a previously closed keyboard.
    const button = event.target?.closest?.('button');
    if (event.button === 0 && button && (button === point?.button || isEcho(event, button))) consume(event);
  };
  const abort = () => {
    const contact = point;
    point = undefined;
    if (contact && (contact.touch || gesture.held())) rememberRelease(contact, true);
    gesture.abort(); focus();
    if (contact) report(contact, contact.dragCancelled ? 'drag-cancelled' : 'interrupted');
  };
  const onPointerCancel = event => { if (point && event.pointerId === point.id) abort(); };
  const onVisibility = () => { if (doc.visibilityState !== 'visible') abort(); };
  const offState = input.state.subscribe(changed);
  const rows = [['pointerdown', onDown], ['pointerup', onUp], ['pointermove', onMove], ['click', onClick], ['contextmenu', onContext], ['focusin', onFocus], ['keydown', onKeyDown], ['mousedown', onMouseDown], ['pointercancel', onPointerCancel], ['visibilitychange', onVisibility]];
  for (const [name, callback] of rows) doc.addEventListener(name, callback, { capture: true, passive: false });
  win.addEventListener('blur', abort);
  return () => {
    gesture.dispose();
    offState();
    for (const [name, callback] of rows) doc.removeEventListener(name, callback, true);
    win.removeEventListener('blur', abort);
  };
}
