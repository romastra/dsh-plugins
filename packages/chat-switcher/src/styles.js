// The native hover slot is additive in DSH 0.2.2. Hide only redundant native
// metadata while our card is present; preserve other plugins and Archive.
// Match semantic CSS-module suffixes rather than their generated hash.
export const IMAGE_ACTION_CSS = `
.cs-image-action{position:relative;display:inline-flex;flex:none;align-items:center;-webkit-app-region:no-drag}
.cs-blank-image-action{display:none}
header.an3WzG_headerBlank>[data-conversation-header-leading] .cs-blank-image-action{display:inline-flex}
.cs-image-palette{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border:0;border-radius:8px;padding:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}
.cs-image-palette:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cs-image-palette:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cs-image-palette:disabled{cursor:default;color:var(--dsw-alias-state-idle-primary)}
.cs-image-palette svg{display:block;width:18px;height:18px;pointer-events:none}
/* A Session scope can wrap the native title row. Use one non-wrapping flex
   row instead of assigning sibling grid cells across that scope boundary. */
header.an3WzG_headerBlank:has(>[data-conversation-header-leading] .cs-blank-image-action){display:flex!important;flex-wrap:nowrap!important;align-items:center!important;justify-content:flex-end!important;column-gap:8px!important}
header.an3WzG_headerBlank:has(>[data-conversation-header-leading] .cs-blank-image-action)>[data-conversation-header-leading]{flex:0 0 auto!important;align-self:center!important}
header.an3WzG_headerBlank:has(>[data-conversation-header-leading] .cs-blank-image-action) .an3WzG_titleRow{flex:0 0 auto!important;width:auto!important;padding-inline-start:0!important;container-type:normal!important}
header.an3WzG_headerBlank:has(>[data-conversation-header-leading] .cs-blank-image-action) [data-conversation-header-corner]{margin-inline-start:0!important;align-self:center!important}
.cs-image-error{position:absolute;z-index:20;top:calc(100% + 6px);right:0;width:max-content;max-width:min(300px,75vw);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.4}
`;

// The core Conversation body is position:relative. This contents-only layer
// leaves its native scroller/composer as flex items and anchors only our hint.
export const PULL_CSS_TEXT = `
.cs-pull-frame{display:contents}
.cs-modal-area{position:absolute;inset:0;visibility:hidden;pointer-events:none;overflow:hidden}
.cs-dialog[data-cs-mode=browse] header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.cs-dialog[data-cs-mode=browse] header h2{margin:0}
.cs-close{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:44px;min-height:44px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.cs-close:focus-visible,.cs-grid:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cs-dialog.cs-chat-area{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.cs-dialog.cs-chat-area>header,.cs-dialog.cs-chat-area>.cs-note{flex:none}
@media(max-width:600px){
.cs-dialog[data-cs-mode=browse]{padding:12px;border-radius:16px}
.cs-dialog[data-cs-mode=browse] .cs-grid{grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:10px;padding:5px;max-height:calc(88dvh - 124px)}
.cs-dialog[data-cs-mode=browse] .cs-card{padding:7px}
.cs-dialog[data-cs-mode=browse] .cs-preview{min-height:0}
.cs-dialog[data-cs-mode=browse] .cs-preview-content{padding:8px;gap:5px}
.cs-dialog[data-cs-mode=browse] .cs-folder-icon{display:none}
}
.cs-dialog.cs-chat-area .cs-grid{flex:1 1 auto;min-height:0;max-height:none;align-content:start}
`;

export const HOVER_CSS_TEXT = `
[class*="_hoverContent"]:has(.cs-hover-card)>:is([class*="_hoverTitle"],[class*="_hoverPath"],[class*="_hoverTime"],[class*="_hoverStatus"]:not([class*="_hoverArchived"])){display:none}
[class*="_hoverContent"]:has(.cs-hover-card){gap:10px;min-width:0}
.cs-hover-card{box-sizing:border-box;width:min(280px,calc(100vw - 48px));max-width:100%;font-size:16px;line-height:1.45;color:var(--dsw-alias-label-primary,#edf1f5);cursor:default}
.cs-hover-card .cs-preview{font-size:14px;min-height:0}
.cs-hover-card .cs-title{font-size:16px;line-height:1.4;overflow-wrap:anywhere}
.cs-hover-card .cs-badges{font-size:12px}
`;

