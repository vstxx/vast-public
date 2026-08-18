# Cat 85 Animations exclusion record

The files listed below describe the former private development asset set. None of the archive, artwork, generated images, metadata, or packaged runtime files is included in this public source repository.

- Original archive: `assets/cat-addon/Cat_85_Animations.zip`
- Canonical source selected by Vast: `Cat_85_Animations/Cat_Grey_White.aseprite`
- Supplied export used for source verification: `Cat_85_Animations/Cat_Grey_White.png`
- Runtime files: `assets/cat-addon/package/assets/cat_grey_white.png` and `assets/cat-addon/package/animations/animations.json`
- Development files: `assets/cat-addon/generated/source-tags.json`, `assets/cat-addon/generated/source-atlas.png`, and `assets/cat-addon/generated/contact-sheet.png`

Vast decodes the original 32 x 32 RGBA frames, validates all frame durations and tags, verifies every decoded frame pixel-for-pixel against the supplied PNG atlas, selects a curated source-frame subset, and repacks those unchanged pixels into a deterministic runtime atlas. Runtime rendering uses nearest-neighbor sampling; no frame is redrawn, recolored, smoothed, vectorized, or AI-generated.

The retained tooling can regenerate this structure only after a properly licensed replacement archive is supplied. A normal public-source application build does not require Cat Addon artwork.

## License status

The former archive contained no license document, author attribution, source URL, or redistribution grant. No license classification has been inferred. It and all derivatives were excluded from the public export. The applicable license and attribution must be recorded here and in project-wide third-party notices before any replacement artwork is added to a public source or binary distribution.

The Ginger and Grey alternatives remain only inside the original development archive. Vast does not extract, generate, load, or distribute them at runtime.
