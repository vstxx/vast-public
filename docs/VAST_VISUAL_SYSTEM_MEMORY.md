# Vast visual system memory

Status: working design-system memory for the Settings + global button rewrite

Snapshot: 2026-09-14, based on current `master`

Primary sources:
- `src/renderer/styles/index.css`
- `src/renderer/app/App.tsx`
- `src/shared/constants.ts`
- `tailwind.config.ts`
- `src/renderer/components/settings/SettingsModal.tsx`
- `src/renderer/components/ui/IconButton.tsx`
- `src/renderer/components/ui/PromptDialog.tsx`
- `src/renderer/components/ui/NotificationsOverlay.tsx`
- `src/renderer/components/tabs/Sidebar.tsx`
- `src/renderer/components/purist/purist.css`
- `src/preload/guest.ts`

This note is intentionally about the core Vast browser UI. It does not treat the public website, Relay Control Panel, IDU+, screenshot fixtures, or other separately branded surfaces as design-system sources. Video & Audio may visually live inside Vast, but its standalone Flask/CSS bundle should not override the core browser token system.

---

## 1. What makes Vast look like Vast

Vast is not a generic black dashboard and it should not become one during the Settings rewrite.

The current visual identity is built from:

1. A near-black canvas in Dark, not pure black everywhere.
2. Very quiet translucent surfaces and thin borders.
3. Inter as the UI typeface.
4. A user-controlled runtime accent. The default user accent is currently lilac, not the older cyan fallback.
5. Large continuous corner-radius scaling rather than unrelated radii.
6. Low-contrast chrome with restrained highlights.
7. Accent used mostly for focus, selected state, progress, active icons and important actions rather than painting every card.
8. Dark has subtle atmosphere. Dim is deliberately flatter and neutral. Light is deliberately opaque and crisp rather than milky glass.
9. Hover states are generally a small surface lift or opacity increase, not loud gradients.
10. Most of the interface feels soft because of spacing, radius, typography and translucency, not because of excessive glow.

The rewrite should keep those principles even if component geometry changes.

---

## 2. Two accent systems currently coexist

This distinction is important.

### CSS / legacy fallback accent

These exist in `:root` and Tailwind legacy tokens:

- Primary fallback accent: `#74E7FF`
- Secondary fallback accent: `#B86CFF`
- Legacy blue: `#89A7FF`
- Legacy lilac: `#B7A7FF`
- Amber: `#F0B86B`

### Actual default persisted appearance

`DEFAULT_SETTINGS` currently ships with:

- `accentColor`: `#D1A3FF`
- `secondaryAccentColor`: `#79159D`
- `backgroundTintColor`: `#000000`
- `surfaceTintColor`: `#1D1127`
- background style: `carbon`

The application writes these values into CSS variables at runtime. Therefore new UI must use `var(--vast-accent)` and `var(--vast-accent-secondary)` rather than assuming Vast is cyan.

Classes such as `bg-vast-cyan` and `text-vast-cyan` are legacy names. Inside `.app-shell`, shared CSS already remaps them to the runtime accent. New component APIs should stop thinking in terms of a fixed cyan color.

### Rule

Do not introduce new hardcoded `#74E7FF` UI simply because old classes are called `vast-cyan`. Treat the runtime accent as the source of truth.

---

## 3. Canonical semantic palette

The semantic token layer in `src/renderer/styles/index.css` is the closest thing Vast currently has to a canonical design system.

### Dark

Dark is the base `:root` theme.

| Token / role | Value |
| --- | --- |
| Canvas | `#050507` |
| Subtle background | `#090A0E` |
| Surface 1 | `rgba(255,255,255,0.055)` |
| Surface 2 | `rgba(255,255,255,0.09)` |
| Elevated surface | `rgba(12,13,18,0.98)` |
| Border subtle | `rgba(255,255,255,0.08)` |
| Border default | `rgba(255,255,255,0.14)` |
| Border strong | `rgba(255,255,255,0.22)` |
| Text primary | `#F5F7FB` |
| Text secondary | `#B4BBC8` |
| Text tertiary | `#929AAA` |
| Text disabled | `#717887` |
| Text inverse | `#11141A` |
| Hover state | `rgba(255,255,255,0.09)` |
| Active state | runtime accent at 17% mixed with Surface 1 |
| Success | `#64D99A` |
| Warning | `#F0B86B` |
| Danger | `#FF858D` |
| Info | `#74CFFF` |
| Legacy/fallback bg tint | `#06121B` |
| Legacy/fallback surface tint | `#151923` |
| Panel | `rgba(8,9,13,0.90)` |

