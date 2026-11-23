// Native action remains responsible for send/steer/queue/stop. Never replay clicks.
export const COMPOSER_ACTION = '[data-composer-card] button.GRgSLq_primary[aria-busy]';
export function bindComposerDoubleActivation({ document, getSession = () => null, now = () => performance.now(), Observer = globalThis.MutationObserver }) {
  let pending = null;
  const reset = () => { pending = null; };
  const state = button => JSON.stringify([getSession(), button.getAttribute('aria-label'), button.getAttribute('aria-busy'), button.disabled, button.innerHTML]);
  const action = event => event.target?.closest?.(COMPOSER_ACTION);
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  function click(event) {
    const button = action(event);
    if (!button) { reset(); return; }
    if (button.disabled || button.getAttribute('aria-disabled') === 'true' || event.button > 0) { reset(); consume(event); return; }
    const time = now(), signature = state(button);
    const kind = event.pointerType || (event.detail === 0 ? 'keyboard' : 'mouse');
    const previous = pending;
    reset();
    if (previous && previous.button === button && previous.signature === signature && previous.kind === kind
        && time - previous.time >= 0 && time - previous.time <= 450) return;
    pending = { button, signature, kind, time };
    consume(event);
  }
  const outside = event => { if (!action(event)) reset(); };
  const key = event => { if (event.key === 'Escape') reset(); };
  // Reset even if a state changes and returns before the second click.
  const observer = Observer ? new Observer(() => {
    if (pending && (!pending.button.isConnected || state(pending.button) !== pending.signature)) reset();
  }) : null;
  observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'aria-busy', 'aria-disabled', 'disabled', 'd'] });
  const style = document.createElement('style');
  style.textContent = COMPOSER_ACTION + '{touch-action:manipulation}';
  document.head.appendChild(style);
  const bindings = [['click', click], ['pointerdown', outside], ['keydown', key], ['visibilitychange', reset]];
  for (const [name, handler] of bindings) document.addEventListener(name, handler, true);
  document.defaultView?.addEventListener('blur', reset);
  return () => {
    reset(); observer?.disconnect(); style.remove();
    for (const [name, handler] of bindings) document.removeEventListener(name, handler, true);
    document.defaultView?.removeEventListener('blur', reset);
  };
}
