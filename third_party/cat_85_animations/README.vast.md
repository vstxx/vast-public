# Cat 85 Animations provenance

- Original archive: `assets/cat-addon/Cat_85_Animations.zip`
- Canonical source selected by Vast: `Cat_85_Animations/Cat_Grey_White.aseprite`
- Supplied export used for source verification: `Cat_85_Animations/Cat_Grey_White.png`
- Runtime files: `assets/cat-addon/package/assets/cat_grey_white.png` and `assets/cat-addon/package/animations/animations.json`
- Development files: `assets/cat-addon/generated/source-tags.json`, `assets/cat-addon/generated/source-atlas.png`, and `assets/cat-addon/generated/contact-sheet.png`

Vast decodes the original 32 x 32 RGBA frames, validates all frame durations and tags, verifies every decoded frame pixel-for-pixel against the supplied PNG atlas, selects a curated source-frame subset, and repacks those unchanged pixels into a deterministic runtime atlas. Runtime rendering uses nearest-neighbor sampling; no frame is redrawn, recolored, smoothed, vectorized, or AI-generated.

Regenerate with `npm run cat-addon:assets`. A normal application build only verifies committed generated files and does not require Aseprite.

## License status

The supplied archive contains no license document, author attribution, source URL, or redistribution grant. No license classification has been inferred. The applicable license and attribution must be recorded here and in any project-wide third-party notice before a public build containing this atlas is released. This is a release-blocking legal follow-up, not a technical build failure.

The Ginger and Grey alternatives remain only inside the original development archive. Vast does not extract, generate, load, or distribute them at runtime.