Dark shadows:
- small: `0 5px 16px rgba(0,0,0,0.20)`
- medium: `0 14px 40px rgba(0,0,0,0.30)`
- large: `0 28px 84px rgba(0,0,0,0.42)`

Dark is where low-opacity white surfaces, controlled blur and subtle tint are allowed to do most of the depth work.

### Dim

Dim is intentionally neutral grey rather than a brighter Dark theme.

| Token / role | Value |
| --- | --- |
| Canvas | `#151515` |
| Subtle background | `#1B1B1B` |
| Surface 1 | `rgba(255,255,255,0.065)` |
| Surface 2 | `rgba(255,255,255,0.10)` |
| Elevated surface | `#292929` |
| Border subtle | `rgba(255,255,255,0.08)` |
| Border default | `rgba(255,255,255,0.14)` |
| Border strong | `rgba(255,255,255,0.22)` |
| Text primary | `#F2F2F2` |
| Text secondary | `#B8B8B8` |
| Text tertiary | `#999999` |
| Text disabled | `#737373` |
| Hover state | `rgba(255,255,255,0.08)` |
| Background tint | `#181818` |
| Surface tint | `#262626` |
| Panel | `rgba(27,27,27,0.94)` |

Dim deliberately reduces atmospheric effects:
- address-panel mix: `72%`
- focus-panel mix: `68%`
- border mix: `34%`
- border soft mix: `22%`
- address border mix: `20%`
- focus border mix: `18%`
- glow mix: `3%`
- soft glow mix: `1%`
- gradient mix: `2%`
- gradient soft mix: `1%`
- gradient strong mix: `4%`

Dim shadows are shallow:
- small: `0 2px 7px rgba(0,0,0,0.12)`
- medium: `0 6px 18px rgba(0,0,0,0.15)`
- large: `0 12px 34px rgba(0,0,0,0.20)`

Specific Dim surfaces currently used:
- glass panel: `#242424`
- address bar: `#232323`
- Settings shell: `rgba(31,31,31,0.98)` / effectively `#1F1F1F`
- command palette: `rgba(31,31,31,0.98)`
- side panel: `#1D1D1D`
- horizontal chrome: `#1F1F1F`
- bookmarks bar: `#1F1F1F`
- main browser surface: `#1D1D1D`
- select menu / native option background: `#272727`

Dim should stay flatter than Dark after the rewrite. Do not add Dark-style purple/cyan haze to it.

### Light

Light is intentionally an opaque cool-neutral system.

| Token / role | Value |
| --- | --- |
| Canvas | `#E9EDF3` |
| Subtle background | `#DDE3EB` |
| Surface 1 | `#F7F9FC` |
| Surface 2 | `#FFFFFF` |
| Elevated surface | `#FFFFFF` |
| Border subtle | `rgba(15,23,42,0.15)` |
| Border default | `rgba(15,23,42,0.24)` |
| Border strong | `rgba(15,23,42,0.38)` |
| Text primary | `#101827` |
| Text secondary | `#455269` |
| Text tertiary | `#5C687B` |
| Text disabled | `#8490A2` |
| Text inverse | `#F8FAFC` |
| Hover state | `rgba(15,23,42,0.075)` |
| Active state | runtime accent at 15% mixed into white |
| Panel | `#F8FAFC` |

Light shadows:
- small: `0 5px 16px rgba(15,23,42,0.10)`
- medium: `0 14px 38px rgba(15,23,42,0.14)`
- large: `0 28px 72px rgba(15,23,42,0.18)`

