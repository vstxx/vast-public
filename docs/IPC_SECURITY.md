# IPC Security Notes

The preload bridge is the only renderer-facing API. Web pages inside webviews do not receive `window.vast`.

## Current Controls

- IPC senders must be the main renderer frame.
- Renderer URL must be trusted dev/file renderer origin.
- Guest webContents ids are checked against the main window host.
- Filesystem operations stay in the main process.
- Storage restore validates schema and backup id before replacing active data.
- Every Labs-sensitive IPC channel is declared once in `src/shared/sensitive-ipc-policy.json`. The main-process registrar applies the required feature before the handler runs, rejects an unlisted channel in a sensitive namespace, and fails startup when policy and registrations diverge.
- Password IPC additionally declares `control`, `unlocked`, or `fresh` vault access in the same policy. Renderer state is never an authorization boundary.
- Relay IPC exposes only a verified presentation snapshot plus `dismiss(presentationId)` and `performAction(presentationId)`. The renderer never receives a remote URL, signing key material, network primitive, updater command, or arbitrary main-process operation.

## Review Rules

- Do not add broad filesystem methods to preload.
- Do not expose raw Node networking, shell, process, or fs APIs to renderer code.
- Do not trust renderer-only checks for Labs access.
- Add every new `vast:passwords:*`, `vast:network:*`, or `vast:avidae:*` channel to the central policy and AST-enumerated test before registering it.
- Keep exported diagnostics redacted by default in packaged builds.
- Treat password, updater, shell, and webview navigation handlers as security-sensitive.
- Keep Relay signature/schema/media verification and URL-to-action resolution in the main process. A renderer may return only the ID of the currently displayed presentation.
