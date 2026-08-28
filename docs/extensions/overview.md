# Vast Extensions overview

Vast supports three install sources and three runtime shapes:

| Source | Trust label | Persistence |
| --- | --- | --- |
| Load unpacked | Developer | Original local directory |
| Local `.vext` | Local package | `Extensions/Managed/<id>/versions/<version>` |
| Vast Extensions Hub | Official | Same managed store, with required pinned-key signature |

An extension can use a compatibility-scored Chrome layer, Vast Native API v1, or both. Vast supports Manifest V3 content scripts and Electron's documented subset of extension APIs; it does not claim Chrome Web Store parity or Manifest V3 background-service-worker support. Vast-native code never receives Node.js, Electron, raw IPC, arbitrary filesystem, or private-workspace access.

## Developer quickstart

1. Create `manifest.json` and local extension files.
2. For a Chrome layer, use Manifest V3 content scripts and feature-detect Electron's documented extension APIs. For a native layer, add `vast.api_version`, a local background module, and explicit `vast.permissions`.
3. Open `vast://extensions`, enable Developer Mode, and choose **Load unpacked**.
4. Exercise the extension in isolated/shared normal workspaces and verify every requested grant. Private ephemeral workspaces intentionally do not load extensions.
5. Add a stable 32-character `a`–`p` `vast.extension_id`, then run:

   ```powershell
   npm run extension:pack -- .\my-extension --out .\dist\my-extension.vext
   ```

6. Sign in to the Vast Extensions publisher dashboard, create a listing, upload the `.vext`, and submit it for review.

Minimal native section:

```json
{
  "manifest_version": 3,
  "name": "My Vast extension",
  "version": "1.0.0",
  "vast": {
    "api_version": 1,
    "extension_id": "abcdefghijklmnopabcdefghijklmnop",
    "background": "vast/background.js",
    "permissions": ["vast.storage", "vast.notifications"]
  }
}
```

```js
await vast.storage.local.set({ installed: true })
await vast.notifications.create({ title: 'Ready', message: 'The extension is running.' })
```

Package installs always show an explicit confirmation with publisher/trust/source and access. Hub website buttons open a strict `vast://extensions/install?id=<id>` deep link; the deep link can select a listing but cannot supply a URL, package, permission, or silent-install instruction.
