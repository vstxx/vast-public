# Extension manifest

Vast reads a local `manifest.json`. The Chrome layer follows Electron/Chromium extension support; the optional `vast` object activates Vast Native API v1.

## Distribution identity

Managed packages should declare:

```json
"vast": {
  "api_version": 1,
  "extension_id": "abcdefghijklmnopabcdefghijklmnop",
  "background": "background.js",
  "permissions": []
}
```

`extension_id` is exactly 32 lowercase characters in the range `a`–`p`. It is the logical identity retained across managed version directories. A package whose metadata, manifest identity, listing, descriptor, or installed record disagrees is rejected.

## Chrome layer

Unpacked loading accepts validated Manifest V2 or V3 input because Electron can still expose limited compatibility, and Hub submissions may use either. Manifest V2 requires an explicit string `content_security_policy` that stays local-only: `script-src` and `object-src` may reference only `'self'` or `'none'`, `object-src` must be exactly `'none'`, and `script-src-elem`, `script-src-attr`, and `worker-src` may not relax it. A network-provider extension must use Manifest V2 (see below). Vast validates referenced local files (including declared background pages/scripts), content-script match patterns, host permissions, manifest size, and icon containment. Electron does not implement every Chrome API; use feature detection and test against the shipped Vast/Electron version.

Vast's toolbar extensions menu supports local custom UI declared through Manifest V3 `action.default_popup` (or Manifest V2 `browser_action.default_popup`). A local `options_ui.page` or `options_page` is exposed as **Extension settings**. Popup and options paths must resolve to HTML files inside the verified extension root; they run in the active persistent workspace extension session. Extensions remain unavailable in private and ephemeral workspaces.

## Vast layer

| Field | Requirement |
| --- | --- |
| `api_version` | Must equal `1` |
| `extension_id` | Optional while unpacked; required for a deliberately stable package identity |
| `background` | Optional local `.js` or `.mjs` module inside the package; needed only for dynamic logic and `event` actions |
| `popup` | Optional local HTML page displayed from the toolbar extensions menu |
| `options` | Optional local HTML settings page displayed from the toolbar extensions menu |
| `permissions` | Unique values from the documented v1 permission set |
| `contributes` | Optional declarative UI (below) |

A Native layer must declare at least one of `background`, `popup`, `options` or `contributes`.

### Declarative contributions

`vast.contributes` registers toolbar actions, command-palette entries, page-menu items and side panels from the manifest alone. Vast reads it after validation; no extension code runs and no background host is created. An extension that only needs these surfaces and a popup consumes no Native process at all.

```json
"vast": {
  "api_version": 1,
  "popup": "popup.html",
  "permissions": ["vast.toolbar", "vast.commands", "vast.contextMenus", "vast.sidebar"],
  "background": "background.js",
  "contributes": {
    "toolbar": [{ "id": "open", "title": "Open", "icon": "icons/16.svg", "action": "popup" }],
    "commands": [{ "id": "open", "title": "Open panel", "action": "popup" }],
    "context_menus": [{ "id": "selection", "title": "Use selection", "contexts": ["selection"], "action": "event" }],
    "sidebar": [{ "id": "panel", "title": "Panel", "icon": "icons/16.svg", "page": "panel.html" }]
  }
}
```

| Section | Fields | Limit | Permission |
| --- | --- | --- | --- |
| `toolbar` | `id`, `title` (≤80), optional `icon`, `action` | 5 | `vast.toolbar` |
| `commands` | `id`, `title` (≤100), optional `shortcut` (listed, not bound), `action` | 50 | `vast.commands` |
| `context_menus` | `id`, `title` (≤100), optional `contexts`, `action: "event"` | 50 | `vast.contextMenus` |
| `sidebar` | `id`, `title` (≤80), `page` (local HTML), optional `icon` | 5 | `vast.sidebar` |

- `action` is one of two fixed values. `"popup"` opens the extension's `vast.popup` (or, for a hybrid, its Chrome `action.default_popup` in the active persistent workspace). `"event"` delivers `toolbar.onClicked`, `commands.onCommand` or `contextMenus.onClicked` to `vast.background` and requires one. Nothing else (URLs, scripts, function or channel names) is accepted.
- `contexts` is a non-empty subset of `all`, `page`, `selection`, `link` with Chrome semantics (`page` applies only when there is no selection or link). It defaults to `["all"]`.
- IDs match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}` and are unique per section. Icons are local PNG/SVG/WebP/JPEG/GIF/ICO files (toolbar icons ≤ 64 KB; SVG with scripts, event handlers or remote references falls back to the generic icon); side-panel pages are local HTML files. Every referenced file must exist in the package.
- Each non-empty section needs its permission in `permissions`. Declaring is never granting: contributions appear only after approval, a section disappears at once when its permission is revoked, and an update that requests more permissions puts the whole Native layer into review until approved.
- A manifest entry belongs to the installed extension that declares it. The extension's background cannot replace, edit or remove it and shares the per-section limit with it.
- An invalid `contributes` disables only the Native layer with a diagnosable error, like an unknown permission; the Chrome layer of a hybrid keeps working. Vast versions before declarative support require `background` and report a declarative-only extension as unsupported instead of running it partially.

Chrome permissions and Vast permissions are separate. A Chrome `storage` grant never grants `vast.storage`, and a Vast grant never widens a Chrome host permission.

## Network providers

A top-level `"vast_network": 1` field (outside the `vast` object) opts the Chrome layer into Vast's request-interception bridge. It is the mechanism behind content blockers such as Adblocker for Vast. Requirements enforced at load time and by Hub validation:

- Manifest V2 with a persistent background page or background scripts;
- the Chrome `webRequest` and `webRequestBlocking` permissions;
- host permissions that must cover both the page URL and the request URL of every interception decision.

A qualifying background page is injected with `globalThis.vastExtensionCapabilities = { network: 1 }` and answers a fixed `globalThis.vastWebRequest.handle(<json>)` entry point. The bridge runs only after Vast's built-in privacy checks, serves only live Vast-owned webviews over HTTP(S)/WSS in the same session, and never evaluates provider-supplied source; decisions are sanitized to `cancel`, a bounded `redirectURL`, or a response `csp`. A provider that does not answer within 500 ms per request is dropped and the request fails open. See [security.md](security.md) for the full boundary.

## Validation

All executable resources must be inside the extension. Hub validation rejects native binaries, nested archives, remote/dynamic code execution (including indirect `(0, eval)(…)` and `window["eval"](…)` forms), unparseable JavaScript, missing local resources (including declared background pages/scripts), a Manifest V2 manifest without the strict local-only CSP, `vast_network` without its Manifest V2/`webRequest`/`webRequestBlocking`/background requirements, unsupported Vast API versions, and unknown Vast permissions. Sources that look minified, obfuscated, or heavily encoded are additionally flagged for manual review; JavaScript that merely documents a forbidden API in comments or strings is not rejected.
