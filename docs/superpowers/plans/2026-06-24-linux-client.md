# TokenTracker Linux Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Arch Linux + KDE Plasma desktop client that launches the existing TokenTracker dashboard inside a Tauri tray app and installs through a local `makepkg -si` package.

**Architecture:** Add `TokenTrackerLinux/` as a thin Tauri v2 shell. The Rust backend manages one bundled Node child process running the existing `bin/tracker.js serve --port <dynamic> --no-open`, then points a WebView window at that local server. Packaging stays local-only through an Arch `PKGBUILD` that installs the app, bundled runtime, desktop entry, icon, and pacman uninstall metadata.

**Tech Stack:** Tauri v2, Rust, existing React/Vite dashboard, existing CommonJS Node CLI, bundled Node.js 22.22.2 linux-x64 runtime, Arch `makepkg`/pacman packaging, KDE Plasma tray integration.

## Global Constraints

- Primary target: Arch Linux + KDE Plasma + x86_64.
- Installation: local Arch package built with `makepkg -si`.
- Package manager lifecycle: install and uninstall through pacman.
- Runtime: bundled Node runtime plus existing TokenTracker CLI files.
- Web UI: reuse the existing React/Vite dashboard; do not create Linux-only dashboard pages.
- Native shell: Tauri v2 with Rust backend.
- First-version tray menu: Open Dashboard and Quit.
- First-version behavior: close hides the window; Quit stops the Node child process and exits.
- Explicit non-goals: public AUR package, `tokentracker-bin`, GitHub Release Linux assets, Linux release GitHub Actions, AppImage, Flatpak, deb, rpm, multi-distro support, GNOME-first tray behavior, native GTK/Qt dashboard rewrite.
- `src/` remains CommonJS; dashboard remains ESM + TypeScript strict.
- Privacy remains unchanged: token counts only; never prompts, messages, responses, or file contents.

---

## File Structure

Create these files:

- `TokenTrackerLinux/package.json` — npm scripts for local Tauri development/build.
- `TokenTrackerLinux/src/index.html` — minimal loading page used before the Rust backend navigates to the local dashboard URL.
- `TokenTrackerLinux/src-tauri/Cargo.toml` — Rust crate and Tauri dependencies.
- `TokenTrackerLinux/src-tauri/build.rs` — Tauri build hook.
- `TokenTrackerLinux/src-tauri/tauri.conf.json` — Tauri app configuration.
- `TokenTrackerLinux/src-tauri/src/main.rs` — app startup, single instance, window lifecycle, tray, shutdown coordination.
- `TokenTrackerLinux/src-tauri/src/paths.rs` — resolve installed runtime paths and development runtime paths.
- `TokenTrackerLinux/src-tauri/src/server.rs` — choose local port, spawn/stop bundled Node server, parse server URL.
- `TokenTrackerLinux/src-tauri/src/tray.rs` — construct tray menu and handle tray actions.
- `TokenTrackerLinux/scripts/bundle-node-linux.sh` — build `EmbeddedServer/` with Node, CLI, production dependencies, and dashboard.
- `TokenTrackerLinux/scripts/build-local-package.sh` — convenience wrapper around `makepkg -si`.
- `TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD` — local Arch package definition.
- `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.install` — desktop/icon cache refresh hooks.
- `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.desktop` — KDE launcher and URL scheme entry.
- `TokenTrackerLinux/icons/tokentracker-linux.svg` — scalable app icon for local package installation.

Modify these files:

- `.gitignore` — ignore `TokenTrackerLinux/EmbeddedServer/`, `TokenTrackerLinux/src-tauri/target/`, and local `makepkg` outputs.
- `package.json` — add root scripts for building the Linux client and local package.

Do not modify dashboard pages for the first version.

---

### Task 1: Scaffold the Linux Tauri Shell

