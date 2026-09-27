# Vast Settings rewrite final memory

Status: final implementation constraints for the Settings redesign and app-wide button refresh.

Date: 2026-09-14.

IMPORTANT CORRECTION, superseding earlier overly-conservative wording:

The Settings rewrite is NOT meant to preserve the old Settings visual structure with only light polish. The production Settings should visually match the approved live preview at `https://vastbrowser.com/settings-preview/` as closely as practical across the ENTIRE Settings experience, not only Appearance.

Preserve the existing categories, settings, values, persistence, feature gates and behavior, but REPLACE the old Settings presentation language broadly. Every section, including ordinary Security/Privacy/Advanced/Labs/Network/Developer/Site Data/Search/Automation/Workspaces/Shortcuts/Data controls, should adopt the preview's new visual system: wider shell, cleaner grouped surfaces, compact rows, preview-style controls, consistent alignment, contextual descriptions, refined sliders, updated buttons, and the same spacing/radius/surface hierarchy.

The old Settings UI is the functional source of truth. The approved live preview is the visual source of truth.

If old Settings visuals conflict with the preview, use the preview unless doing so would break functionality/accessibility.

---

## 1. Core scope

This is a full visual rewrite of the Settings UI while keeping the current product model and behavior.

Goals:

- make ALL Settings pages look like the approved preview, not just Appearance;
- preserve existing categories and controls but render them using the new preview visual language;
- make Settings wider, more deliberate and much cleaner;
- replace the old card/action/checkbox styling where it visibly belongs to the previous generation;
- improve grouping, spacing, alignment and hierarchy everywhere;
- add the real browser preview inside Appearance;
- refresh button styling across the app using shared primitives;
- remove visible explanatory clutter from ordinary settings rows;
- preserve behavior, validation, feature gates, persistence, search and instant-apply semantics.

This is NOT permission to invent new product categories or backend features. It IS permission to substantially replace the old Settings presentation layer.

---

## 2. No new Settings categories

Preserve the current Settings categories and their order from `SettingsModal.tsx`:

1. Appearance
2. Advanced
3. Labs
4. Network
5. Developer
6. Privacy
7. Spoofing
8. Security
9. Site Data
10. Search
11. Automation
12. Workspaces
13. Shortcuts
14. Data

Do not add design-only categories such as `Button system`.

Do not add a separate `Password Providers` sidebar category during this visual rewrite unless a separate product decision explicitly changes navigation.

The preview may contain design-only demonstration surfaces. Those are references, not new shipping categories.

---

## 3. Preview is the visual target

The live preview at:

`https://vastbrowser.com/settings-preview/`

is the authoritative visual reference.

The production implementation should match its:

- overall shell proportions;
- wider modal geometry;
- sidebar proportions;
- content spacing;
- section hierarchy;
- grouped surface treatment;
- ordinary setting-row geometry;
- visual selector cards;
- toggle/select/slider alignment;
- hover behavior;
- tooltip/contextual-help behavior;
- Dark/Dim/Light surface language;
- continuous radius behavior;
- button treatment;
- search-field styling;
- card spacing and borders;
- low-noise typography.

Do not merely copy the preview's Appearance page and leave all other sections looking like old Vast.

ALL Settings sections must be migrated to the same system.

Examples:

- Security checkboxes/toggles must look like preview rows and controls, not old Settings cards.
- Privacy controls must use preview grouping/rows.
- Advanced selects/sliders must use preview geometry.
- Labs controls must use preview surfaces.
- Network/Developer/Spoofing controls must use preview rows/cards where appropriate.
- Site Data/Search/Automation/Workspaces/Shortcuts/Data should all visually belong to the same redesigned Settings system.

The visual language must be coherent across the entire modal.

---

## 4. Preserve feature model and behavior

The redesign must not quietly create or remove functional settings.

Preserve:

- existing controls, values and defaults;
- persistence;
- validation;
- feature gates;
- Labs enable/disable behavior;
- Settings search;
- Workspaces behavior;
- Shortcuts behavior;
- Data/import/export flows;
- Site Data and permission handling;
- theme/layout/appearance semantics;
- keyboard access;
- accessibility names;
- instant apply.

Do not add a global Save/Cancel flow.

Do not redesign backend architecture.

Do not remove an existing feature just because the preview does not show it.

The existing app defines WHAT settings exist. The preview defines HOW they should look.

---

## 5. Overall geometry

