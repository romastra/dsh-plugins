import { PULL_THRESHOLD } from './pull.js';

// Finger-driven resistance, not a loading spinner: no timers or endless motion.
export function tensionModel(distance, ready = false) {
  const d = Number.isFinite(distance) ? Math.max(0, Math.min(320, distance)) : 0;
  const progress = ready ? 1 : Math.min(.96, d / PULL_THRESHOLD);
  const reach = 22 + 64 * (1 - Math.exp(-d / 70));
  return {
    progress,
    reach,
    opacity: Math.min(1, d / 28),
    scale: .76 + .24 * Math.min(1, d / PULL_THRESHOLD) + (ready ? .04 : 0),
    dash: `${2 * Math.PI * 29 * progress} ${2 * Math.PI * 29}`,
  };
}

export const TENSION_CSS = `
.cs-tension{position:absolute;left:0;top:50%;width:560px;max-width:none;height:704px;transform:translateY(-50%);z-index:10;pointer-events:none;user-select:none}
.cs-tension[data-side=right]{left:auto;right:0}
.cs-tension svg{display:block;overflow:visible}
.cs-tension-head-svg{width:100%;height:100%}
.cs-tension-head{fill:var(--dsw-alias-bg-overlay);stroke:var(--dsw-alias-border-l1);stroke-width:1}
.cs-tension-track{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:2}
.cs-tension-progress{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:2.5;stroke-linecap:round}
.cs-tension-window{fill:none;stroke:var(--dsw-alias-label-primary);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.cs-tension-tile{fill:var(--dsw-alias-label-primary);stroke:none;opacity:.8}
`;
