use std::env;
use std::path::{Path, PathBuf};

/// Directory name used by the Arch package (`/usr/lib/tokentracker-linux`).
const INSTALL_DIR_NAME: &str = "tokentracker-linux";

/// Directory name Tauri itself uses for Linux resources (`<prefix>/lib/<name>`),
/// where `<name>` is `productName` from `tauri.conf.json` -- verified against
/// `tauri-codegen`, which sets `PackageInfo.name` from `product_name`.
///
/// Probed in addition to Tauri's `resource_dir()` so an AppImage still resolves
/// if that lookup is unavailable for any reason.
const PRODUCT_DIR_NAME: &str = "TokenTracker";

/// Subdirectory that `scripts/bundle-node-linux.sh` writes and that
/// `bundle.resources` in `tauri.conf.json` maps into the bundle.
const EMBEDDED_DIR_NAME: &str = "EmbeddedServer";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub node: PathBuf,
    pub tracker: PathBuf,
}

/// The runtime layout produced by `bundle-node-linux.sh`: a `node` binary next
/// to a `tokentracker/` checkout. Every candidate root below is probed with
/// this same shape.
pub fn runtime_paths_in(root: &Path) -> RuntimePaths {
    RuntimePaths {
        node: root.join("node"),
        tracker: root.join("tokentracker").join("bin").join("tracker.js"),
    }
}

pub fn installed_runtime_paths(prefix: &Path) -> RuntimePaths {
    runtime_paths_in(prefix)
}

pub fn development_runtime_paths(project_dir: &Path) -> RuntimePaths {
    runtime_paths_in(&project_dir.join(EMBEDDED_DIR_NAME))
}

/// Locations the runtime may live in, injected rather than read from the
/// environment so the priority order is unit-testable.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RuntimeRoots {
    /// Tauri's own resource directory (`app.path().resource_dir()`).
    ///
    /// Authoritative for bundled builds: it is derived from the same
    /// `package_info.name` the bundler used, so it stays correct even though
    /// the product name ("TokenTracker") differs from the Arch package
    /// directory name ("tokentracker-linux").
    pub resource_dir: Option<PathBuf>,
    /// `$APPDIR`, exported by the AppImage runtime after it mounts the image
    /// on a random `/tmp/.mount_XXXXXX` path.
    pub appdir: Option<PathBuf>,
    /// Directory holding the running executable.
    pub exe_dir: Option<PathBuf>,
    /// `TokenTrackerLinux/` inside a repository checkout, for `cargo run`.
    pub project_dir: Option<PathBuf>,
}

impl RuntimeRoots {
    /// Reads everything discoverable from the process environment. The Tauri
    /// resource directory has to be supplied by the caller because it needs an
    /// `AppHandle`.
    pub fn from_env(resource_dir: Option<PathBuf>) -> Self {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        Self {
            resource_dir,
            appdir: env::var_os("APPDIR").map(PathBuf::from),
            exe_dir: env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            project_dir: manifest_dir.parent().map(Path::to_path_buf),
        }
    }
}