Specific Light surfaces currently used:
- Settings shell gradient: `#F9FAFC -> #EDF1F6`
- Settings cards: `#F8FAFC`, hover `#FFFFFF`
- inputs/select buttons: `#FFFFFF`
- select hover: `#EEF2F7`
- generic dark utility replacement: `#F5F7FA`
- `bg-black/*` replacement: `#E6EBF2`
- side panel gradient: `#F9FBFD -> #EDF1F6`
- horizontal chrome: `#F5F7FA`
- bookmarks bar: `#F5F7FA`
- main browser surface: `#F7FAFC -> #E7EDF5`
- native option text/background: `#111827 / #FFFFFF`

Important: Settings in Light intentionally disable glass blur. Keep that. A translucent milky Settings redesign would be a regression against the current direction.

---

## 4. Current runtime appearance defaults

Current persisted defaults in `src/shared/constants.ts`:

- theme: Dark
- accent: `#D1A3FF`
- secondary accent: `#79159D`
- background tint: `#000000`
- surface tint: `#1D1127`
- background style: Carbon
- corner radius: `26px`
- glass: `100`
- blur: `76`
- glow: `1`
- borders: `46`
- shadows: `4`
- gradients: `52`
- panel opacity: `78`
- chrome opacity: `84`
- saturation: `100%`

With the formulas in `appearanceStyle()`, these defaults approximately resolve to:

- base radius: `26px`
- blur: `32px`
- saturation: `1.00`
- panel mix: `91%`
- address panel mix: `80%`
- focus panel mix: `72%`
- surface mix: `90%`
- border mix: `39%`
- border soft mix: `26%`
- address border mix: `25%`
- focus border mix: `23%`
- glow mix: `2%`
- soft glow mix: `1%`
- focus glow mix: `4%`
- general shadow alpha: `0.097`
- address shadow alpha: `0.073`
- focus shadow alpha: `0.085`
- gradient mix: `11%`
- gradient soft mix: `6%`
- gradient strong mix: `22%`
- chrome alpha: `0.900`
- chrome mix: `90%`
- sheen alpha: `0.084`
- soft sheen alpha: `0.048`

This explains why current Vast is softer than the raw `:root` fallbacks suggest. The runtime settings matter.

---

## 5. Appearance background presets

These should remain recognizably the same even if the picker UI is rewritten.

### Graphite

The default/base app surface uses runtime accent, secondary accent and background tint over `--vast-ink -> --vast-bg`.

### Midnight

Additional colors:
- blue energy: `#2347FF`
- deep blue-black: `#07101D`

### Aurora

Additional color:
- green energy: `#00FFA8`

Uses runtime primary and secondary accents heavily.

### Violet

Additional colors:
- pink-violet: `#FF4FD8`
- deep violet-black: `#0D0718`

### Carbon

The current default appearance preset.

- upper dark: `#07080A`
- lower dark: `#030304`

Only a very small runtime-accent haze is added. Carbon is the cleanest representation of the current default Vast vibe.

### Frost

Uses runtime accent + secondary accent and mixes the theme background toward white. It is the lightest atmospheric preset.

---

## 6. Important legacy / hardcoded dark neutrals

Core renderer code still contains hardcoded Tailwind/arbitrary dark values. These are part of the current look, but new rewritten components should migrate away from depending on them directly.

Common values:
- `#050507` main black canvas
- `#06070A` internal/lab page black
- `#07080A` Carbon upper surface
- `#07080B` horizontal chrome
- `#08090B` opening gradient
- `#08090D` sidebar / error/internal surfaces
- `#090A0D` menus and split-view chrome
- `#090A0E` semantic subtle background
- `#0A0B0F` legacy Tailwind ink
- `#0B0C10` download toast surface
- `#0C0D12` elevated dark surface / Smart Unload
- `#0D0E13` Find bar / elevated chrome
- `#111218` legacy Tailwind panel
- `#11121A` extension-toolbar mix target
- `#12131A` Smart Unload hover
- `#171922` legacy Tailwind panel2
- `#252834` legacy Tailwind line

