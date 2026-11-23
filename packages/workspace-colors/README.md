# MSX workspace colors

Right-click a Workspace header, or open its **…** menu, then choose **Workspace color · MSX** / **Цвет Workspace · MSX**. Select one of the 15 solid colors or **No color** / **Без цвета**. The current choice is marked with a check and a localized label.

The header gets a subtle 12% tint and a narrow color stripe. Its Session rows inherit a lighter 9% tint and an inset accent, based on exact Workspace membership. In grouped views, Session content and paint start one 12px step inside the owning Workspace's native tree depth; the row's full click/drag target stays unchanged. Flat lists keep their normal alignment. Hover, selection, focus, status dots and drag markers keep their native styling. Ungrouped sessions receive no invented Workspace color. Colors do not affect conversations, directory contents, titles or paths.

## Persistence

The Host saves Workspace-ID → palette-index records through `storageDomain`, in the `local_workspace_colors` domain. Saving completes only after durability is acknowledged. Pages share updates through an authenticated, owner-only Connection route and a cancellable change-driven long poll. No localStorage, session events, profile-patch rewrites, DOM observers or background scans are used. The shared DSH menu supplies positioning, keyboard navigation, touch dismissal and submenus (it is not a native operating-system menu).

The optional `workspace_colors` agent tool lists Workspace IDs and the palette, and calls the same Host operation as the UI. `set` accepts index 1–15 or `null` to reset. Optional `expectedColor` prevents stale overwrites.

## Chat Switcher

Chat Switcher 1.14.0 optionally consumes the Client `workspaceColorSource` read-only service. `getSnapshot()` returns an identity-stable immutable `{ generation, revision, colors }`, with Workspace IDs mapped to `#rrggbb` strings; `subscribe(listener)` returns an unsubscribe function. There are no mutation methods or palette/storage dependencies. Cards derive their owner from native Workspace membership and tint their outer background; the small Workspace caption uses the primary theme label to preserve contrast. Mosaics, task/status content, selection and transitions remain unchanged. Late activation, reset and plugin withdrawal update consumers without copying saved state.

## Compatibility and implementation

Tested against installed DSH **0.2.2-rc.3**; the engine is pinned to that version. The context-menu API and additive slots are public. This DSH version has no additive Workspace row-appearance slot, so a component-owned stylesheet targets the inspected row markers `[data-sidebar-list-area] [data-row-key="workspace:ID"]` and `[data-row-key="session:ID"]`. Grouped indentation follows the inspected native `--dsh-workspace-indent` container, not title/path guesses or DOM scans. No component is replaced and no DOM is imperatively modified. The row-key detail must be rechecked when upgrading DSH; no version exemption is appropriate without that review. Host theme tokens supply neutral borders; literal sRGB colors are the requested MSX swatches and accents.

Palette values: [MSX programmers palette](https://paulwratt.github.io/programmers-palettes/HW-MSX/HW-MSX-palettes.html). Index 0 is transparent and is represented by reset; black retains the reference's #010101 adjustment. The folder-and-swatches icon is original MIT-licensed artwork.

## Development

`node build.mjs` builds the ModuleLoader artifact with React as its sole import. `node --test test/*.test.mjs` checks persistence operations, conflicts, missing Workspaces, failure behavior, menu targets, palette values, safe CSS and cancellation. Tests never emulate React/DOM or launch a browser.

The read-only Client Inspect provider `WorkspaceColors.status` reports loaded version, registrations, stream state and aggregate real-page style matching. It is not a screenshot or a visual review.
