# TokenTracker Linux Client

This is a local Arch Linux + KDE Plasma desktop client for TokenTracker. It is intended for personal local use from this repository, not public release distribution.

## Build and install

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

## Run

Start **TokenTracker** from the KDE application launcher, or run:

```bash
tokentracker-linux
```

The app starts a bundled local TokenTracker server, opens the existing dashboard in a Tauri window, and keeps a system tray icon alive.

## Window behavior

- Closing the window hides it to the tray.
- Tray **Open Dashboard** restores the window.
- Tray **Quit** stops the bundled Node server and exits the app.

## Uninstall

```bash
sudo pacman -R tokentracker-linux
```
