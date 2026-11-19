# Vast on Linux (AppImage)

Download `Vast-<version>-x86_64.AppImage` from [GitHub Releases](https://github.com/vstxx/vast-public/releases). It runs on any recent 64-bit distribution and needs no FUSE 2 package.

Vast picks Wayland or X11 automatically; you don't need any flags. To force X11, start it with `--ozone-platform=x11`.

## Gear Lever (recommended)

1. Install [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever): `flatpak install flathub it.mijorus.gearlever`
2. Open the downloaded AppImage with Gear Lever, click **Unlock**, then **Move to the app menu**. Gear Lever moves it to `~/AppImages` and adds Vast to your app menu with its icon.
3. Optional: in Vast's page in Gear Lever, open **Update management**, choose **GitHub**, and enter:
   - Username/Repo: `vstxx/vast-public`
   - Release file name: `Vast-*-x86_64.AppImage`

Vast also updates itself (see [Updates](#updates)). The two don't conflict: Vast replaces the file in place, and Gear Lever compares the file with the release, so it shows no update once Vast has installed it.

## Manual

```bash
chmod +x Vast-*-x86_64.AppImage
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
mv Vast-*-x86_64.AppImage ~/.local/bin/vast.AppImage

# Icon
cd /tmp && ~/.local/bin/vast.AppImage --appimage-extract 'usr/share/icons/hicolor/512x512/apps/vast-browser.png' >/dev/null
mv /tmp/squashfs-root/usr/share/icons/hicolor/512x512/apps/vast-browser.png ~/.local/share/icons/hicolor/512x512/apps/
rm -rf /tmp/squashfs-root

# Menu entry ($HOME is expanded now; desktop files need an absolute path)
cat > ~/.local/share/applications/Vast.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Vast
GenericName=Web Browser
Exec=$HOME/.local/bin/vast.AppImage %U
Icon=vast-browser
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/vast;
StartupWMClass=Vast
EOF
update-desktop-database ~/.local/share/applications
```

Keep the file name without a version (`vast.AppImage`), so the menu entry stays valid after updates.

## Updates

Vast checks for updates in the background, downloads and verifies them, and installs them when you close Vast; the next start runs the new version. It replaces the AppImage at the same path, so menu entries keep working, and your profile (`~/.config/Vast`) is never touched.

Self-update needs write access to the AppImage and its folder. If Vast lives somewhere it can't write (for example `/opt`), or wasn't started from its AppImage, it doesn't update itself; update it with your AppImage manager or by replacing the file.

## Sandbox

Vast runs its web content in Chromium's sandbox, which needs unprivileged user namespaces. Ubuntu 24.04 and later restrict these through AppArmor, so there, like other AppImages, Vast starts without the sandbox. To allow it system-wide:

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf && sudo sysctl --system
```

## Extensions on Linux

The Linux build uses the standard Electron runtime. Vast's patched runtime, which provides full Chrome Web Store compatibility for extensions such as password managers, is currently built for Windows only. On Linux, extensions run with standard Electron extension support.
