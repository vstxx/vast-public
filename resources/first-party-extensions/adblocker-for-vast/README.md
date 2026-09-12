# Adblocker for Vast

Standalone optional Extension Hub package, developed alongside IDU+.
The browser distribution contains none of this product's engine, UI or assets.

Build from the Vast repository root:

```powershell
npm ci
npm run extension:adblock:typecheck
npm run extension:adblock:build
npm run extension:pack -- resources/first-party-extensions/adblocker-for-vast --out artifacts/Adblocker-for-Vast-1.0.0.vext
npm run test:adblock:extension-e2e
```

Stable ID: `ighghepofocdonohadbmkbgmphppdagk`. Preserve manifest.key.
The archive is an unsigned publisher upload; the Hub signs approved releases.
Requires a Vast build with extension network provider API 1 (`vast_network`).
Older builds show a compatibility error. Version 0.2.7 alone is not sufficient.

Defaults: EasyList and EasyPrivacy. Optional uBlock filters and cookie notices.
Only enabled lists update, daily, using HTTPS without credentials or redirects.
Failed updates retain good filters. All decisions/statistics remain local.

Unsupported: page scriptlets, non-native procedural selectors, response rewriting,
CSP reporting, private workspaces, custom list URLs and background service-worker
requests without a Vast-owned page. Unsupported list rules are counted; unsupported
custom rules are rejected. Reload open pages after enabling or changing CSP.

Original standalone integration is GPL-3.0-or-later. Upstream components retain
individual licenses; see assets/THIRD-PARTY-NOTICES.txt and full license texts.
Corresponding resource source and offline generator are in assets/source.
See docs/ADBLOCKER_FOR_VAST.md in the repository for the release review.
