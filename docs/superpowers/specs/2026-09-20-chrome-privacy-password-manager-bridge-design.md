# Chrome Privacy Password-Manager Bridge

## Purpose

Make the standard MV3 `chrome.privacy.services` API operational for compatible
extensions that have both declared and received the optional `privacy`
permission. This unblocks Bitwarden's upstream "Make Bitwarden your default
password manager" flow without modifying Bitwarden, weakening Vast's network
or security policy, or choosing a password manager in Vast.

The design is a correction to the currently measured no-op ECE `ChromeSetting`
stub. It is not a vault, credential, native-messaging, or iCloud feature.

## Observed defect and ownership

In the active ECE 4.9.0 runtime, `chrome.privacy.services` is exposed but its
`ChromeSetting.get`, `.set`, and `.clear` methods have empty bodies. Bitwarden
2026.8.0 declares `privacy` as an optional permission and invokes all three
password-manager setting keys after the user accepts its own dialog. The calls
complete without changing state, so Bitwarden cannot persist or verify its
default-password-manager state.

Classification: **B: real compatibility defect**. The owner is the
ECE/Vast compatibility integration, specifically its incomplete ECE privacy
surface. It is not a Bitwarden defect and must not be fixed by modifying the
extension.

## Constraints

- Preserve official upstream extension IDs and all third-party extension code.
- Require a manifest-declared optional `privacy` permission and the existing
  user approval path before an extension can write or clear privacy settings.
- Keep state per Vast profile/session partition and persist only browser-setting
  metadata, never vault or credential content.
- Do not alter Electron/Chromium source or start an Electron rebuild. Revisit
  that only if a public Electron API cannot support the required behavior and
  an end-to-end, reproducible defect demonstrates the need.
- Vast must not select a preferred password manager. Standard last-writer
  control belongs to the extension that successfully writes an individual
  setting; another permitted extension may later supersede it.
- Unavailable or failed initialization is fail-closed: the compatibility layer
  stays disabled rather than exposing a partly working privacy API.

## Scope

Initially implement only the three Chromium service settings used by password
manager extensions:

- `privacy.services.passwordSavingEnabled`
- `privacy.services.autofillAddressEnabled`
- `privacy.services.autofillCreditCardEnabled`

Each supports `get(details, callback)`, `set(details, callback?)`,
`clear(details, callback?)`, and `onChange`. Unsupported privacy keys remain
feature-detectable and are not silently claimed as supported.

`get` returns the Chrome-shaped value and `levelOfControl`. A successful write
records the requesting extension as the controller for that one key. `clear`
removes only the caller's control; it cannot clear a setting controlled by a
different extension. Changes dispatch only to extensions permitted to observe
the setting and never carry credential data.

The stored value is an explicit preference for Vast's browser-autofill
compatibility surface. Because Vast has no separate built-in password-manager
policy in this phase, its only immediate observable effect is accurate Chrome
API state for extensions and removal of the false success produced by the
current stub. Any future built-in autofill provider must consume this same
setting store before presenting suggestions; it must not create a second policy
path.

## Architecture

1. A Vast-owned `ChromePrivacySettingsStore` is created for each compatibility
   profile. It validates a narrow allow-list of keys, loads and atomically
   persists a versioned metadata file under that profile's extension
   compatibility data, and exposes read/set/clear plus subscription methods.
2. `ExtensionCompatibilityRuntime` owns one such store per persistent target
   session. Its bridge validates the extension identity and current optional
   `privacy` grant before every request. It supplies only a narrow, typed API
   to ECE; renderer and extension code cannot access the store directly.
3. The pinned ECE 4.9.0 patch replaces the inert preload `ChromeSetting` with
   IPC-backed methods and adds permission-gated handlers for the three keys.
   The patch preserves Chrome callback behavior and `runtime.lastError` on
   denied, malformed, unsupported, or ownership-conflicting operations.
4. The ECE patch is committed as
   `patches/electron-chrome-extensions-4.9.0-vast.patch`. The preparation
   script applies and verifies that exact patch against the pinned package;
   runtime fingerprinting records its SHA-256. No important behavior remains
   only as a local `node_modules` edit.

## Failure and security behavior

- Requests lacking a live optional `privacy` grant fail before they reach the
  store; no state is created.
- Unknown keys, non-boolean values, invalid scopes, malformed requests, and
  cross-extension clear attempts fail without mutation.
- Writes are serialized and atomically persisted. A failed persistence leaves
  the prior in-memory and on-disk state intact and reports an API error.
- State has no secrets: setting key, boolean value, controller extension ID,
  schema version, and timestamp only. Diagnostics redact extension message
  contents and never record vault, form, username, or password values.
- Disabling/uninstalling an extension removes its control and emits a change;
  profile deletion removes the profile-scoped store with the profile.

## Testing and acceptance

TDD is required. Tests are written and observed failing before implementation.

- Unit tests: key validation; optional-grant enforcement; set/get/clear;
  controller conflict behavior; atomic persistence and restart recovery;
  malformed input; failed writes; and removal on extension disable/uninstall.
- ECE patch verification: the pinned patch applies exactly once, rejects an
  unexpected package version or changed anchor, and is included in the runtime
  fingerprint.
- Runtime tests: callback and promise forms, `runtime.lastError`, `onChange`,
  and no API exposure after compatibility-gate failure.
- Authenticated Bitwarden gate: user accepts Bitwarden's upstream dialog;
  optional `privacy` grant persists; the three settings report
  `controlled_by_this_extension` with `false`; restart and extension reload
  preserve the state; Bitwarden inline suggestion behavior is then retested.
- Proton is tested only after Bitwarden's isolated gate passes. The combined
  profile verifies that either extension can request the API without cross-
  extension storage or message leakage.

Passing an API test is not by itself password-manager compatibility. The
existing authenticated autofill scenarios remain the acceptance gate.

## Non-goals

- No Bitwarden, Proton Pass, Apple, or KeePassXC code changes.
- No native messaging or iCloud work.
- No browser-side UI that selects a password manager.
- No suppression of lifecycle warnings without a demonstrated required
  operation failure.
- No public beta or packaged release enablement in this phase.
