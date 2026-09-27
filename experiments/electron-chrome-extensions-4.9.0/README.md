# Vast ECE 4.9.0 source patch

Vast uses `electron-chrome-extensions` 4.9.0 under its upstream GPL-3.0
license. The npm package contains compiled `dist/` files, so this directory
records the preferred TypeScript source changes used to produce Vast's
patched runtime.

## Exact upstream base

- Repository: `https://github.com/samuelmaddock/electron-browser-shell.git`
- Commit: `927ac340c3c6cc462f636a50ccd9991df0cd2e12`
- Upstream release commit: `electron-chrome-extensions@4.9.0`
- npm integrity: `sha512-4kLlh4sPPF0ieOy/Gw7A7KrmqB07megDLqOWAWXdFLAYu+2AeOGME6uOBa80NZLbKgTqBvrsVDZ+epdszRm/EQ==`

## Changes

`0001-vast-browser-compatibility.patch` changes only ECE TypeScript source:

- synchronizes APIs added by ECE into Electron's matching `browser.*`
  namespace for standards-based wrappers;
- leaves the Chrome API proxy mutable;
- dispatches `permissions.onAdded` and `permissions.onRemoved` after validated
  optional-permission changes;
- treats requests for already granted required permissions and origins as
  successful no-ops, while still rejecting every undeclared new grant;
- initializes action state for extensions that were loaded before ECE, returns
  fully qualified popup URLs, and keeps programmatic `action.openPopup()` from
  toggling an already-open popup closed;
- hardens Chromium-compatible Native Messaging discovery, including both
  Windows registry views and relative Windows host paths;
- uses byte-accurate UTF-8 framing with bounded, buffered parsing for
  fragmented and coalesced host messages;
- propagates host startup, protocol, size-limit, crash, and disconnect errors
  without logging extension message payloads.

The runtime preparation script applies equivalent transformations to the
published npm `dist/` files. This source patch is authoritative for source
distribution and review.

## Rebuild

```powershell
git clone https://github.com/samuelmaddock/electron-browser-shell.git
cd electron-browser-shell
git checkout --detach 927ac340c3c6cc462f636a50ccd9991df0cd2e12
git apply --check path/to/0001-vast-browser-compatibility.patch
git apply path/to/0001-vast-browser-compatibility.patch
yarn install --frozen-lockfile
yarn build:extensions
```

The resulting package output is under
`packages/electron-chrome-extensions/dist/`. Preserve the upstream
`LICENSE-GPL` and copyright notices in every distribution.