The theme CSS has broad compatibility selectors that translate several of these hardcoded dark classes into Light and Dim surfaces. That compatibility layer is useful, but it is also evidence of color debt.

New Settings and new buttons should use semantic variables from day one so another override matrix is not required.

---

## 7. Other identity colors worth preserving or consciously migrating

### Tailwind legacy Vast palette

`tailwind.config.ts` still defines:

- black `#050507`
- ink `#0A0B0F`
- panel `#111218`
- panel2 `#171922`
- line `#252834`
- soft `#9AA0AD`
- bright `#F3F5F8`
- cyan `#74E7FF`
- blue `#89A7FF`
- lilac `#B7A7FF`
- amber `#F0B86B`

The new design system should consider these legacy aliases, not the preferred source of truth.

### Opening sequence

The opening animation deliberately uses a darker cinematic palette than normal chrome:

- `#030406`
- `#06070A`
- `#08090B`
- glow purple around RGB `(91,64,168)` / `#5B40A8`
- deeper glow around RGB `(42,25,82)` / `#2A1952`

Do not make Settings inherit this cinematic treatment.

### Body ambient glow

The root body still has hardcoded low-opacity cyan and lilac atmosphere based on `#74E7FF` and `#B7A7FF`. This is a legacy split from the user-controlled accent system. It is subtle enough to keep for now, but a future cleanup may convert it to runtime accent variables.

---

## 8. Purist theme colors

Purist intentionally has its own glass treatment and should not be accidentally flattened by the global button rewrite.

### Dark Purist

Expanded/collapsed chrome is based on `rgba(3,4,7,~0.72-0.76)` with white sheens around `0.045-0.085` and black shadows around `0.24-0.34`.

### Dim Purist

- base glass: `rgba(29,29,29,0.62)`
- collapsed island: `rgba(29,29,29,0.56)`
- borders around white `0.055-0.075`

### Light Purist

- glass base around `rgba(241,245,249,0.52-0.58)`
- white overlay around `0.68-0.78`
- active tab can reach `rgba(255,255,255,0.76)`
- shadows use dark slate RGB `(15,23,42)`

Purist buttons are more transparent than normal controls. Its icon buttons are intentionally borderless at rest and only receive a faint surface on hover/focus.

---


## 10. Smart Unload explicit palettes

Smart Unload is one of the few features with explicit tested surfaces per theme.

Dark:
- panel `#050507`
- surface `#0C0D12`
- hover `#12131A`
- muted surface `#090A0E`
- border `rgba(255,255,255,0.09)`

Dim:
- panel `#1B1B1B`
- surface `#242424`
- hover `#2B2B2B`
- muted surface `#171717`
- border `rgba(255,255,255,0.12)`

Light:
- panel `#F7F9FC`
- surface `#FFFFFF`
- hover `#EEF2F7`
- muted surface `#F1F4F8`
- border `rgba(15,23,42,0.16)`

There are regression tests around these values. Any global button/surface rewrite must either preserve them or update the tests deliberately.

---

## 11. Typography and density

Core font: Inter Display / Inter stack.

Semantic sizes:
- caption: `13px` (`0.8125rem`)
- body: `14px` (`0.875rem`)
- strong body: `15px` (`0.9375rem`)
- title: `18px` (`1.125rem`)

Control heights:
- small: `32px`
- medium: `40px`
- large: `48px`

Do not make the Settings rewrite look like a mobile accessibility panel. Vast should stay compact, readable and desktop-first. Use 13-14 px for ordinary control labels and descriptions, with larger type reserved for page/section hierarchy.

---

## 12. Radius system

Current base radius: `26px`.

Every major radius is derived from it:

- micro: base × `0.16` ≈ `4.2px`
- checkbox: base × `0.28` ≈ `7.3px`
- swatch: same as checkbox
- control: base × `0.54` ≈ `14px`
- card: base = `26px`
- panel: base × `1.15` ≈ `30px`
- modal: base × `1.30` ≈ `34px`

