# Local Vast test update

A manual, private Windows update of this machine's existing direct Vast installation (`%LOCALAPPDATA%\Programs\Vast`) and its daily profile. It creates no GitHub release, update feed, Store package or public installer. The build is unsigned and may trigger Windows security prompts.

Run `Update-Vast-Alpha.cmd` from this checkout. It builds and verifies the current committed source with the pinned patched Electron runtime (`C:\VastElectron45\src\out\VastRelease`, or `VAST_PATCHED_ELECTRON_SOURCE_DIR`), asks you to close Vast, then applies it. It never force-closes the browser.

The same steps separately:

```powershell
npm run alpha:prepare
# Close all Vast windows.
npm run alpha:check
npm run alpha:apply
```

- The build is version `0.6.0` (override with `VAST_LOCAL_ALPHA_VERSION`, which must be newer than the source version). It is a stable-shaped number on purpose: the Hub hides password managers and Translator from prerelease versions. Running it again after a new commit repairs the same version in place.
- The built-in network updater is off. Install the public 0.6.0 later with its installer.
- `alpha:prepare` needs a clean, committed checkout. It verifies the ECE integration, the native Electron hash, packaged PE code and resources, fuses and every payload file.
- The active profile (including a custom root from `%APPDATA%\Vast\data-root.json`) is backed up to `%LOCALAPPDATA%\Vast\AlphaUpdateBackups`; replaced runtime files go to the installation's `.vast-update` directory. Keep both while testing. The command does not downgrade.