export const CSS_TEXT = ".cs-dialog:not([open]){display:none!important}\n.cs-dialog{box-sizing:border-box;width:min(1120px,94vw);max-height:88dvh;border:1px solid var(--dsw-alias-border-l1,#657080);border-radius:20px;padding:22px;background:var(--dsw-alias-bg-layer-1,#20242b);color:var(--dsw-alias-label-primary,#edf1f5);box-shadow:0 24px 90px #0008;font:inherit}\n.cs-dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}\n.cs-dialog header h2{font-size:1.1em;margin:0 0 16px}\n.cs-note{font-size:.75em;line-height:1.5;color:var(--dsw-alias-label-secondary,#b7c0cb);margin:14px 0 0}\n.cs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:16px;max-height:70dvh;overflow:auto;padding:6px;outline:none;align-items:start;overscroll-behavior:contain}\n.cs-card{min-width:0;cursor:pointer;border:2px solid transparent;border-radius:14px;padding:10px;background:var(--dsw-alias-bg-layer-2,#292f38);outline:1px solid var(--dsw-alias-border-l1,#48515f)}\n.cs-card[aria-selected=true]{border-color:var(--dsw-alias-state-business-primary,#4997ed);outline:2px solid var(--dsw-alias-state-business-primary,#4997ed);outline-offset:2px}\n.cs-preview{position:relative;isolation:isolate;aspect-ratio:1;min-height:150px;overflow:hidden;border-radius:9px;background:var(--dsw-alias-bg-base,#171c23);font-size:.7em}\n.cs-mosaic,.cs-mosaic-shade{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;user-select:none}\n.cs-mosaic{object-fit:contain;display:block}\n.cs-mosaic-shade{background:var(--dsw-alias-bg-base,#171c23);opacity:.5}\n.cs-preview-content{position:relative;z-index:1;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;height:100%;padding:11px;pointer-events:none}\n.cs-folder-icon{font-size:30px;line-height:1;color:var(--dsw-alias-label-primary,#edf1f5);text-shadow:0 1px 3px #0008}\n.cs-folder{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#edf1f5);background:color-mix(in srgb,var(--dsw-alias-bg-base,#171c23) 75%,transparent);padding:4px 6px;border-radius:5px;align-self:flex-start;line-height:1.4}\n.cs-state{margin-top:auto;align-self:flex-start;background:var(--dsw-alias-bg-base,#171c23);border:1px solid var(--dsw-alias-border-l1,#48515f);padding:5px 8px;border-radius:7px;font-weight:600}\n.cs-title{white-space:normal;overflow-wrap:anywhere;font-size:.85em;font-weight:600;line-height:1.45;margin:12px 0 6px}\n.cs-badges{display:flex;flex-wrap:wrap;gap:6px;font-size:.65em;line-height:1.5;min-height:1.5em}\n.cs-badges>span{border-radius:6px;padding:2px 6px;background:var(--dsw-alias-bg-base,#171c23)}\n.cs-indicator,.cs-row-indicator{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}\n.cs-row-indicator{flex-shrink:0;line-height:1;vertical-align:middle;padding:2px 3px}\n.cs-status-dot{--cs-dot:#a3aab4;display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:var(--cs-dot);box-shadow:0 0 0 1px #0004,0 0 7px color-mix(in srgb,var(--cs-dot) 70%,transparent)}\n.cs-row-indicator>.cs-status-dot{width:12px;height:12px}\n.cs-status-dot[data-state=completion]{--cs-dot:#39ff70;box-shadow:0 0 0 1px #002c12,0 0 9px #39ff70aa}\n.cs-status-dot[data-state=failed]{--cs-dot:#ff4545}\n.cs-status-dot[data-state=approval]{--cs-dot:#ffd332}\n.cs-status-dot[data-state=question]{--cs-dot:#ff5fd2}\n.cs-status-dot[data-state=plan-review]{--cs-dot:#ff9d35}\n.cs-status-dot[data-state=attention]{--cs-dot:#ff9d35}\n.cs-status-dot[data-state=running]{--cs-dot:#43c8ff}\n.cs-status-dot[data-state=unread]{--cs-dot:#7db6ff}\n.cs-reminder{font-size:12px;color:var(--dsw-alias-label-secondary,#b7c0cb)}\n.cs-settings{padding:12px 0;max-width:750px}.cs-settings p{font-size:13px;line-height:1.5}.cs-settings label{display:flex;align-items:center;gap:10px;margin:14px 0}.cs-settings input[type=number]{width:100px;padding:6px}.cs-settings button{padding:7px 14px}\n.cs-error{position:fixed;right:20px;bottom:20px;z-index:100000;padding:12px 18px;border:1px solid #ff4545;border-radius:8px;background:var(--dsw-alias-bg-base,#171c23);color:var(--dsw-alias-label-primary,#edf1f5)}\n@media(max-width:540px){.cs-dialog{padding:14px}.cs-grid{grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:12px}.cs-card{padding:7px}.cs-preview{min-height:110px}.cs-folder{font-size:11px}.cs-title{font-size:.8em}}\n@media(forced-colors:active){.cs-status-dot{background:Highlight;forced-color-adjust:none;outline:1px solid CanvasText}.cs-card[aria-selected=true]{outline:3px solid Highlight}}\n";
