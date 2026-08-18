# Vast Chromium branding

The first native milestone uses Chromium's open-source asset set plus Vast product names. Existing Vast artwork is sourced from `assets/logos`; no Google Chrome trademark or private asset is allowed here.

The initial patch changes version/product metadata and Windows application identity while retaining Chromium icons where a complete Vast scale set has not yet been produced. That temporary combination is honest and distributable as a development build. It must not be called a polished public Vast package until all required icon sizes, installer artwork, accessibility assets, and license notices have been verified.

`scripts/generate-windows-branding.ps1` derives alpha-preserving 16, 24, 32, 48, 64, 128, and 256 px PNGs plus a 16/32/48/256 multi-frame Windows ICO from the 500 px `assets/logos/vasticon.png` source. Its fixture test validates the container and dimensions. The generated ICO is tracked in the Chromium patch series rather than as a loose build-tree mutation.

Windows identity target:

```text
Product: Vast
Product version: 2.0.0-dev (Chromium engine version remains separately visible)
Base AppUserModelID: app.vast.browser
URL scheme: vast
Browser ProgID prefix: VastHTM
PDF ProgID prefix: VastPDF
```

Stable GUIDs and sandbox/AppContainer identifiers are generated once, documented, and tested before an installer is enabled. Development staging does not register or overwrite the Electron 1.0.11 installation.

Widevine, Chrome Sync, private Google API keys, and Google Chrome branding are not branding assets and are never added by this directory.
