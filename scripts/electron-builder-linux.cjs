const { join } = require('node:path')

// Linux AppImage (x64). It packages the npm Electron: the patched runtime is
// built for win32-x64 only, so the Electron extension-compatibility layer
// stays disabled on Linux (see docs/LINUX.md).
const pkg = require(join(__dirname, '..', 'package.json'))
if (pkg.devDependencies.electron !== require(join(__dirname, '..', 'patches', 'extension-compatibility-runtime.json')).electron.version) {
  throw new Error('The npm Electron version must match the approved runtime version.')
}

const windowsOnlyResources = new Set(['resources/apply-update.ps1', 'assets/logos/vasticon-windows.png'])

module.exports = {
  ...pkg.build,
  forceCodeSigning: false,
  extraResources: pkg.build.extraResources.filter((entry) => !windowsOnlyResources.has(entry.from)),
  // The static AppImage runtime needs no libfuse2 on the host, and its
  // desktop entry does not force --no-sandbox: AppRun only disables the
  // sandbox when unprivileged user namespaces are unavailable.
  toolsets: { ...pkg.build.toolsets, appimage: '1.0.3' },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    // Standard hicolor sizes; the 605px source icon is not a theme size.
    icon: 'assets/logos/linux',
    executableName: 'vast-browser',
    // package.json desktopName (Vast.desktop) sets Electron's Wayland app_id
    // to "Vast", the same as the X11 WM_CLASS, and electron-builder derives
    // StartupWMClass=Vast and the desktop file name from it.
    syncDesktopName: true,
    category: 'Network;WebBrowser',
    mimeTypes: ['text/html', 'application/xhtml+xml', 'x-scheme-handler/http', 'x-scheme-handler/https'],
    desktop: { entry: { GenericName: 'Web Browser' } }
  },
  appImage: {
    artifactName: 'Vast-${version}-x86_64.${ext}',
    executableArgs: []
  }
}
