# Vast Chromium WebUI

This directory contains the integration policy and will own reusable adapters for `chrome://vast-*` pages. Patches `0004` through `0006` provide the first compiled vertical slice at `chrome://vast/`: a profile-scoped `MojoWebUIController`, GRIT-bundled TypeScript/CSS/HTML resources, generated C++/TypeScript Mojo bindings, and an automated DOM/screenshot smoke test. The page obtains its runtime proof through `PageHandler.GetRuntimeInfo` and a read-only copied-fixture preview through `PageHandler.GetMigrationPreview`; it no longer treats load-time strings as a native service boundary. The existing React/TypeScript code remains in `src/renderer` during the migration and is moved only when a surface has a working native data adapter.

## Integration rule

React pages are compiled into Chromium resources and served through `WebUIDataSource`. There is no localhost web server and no Node.js runtime. A page may access native functionality only through a generated, profile-scoped Mojo/WebUI handler.

The first adapter boundary is intentionally small:

```text
Page handler
  loadProductData() -> schema/version + Vast-owned collections
  saveProductData(change) -> validated, atomic native transaction
  openUrl(url, disposition) -> Chromium tab model
  getFeatureState(feature) -> local feature-flag decision
  chooseImportFile()/chooseExportFile() -> native file dialog + scoped token
```

Live tabs, cookies, history, downloads, permissions, service workers, and page lifecycle are not mirrored into the old Zustand store as competing authorities. Chromium owns them. Vast workspaces and product data use adapters that expose only the projections required by a WebUI page.

Initial candidate pages are New Tab, Notes, Settings, Passwords, Automation, Video & Audio, Network, Diagnostics, and Session Timeline. Each candidate stays `planned` until its bundle loads under a registered `chrome://vast-*` controller and its tests pass without `window.vast`.
