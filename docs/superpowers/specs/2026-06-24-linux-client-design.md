# TokenTracker Linux Client Design

## Goal

Build a Linux desktop client for personal use on the current Arch Linux + KDE Plasma machine. The client should provide a native-feeling tray application while reusing TokenTracker's existing CLI, local server, and React dashboard.

This is not a public release effort. It does not require GitHub Release assets, CI release automation, public AUR publishing, AppImage, Flatpak, deb, or rpm packages.

## Primary target

- OS: Arch Linux
- Desktop: KDE Plasma
- Architecture: x86_64
- Installation: local Arch package built with `makepkg -si`
- Package manager lifecycle: install and uninstall through pacman

Other Linux desktops and distributions are out of scope for the first version.

## Recommended stack

- Desktop shell: Tauri v2
- Native backend: Rust
- Web UI: existing React/Vite dashboard
- Runtime: bundled Node runtime plus existing TokenTracker CLI files
- Packaging: local Arch `PKGBUILD`

This stack keeps the Linux client lightweight, gives KDE tray integration, and maximizes reuse of the existing dashboard so the UI remains aligned with the Windows and macOS clients.

## Proposed repository layout

```text
TokenTrackerLinux/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── server.rs
│       ├── tray.rs
│       └── paths.rs
├── scripts/
│   ├── bundle-node-linux.sh
│   └── build-local-package.sh
└── packaging/
    └── arch/
        └── tokentracker-linux/
            ├── PKGBUILD
            └── tokentracker-linux.install
```

The Linux client should stay as a thin native shell. Business logic remains in `src/`, and dashboard UI remains in `dashboard/`.

## Build and install flow

The user builds and installs locally:

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

The `PKGBUILD` should:

1. Install JavaScript dependencies.
2. Build the existing dashboard.
3. Bundle a Linux Node runtime and required CLI files.
4. Build the Tauri desktop app.
5. Package files into a normal Arch package.

Expected installed paths:

```text
/usr/bin/tokentracker-linux
/usr/lib/tokentracker-linux/
  ├── node
  ├── bin/tracker.js
  ├── src/
  ├── package.json
  └── dashboard/dist/
/usr/share/applications/tokentracker-linux.desktop
/usr/share/icons/hicolor/.../apps/tokentracker-linux.png
```

Uninstall should use pacman:

```bash
sudo pacman -R tokentracker-linux
```

## Runtime behavior

At launch:

1. Enforce a single running app instance.
2. Pick an available `127.0.0.1` port dynamically.
3. Start the bundled Node server:

   ```text
   /usr/lib/tokentracker-linux/node \
     /usr/lib/tokentracker-linux/bin/tracker.js \
     serve --port <port> --no-open
   ```

4. Open a Tauri window at `http://127.0.0.1:<port>`.
5. Keep a KDE system tray icon alive while the app runs.

The close button should hide the window instead of quitting. The app exits only through the tray Quit action, which must stop the Node child process before exiting.

## KDE integration

Install a desktop entry like:

```ini
[Desktop Entry]
Type=Application
Name=TokenTracker
Comment=Local AI token usage tracker
Exec=tokentracker-linux %u
Icon=tokentracker-linux
Terminal=false
Categories=Development;Utility;
StartupNotify=true
MimeType=x-scheme-handler/tokentracker;
```

Post-install and post-upgrade hooks should refresh desktop and icon caches:

```bash
update-desktop-database -q
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor
```

KDE launcher search and tray behavior are first-class requirements. GNOME-specific behavior is not a first-version requirement.

## Tray menu

First version tray menu:

- Open Dashboard
- Quit

Second phase tray menu:

- Sync Now
- Status
- Launch at Login toggle

The first version should focus on reliable window lifecycle and server cleanup before adding command shortcuts.

## UI consistency

The Linux client should reuse the existing dashboard without creating Linux-only dashboard pages. The principle is:

```text
Dashboard UI stays unified. Native shell behavior follows each platform.
```

Only add Linux platform detection or a Linux native bridge if a concrete dashboard feature needs it. The first version should avoid a bridge unless required.

## Dependencies

Expected runtime dependencies, subject to the final Tauri v2 template:

```bash
depends=(
  'webkit2gtk'
  'gtk3'
  'libayatana-appindicator'
  'xdg-utils'
)
```

Expected build dependencies:

```bash
makedepends=(
  'nodejs'
  'npm'
  'rust'
  'cargo'
  'pkgconf'
  'base-devel'
)
```

The exact WebKitGTK package should be verified against the chosen Tauri v2 Linux target before implementation.

## Explicit non-goals

- Public AUR package
- `tokentracker-bin`
- GitHub Release Linux assets
- Linux release GitHub Actions
- AppImage, Flatpak, deb, or rpm packaging
- Multi-distro support
- GNOME-first tray behavior
- Rewriting the dashboard UI in native GTK/Qt

## Acceptance criteria

On the current Arch + KDE machine:

1. `makepkg -si` builds and installs `tokentracker-linux`.
2. KDE launcher can find and start TokenTracker.
3. Launching TokenTracker starts the local server and displays the dashboard.
4. A system tray icon appears.
5. Closing the window hides it while keeping the tray app alive.
6. Tray Open Dashboard restores or focuses the window.
7. Tray Quit exits the app and stops the Node server process.
8. `sudo pacman -R tokentracker-linux` removes installed program files.

Deep link handling, launch at login, and tray Sync/Status actions are second-phase acceptance criteria.
