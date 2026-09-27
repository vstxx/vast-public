# Adblocker for Vast 1.1.0

Optional Extensions Hub package. The browser ships no blocking engine or filter
lists. Stable ID: `ighghepofocdonohadbmkbgmphppdagk`; never regenerate manifest.key.

## Build

From the Vast repository root, with dependencies installed:

```powershell
npm run extension:adblock:typecheck
npm run extension:adblock:build
npm run extension:pack -- resources/first-party-extensions/adblocker-for-vast --out artifacts/Adblocker-for-Vast-1.1.0.vext --publisher-id publisher_7b1e2c9f4a806d3e5b709c12
npm run test:adblock:extension-e2e
```

The build checks exact reproduction of both pinned resource bundles. The archive
is an unsigned publisher upload; the Hub reviews and signs approved versions.
Keep the existing `adblocker` listing and Vast publisher identity.

## Protection

Network filters, exceptions, redirects, ordinary CSS, Ghostery-supported extended
selectors, safe scriptlets and trusted scriptlets from approved official uBlock
lists. Rules remain list-driven; there are no site-specific browser patches.

New profiles enable EasyList, EasyPrivacy, uBlock filters, Quick fixes, Unbreak
and Privacy. Cookie notices are optional. Quick fixes checks every six hours;
other enabled lists daily. Fixed HTTPS sources use conditional requests without
credentials, referrer or redirects. Failed updates retain working filters.

Advanced site protection controls scriptlets and extended cosmetics. The popup
can disable only advanced protection for one hostname. Reload after changing
page rules: already executed JavaScript patches cannot safely be undone in place.
Schema 1 settings migrate explicitly without changing selected lists, custom
filters, allowlists or enabled state. Existing users can select the new lists.

## Compatibility and limits

Early page rules require a Vast build exposing `vast_document_rules: 1`, in
addition to `vast_network: 1`. These browser changes must ship before this update
is broadly advertised. Older builds retain network blocking and show an update
notice; a product version number alone does not prove capability availability.

Custom filters may use supported safe scriptlets and extended selectors. Trusted
scriptlets are reserved for code-owned approved list IDs. Invalid edits do not
replace working filters. Executable resources come only from this reviewed
package; downloaded list text supplies arguments, never JavaScript bodies.

No HTML response-body filtering, remote custom list URLs, CSP report endpoints,
private-workspace extension runtime or service-worker traffic without an owned
page. Scriptlets run in the top-level HTTP(S) document; cosmetics are frame-aware.
Internal, extension and auth-sensitive pages never receive document scriptlets.
Startup is asynchronous: reload pages opened before the engine became ready.
No guarantee of permanent or complete blocking on any live site.

Original integration: GPL-3.0-or-later. Preserve assets/THIRD-PARTY-NOTICES.txt,
license texts, pinned source and provenance. See docs/ADBLOCKER_FOR_VAST.md in the
repository for architecture, validation and submission prerequisites.