The new Settings should be visibly larger and wider than the old modal and should resemble the live preview.

Direction:

- desktop-first;
- roughly ~1300-1360 px wide on large viewports where possible;
- navigation rail roughly ~240-250 px;
- broad content area around ~1050-1100 px max;
- more breathing room than old Settings;
- clear two-column composition where useful;
- ordinary controls remain compact;
- avoid accessibility-panel scale;
- avoid generic SaaS dashboard excess.

This should be a noticeable visual change, not a 5% padding adjustment.

---

## 6. Descriptions are contextual

Ordinary Settings should NOT permanently display a second descriptive line beneath each setting.

Default row:

`Setting name                                      [control]`

Descriptions should appear only as contextual help after deliberate hover/focus dwell.

Target:

- ~650-750 ms hover delay;
- compact Vast tooltip/popover;
- nearby positioning;
- disappear on pointer leave/scroll/focus loss;
- keyboard accessible;
- touch long-press where reasonable;
- safety-critical warnings remain visible when necessary.

Descriptions may remain in the semantic/search model.

This applies across ALL sections, not only Appearance.

---

## 7. Standard setting row system

Create a reusable redesigned Settings row primitive and use it broadly.

Ordinary controls such as:

- toggles;
- checkboxes;
- selects;
- sliders;
- text inputs;
- numeric values;
- buttons/actions;
- security/privacy options;

should use a consistent preview-like row system.

Target characteristics:

- compact height around ~50-56 px when possible;
- label aligned left;
- control aligned right;
- no permanent helper line;
- subtle hover surface;
- thin separators or grouped-surface boundaries;
- consistent right edge;
- no old oversized `.settings-action` card-button language unless semantically necessary;
- no random per-section styling.

Checkbox-like binary options may be represented with the same modern toggle/checkbox language used by the preview, provided semantics/accessibility remain correct.

The key requirement is visual consistency across every section.

---

## 8. Sections and grouped surfaces

Use the preview as the composition reference.

Sections should be grouped using:

- restrained section headings;
- spacing;
- preview-style cards/surfaces where a group needs containment;
- rows within those groups;
- thin borders;
- subtle surface contrast.

Do not keep old giant card-actions simply because the old implementation used them.

Do not put every individual setting in its own giant card.

The goal is the exact middle ground demonstrated by the preview: structured, calm, compact, visually grouped.

---

## 9. Appearance page

Appearance should match the preview especially closely.

Keep all real existing controls.

Visual selectors for:

- Horizontal / Vertical / Purist;
- Dark / Dim / Light / any real existing System option if present;
- Graphite / Midnight / Aurora / Violet / Carbon / Frost.

Do NOT invent replacement selector designs that diverge from the approved preview.

Selected visual cards:

- subtle accent border;
- faint selected surface/tint;
- no ugly detached radio bubble/check circle if the card itself already communicates selection;
- no layout shift;
- equal dimensions/alignment.

The theme/layout cards should be visually almost the same as the preview, not an unrelated interpretation.

---

## 10. Browser preview

Keep the new browser preview in Appearance.

It should resemble real Vast chrome and react to current appearance state.

Relevant inputs include:

- layout;
- theme;
- background preset;
- accent;
- secondary accent;
- background tint;
- surface tint;
- radius;
- glass;
- blur;
- glow;
- borders;
- shadows;
- gradients;
- panel/chrome opacity;
- saturation where relevant.

Keep it lightweight and driven by the same state/tokens.

---

## 11. Slider design

Sliders are the one area where current production Vast is the closer reference than the web preview.

Use the current `.settings-range-control` language and refine it.

Desired:

- thin ~0.44rem track;
- runtime accent progress;
- quiet neutral remaining track;
- small inset sheen;
- ~1.02rem thumb;
- white-to-accent thumb treatment;
- no rectangular wrapper around slider;
- no heavy value chip;
- value as clean muted text;
- consistent alignment;
- proper focus-visible only when focused.

Do NOT use browser-default range styling or chunky SaaS sliders.

---

## 12. Radius system

One continuous radius system must drive the entire redesigned modal.

Changing base corner radius must coherently affect:

- modal shell;
- grouped cards;
- nested surfaces;
- rows where applicable;
- visual tiles;
- search field;
- selects;
- buttons;
- preview chrome;
- nested modals/shared primitives.

Do not scatter arbitrary radii.

True circles stay circular.

---

## 13. Themes/colors