The Appearance setting allows base radius from 6 to 36 px.

### Rewrite rule

Buttons should normally use `--vast-radius-control`, not `--vast-radius-card`. Large visual selectors/cards can use card radius. Modals use modal radius. Keep the single continuous scale so Corner radius continues to change the entire product coherently.

---

## 13. Motion and focus

Current motion tokens:

- snap: `140ms cubic-bezier(.2,.8,.2,1)`
- swift: `220ms cubic-bezier(.2,.8,.2,1)`
- gentle: `280ms cubic-bezier(.22,1,.36,1)`
- page: `420ms cubic-bezier(.16,1,.3,1)`

Global focus uses the runtime accent with a two-stage ring.

The rewrite must continue respecting:
- user Animations setting
- `prefers-reduced-motion`
- `prefers-reduced-transparency`
- constrained-GPU / low-effects mode

Buttons should not introduce constant bouncing. A hover color/border change is usually enough. If movement is used, keep it to at most ~1 px and avoid it for dense Settings rows.

---

## 14. Current button system audit

There is not one button system today. There are several overlapping styles.

### Shared `IconButton`

Current default:
- 36 × 36
- control radius
- border: white at ~4.5%
- background: white at ~2.6%
- muted text
- subtle top inset highlight

Hover:
- border ~12% white
- background ~8.5% white
- text becomes white
- shadow/elevation appears

Active:
- runtime accent border around 35%
- runtime accent background around 10%
- accent-colored icon/text
- glow

This is close to Vast's desired language, but still depends on white-alpha utilities instead of semantic button tokens.

### Settings action buttons

`.settings-action` currently behaves like a large card-button:
- min height `68px`
- card radius
- faint white gradient
- low-opacity Vast background
- 14 px text, weight 600

This is one of the main things to reconsider. Many Settings actions do not need to look like large dashboard cards.

### Prompt / modal buttons

Several prompt components use:
- secondary: white-alpha background/border
- primary: full `bg-vast-cyan` / runtime accent with dark text
- danger: rose-tinted background

This makes primary buttons much louder than ordinary Vast chrome.

### Sidebar buttons

Sidebar has its own hand-built variations:
- 36 px IconButton
- command button with white ~3.5% fill
- New Tab button with white ~4.5% fill
- tiny collapse affordance with almost no background

### Purist buttons

Purist is intentionally quieter:
- transparent at rest
- faint border/surface only on hover/focus
- no strong default shadow

### Extension toolbar buttons

Already closer to a semantic model:
- primary = accent-tinted surface, accent text and accent border
- secondary = quiet translucent neutral surface

This is a good conceptual direction for the global rewrite.

---

## 15. Proposed global button rewrite

The button rewrite should happen as a system, not as hundreds of one-off Tailwind edits.

### Components

Create one shared text-button primitive, for example `VastButton`, and evolve `IconButton` into the same token family.

Recommended variants:

1. `primary`
   - for the single most important action in a context
   - accent-tinted or full accent depending prominence
   - never assume cyan

2. `secondary`
   - ordinary actions
   - theme surface + subtle border

3. `ghost`
   - chrome/toolbars/close/back/tiny actions
   - transparent rest state, faint hover surface

4. `selected`
   - toggle-like active state
   - accent-tinted background + accent/primary text
   - distinct from a primary CTA

5. `danger`
   - semantic danger token, not arbitrary rose classes

6. `quiet`
   - nav rows and dense list actions
   - no border at rest; surface only on hover/active

### Recommended sizes

Keep size decisions aligned with existing density tokens:
- compact: 32 px
- standard: 36-40 px depending context
- large: 44-48 px only when genuinely needed
- icon-only chrome: usually 32 or 36 px

Settings should mostly use compact/standard buttons. Do not turn every setting action into a 68 px card.

### Default visual treatment

For normal Dark buttons:
- no decorative gradient
- background around Surface 1 / a low-opacity neutral mix
- 1 px subtle border
- primary text
- no default glow
- optional tiny inset top sheen

