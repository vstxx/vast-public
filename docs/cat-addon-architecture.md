# Cat Addon architecture

## Historical art and provenance

The implementation was developed for a `Cat_Grey_White` character from `assets/cat-addon/Cat_85_Animations.zip`. That archive and every derived image/package are intentionally absent from the public source export because no redistribution permission was recorded. The descriptions below document the retained implementation and pipeline; they do not indicate that the artwork is available or licensed.

The former archive contained no license, author, source URL, or redistribution grant. The provenance record at `third_party/cat_85_animations/README.vast.md` records the exclusion. Technical validation succeeding would not grant permission to distribute the art.

## Deterministic asset pipeline

With a properly licensed replacement archive in the documented format, run `npm run cat-addon:assets` to regenerate assets or `npm run cat-addon:check` to verify outputs without rewriting them. These commands intentionally fail in a clean public checkout until such an archive is supplied. The Python builder uses a minimal, bounded Aseprite parser; Aseprite itself is not required.

The builder:

1. reads `Cat_Grey_White.aseprite` directly from the ZIP;
2. verifies 483 RGBA frames at 32 × 32, one visible image layer, one compressed cel per frame, 94 valid tags, and positive durations;
3. decodes every source cel and compares it pixel for pixel with the 483 occupied cells in the supplied PNG;
4. rejects empty frames, opaque background rectangles, unexpected geometry, invalid ranges, or stale curated mappings;
5. packs 294 unchanged source frames used by 49 curated animations into a 512 × 608 runtime atlas;
6. writes per-frame duration, source frame, atlas coordinate, loop mode, anchor, baseline, facing, cancellability, and roles;
7. generates a 94-tag development atlas/metadata set and a curated contact sheet; and
8. writes deterministic PNG/JSON outputs atomically.

When generated from licensed artwork, the production archive contains only:

- `manifest.json`;
- `animations/animations.json`;
- `assets/cat_grey_white.png`.

`scripts/build-cat-addon-archive.cjs` creates a deterministic `resources/cat-addon/cat_addon.zip`, its SHA-256, and the compiled expected-hash constant. Contact sheets, the full source atlas, original ZIP, Aseprite files, and unused characters are not part of the runtime archive.

## Developer preview

Run `npm run cat-addon:studio`, then open `http://localhost:4174/tools/cat_addon/studio.html`. This standalone development page is not linked from Vast or copied into the packaged app. It previews all 94 source tags with actual timing, play/pause, frame stepping, cancellation, 1×/2×/3× integer scales, light/dark backgrounds, facing, clipping, bounds, baseline and anchor guides, plus source sequences used by final Vast scenes.

The generated contact sheet is `assets/cat-addon/generated/contact-sheet.png`.

## Installation and security boundary

`CatAddonManager` owns archive verification, strict ZIP parsing, extraction, installed-file revalidation, repair, operation serialization, and removal under `<active Vast userData>/CatAddon/2.0.0/`. It rejects traversal, absolute/drive/backslash paths, control characters, duplicate normalized paths, links and special files, encryption, unsupported compression, CRC disagreement, undeclared files, excessive sizes/counts, invalid PNG geometry, invalid animation metadata, and manifest/hash disagreement.

Enable extracts to a temporary sibling, validates it, and atomically activates it. Disable wins over an in-flight install, clears the cached data URL/metadata, cancels renderer layers through state propagation, and removes extracted assets. A bounded pending-cleanup marker makes deletion retryable after file locking. Separate Vast data roots remain isolated.

The narrow trusted IPC bridge returns only a validated in-memory PNG data URL and parsed metadata after the addon is enabled. It never exposes an extracted path or executable content.

## Renderer and scene engine

The renderer is split into four responsibilities:

- `CatSpriteAtlas` resolves validated animation metadata.
- `CatAnimator` honors per-frame durations, cycles, reverse and ping-pong order, immediate cancellation, completion safety, and hidden-window suspension.
- `CatActor` owns visibility, position, facing, stable baseline, current atlas frame and compositor movement independently of sprite frames.
- `CatSceneDirector` runs cancellable show/hide/play/move/travel/wait/turn sequences and releases callbacks on cancellation or destruction.

