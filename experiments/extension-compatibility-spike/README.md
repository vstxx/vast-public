# Vast extension compatibility spike

This harness measures stock Electron 44.3.0 and `electron-chrome-extensions`
without changing Vast's production extension path. Every scenario runs in a
new child process with a disposable `userData` directory and crash dump folder.
Install the root repository's dependencies first; the harness reuses its pinned
Electron binary but keeps ECE in a separate dependency tree.

Third-party extension builds are read from the repository-ignored
`extension-reference/{bitwarden,protonpass,keepassxc}` directories. They are
never copied into this experiment or modified.

```powershell
npm install --prefix experiments/extension-compatibility-spike --ignore-scripts
node experiments/extension-compatibility-spike/run-matrix.cjs
```

Set `VAST_SPIKE_SKIP_CWS=1` to skip the live Chrome Web Store crash probes.
Results are written below `results/`, which is ignored by Git.

The dependency is dual licensed upstream under GPL-3.0 or its paid Patron
license. Vast selected the GPL-3.0 path and relicensed Vast-owned code as
GPL-3.0-only. The exact ECE source patch is maintained in
`experiments/electron-chrome-extensions-4.9.0/`.

## Production-readiness follow-up (experimental only)

The follow-up uses the same disposable profiles. Run the baseline scenarios
before applying the local ECE patch, then apply the patch and run the comparison.
The patch edits only this experiment's ignored `node_modules` copy and checks
the exact ECE 4.9.0 code anchors before changing it.

```powershell
node experiments/extension-compatibility-spike/run-matrix.cjs ece-polyfill-wrapper,ece-protonpass,ece-keepassxc,stock-mv3-lifecycle-70s,ece-mv3-lifecycle-70s
node experiments/extension-compatibility-spike/patch-ece-preload.cjs
node experiments/extension-compatibility-spike/run-matrix.cjs ece-patched-polyfill-wrapper,ece-patched-protonpass,ece-patched-keepassxc,ece-patched-bitwarden,ece-patched-permissions-grant,ece-mv2-vast-webrequest-late,ece-mv2-policy-late
node experiments/extension-compatibility-spike/run-matrix.cjs stock-mv3-alarm-consumption,stock-mv3-restart,ece-mv3-restart
node experiments/extension-compatibility-spike/verify-readiness.cjs
```

The lifecycle follow-up also runs `stock-mv3-alarm-consumption` for 130 seconds
and `stock-mv3-restart,ece-mv3-restart` as two-process pairs. Each restart pair
reuses one temporary profile, persistent partition, extension path and server
port. Run those scenarios before `verify-readiness.cjs` when reproducing the
full follow-up evidence.

The patch aligns Electron's partial `browser` namespace with ECE's augmented
`chrome` namespace, removes ECE's non-Chrome-like `Object.freeze(chrome)`, and
dispatches scoped permission grant/revoke events. It is a diagnostic prototype,
not a distributable package or a Vast production integration. Network policy and
MV3 lifecycle remain unresolved; see the follow-up audit report.