Hover:
- slightly stronger surface
- border moves toward strong border
- no large shadow bloom

Pressed:
- slightly darker / more solid surface
- no translation required

Focus:
- use the existing global accent focus ring

Disabled:
- no hover
- semantic disabled text
- reduced opacity

### Primary actions

Most Vast primary actions should prefer an accent-tinted surface rather than a huge flat neon fill. A fully solid accent button is acceptable when there is one obvious confirmation action, but should not appear repeatedly in dense Settings.

Reason: the default accent is user-customizable. A tinted treatment is more robust across very bright, dark, saturated and unusual custom accents.

### Danger actions

Use `--vast-color-danger` and a danger-tinted surface. Do not use miscellaneous `rose-*` utility colors across new code.

### State colors

Use semantic state tokens:
- success `#64D99A`
- warning `#F0B86B`
- danger `#FF858D`
- info `#74CFFF`

Existing notification code still uses Tailwind emerald/amber/rose/sky colors. That is legacy color debt and a good candidate to migrate after the main button primitive exists.

---

## 16. Settings rewrite: visual rules

The inspiration image is useful for hierarchy and visual selectors, but the result must still feel like Vast.

### Keep from current Vast

- Dark near-black base.
- Existing theme semantics.
- Current runtime accent/tint system.
- Inter.
- Continuous radius scale.
- Settings search.
- Instant-apply behavior.
- Existing feature behavior and validation.
- Theme differences: atmospheric Dark, flat Dim, opaque Light.
- Keyboard focus and reduced-motion/transparency behavior.

### Take from the inspiration

- Better visual hierarchy.
- Visual pickers for settings where seeing the option matters.
- More deliberate grouping.
- Cleaner whitespace.
- A useful browser preview for appearance changes.
- Strong page/section composition rather than a giant undifferentiated settings grid.

### Do not copy from the inspiration

- Do not make every option a large card.
- Do not create a dashboard of nested boxes.
- Do not add marketing copy inside Settings.
- Do not add decorative icons everywhere just to fill space.
- Do not invent a separate color language that ignores Vast theme tokens.
- Do not turn Dim into a purple version of Dark.
- Do not make Light translucent/glassy.

### Settings copy tone

Keep copy functional and short.

Good:
- `Corner radius`
- `Sidebar width`
- `Force dark mode on websites`
- `Clear cookies on exit`

Use descriptions only when behavior is not obvious or has a privacy/security consequence.

Avoid lines such as:
- “Make Vast truly yours.”
- “Fine-tune your browsing experience.”
- “Your browser, your way.”

The current Settings header subtitle `Customize Vast without sending data anywhere.` is factually aligned with Vast but not necessary for the new layout. The rewrite can simply use `Settings` or a short section-specific description.

---

## 17. Settings rewrite: component model

Recommended layout model:

### Left navigation

Preserve search and clear section navigation. Navigation rows should be quiet buttons, not card-buttons.

### Main page

Use a page title and optional one-line description.

### Visual choice cards

Use only for:
- layout
- theme
- appearance background
- possibly New Tab layout
- other settings where visual comparison is materially useful

Selected state:
- accent border/tint
- subtle check/indicator
- no giant glow

### Ordinary setting rows

Use a compact row for:
- toggle
- select
- slider
- input
- button/action

A row should usually be approximately 52-60 px tall unless it includes a real explanatory description.

### Sections

Separate groups with spacing and headings before adding more outer cards. Use cards only when the group itself needs a surface.

### Save behavior

Keep instant apply. Do not add global Save/Cancel to Settings.

### Preview

Appearance should have a real visual preview, but it must resemble Vast's actual chrome:
- current horizontal layout
- vertical layout
- Purist when experimental features are enabled
- address bar
- tabs
- sidebar / side panel where relevant
- Carbon/default canvas

The preview should respond to:
- theme
- layout
- background preset
- accent
- secondary accent
- background tint
- surface tint
- radius
- glass
- blur
- glow
- borders
- shadows
- gradients
- panel/chrome opacity
- saturation

---


## 19. Theme and color debt to address while rewriting