**Files:**
- Create: `TokenTrackerLinux/package.json`
- Create: `TokenTrackerLinux/src/index.html`
- Create: `TokenTrackerLinux/src-tauri/Cargo.toml`
- Create: `TokenTrackerLinux/src-tauri/build.rs`
- Create: `TokenTrackerLinux/src-tauri/tauri.conf.json`
- Create: `TokenTrackerLinux/src-tauri/src/main.rs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing repo root `package.json` version and existing dashboard build output in `dashboard/dist/`.
- Produces: a compilable Tauri crate named `tokentracker_linux` and a binary named `tokentracker-linux`; later tasks add modules used by `main.rs`.

- [ ] **Step 1: Create the Linux client npm package**

Create `TokenTrackerLinux/package.json`:

```json
{
  "name": "tokentracker-linux",
  "version": "0.59.0",
  "private": true,
  "type": "module",
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build",
    "bundle:node": "bash scripts/bundle-node-linux.sh",
    "package:local": "bash scripts/build-local-package.sh"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create the startup HTML page**

Create `TokenTrackerLinux/src/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TokenTracker</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
      }
      main {
        text-align: center;
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 1.5rem;
      }
      p {
        margin: 0;
        color: #94a3b8;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Starting TokenTracker…</h1>
      <p>The local dashboard will open automatically.</p>
    </main>
  </body>
</html>
```

- [ ] **Step 3: Create the Rust manifest**

Create `TokenTrackerLinux/src-tauri/Cargo.toml`:

```toml
[package]
name = "tokentracker-linux"
version = "0.59.0"
description = "TokenTracker Linux desktop client"
authors = ["TokenTracker"]
edition = "2021"
license = "MIT"

[lib]
name = "tokentracker_linux"
crate-type = ["staticlib", "cdylib", "rlib"]

[[bin]]
name = "tokentracker-linux"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-single-instance = "2"
once_cell = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 4: Create the Tauri build hook**

Create `TokenTrackerLinux/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 5: Create the Tauri config**

Create `TokenTrackerLinux/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "TokenTracker",
  "version": "0.59.0",
  "identifier": "cc.tokentracker.linux",
  "build": {
    "beforeDevCommand": "",
    "beforeBuildCommand": "",
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      {
        "label": "main",
        "title": "TokenTracker",
        "width": 1180,
        "height": 820,
        "minWidth": 960,
        "minHeight": 640,
        "url": "index.html",
        "visible": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": false,
    "targets": []
  }
}
```

- [ ] **Step 6: Create a temporary main file that compiles**

Create `TokenTrackerLinux/src-tauri/src/main.rs`:

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("failed to run TokenTracker Linux client");
}
```

- [ ] **Step 7: Ignore Linux local build outputs**

Append these lines to `.gitignore`:

```gitignore
# TokenTrackerLinux build artifacts
TokenTrackerLinux/EmbeddedServer/
TokenTrackerLinux/src-tauri/target/
TokenTrackerLinux/packaging/arch/tokentracker-linux/pkg/
TokenTrackerLinux/packaging/arch/tokentracker-linux/src/
TokenTrackerLinux/packaging/arch/tokentracker-linux/*.pkg.tar.*
TokenTrackerLinux/packaging/arch/tokentracker-linux/*.log
```

- [ ] **Step 8: Add root npm scripts**

Modify the root `package.json` `scripts` object by adding these entries after `dashboard:build`:

```json
"linux:bundle": "npm run dashboard:build && npm --prefix TokenTrackerLinux run bundle:node",
"linux:build": "npm run linux:bundle && npm --prefix TokenTrackerLinux run build",
"linux:package:local": "npm --prefix TokenTrackerLinux run package:local",
```

The surrounding `scripts` block must remain valid JSON.

- [ ] **Step 9: Install Linux client npm dependencies**

Run:

```bash
npm --prefix TokenTrackerLinux install
```

Expected: `TokenTrackerLinux/package-lock.json` is created and npm exits with code 0.

- [ ] **Step 10: Run the initial compile check**

Run:

```bash
npm --prefix TokenTrackerLinux run build
```

Expected: Tauri starts compiling. If it fails only because Arch system packages for Tauri are missing, install them with:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg base-devel pkgconf
```

Then rerun:

```bash
npm --prefix TokenTrackerLinux run build
```

Expected: build exits with code 0 and creates `TokenTrackerLinux/src-tauri/target/release/tokentracker-linux`.

- [ ] **Step 11: Commit scaffold**

Run:

```bash
git add .gitignore package.json TokenTrackerLinux/package.json TokenTrackerLinux/package-lock.json TokenTrackerLinux/src TokenTrackerLinux/src-tauri
git commit -m "feat(linux): scaffold tauri desktop client"
```

Expected: commit succeeds.

---

### Task 2: Add Runtime Path and Server Process Management

**Files:**
- Create: `TokenTrackerLinux/src-tauri/src/paths.rs`
- Create: `TokenTrackerLinux/src-tauri/src/server.rs`
- Modify: `TokenTrackerLinux/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: installed runtime layout `/usr/lib/tokentracker-linux/{node,tokentracker/bin/tracker.js}` and dev layout `TokenTrackerLinux/EmbeddedServer/{node,tokentracker/bin/tracker.js}`.
- Produces:
  - `paths::RuntimePaths { node: PathBuf, tracker: PathBuf }`
  - `paths::resolve_runtime_paths() -> Result<RuntimePaths, String>`
  - `server::TokenTrackerServer::start(paths: RuntimePaths) -> Result<TokenTrackerServer, String>`
  - `TokenTrackerServer::url(&self) -> &str`
  - `TokenTrackerServer::stop(&mut self)`

- [ ] **Step 1: Write runtime path tests**

Create `TokenTrackerLinux/src-tauri/src/paths.rs` with tests first:

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub node: PathBuf,
    pub tracker: PathBuf,
}

pub fn installed_runtime_paths(prefix: &Path) -> RuntimePaths {
    RuntimePaths {
        node: prefix.join("node"),
        tracker: prefix.join("tokentracker").join("bin").join("tracker.js"),
    }
}

pub fn development_runtime_paths(project_dir: &Path) -> RuntimePaths {
    RuntimePaths {
        node: project_dir.join("EmbeddedServer").join("node"),
        tracker: project_dir
            .join("EmbeddedServer")
            .join("tokentracker")
            .join("bin")
            .join("tracker.js"),
    }
}

pub fn resolve_runtime_paths() -> Result<RuntimePaths, String> {
    let installed = installed_runtime_paths(Path::new("/usr/lib/tokentracker-linux"));
    if installed.node.exists() && installed.tracker.exists() {
        return Ok(installed);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_dir = manifest_dir
        .parent()
        .ok_or_else(|| "failed to resolve TokenTrackerLinux directory".to_string())?;
    let development = development_runtime_paths(project_dir);
    if development.node.exists() && development.tracker.exists() {
        return Ok(development);
    }

    Err(format!(
        "TokenTracker runtime not found. Checked {} and {}",
        installed.node.display(),
        development.node.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_runtime_paths_use_usr_lib_layout() {
        let paths = installed_runtime_paths(Path::new("/usr/lib/tokentracker-linux"));
        assert_eq!(paths.node, PathBuf::from("/usr/lib/tokentracker-linux/node"));
        assert_eq!(
            paths.tracker,
            PathBuf::from("/usr/lib/tokentracker-linux/tokentracker/bin/tracker.js")
        );
    }

    #[test]
    fn development_runtime_paths_use_embedded_server_layout() {
        let paths = development_runtime_paths(Path::new("/repo/TokenTrackerLinux"));
        assert_eq!(paths.node, PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer/node"));
        assert_eq!(
            paths.tracker,
            PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer/tokentracker/bin/tracker.js")
        );
    }
}
```

- [ ] **Step 2: Run the path tests**

Run:

```bash
cd TokenTrackerLinux/src-tauri && cargo test paths -- --nocapture
```

Expected: both tests pass.

- [ ] **Step 3: Write server management tests and implementation**

Create `TokenTrackerLinux/src-tauri/src/server.rs`:

```rust
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::paths::RuntimePaths;

#[derive(Debug)]
pub struct TokenTrackerServer {
    child: Child,
    url: String,
}

impl TokenTrackerServer {
    pub fn start(paths: RuntimePaths) -> Result<Self, String> {
        let port = pick_available_port()?;
        let url = dashboard_url(port);

        let mut child = Command::new(&paths.node)
            .arg(&paths.tracker)
            .arg("serve")
            .arg("--port")
            .arg(port.to_string())
            .arg("--no-open")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to start TokenTracker server: {error}"))?;

        wait_for_server(port, Duration::from_secs(20)).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;

        Ok(Self { child, url })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn stop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_status)) => {}
            Ok(None) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            Err(_error) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

impl Drop for TokenTrackerServer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn pick_available_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve local port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read reserved local port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(port: u16, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpListener::bind(("127.0.0.1", port)).is_err() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!("TokenTracker server did not listen on port {port} within {timeout:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_url_uses_loopback_http() {
        assert_eq!(dashboard_url(45678), "http://127.0.0.1:45678");
    }

    #[test]
    fn pick_available_port_returns_bindable_port() {
        let port = pick_available_port().expect("port should be available");
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port)).expect("returned port should be bindable immediately");
    }
}
```

- [ ] **Step 4: Run the server tests**

Run:

```bash
cd TokenTrackerLinux/src-tauri && cargo test server -- --nocapture
```

Expected: both tests pass.

- [ ] **Step 5: Wire modules into main**

Replace `TokenTrackerLinux/src-tauri/src/main.rs` with:

```rust
mod paths;
mod server;

use std::sync::Mutex;

use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{Manager, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            let runtime_paths = paths::resolve_runtime_paths()?;
            let server = TokenTrackerServer::start(runtime_paths)?;
            let dashboard_url = server.url().to_string();

            if let Ok(mut guard) = SERVER.lock() {
                *guard = Some(server);
            }

            if let Some(window) = app.get_webview_window("main") {
                window.navigate(dashboard_url.parse().map_err(|error| error.to_string())?)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TokenTracker Linux client")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                stop_server();
            }
        });
}
```

- [ ] **Step 6: Run all Rust tests**

Run:

```bash
cd TokenTrackerLinux/src-tauri && cargo test -- --nocapture
```

Expected: all tests pass.

- [ ] **Step 7: Build the dashboard and bundle runtime for manual app launch**

Run:

```bash
npm run dashboard:build
npm --prefix TokenTrackerLinux run bundle:node
```

Expected now: the bundle script is not created until Task 4, so this command fails with `scripts/bundle-node-linux.sh: No such file or directory` if Task 4 has not run. If executing tasks strictly in order, skip this step and run it during Task 4.

- [ ] **Step 8: Commit server management**

Run:

```bash
git add TokenTrackerLinux/src-tauri/src/main.rs TokenTrackerLinux/src-tauri/src/paths.rs TokenTrackerLinux/src-tauri/src/server.rs
git commit -m "feat(linux): manage bundled dashboard server"
```

Expected: commit succeeds.

---

### Task 3: Add Tray Menu and Close-to-Tray Lifecycle

**Files:**
- Create: `TokenTrackerLinux/src-tauri/src/tray.rs`
- Modify: `TokenTrackerLinux/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `show_main_window(app: &tauri::AppHandle)` and `stop_server()` from `main.rs`.
- Produces: `tray::install(app: &tauri::App) -> tauri::Result<()>` with Open Dashboard and Quit actions.

- [ ] **Step 1: Create tray module**

Create `TokenTrackerLinux/src-tauri/src/tray.rs`:

```rust
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

const OPEN_ID: &str = "open-dashboard";
const QUIT_ID: &str = "quit";

pub fn install(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .tooltip("TokenTracker")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 2: Wire tray module into main**

Replace `TokenTrackerLinux/src-tauri/src/main.rs` with:

```rust
mod paths;
mod server;
mod tray;

use std::sync::Mutex;

use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{Manager, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            tray::install(app)?;

            let runtime_paths = paths::resolve_runtime_paths()?;
            let server = TokenTrackerServer::start(runtime_paths)?;
            let dashboard_url = server.url().to_string();

            if let Ok(mut guard) = SERVER.lock() {
                *guard = Some(server);
            }

            if let Some(window) = app.get_webview_window("main") {
                window.navigate(dashboard_url.parse().map_err(|error| error.to_string())?)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TokenTracker Linux client")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                stop_server();
            }
        });
}
```

- [ ] **Step 3: Run Rust checks**

Run:

```bash
cd TokenTrackerLinux/src-tauri && cargo test -- --nocapture
cargo check
```

Expected: tests pass and `cargo check` exits with code 0.

- [ ] **Step 4: Commit tray lifecycle**

Run:

```bash
git add TokenTrackerLinux/src-tauri/src/main.rs TokenTrackerLinux/src-tauri/src/tray.rs
git commit -m "feat(linux): add kde tray lifecycle"
```

Expected: commit succeeds.

---

### Task 4: Bundle Node Runtime and Existing TokenTracker App

**Files:**
- Create: `TokenTrackerLinux/scripts/bundle-node-linux.sh`
- Modify: `.gitignore` if Task 1 did not already add Linux bundle outputs

**Interfaces:**
- Consumes: root `bin/tracker.js`, root `src/`, root `package.json`, and built `dashboard/dist/`.
- Produces: `TokenTrackerLinux/EmbeddedServer/node` and `TokenTrackerLinux/EmbeddedServer/tokentracker/bin/tracker.js`, which `paths::development_runtime_paths()` consumes.

- [ ] **Step 1: Create the Linux bundle script**

Create `TokenTrackerLinux/scripts/bundle-node-linux.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

EXPECTED_NODE_VERSION="22.22.2"
NODE_VERSION="${NODE_VERSION:-$EXPECTED_NODE_VERSION}"
if [[ "$NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Refusing to bundle Node.js v${NODE_VERSION}; expected pinned v${EXPECTED_NODE_VERSION}." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$LINUX_DIR/.." && pwd)"
EMBED_DIR="$LINUX_DIR/EmbeddedServer"
TARGET_ARCH="${TARGET_ARCH:-x64}"
NODE_PLATFORM="linux-${TARGET_ARCH}"
NODE_TAR="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$EMBED_DIR"
  echo "Cleaned $EMBED_DIR"
  exit 0
fi

rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"

TMPDIR_BUNDLE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUNDLE"' EXIT

curl -fSL --retry 4 --retry-delay 2 -o "$TMPDIR_BUNDLE/$NODE_TAR" "$NODE_BASE_URL/$NODE_TAR"
curl -fSL --retry 4 --retry-delay 2 -o "$TMPDIR_BUNDLE/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"
EXPECTED_SUM="$(grep " $NODE_TAR\$" "$TMPDIR_BUNDLE/SHASUMS256.txt" | awk '{print $1}')"
ACTUAL_SUM="$(sha256sum "$TMPDIR_BUNDLE/$NODE_TAR" | awk '{print $1}')"
if [[ -z "$EXPECTED_SUM" || "$EXPECTED_SUM" != "$ACTUAL_SUM" ]]; then
  echo "Node.js checksum mismatch for $NODE_TAR" >&2
  echo "expected: $EXPECTED_SUM" >&2
  echo "actual:   $ACTUAL_SUM" >&2
  exit 1
fi

tar -xzf "$TMPDIR_BUNDLE/$NODE_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-${NODE_PLATFORM}/bin/node"
cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$EMBED_DIR/node"
chmod +x "$EMBED_DIR/node"

BUNDLED_NODE_VERSION="$($EMBED_DIR/node -p 'process.versions.node')"
if [[ "$BUNDLED_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Bundled Node drifted: expected $EXPECTED_NODE_VERSION, got $BUNDLED_NODE_VERSION" >&2
  exit 1
fi

TT_DIR="$EMBED_DIR/tokentracker"
mkdir -p "$TT_DIR/bin"
cp "$REPO_ROOT/bin/tracker.js" "$TT_DIR/bin/"
cp -R "$REPO_ROOT/src" "$TT_DIR/src"
cp "$REPO_ROOT/package.json" "$TT_DIR/"

if [[ ! -d "$REPO_ROOT/dashboard/dist" ]]; then
  echo "dashboard/dist not found. Run npm run dashboard:build first." >&2
  exit 1
fi
mkdir -p "$TT_DIR/dashboard"
cp -R "$REPO_ROOT/dashboard/dist" "$TT_DIR/dashboard/dist"

(
  cd "$TT_DIR"
  npm install --omit=dev --no-optional --ignore-scripts
)

find "$TT_DIR/node_modules" -type f \( \
  -name "*.md" -o \
  -name "*.txt" -o \
  -name "*.map" -o \
  -name "*.ts" -o \
  -name "*.d.ts" -o \
  -iname "LICENSE*" -o \
  -iname "LICENCE*" -o \
  -iname "CHANGELOG*" -o \
  -iname "CHANGES*" -o \
  -iname "HISTORY*" -o \
  -name ".npmignore" -o \
  -name ".eslintrc*" -o \
  -name ".prettierrc*" -o \
  -name "tsconfig.json" -o \
  -name ".editorconfig" \
\) -delete 2>/dev/null || true

find "$TT_DIR/node_modules" -type d \( \
  -name "test" -o \
  -name "tests" -o \
  -name "__tests__" -o \
  -name "examples" -o \
  -name "example" -o \
  -name "docs" -o \
  -name ".github" \
\) -exec rm -rf {} + 2>/dev/null || true

printf 'Bundled TokenTracker Linux runtime at %s\n' "$EMBED_DIR"
printf 'Node: %s\n' "$($EMBED_DIR/node -p 'process.versions.node')"
printf 'Size: %s\n' "$(du -sh "$EMBED_DIR" | cut -f1)"
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x TokenTrackerLinux/scripts/bundle-node-linux.sh
```

Expected: no output and exit code 0.

- [ ] **Step 3: Build dashboard and bundle runtime**

Run:

```bash
npm run dashboard:build
npm --prefix TokenTrackerLinux run bundle:node
```

Expected: `TokenTrackerLinux/EmbeddedServer/node` exists, `TokenTrackerLinux/EmbeddedServer/tokentracker/bin/tracker.js` exists, and the script prints the bundled runtime size.

- [ ] **Step 4: Verify bundled CLI can print help**

Run:

```bash
TokenTrackerLinux/EmbeddedServer/node TokenTrackerLinux/EmbeddedServer/tokentracker/bin/tracker.js --help
```

Expected output starts with:

```text
tokentracker

Usage:
```

- [ ] **Step 5: Build and launch the Tauri app from source**

Run:

```bash
npm --prefix TokenTrackerLinux run build
./TokenTrackerLinux/src-tauri/target/release/tokentracker-linux
```

Expected: the TokenTracker window opens, the dashboard loads from a `127.0.0.1` URL, and a KDE tray icon appears. Use the tray Quit item to exit.

- [ ] **Step 6: Commit bundling**

Run:

```bash
git add TokenTrackerLinux/scripts/bundle-node-linux.sh
git commit -m "feat(linux): bundle node runtime"
```

Expected: commit succeeds.

---

### Task 5: Add Local Arch Package Files

**Files:**
- Create: `TokenTrackerLinux/icons/tokentracker-linux.svg`
- Create: `TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD`
- Create: `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.install`
- Create: `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.desktop`
- Create: `TokenTrackerLinux/scripts/build-local-package.sh`

**Interfaces:**
- Consumes: Tauri release binary at `TokenTrackerLinux/src-tauri/target/release/tokentracker-linux` and bundled runtime at `TokenTrackerLinux/EmbeddedServer/`.
- Produces: a pacman-installable local package named `tokentracker-linux` with `/usr/bin/tokentracker-linux`, `/usr/lib/tokentracker-linux`, desktop entry, and icon.

- [ ] **Step 1: Create scalable icon**

Create `TokenTrackerLinux/icons/tokentracker-linux.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="TokenTracker">
  <defs>
    <linearGradient id="bg" x1="24" y1="16" x2="104" y2="112" gradientUnits="userSpaceOnUse">
      <stop stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect x="12" y="12" width="104" height="104" rx="28" fill="url(#bg)"/>
  <path d="M38 78c8 12 20 18 36 18 10 0 18-2 24-6" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>
  <circle cx="48" cy="52" r="8" fill="#ffffff"/>
  <circle cx="80" cy="52" r="8" fill="#ffffff"/>
  <path d="M64 24v18" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 2: Create desktop entry**

Create `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.desktop`:

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

- [ ] **Step 3: Create pacman install hook file**

Create `TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.install`:

```bash
post_install() {
  update-desktop-database -q || true
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
}

post_upgrade() {
  post_install
}

post_remove() {
  update-desktop-database -q || true
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
}
```

- [ ] **Step 4: Create local PKGBUILD**

Create `TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD`:

```bash
# Maintainer: local
pkgname=tokentracker-linux
pkgver=0.59.0
pkgrel=1
pkgdesc='Local TokenTracker Linux desktop client for Arch KDE'
arch=('x86_64')
url='https://github.com/mm7894215/TokenTracker'
license=('MIT')
depends=(
  'webkit2gtk-4.1'
  'gtk3'
  'libayatana-appindicator'
  'librsvg'
  'xdg-utils'
)
makedepends=(
  'nodejs'
  'npm'
  'rust'
  'cargo'
  'pkgconf'
  'base-devel'
)
install='tokentracker-linux.install'
source=()
sha256sums=()

_repo_root="${startdir}/../../../.."
_linux_dir="${_repo_root}/TokenTrackerLinux"

build() {
  cd "${_repo_root}"
  npm ci
  npm --prefix dashboard ci
  npm run dashboard:build
  npm --prefix TokenTrackerLinux install
  npm --prefix TokenTrackerLinux run bundle:node
  npm --prefix TokenTrackerLinux run build
}

package() {
  cd "${_repo_root}"

  install -Dm755 "TokenTrackerLinux/src-tauri/target/release/tokentracker-linux" \
    "${pkgdir}/usr/bin/tokentracker-linux"

  install -dm755 "${pkgdir}/usr/lib/tokentracker-linux"
  cp -a "TokenTrackerLinux/EmbeddedServer/." "${pkgdir}/usr/lib/tokentracker-linux/"
  chmod 755 "${pkgdir}/usr/lib/tokentracker-linux/node"

  install -Dm644 "TokenTrackerLinux/packaging/arch/tokentracker-linux/tokentracker-linux.desktop" \
    "${pkgdir}/usr/share/applications/tokentracker-linux.desktop"

  install -Dm644 "TokenTrackerLinux/icons/tokentracker-linux.svg" \
    "${pkgdir}/usr/share/icons/hicolor/scalable/apps/tokentracker-linux.svg"

  install -Dm644 "LICENSE" "${pkgdir}/usr/share/licenses/tokentracker-linux/LICENSE"
}
```

- [ ] **Step 5: Create package wrapper script**

Create `TokenTrackerLinux/scripts/build-local-package.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$SCRIPT_DIR/../packaging/arch/tokentracker-linux"

cd "$PKG_DIR"
makepkg -si
```

- [ ] **Step 6: Make package wrapper executable**

Run:

```bash
chmod +x TokenTrackerLinux/scripts/build-local-package.sh
```

Expected: no output and exit code 0.

- [ ] **Step 7: Build and install local package**

Run:

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

Expected: pacman installs `tokentracker-linux` and prints no packaging errors. If pacman asks to install dependencies, answer yes.

- [ ] **Step 8: Check installed files**

Run:

```bash
pacman -Ql tokentracker-linux | grep -E 'tokentracker-linux$|tokentracker-linux.desktop|tokentracker-linux.svg|/usr/lib/tokentracker-linux/node'
```

Expected output includes these paths:

```text
tokentracker-linux /usr/bin/tokentracker-linux
tokentracker-linux /usr/lib/tokentracker-linux/node
tokentracker-linux /usr/share/applications/tokentracker-linux.desktop
tokentracker-linux /usr/share/icons/hicolor/scalable/apps/tokentracker-linux.svg
```

- [ ] **Step 9: Commit package files**

Run:

```bash
git add TokenTrackerLinux/icons TokenTrackerLinux/packaging TokenTrackerLinux/scripts/build-local-package.sh
git commit -m "feat(linux): add local arch package"
```

Expected: commit succeeds.

---

### Task 6: Validate KDE Runtime Behavior and Document Local Use

**Files:**
- Create: `TokenTrackerLinux/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: installed `tokentracker-linux` package from Task 5.
- Produces: local user documentation and verified acceptance criteria.

- [ ] **Step 1: Create Linux client README**

Create `TokenTrackerLinux/README.md`:

```markdown
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
```

- [ ] **Step 2: Add a short root README note**

In `README.md`, after the Homebrew section ending at `README.md:86`, add:

```markdown
### 🐧 Local Arch/KDE Linux client

This repository also includes a local-use Linux desktop client for Arch Linux + KDE Plasma. It is built from source and installed as a local pacman package:

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

See [`TokenTrackerLinux/README.md`](TokenTrackerLinux/README.md). This is not a public AUR package or release asset.
```

- [ ] **Step 3: Run package install if not already installed**

Run:

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

Expected: `tokentracker-linux` is installed or upgraded successfully.

- [ ] **Step 4: Launch installed app from terminal**

Run:

```bash
tokentracker-linux
```

Expected: TokenTracker window opens with the dashboard loaded. A KDE tray icon appears.

- [ ] **Step 5: Manually verify close-to-tray**

Manual action: click the window close button.

Expected: window disappears, tray icon remains visible, and this command still finds the app process:

```bash
pgrep -af tokentracker-linux
```

Expected output includes `tokentracker-linux`.

- [ ] **Step 6: Manually verify tray restore**

Manual action: click tray icon or choose **Open Dashboard** from the tray menu.

Expected: TokenTracker dashboard window returns and is focused.

- [ ] **Step 7: Manually verify tray quit cleanup**

Manual action: choose **Quit** from the tray menu.

Then run:

```bash
pgrep -af 'tokentracker-linux|tracker.js serve' || true
```

Expected: no `tokentracker-linux` process and no bundled `tracker.js serve` process remain.

- [ ] **Step 8: Verify pacman uninstall removes installed files**

Run:

```bash
sudo pacman -R tokentracker-linux
```

Expected: package removal succeeds.

Then run:

```bash
test ! -e /usr/bin/tokentracker-linux && test ! -d /usr/lib/tokentracker-linux && echo removed
```

Expected output:

```text
removed
```

- [ ] **Step 9: Reinstall for continued local use**

Run:

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

Expected: package installs successfully.

- [ ] **Step 10: Run project validation relevant to touched areas**

Run:

```bash
npm test
npm run dashboard:build
cd TokenTrackerLinux/src-tauri && cargo test -- --nocapture && cargo check
```

Expected: Node tests pass, dashboard build passes, Rust tests pass, and Rust check passes.

- [ ] **Step 11: Commit docs and validation updates**

Run:

```bash
git add README.md TokenTrackerLinux/README.md
git commit -m "docs(linux): document local desktop client"
```

Expected: commit succeeds.

---

## Self-Review Notes

Spec coverage:

- Arch + KDE + x86_64 local target: covered by Global Constraints, Task 5 package dependencies, Task 6 manual KDE validation.
- `makepkg -si` install and pacman uninstall: covered by Task 5 and Task 6.
- Tauri v2 + Rust shell: covered by Task 1 through Task 3.
- Existing React dashboard reuse: covered by Task 4 bundle and no dashboard page tasks.
- Bundled Node runtime plus existing CLI: covered by Task 4.
- Dynamic local server and dashboard URL: covered by Task 2.
- Tray Open Dashboard and Quit: covered by Task 3 and Task 6.
- Close hides instead of exits: covered by Task 3 and Task 6.
- No public release/AUR/CI/AppImage/Flatpak/deb/rpm work: no tasks create those artifacts.

Placeholder scan:

- The plan contains no `TBD`, no `TODO`, and no unspecified implementation steps.
- Second-phase features from the spec are intentionally excluded from tasks.

Type consistency:

- `RuntimePaths`, `resolve_runtime_paths`, `TokenTrackerServer::start`, `TokenTrackerServer::url`, `TokenTrackerServer::stop`, and `tray::install` are defined before use.
- Installed paths in packaging match `paths::installed_runtime_paths()`.
- Development paths in bundling match `paths::development_runtime_paths()`.