Use semantic Vast tokens.

Dark identity:
`#050507`

Dim identity:
`#151515`
neutral and flatter

Light identity:
`#E9EDF3`
crisp, cool-neutral, mostly opaque

Runtime accent is authoritative.

Current default accent:
`#D1A3FF`

Current default secondary accent:
`#79159D`

Current default background:
Carbon

Do not hardcode cyan because of legacy naming.

---

## 14. Button rewrite

The button rewrite is real and app-wide, but there is no Button System Settings category.

Create/refine shared semantic primitives such as `VastButton` and `IconButton`.

Visual direction:

- closer to the current vastbrowser.com button language;
- translucent/glassy dark surface;
- thin border;
- subtle top sheen;
- restrained accent response;
- clean typography;
- no default neon glow;
- compact/standard sizing inside Settings;
- tiny hover lift only where appropriate.

Variants:

- primary;
- secondary;
- ghost;
- selected/accent;
- danger;
- quiet;
- icon-only.

Settings buttons should visually match the preview's redesigned button examples, adapted for dense app UI.

Do not spend the task migrating every obscure button in the entire app before the Settings rewrite is actually complete.

Priority:

1. Settings;
2. shared dialogs/prompts used frequently;
3. high-visibility common buttons;
4. rest incrementally.

---

## 16. Search/navigation

Preserve the existing Settings search implementation and current section IDs.

Search must continue to open the right section after the visual rewrite.

Hidden descriptions may still be searchable metadata.

---

## 17. Audit-first implementation, implementation-first time budget

Before coding, do a focused visual audit of the current Settings implementation.

The audit should answer:

- which components/classes still render old Settings visuals;
- which sections use old `.settings-action` cards;
- which sections have bespoke checkbox/toggle/select styling;
- which sections are not using shared rows;
- which components prevent the preview visual system from being applied consistently;
- where shared primitives can replace repeated old markup.

Then IMPLEMENT the redesign.

Do not spend most of the work session writing audits, reports or tests.

The audit is preparation for code changes, not the deliverable.

---

## 18. Testing philosophy for this pass

Do NOT spend hours adding large new test suites before implementing the UI.

For this pass, use minimal verification sufficient to catch obvious breakage:

- typecheck / compile;
- existing relevant tests only if quick;
- renderer/app build if reasonably fast;
- open Settings;
- click every category;
- confirm controls still update state;
- confirm search still navigates;
- confirm Dark/Dim/Light render;
- confirm no obvious runtime errors.

Do NOT write thousands of new snapshot/unit tests.

Do NOT block implementation on exhaustive visual regression infrastructure.

The user will manually test/polish the result afterward.

Implementation quality and visual fidelity are the priority in this pass.

---

## 19. Explicit anti-failure rules

The implementation is WRONG if:

- only Appearance changes substantially;
- only the browser preview changes;
- Theme/Layout cards change but the rest of Settings still looks old;
- Security/Privacy/etc. keep old oversized cards/checkbox styling;
- old `.settings-action` visuals dominate most pages;
- the shell gets slightly wider but content components remain old;
- the result is described as a redesign but side-by-side screenshots look almost identical;
- GLM spends most of its time writing tests instead of changing UI;
- it invents new categories instead of restyling existing ones.

A successful implementation should make a side-by-side comparison of OLD SETTINGS vs NEW SETTINGS immediately and obviously different across every major category.

---

## 20. Acceptance criteria

The rewrite is ready for user testing when:

- every current Settings category still exists in the same order;
- every category visually belongs to the preview design system;
- ordinary settings use the redesigned row/group system;
- old card/action styling is removed or intentionally retained only where semantically justified;
- Security/Privacy/Advanced/Labs/Network/Developer/Spoofing/Site Data/Search/Automation/Workspaces/Shortcuts/Data all visibly changed;
- Appearance matches preview closely;
- visual selectors match preview closely;
- browser preview works;
- descriptions are hidden by default and contextual on hover/focus;
- sliders use refined current Vast styling;
- buttons use the new semantic family;
- Settings are wider and better aligned;
- runtime accent and radius still work;
- Dark/Dim/Light retain Vast identity;
- core controls still function;
- Settings search still works;
- no major runtime/type errors exist.

---

## One-line product intent

Keep Vast's existing Settings categories and behavior, but visually replace the old Settings UI across the entire modal with the approved preview design system, not merely a light polish of the old layout.