The rewrite is a good time to reduce visual debt without attempting a risky all-app refactor at once.

### High priority

1. New Settings code should use semantic tokens only.
2. New global button primitive should use semantic tokens only.
3. Replace direct `bg-vast-cyan` assumptions in the new button system with runtime accent semantics.
4. Keep radius controlled by the existing global base radius.
5. Keep theme-specific surfaces centralized.

### Medium priority

1. Replace hardcoded dark background classes in frequently touched shared UI with semantic surfaces.
2. Move notification status colors toward semantic success/warning/danger/info tokens.
3. Reduce component-local white-alpha button recipes after `VastButton` exists.
4. Consider moving body ambient cyan/lilac glow to runtime accent/secondary variables.

### Do not bundle blindly

Do not rewrite every internal page, Purist, Smart Unload in the same PR just because the new button primitive exists. Introduce the primitive, migrate high-visibility surfaces first, keep regression coverage, then expand.

---

## 20. Golden rules for the upcoming work

1. `#050507` is the Dark identity canvas.
2. `#151515` is the Dim identity canvas.
3. `#E9EDF3` is the Light identity canvas.
4. Runtime accent is authoritative; fixed cyan is not.
5. Current default accent is `#D1A3FF`.
6. Current default background preset is Carbon.
7. Dark may have atmosphere; Dim should stay neutral; Light should stay opaque.
8. Use thin borders and controlled surfaces before adding shadow/glow.
9. Accent is a signal, not wallpaper.
10. One continuous radius system must survive the rewrite.
11. Most buttons use control radius, not card radius.
12. Settings should get more structured, not more boxed-in.
13. Visual selectors only where a visual preview adds value.
14. Ordinary settings stay compact rows.
15. No global Save/Cancel; keep instant apply.
16. No generic AI-product copy.
17. Preserve keyboard/focus/accessibility behavior.
18. Preserve reduced-motion/reduced-transparency behavior.
19. Build buttons as shared primitives before manually restyling the entire app.
20. Remove visual inconsistency gradually, without turning the redesign into a backend refactor.

---

## 21. Files most likely to change in the rewrite

Settings:
- `src/renderer/components/settings/SettingsModal.tsx`
- `src/renderer/components/settings/settings-search.ts`
- `src/renderer/styles/index.css`
- potentially new Settings-specific components under `src/renderer/components/settings/`

Shared button system:
- `src/renderer/components/ui/IconButton.tsx`
- new `src/renderer/components/ui/VastButton.tsx` or equivalent
- `src/renderer/styles/index.css` for shared button tokens/states

First migration targets after the primitive exists:
- Settings actions/nav
- PromptDialog
- NotificationsOverlay / ActionPromptModal
- Sidebar actions
- ContextMenu actions where applicable
- browser toolbar/chrome actions

Special surfaces to verify but not casually flatten:
- `src/renderer/components/purist/purist.css`
- Smart Unload styles in `src/renderer/styles/index.css`
- `src/preload/guest.ts`

Regression/test areas:
- Settings search
- dropdown/select behavior
- visual polish/theme tests
- Smart Unload theme tests
- Purist layout tests
- reduced motion/transparency behavior

---

## 22. Practical rewrite acceptance criteria

The rewrite is successful only if:

- Dark still immediately reads as Vast, not a generic black SaaS dashboard.
- Dim is visibly different from Dark and does not inherit Dark haze.
- Light looks intentional rather than like Dark with colors inverted.
- Changing the global accent updates all new Settings and button states coherently.
- Changing Corner radius visibly affects rewritten controls without geometry breakage.
- Buttons across Settings, prompts and chrome share the same state model.
- There is no new fixed-cyan dependency in shared components.
- There are fewer one-off button class strings than before.
- Keyboard focus remains obvious.
- Dense Settings content becomes easier to scan without becoming oversized.
- Appearance gets better visual controls without turning every setting into a card.
- No old functionality is lost just because the presentation changed.

This file should be treated as the design memory for the Settings + button rewrite until the new system itself becomes the source of truth.
