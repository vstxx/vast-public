# Local Vast 0.5.0 alpha update

This is a manual, private Windows update of the existing direct Vast installation and its existing daily profile. It does not create a GitHub release, an update feed, a Store package, or a public installer. The alpha runtime has network auto-updates disabled. It is unsigned and may trigger Windows security prompts.

Run `Update-Vast-Alpha.cmd` from this CWS Bridge checkout. It builds and verifies the current committed source and the pinned patched Electron 44.7.0 runtime. When prompted, close all Vast windows; the script then applies the package to `%LOCALAPPDATA%\Programs\Vast`. The updater will refuse to force-close the browser or run against a different installation.

The same steps can be run separately:

```powershell
npm run alpha:prepare
# Close all Vast windows.
npm run alpha:check
npm run alpha:apply
```

`alpha:prepare` must run again after a new source commit. It requires a clean checkout and uses the source commit in the packaged build metadata. It verifies the ECE integration, native Electron hash, packaged PE code and resources, security fuses, and every file in the payload before use. The installed app's built-in network updater is disabled in this private alpha; run the local command again for subsequent builds.

The updater reads `%APPDATA%\Vast\data-root.json` when Vast uses a custom data root. It backs up the active profile, including managed extensions, to `%LOCALAPPDATA%\Vast\AlphaUpdateBackups`. It also preserves a separate copy of `data-root.json` there. Runtime files changed by the updater have a transaction backup under the installation's `.vast-update` directory. Do not delete these backups while evaluating the alpha.

If the alpha has a serious regression, stop using that installation and keep both backup locations. A return to 0.4.3 requires a deliberate reinstall and review of profile compatibility; this command does not perform a downgrade.
