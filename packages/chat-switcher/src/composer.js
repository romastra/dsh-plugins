import { getMosaicDataUrl } from './mosaic.js';

const composerMultilineFlag = 'data-cs-composer-multiline';
const composerScrollbarFlag = 'data-cs-composer-scrollbar';
const nativeComposerScroll = ':scope > [data-input-scroll]';
const nativeComposerInput = '[data-composer-input]';

// DSH 0.2.2's main composer action is the primary button with aria-busy.
// The auxiliary interrupt button deliberately stays native when both coexist.
export function composerIdentityCss(sessionId, mosaicSeed = sessionId, imageOverride) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  // Hex-escape every codepoint: arbitrary session IDs must never become CSS.
  const key = Array.from(sessionId, ch => '\\' + ch.codePointAt(0).toString(16) + ' ').join('');
  const card = '[data-composer-card]:has(style[data-cs-composer-image="' + key + '"])';
  const measuredCard = flag => '[data-composer-card]:has(>[data-composer-overlay] style[data-cs-composer-image="' + key + '"][' + flag + '])';
  const action = 'button.GRgSLq_primary[aria-busy]';
  const button = card + ' ' + action;
  const row = card + ' .GRgSLq_row:has(' + action + ')';
  const trailing = card + ' .GRgSLq_trailing:has(' + action + ')';
  const image = typeof imageOverride === 'string' ? imageOverride : getMosaicDataUrl(mosaicSeed);
  const width = 'calc(var(--dsw-radius-panel) * 0.75 * 5)';
  const height = 'calc(var(--dsw-radius-panel) * 0.75 * 4.4)';
  const spacerWidth = 'calc(var(--dsw-radius-panel) * 0.75 * 4.5)';
  return button + '{' +
    // The native card is the containing block; geometry follows its theme radius.
    'position:absolute!important;inset:auto 0 0 auto!important;' +
    'margin:0!important;transform:none!important;z-index:2!important;' +
    'zoom:1!important;width:' + width + '!important;height:' + height + '!important;' +
    'border-radius:calc(var(--dsw-radius-panel) * 0.75) 0 0 0!important;' +
    'border:0!important;padding:0!important;' +
    'background-color:transparent!important;background-image:url("' + image + '")!important;' +
    'background-size:100% auto!important;background-position:center!important;background-repeat:no-repeat!important;' +
    'background-blend-mode:normal!important;box-shadow:none!important;filter:none!important;opacity:0.5!important;' +
    'transition:opacity 0.5s ease!important;' +
    '}' +
    button + ':hover{opacity:1!important;}' +
    // The native rounded card clips its contents, not the button's own shape.
    // Shipped composer popovers/tooltips portal outside this card. Unlike
    // overflow:hidden, clip does not create another scrolling container.
    card + ':has(' + action + '){overflow:clip!important;overflow-clip-margin:0!important;}' +
    // A pseudo-element after Lexical's trailing caret BR creates another line.
    // Omit it on BR-terminated paragraphs; never delete the editor's own BR.
    card + ' [data-composer-input]>p:last-child:not(:has(>br:last-child))::after{' +
    'content:"";display:inline-block;width:' + spacerWidth + ';}' +
    measuredCard(composerMultilineFlag) + '>[data-input-scroll] ' + nativeComposerInput + '{margin-bottom:14px!important;}' +
    measuredCard(composerScrollbarFlag) + '>[data-input-scroll]{margin-bottom:47px!important;}' +
    // Keep the card, not either flex group, as the action's containing block.
    row + ',' + trailing + '{position:static!important;}' +
    // Reserve the same horizontal seat and native flex gap for model/interrupt
    // controls, but no height: the image can overlap the draft above the toolbar.
    trailing + '::after{content:""!important;display:block!important;flex:0 0 ' + width + '!important;' +
    'width:' + width + '!important;height:0!important;pointer-events:none!important;}' +
    button + '>*{visibility:hidden!important;}' +
    button + '::before,' + button + '::after{content:none!important;display:none!important;}';
}

// Native MenuView and PopupSelect live inside the card and unmount when closed.
// Keep the pixel-reference CSS above untouched; only open menus need this escape.
export function composerMenuVisibilityCss(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  const key = Array.from(sessionId, ch => '\\' + ch.codePointAt(0).toString(16) + ' ').join('');
  const action = 'button.GRgSLq_primary[aria-busy]';
  const card = '[data-composer-card]:has(style[data-cs-composer-image="' + key + '"])';
  const open = card + ':has(' + action + '):has([data-trigger-menu], [data-composer-overlay] input[type="text"][aria-label])';
  return open + '{overflow:visible!important;}' +
    open + ' ' + action + '{border-bottom-right-radius:var(--dsw-radius-panel)!important;max-height:100%!important;}';
}

/** Use the laid-out paragraphs, not the field's minimum height or focus.
 *  A block P includes its ::after spacer in its height. The native editor
 *  uses zero-margin paragraphs and a computed line-height in CSS pixels.
 */
export function composerHasSecondLine(paragraphHeight, lineHeight, lastParagraphHeight = 0) {
  // offsetHeight is rounded to a CSS pixel and unaffected by transforms.
  return paragraphHeight > 0 && (lastParagraphHeight > 0 || (lineHeight > 0 && paragraphHeight >= 2 * lineHeight - 1));
}

