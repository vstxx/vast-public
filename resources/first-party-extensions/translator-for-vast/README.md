# Translator for Vast 1.0.0

Optional Extensions Hub package. Vast ships no translation engine or model; this
extension carries the engine and downloads models only when a user asks for a
language. Stable ID: `oaamgecaoemplhkceohcpahaeampndpj`; never regenerate
`manifest.key` (no private key exists or is needed: the Hub signs packages).

## Build

From the Vast repository root, with dependencies installed:

```powershell
npm run extension:translator:engine     # once: downloads and verifies the pinned Bergamot binary
npm run extension:translator:typecheck
npm run extension:translator:pack       # builds dist/ and artifacts/Translator-for-Vast-1.0.0.vext
node scripts/translator-dom-tests.cjs   # DOM tests in real Chromium
npm run test:translator:e2e             # Vast runtime E2E (network: model downloads)
node resources/first-party-extensions/translator-for-vast/tools/quality.mjs
```

The build is offline and checks the glue, binary and license against
`vendor/bergamot/engine.lock.json` and the manifest key against the stable ID.
The `.vext` is an unsigned publisher upload; the Hub reviews and signs it.

## Layout

| Path | Role |
| --- | --- |
| `src/background/` | MV3 service worker: routing, context menus, on-demand injection, optional registered scripts |
| `src/engine/` | Offscreen document, engine host (queue, lifecycle, idle release), model store, Bergamot worker |
| `src/content/` | Page translator (segmenter, scheduler, safe renderer), selection panel, optional scripts |
| `src/ui/` | Popup and settings with model manager |
| `src/shared/` | Catalog, protocol validation, settings, languages, interface strings (en, pl) |
| `catalog/models.json` | Packaged model catalog: paths, sizes and SHA-256 per file |
| `vendor/bergamot/` | Pinned Mozilla glue, lock file and MPL-2.0 text (binary fetched by the tool) |
| `tools/` | `build.mjs`, `fetch-engine.mjs`, `refresh-catalog.mjs`, `quality.mjs` |
| `tests/` | DOM tests and the EN/PL quality set |

## Updating the engine or models

- Models: `node tools/refresh-catalog.mjs` regenerates `catalog/models.json` from
  Mozilla Remote Settings and the model registry, refusing to write when they
  disagree. Review the diff, bump the version and repack. Users get new models
  only through an extension update; nothing about models is read at runtime.
- Engine: follow `vendor/bergamot` provenance (glue from the Firefox tree at a
  revision that ships the same Remote Settings release), update the lock file,
  `ENGINE_RELEASE` in `src/shared/catalog.ts`, and the Hub's reviewed-module
  record in `extensions-hub/src/validation.ts`. Models from another engine
  release count as not installed and download again.

## Licensing

Original integration: GPL-3.0-or-later. Adapted Glossa code: MIT (file headers,
`assets/licenses/Glossa-MIT.txt`). Bergamot glue and binary: MPL-2.0, unmodified.
See `assets/THIRD-PARTY-NOTICES.txt` and docs/TRANSLATOR_FOR_VAST.md.
