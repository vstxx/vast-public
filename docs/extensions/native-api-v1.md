# Vast Native Extension API v1

Vast-native code is an optional layer in an unpacked Chrome manifest. Chrome capabilities and Vast capabilities are authorized and executed independently.

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "1.0.0",
  "vast": {
    "api_version": 1,
    "extension_id": "abcdefghijklmnopabcdefghijklmnop",
    "background": "vast/background.js",
    "permissions": ["vast.storage", "vast.tabs.read", "vast.toolbar"]
  }
}
```

The optional background entry is a local ES module. Static UI can instead be declared in `vast.contributes` (see [manifest.md](manifest.md#declarative-contributions)); such an extension runs no Native background at all, and its popup, options and side-panel pages still receive the `vast.*` API while they are open. Remote scripts, general network access, Node.js, Electron, raw IPC, filesystem access, arbitrary popup creation, and navigation away from the extension origin are blocked. Declarative `vast.popup` and `vast.options` pages may provide custom toolbar UI. Each extension background, sidebar, popup, and options surface uses a separate in-memory Chromium partition and the dedicated extension preload.

## Permissions

- `vast.storage`: extension-scoped local JSON storage (5 MB quota).
- `vast.tabs.read`: query sanitized ordinary `http:`/`https:` tabs; private and internal tabs are omitted.
- `vast.tabs.write`: create, update, reload, activate, and close ordinary web tabs.
- `vast.theme`: apply validated theme tokens as a non-persistent overlay.
- `vast.toolbar`: add up to five data-only toolbar actions.
- `vast.sidebar`: add up to five sandboxed local panels.
- `vast.commands`: add up to fifty identified command-palette actions. Vast-reserved shortcuts are not bound.
- `vast.contextMenus`: add up to fifty actions to normal webpage menus.
- `vast.notifications`: show bounded in-app notifications, limited to ten per minute.

Requested permissions are not grants. Installation requires approval. A reload that adds permissions puts the native runtime into permission review; the Chrome layer of a hybrid extension remains independent. Removing a permission immediately blocks calls and removes related contributions.

## API

- `vast.runtime.getManifest()`, `getExtensionInfo()`, `getPlatformInfo()`
- `vast.storage.local.get()`, `set()`, `remove()`, `clear()`
- `vast.tabs.query()`, `get()`, `create()`, `update()`, `reload()`, `close()`, `activate()` and tab events
- `vast.theme.apply()`, `clear()`
- `vast.toolbar.create()`, `update()`, `remove()`, `onClicked`
- `vast.sidebar.create()`, `remove()`
- `vast.commands.register()`, `remove()`, `onCommand`
- `vast.contextMenus.create()`, `remove()`, `onClicked`
- `vast.notifications.create()`

```js
const tabs = await vast.tabs.query({ active: true })
await vast.storage.local.set({ lastTitle: tabs[0]?.title ?? null })
await vast.notifications.create({ title: 'Example', message: tabs[0]?.title ?? 'No ordinary tab' })
```

## Lifecycle and delivery

- Native state: `pending-permission` until every requested Vast permission is approved; `idle` when the layer is active without a background; `starting`/`running` while the background loads/runs; `error` after an invalid manifest or a background crash; `stopped` when disabled.
- A background is started once and kept: enabling an already-enabled extension or changing grants does not restart it. Reload, an update or a changed `vast` section restarts it.
- `toolbar.onClicked`, `commands.onCommand` and `contextMenus.onClicked` are acknowledged: Vast reports the action as done only when at least one listener received it, and reports an error when the background is not running, has no listener, crashes first, or does not answer within 3 seconds. Asynchronous work a listener starts is not awaited.
- When a background stops or crashes, the toolbar actions, commands, menu items, panels and theme it registered at runtime are removed; manifest contributions stay and their `event` actions are shown as unavailable until it runs again.
- Tab events are produced only while at least one running background holds `vast.tabs.read`. Listening starts from the current tabs; no synthetic history is replayed.
- `contextMenus.create()` accepts an optional `contexts` array (as in `vast.contributes`). Items without it appear in every page menu, as before. Click payloads contain `menuItemId`, `tabId` and `pageUrl`, plus `selectionText` (≤2048 characters) and `linkUrl` only when the item's contexts include them.

## Distribution and current limits

Vast-native and hybrid extensions can be loaded unpacked, installed from local `.vext` files, or installed from signed Hub releases. Managed updates preserve a stable `vast.extension_id`; permission increases wait for explicit user approval and failed candidates roll back.

API v1 intentionally provides no native networking namespace, arbitrary filesystem access, raw Electron/Node/IPC, arbitrary window creation, remote code loading, or private-browsing access. Network interception is not part of the `vast.*` namespace: it is a separate opt-in Chrome-layer provider API declared with the top-level `vast_network` field (see [manifest.md](manifest.md) and [security.md](security.md)). Custom UI is declarative and limited to verified local `vast.popup` and `vast.options` pages. A Chrome layer may use the subset of Manifest V3 APIs supported by the shipped Electron runtime, subject to its own manifest permissions.
