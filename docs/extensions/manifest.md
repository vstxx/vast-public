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

Unpacked loading accepts validated Manifest V2 or V3 input because Electron can still expose limited compatibility, but new Hub submissions must use Manifest V3. Vast validates referenced local files, content-script match patterns, host permissions, manifest size, and icon containment. Electron does not implement every Chrome API; use feature detection and test against the shipped Vast/Electron version.

Vast's toolbar extensions menu supports local custom UI declared through Manifest V3 `action.default_popup` (or Manifest V2 `browser_action.default_popup`). A local `options_ui.page` or `options_page` is exposed as **Extension settings**. Popup and options paths must resolve to HTML files inside the verified extension root; they run in the active persistent workspace extension session. Extensions remain unavailable in private and ephemeral workspaces.

## Vast layer

| Field | Requirement |
| --- | --- |
| `api_version` | Must equal `1` |
| `extension_id` | Optional while unpacked; required for a deliberately stable package identity |
| `background` | Local `.js` or `.mjs` module inside the package |
| `popup` | Optional local HTML page displayed from the toolbar extensions menu |
| `options` | Optional local HTML settings page displayed from the toolbar extensions menu |
| `permissions` | Unique values from the documented v1 permission set |

Chrome permissions and Vast permissions are separate. A Chrome `storage` grant never grants `vast.storage`, and a Vast grant never widens a Chrome host permission.

All executable resources must be inside the extension. Hub validation rejects native binaries, nested archives, remote/dynamic code execution, missing local resources, unsupported Vast API versions, and unknown Vast permissions.
