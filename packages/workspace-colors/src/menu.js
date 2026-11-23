import { PALETTE } from '../palette.js';

export function createColorMenu({ workspaceId, current, t, save }) {
  const label = (name, chosen) => chosen ? `✓ ${t('selected', { name })}` : name;
  return [{
    id: 'color', label: t('menu'), icon: { key: 'workspace-colors.palette' },
    children: [
      { id: 'none', label: label(t('none'), current === null), icon: { key: 'workspace-colors.none' },
        failureLabel: t('failure'), run: () => save({ workspaceId, color: null, expectedColor: current }) },
      ...PALETTE.map(color => ({
        id: `msx-${color.index}`, label: label(t(color.name), current === color.index), separatorBefore: color.index === 1,
        icon: { key: 'workspace-colors.swatch', src: String(color.index) }, failureLabel: t('failure'),
        run: () => save({ workspaceId, color: color.index, expectedColor: current }),
      })),
    ],
  }];
}
