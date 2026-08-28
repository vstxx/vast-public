# Extension permissions

Permissions are requested by the manifest, displayed before installation, and stored as explicit grants. Requested permissions are not capabilities by themselves.

## Vast Native API v1 grants

| Permission | Capability |
| --- | --- |
| `vast.storage` | Extension-scoped local JSON storage, 5 MB quota |
| `vast.tabs.read` | Sanitized ordinary HTTP(S) tab metadata |
| `vast.tabs.write` | Create, navigate, reload, activate, and close ordinary tabs |
| `vast.theme` | Apply validated, bounded theme tokens |
| `vast.toolbar` | Add bounded native-looking toolbar actions |
| `vast.sidebar` | Add bounded sandboxed local sidebar panels |
| `vast.commands` | Register bounded commands; reserved shortcuts remain unavailable |
| `vast.contextMenus` | Add bounded actions to ordinary webpage menus |
| `vast.notifications` | Show bounded, rate-limited Vast notifications |

The broker authenticates the sender's isolated `webContents`, extension ID, declared permission, current stored grant, operation schema, and resource ownership on every call.

## Lifecycle

- Install: the confirmation separates Chrome permissions, host access, and Vast permissions. Native requests become grants only after approval.
- Revoke: revocation takes effect immediately and removes related contributions.
- Reload: a newly requested native permission puts that layer into permission review; it is not silently granted.
- Update: same-or-narrower permission snapshots may update automatically after signature/hash validation. Any new Chrome, host, or Vast access enters `pending-approval` and the old version remains active.
- Disable: runtime and contributions stop, but the installed files and grants remain.
- Remove: all runtimes, contributions, registry data, scoped storage, and managed files are removed.
- Private browsing: extensions do not load into ephemeral/private workspace partitions and tab APIs omit private/internal tabs.
