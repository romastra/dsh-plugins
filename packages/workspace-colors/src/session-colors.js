import { PALETTE, cssString } from '../palette.js';

export const SESSION_CHILD_STEP_PX = 12;
const LIST = '[data-sidebar-list-area]';
const GROUP = `${LIST} [style*="--dsh-workspace-indent"]`;

// Exact membership, like the native list and Chat Switcher. An uncolored first
// owner still wins; duplicate titles, paths or nested folder prefixes are not IDs.
export function sessionWorkspaceIds(workspaces) {
  const ids = new Map();
  for (const workspace of workspaces) {
    if (typeof workspace.workspaceId !== 'string' || !Array.isArray(workspace.sessionIds)) continue;
    for (const sessionId of workspace.sessionIds) {
      if (typeof sessionId === 'string' && !ids.has(sessionId)) ids.set(sessionId, workspace.workspaceId);
    }
  }
  return ids;
}

export const SESSION_HIERARCHY_CSS = `
${GROUP} [data-row-key^="session:"] {
  --wc-session-paint-inset:calc(var(--dsh-workspace-indent, 0px) + ${SESSION_CHILD_STEP_PX}px);
  padding-inline-start:calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset) + var(--dsh-workspace-indent, 0px) + ${SESSION_CHILD_STEP_PX}px);
}
${GROUP} [data-row-key^="overflow:"] {
  padding-inline-start:calc(var(--dsh-sidebar-row-padding) + 16px + var(--dsh-sidebar-label-gap) + var(--dsh-workspace-indent, 0px) + ${SESSION_CHILD_STEP_PX}px);
}`;

export function sessionColorRules(colors, workspaces) {
  const groups = new Map();
  for (const [sessionId, workspaceId] of sessionWorkspaceIds(workspaces)) {
    const color = PALETTE.find(item => item.index === colors[workspaceId]);
    if (!color) continue;
    const selectors = groups.get(color.hex) ?? [];
    selectors.push(`${LIST} [data-row-key=${cssString(`session:${sessionId}`)}]`);
    groups.set(color.hex, selectors);
  }
  return [...groups].map(([hex, selectors]) => `${selectors.join(',\n')}{
  --wc-session-accent:${hex};
  background-image:linear-gradient(color-mix(in srgb, ${hex} 80%, var(--dsw-alias-label-secondary)),color-mix(in srgb, ${hex} 80%, var(--dsw-alias-label-secondary))),linear-gradient(color-mix(in srgb, ${hex} 9%, transparent),color-mix(in srgb, ${hex} 9%, transparent));
  background-repeat:no-repeat;
  background-position:var(--wc-session-paint-inset, 0px) center,var(--wc-session-paint-inset, 0px) 0;
  background-size:2px calc(100% - 8px),max(0px, calc(100% - var(--wc-session-paint-inset, 0px))) 100%;
}`).join('\n');
}
