# Default Browser And Protocol Registration

Vast default-browser setup is separate from Electron Builder protocol metadata.

Electron Builder must not register `http` or `https` under `build.protocols`. Vast declares only the custom `vast` scheme there. Registering web schemes in packaged metadata is too broad for a browser shell and can create surprising OS protocol ownership.

Windows default-browser integration is handled by `src/main/default-browser.ts` through the Windows Default Apps registration path. That code advertises the app's HTTP/HTTPS capability for the OS default-browser chooser without using Electron Builder custom protocol metadata for `http` or `https`.

Release checks fail if `http` or `https` appear in `package.json` `build.protocols`.