/// Candidate runtime roots, most specific first.
///
/// A development checkout is normally probed last so an installed copy always
/// wins, but it is promoted to the front when the running executable actually
/// lives inside that checkout (`cargo run` / `cargo build`), which is the only
/// situation where the repository copy is the intended runtime.
pub fn candidate_runtime_roots(roots: &RuntimeRoots) -> Vec<PathBuf> {
    let development = roots
        .project_dir
        .as_ref()
        .map(|project_dir| project_dir.join(EMBEDDED_DIR_NAME));
    let running_from_checkout = match (&roots.exe_dir, &roots.project_dir) {
        (Some(exe_dir), Some(project_dir)) => exe_dir.starts_with(project_dir),
        _ => false,
    };

    let mut candidates: Vec<PathBuf> = Vec::new();

    if running_from_checkout {
        push_unique(&mut candidates, development.clone());
    }

    if let Some(resource_dir) = &roots.resource_dir {
        // `bundle.resources` maps `../EmbeddedServer` under the resource root.
        push_unique(&mut candidates, Some(resource_dir.join(EMBEDDED_DIR_NAME)));
        // Tolerate a flattened bundle that drops the runtime at the root.
        push_unique(&mut candidates, Some(resource_dir.clone()));
    }

    // AppImage: `$APPDIR/usr/lib/<name>`, trying Tauri's product-name layout
    // before the Arch-style name.
    for dir_name in [PRODUCT_DIR_NAME, INSTALL_DIR_NAME] {
        for suffix in [Some(EMBEDDED_DIR_NAME), None] {
            push_unique(
                &mut candidates,
                roots.appdir.as_ref().map(|appdir| {
                    let root = appdir.join("usr").join("lib").join(dir_name);
                    match suffix {
                        Some(suffix) => root.join(suffix),
                        None => root,
                    }
                }),
            );
        }
    }

    // An installed prefix reached relatively from the executable
    // (`<prefix>/bin/../lib/<name>`), which also covers an AppImage whose
    // `$APPDIR` was not exported.
    for dir_name in [PRODUCT_DIR_NAME, INSTALL_DIR_NAME] {
        for suffix in [Some(EMBEDDED_DIR_NAME), None] {
            push_unique(
                &mut candidates,
                roots.exe_dir.as_ref().map(|exe_dir| {
                    let root = exe_dir.join("..").join("lib").join(dir_name);
                    match suffix {
                        Some(suffix) => root.join(suffix),
                        None => root,
                    }
                }),
            );
        }
    }

    // Portable layout: runtime sitting next to the executable.
    push_unique(
        &mut candidates,
        roots
            .exe_dir
            .as_ref()
            .map(|exe_dir| exe_dir.join(EMBEDDED_DIR_NAME)),
    );

    // Arch package (`PKGBUILD` copies `EmbeddedServer/.` straight into it).
    push_unique(
        &mut candidates,
        Some(Path::new("/usr/lib").join(INSTALL_DIR_NAME)),
    );

    push_unique(&mut candidates, development);

    candidates
}

fn push_unique(candidates: &mut Vec<PathBuf>, candidate: Option<PathBuf>) {
    if let Some(candidate) = candidate {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
}

/// Picks the first candidate root that holds both a `node` binary and
/// `tracker.js`.
pub fn resolve_runtime_paths_from(roots: &RuntimeRoots) -> Result<RuntimePaths, String> {
    let candidates = candidate_runtime_roots(roots);
    for candidate in &candidates {
        let paths = runtime_paths_in(candidate);
        if paths.node.exists() && paths.tracker.exists() {
            return Ok(paths);
        }
    }

    Err(format!(
        "TokenTracker runtime not found. Checked {}",
        candidates
            .iter()
            .map(|candidate| candidate.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub fn resolve_runtime_paths(resource_dir: Option<PathBuf>) -> Result<RuntimePaths, String> {
    resolve_runtime_paths_from(&RuntimeRoots::from_env(resource_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_runtime_paths_use_usr_lib_layout() {
        let paths = installed_runtime_paths(Path::new("/usr/lib/tokentracker-linux"));
        assert_eq!(
            paths.node,
            PathBuf::from("/usr/lib/tokentracker-linux/node")
        );
        assert_eq!(
            paths.tracker,
            PathBuf::from("/usr/lib/tokentracker-linux/tokentracker/bin/tracker.js")
        );
    }

    #[test]
    fn development_runtime_paths_use_embedded_server_layout() {
        let paths = development_runtime_paths(Path::new("/repo/TokenTrackerLinux"));
        assert_eq!(
            paths.node,
            PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer/node")
        );
        assert_eq!(
            paths.tracker,
            PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer/tokentracker/bin/tracker.js")
        );
    }
}
