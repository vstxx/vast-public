# Purist layout

`purist` is the third `LayoutMode`, alongside `vertical` and `horizontal`. It is an experimental layout: Settings exposes it only while **Experimental features** is enabled. Disabling Experimental features while Purist is active safely returns the browser to `horizontal`. The same rule is enforced by the renderer, store, and persisted-settings sanitizer, so stale profiles cannot bypass it.

Purist renders its browser chrome as a `Topbar Island` overlay. The page always occupies the full browser stage behind it. The island is collapsed by default to a narrow pill containing only the current host. Clicking it, focusing the address bar, switching tabs, or loading a page expands the full controls. Clicking the page, pressing Escape, or leaving the controls idle collapses it again.

The layout is composed from:

- `PuristChrome` - the Topbar Island state, activity rules, and floating overlay shell.
- `WindowControls` - Vast-owned Windows minimize, maximize/restore, and close controls inside the expanded island.
- `BrowserStage` - reveals a black, browser-owned safe scroll space (50px compact / 150px expanded) only after the user overscrolls upward beyond the page's top boundary, without modifying page DOM.
- `PuristTabStrip` and `PuristTab` - horizontal tabs with hidden native scrollbars, smooth wheel scrolling, active-tab reveal, pinned-tab compaction, drag/reorder, tear-out, context menus, and middle-click close.
- the shared `AddressBar` in its `purist` variant, preserving navigation, suggestions, site information, browser tools, and keyboard focus behavior.
- the shared workspace popover and bookmarks bar in their `purist` variants, preserving the existing actions and overflow logic while removing the classic heavy bar treatment.

Visual rules live under `.layout-purist` / `.purist-*` selectors. Reduced motion continues to use the global `.no-motion` policy, and reduced transparency removes Purist blur. Narrow windows reduce tab and control widths without changing the underlying actions.