export function composerHasVerticalScrollbar({ clientHeight, scrollHeight, overflowY, scrollbarWidth, webkitBar }) {
  return clientHeight > 0 && scrollHeight > clientHeight && /^(auto|scroll|overlay)$/.test(overflowY)
    && scrollbarWidth !== 'none' && webkitBar?.display !== 'none' && Number.parseFloat(webkitBar?.width) !== 0;
}

/** Bind once per mounted identity style. Only that owned node gets flags;
 *  no cloning, reading text, or edits to the native Lexical tree.
 */
export function bindComposerSpacing(marker) {
  const card = marker?.closest('[data-composer-card]');
  const view = marker?.ownerDocument.defaultView;
  if (!card || typeof view?.ResizeObserver !== 'function') return;

  let disposed = false, frame = null, editor, observed = new Set();
  function schedule() {
    if (disposed || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; measure(); });
  }
  const resize = new view.ResizeObserver(schedule);
  const mutate = typeof view.MutationObserver === 'function' ? new view.MutationObserver(schedule) : null;
  function measure() {
    if (disposed || !marker.isConnected) return;
    const scroll = card.querySelector(nativeComposerScroll);
    const input = scroll?.querySelector(nativeComposerInput) ?? null;
    const first = input?.firstElementChild;
    const last = input?.lastElementChild;
    const paragraph = first?.tagName === 'P' ? first : null;
    const lastParagraph = last !== first && last?.tagName === 'P' ? last : null;
    if (editor !== input) {
      editor = input;
      mutate?.disconnect();
      mutate?.observe(card, { childList: true });
      if (editor) mutate?.observe(editor, { childList: true });
    }
    // The scrollport stops growing at its cap, but the editor inside doesn't.
    // Paragraphs also change size before the editor grows past its hero floor.
    const targets = new Set([scroll, editor, paragraph, lastParagraph].filter(Boolean));
    for (const target of observed) if (!targets.has(target)) resize.unobserve(target);
    for (const target of targets) if (!observed.has(target)) resize.observe(target);
    observed = targets;

    const multiline = paragraph !== null && composerHasSecondLine(paragraph.offsetHeight,
      Number.parseFloat(view.getComputedStyle(paragraph).lineHeight), lastParagraph?.offsetHeight);
    marker.toggleAttribute(composerMultilineFlag, multiline);
    // Read the scroll range with the 14px rule already resolved. The 47px
    // margin is outside the capped scrollport, so it can't sustain overflow.
    const clientHeight = scroll?.clientHeight ?? 0, scrollHeight = scroll?.scrollHeight ?? 0;
    const scrollStyle = scrollHeight > clientHeight ? view.getComputedStyle(scroll) : null;
    // Non-auto standard properties take precedence over the WebKit skin.
    const webkitBar = scrollStyle && (scrollStyle.scrollbarWidth || 'auto') === 'auto'
      && (scrollStyle.scrollbarColor || 'auto') === 'auto' && view.CSS?.supports?.('selector(::-webkit-scrollbar)')
      ? view.getComputedStyle(scroll, '::-webkit-scrollbar') : null;
    marker.toggleAttribute(composerScrollbarFlag, composerHasVerticalScrollbar({ clientHeight, scrollHeight,
      overflowY: scrollStyle?.overflowY, scrollbarWidth: scrollStyle?.scrollbarWidth, webkitBar }));
  }
  measure();
  return () => {
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    resize.disconnect();
    mutate?.disconnect();
    marker.removeAttribute(composerMultilineFlag);
    marker.removeAttribute(composerScrollbarFlag);
  };
}

/** Read only the decorated composer's appearance; never read draft text. */
export function readComposerAppearance(document, view) {
  return Array.from(document.querySelectorAll?.('[data-composer-card]') ?? []).flatMap(card => {
    const marker = card.querySelector(':scope > [data-composer-overlay] style[data-cs-composer-image]');
    if (!marker) return [];
    const action = card.querySelector('button.GRgSLq_primary[aria-busy]');
    const scroll = card.querySelector(nativeComposerScroll);
    const input = scroll?.querySelector(nativeComposerInput);
    const style = view.getComputedStyle(card), button = action ? view.getComputedStyle(action) : null;
    const editor = input ? view.getComputedStyle(input) : null;
    return [{
      openMenu: card.querySelector('[data-trigger-menu], [data-composer-overlay] input[type="text"][aria-label]') !== null,
      overflowX: style.overflowX, overflowY: style.overflowY,
      action: button ? { width: button.width, height: button.height, borderRadius: button.borderRadius, maxHeight: button.maxHeight, position: button.position, right: button.right, bottom: button.bottom, opacity: button.opacity, backgroundSize: button.backgroundSize } : null,
      inputMarginBottom: editor?.marginBottom ?? null,
      inputMultiline: marker.hasAttribute(composerMultilineFlag),
      scrollMarginBottom: scroll ? view.getComputedStyle(scroll).marginBottom : null,
      scrollHasScrollbar: marker.hasAttribute(composerScrollbarFlag),
      scrollClientHeight: scroll?.clientHeight ?? null, scrollHeight: scroll?.scrollHeight ?? null,
    }];
  });
}
