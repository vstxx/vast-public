# Motion system

Vast's interface motion is small, purposeful and cheap at rest. This page is
for contributors adding or changing an animated surface.

## Levels

`Settings → Appearance → Motion` offers **Off**, **Standard** (default) and
**Enhanced**. They are stored as the existing `animations` boolean plus
`motionLevel` (`'standard' | 'enhanced'`), so Off is still `animations: false`
and profiles from older builds keep working (a missing `motionLevel` reads as
Standard). Visual Profiles carry the level from file version 2; version 1
files import as Standard.

`resolveMotionLevel` (`src/renderer/lib/motion.ts`) is the only place the
choice meets runtime constraints:

| Input | Result |
|---|---|
| Animations off, or `prefers-reduced-motion: reduce` | `off` |
| Enhanced on constrained graphics (low effects) | `standard` |
| Otherwise | the user's level |

Enhanced is never switched on automatically. The opening splash keeps its own
setting and is unaffected by the level.

The resolved level is set on `<html data-vast-motion>`. CSS uses it for the
motion tokens (`--vast-motion-press`, `--vast-motion-snap`,
`--vast-motion-swift`, `--vast-motion-sidebar`), and `off` collapses every
transition, including menus portaled outside `.app-shell`.

## Primitives

All in `src/renderer/lib/motion.ts`:

- **`usePresence(open)`** for a conditionally rendered surface. It returns
  `mounted`, `exiting` and `ref(kind)`. The logical state flips immediately.
  The DOM stays only while the exit plays, and during that time it is inert,
  pointer-transparent and has no `role`. Reopening mid-exit continues from the
  visible state.
- **`PresenceContext`** and **`useMotionRef(kind)`** for surfaces mounted by a
  parent. App wraps Settings, the command palette, the side panel and Smart
  Unload, and `ModalShell` registers its backdrop and panel through it.
- **`useRetained(value, mounted)`** keeps showing the last content while it
  exits, for example a context menu the store already cleared.
- **`useListPresence(items, key, kind, immediate)`** for keyed stacks such as
  notifications and downloads. Entries enter, removed entries withdraw in
  place, and the rest slide. Geometry is read only when the set of keys
  changes, never on progress updates.
- **`playMove(element, dx, dy)`** is a FLIP translation for an element that
  has already moved, such as pinning the side panel.

Tabs keep their own FLIP in `src/renderer/lib/tab-motion.ts`:

- Positions are captured inside the store update.
- Tabs only translate.
- Off-screen tabs are skipped.
- A closed tab withdraws as an inert snapshot while its neighbours close the
  gap.

Kinds and their Standard / Enhanced timings (ms) are below. Exits run at 0.7 ×
entry.

| Kind | Use | Standard | Enhanced |
|---|---|---|---|
| `menu` | anchored menus, dropdowns | 150 | 190 |
| `popover` | containers that may host web content (no scale) | 150 | 185 |
| `context` | right-click menus | 130 | 165 |
| `suggest` | address suggestions | 140 | 180 |
| `find` | find bar | 150 | 190 |
| `dialog` | modals, palette | 220 | 280 |
| `backdrop` | blurred dialog backdrops: not animated (re-blurring per frame drops frames), only inert while their dialog exits | – | – |
| `panel` / `docked` | side panels | 210 / 190 | 265 / 240 |
| `toast` | notification stack | 200 | 250 |
| reposition (FLIP) | tabs, workspace rows, pinning | 180 | 220 |

## Rules

- Animate `transform` and `opacity` only. Do not animate filters, blur,
  shadows or layout properties. Never add global `will-change` or permanent
  layer promotion.
- Logical state, focus, commands and navigation never wait for motion. Focus
  inputs in a layout effect, before the first paint.
- Exiting surfaces must not take input. `usePresence` handles this. Do not
  render click-away layers while exiting (render them from the logical
  `open`).
- Content that updates while a surface is open (search results, suggestions,
  progress) must not re-trigger motion.
- Security and update-critical notices appear without an entrance
  (`motionImmediate` on `ModalShell`, `immediate` in `useListPresence`).
- Never transform third-party extension content directly. Use `popover` (no
  scale) for Vast containers that host it.
- The vertical sidebar keeps the page at its final width while its own width
  transitions, so the page resizes once. Its labels return on `transitionend`,
  not by polling.

## Tests and measurements

- `tests/renderer/motion.test.ts`: levels, timings, interruption, fallback,
  immediate surfaces.
- `npm run test:motion:e2e`: the real app. It covers lifecycle, rapid input,
  notification stacks, focus and Escape, dropdown and context-menu placement,
  fast typing, tab FLIP, sidebar and side-panel page resizes,
  Horizontal/Purist menus, Off, reduced motion, and leftovers.
- `npm run performance:motion -- --label=<name> --modes=off,standard,enhanced`
  writes `performance-results/motion-<name>.json`. It records open/close
  latency, frame pacing, layout/style work, page resizes, idle CPU and memory,
  compositor layers and startup for every surface. Use `--modes=legacy` on
  builds from before the motion system.