`CatSprite` addresses the atlas through CSS background coordinates with `image-rendering: pixelated`/`crisp-edges`; it does not recolor, vectorize, smooth, or theme-swap the source. Coordinates are snapped to device pixels and the CSS scale is selected so its physical backing scale is integral at 100%, 125%, 150%, 175%, and 200% Windows DPI.

Movement uses bounded compositor transforms while sprite frames use one-shot timers at their source timings. There is no `requestAnimationFrame`, interval, WebGL, canvas, extra renderer process, guest DOM access, or continuous idle loop.

## Scenes and scheduling

The renderer implements one prominent scene per eligible window: omnibox peek and swat, tab walk/tail/climb, closing-tab scratch, new-tab tap, toolbar patrol, bottom-edge zoomies, tab-strip nap, sidebar sneak, bookmark paw, walk/sit/rest/dream/wake idle lifecycle, four exact local secret phrases, and contextual error reactions. The resident cat guarantees one visible cat while the enabled layer is eligible and cycles through bounded looks, scratches, short walks, rests and lifts between prominent scenes.

Scheduling has two deliberate tiers. A guaranteed bottom-edge zoomies scene is offered after 3 seconds, followed by a rotating, layout-aware scene every 11–15.5 seconds with a 9-second global gap and longer per-scene cooldowns for major choreography. An open Settings modal defers, rather than consumes, that first visible scene. Direct interactions such as omnibox focus, new-tab, close-tab, tab switching, bookmark clicks and reload use a 2.8-second anti-spam gap, so the mascot responds without reacting to every keystroke. Idle starts after 62 seconds without activity. Secret phrases bypass probability but are deduplicated. One prominent scene may run at a time, consecutive repeats are rejected, and the resident becomes visually quiet while it runs. Private workspaces, HTML/native fullscreen, minimized/hidden windows, and disabled state render nothing and own no cat timers.

Scene placement is derived from live chrome rectangles through bounded geometry helpers. Horizontal tab scenes perch below the tab strip, vertical scenes use the visible middle of the rail, and chrome scenes overlap the bottom edge of their control without ever producing a negative viewport coordinate. Prominent actors render at an 80-pixel pixel-perfect size while the resident remains compact. Actor and sprite containers share that size so paint containment cannot crop scaled frames.

The layer is fixed, `aria-hidden`, presentation-only, non-selectable, and pointer-transparent. Hooks emit passive local events from Vast chrome only; they never alter omnibox text, selection, IME, navigation, clipboard, tab behavior, accessibility text, or website DOM. Reduced motion resolves animations to a static terminal frame and removes movement transitions.

## Selected source mapping

Scene mappings are traceable in generated metadata. Important mappings include:

- peek: `Spawn_1`, `Sit_Lift_1`, `Sit_Tilt_1`;
- swat: `Idle_Lift_1`, `Attack_1`, `Pull_Back`, `Idle_Yes`;
- tab walk: `Spawn_1`, `Run_1`, `Idle_Tilt_1`;
- signature climb: `Climb_1`, `Climb_2`, `Climb_3`, `Climb_Jump_1`, `Sit_Tilt_1`, `Climb_Jump_2`;
- tab close: `Scratching_Start`, `Scratching_1`, `Scratching_End`, `Sit_No`;
- idle: `W_1`, `SIt_Down`, `Rest_1`, `Rest_2`, `Dream`, `Rest_4`, `Stand_Up`;
- errors: `Sit_No` followed by `Sit_1`;
- signatures: `Spawn_2`, `Run_2`, `Dance`, `Jump_1`, `Sit_Yes`.

Source spelling is preserved in `source_tag`; stable IDs normalize inconsistencies such as `SIt_Down`, `Rset_3`, and `Scratchng_2_85` without modifying the source archive.
