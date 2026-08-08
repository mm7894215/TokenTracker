//! Runtime discovery has to work in four very different layouts: an AppImage
//! mounted on a random `/tmp/.mount_XXXXXX` path, an Arch package under
//! `/usr/lib`, a portable directory next to the executable, and a repository
//! checkout. Getting the priority wrong means the app either fails to start or
//! silently runs a stale runtime.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tokentracker_linux::paths::{
    candidate_runtime_roots, resolve_runtime_paths_from, runtime_paths_in, RuntimeRoots,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Minimal scratch directory helper; the crate has no `tempfile` dependency.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tokentracker-linux-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch dir should be creatable");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Materialize the `node` + `tokentracker/bin/tracker.js` shape that
/// `bundle-node-linux.sh` produces.
fn install_runtime(root: &Path) {
    fs::create_dir_all(root.join("tokentracker").join("bin")).expect("bin dir");
    fs::write(root.join("node"), b"#!/bin/sh\n").expect("node stub");
    fs::write(
        root.join("tokentracker").join("bin").join("tracker.js"),
        b"// stub\n",
    )
    .expect("tracker stub");
}

fn index_of(candidates: &[PathBuf], needle: &Path) -> Option<usize> {
    candidates.iter().position(|candidate| candidate == needle)
}

#[test]
fn appimage_resource_dir_is_probed_first() {
    let roots = RuntimeRoots {
        resource_dir: Some(PathBuf::from("/tmp/.mount_abc123/usr/lib/TokenTracker")),
        appdir: Some(PathBuf::from("/tmp/.mount_abc123")),
        exe_dir: Some(PathBuf::from("/tmp/.mount_abc123/usr/bin")),
        project_dir: Some(PathBuf::from("/repo/TokenTrackerLinux")),
    };

    let candidates = candidate_runtime_roots(&roots);

    assert_eq!(
        candidates.first(),
        Some(&PathBuf::from(
            "/tmp/.mount_abc123/usr/lib/TokenTracker/EmbeddedServer"
        )),
        "Tauri's own resource directory is authoritative for bundled builds"
    );
}

#[test]
fn appimage_appdir_is_probed_when_no_resource_dir_is_available() {
    let roots = RuntimeRoots {
        resource_dir: None,
        appdir: Some(PathBuf::from("/tmp/.mount_xyz789")),
        exe_dir: Some(PathBuf::from("/tmp/.mount_xyz789/usr/bin")),
        project_dir: None,
    };

    let candidates = candidate_runtime_roots(&roots);

    // Tauri lays Linux resources out under `usr/lib/<productName>`, so the
    // product-name variant must be probed and must come before the Arch name.
    let product = index_of(
        &candidates,
        &PathBuf::from("/tmp/.mount_xyz789/usr/lib/TokenTracker/EmbeddedServer"),
    )
    .expect("the productName layout must be a candidate");
    let arch = index_of(
        &candidates,
        &PathBuf::from("/tmp/.mount_xyz789/usr/lib/tokentracker-linux"),
    )
    .expect("the Arch-style name must remain a candidate");

    assert!(
        product < arch,
        "AppImage bundles use productName; got {candidates:?}"
    );
}

/// `resource_dir()` is the primary lookup, but it is not the only one: an
/// AppImage must still resolve from `$APPDIR` alone.
#[test]
fn appimage_resolves_from_appdir_without_a_resource_dir() {
    let temp = TempDir::new("appimage");
    let appdir = temp.path().join("mount");
    install_runtime(&appdir.join("usr/lib/TokenTracker/EmbeddedServer"));

    let resolved = resolve_runtime_paths_from(&RuntimeRoots {
        resource_dir: None,
        appdir: Some(appdir.clone()),
        exe_dir: Some(appdir.join("usr/bin")),
        project_dir: None,
    })
    .expect("the AppImage runtime should be found");

    assert_eq!(
        resolved,
        runtime_paths_in(&appdir.join("usr/lib/TokenTracker/EmbeddedServer"))
    );
}

#[test]
fn exe_relative_prefix_is_probed_before_the_absolute_install_path() {
    let roots = RuntimeRoots {
        resource_dir: None,
        appdir: None,
        exe_dir: Some(PathBuf::from("/opt/tokentracker/bin")),
        project_dir: None,
    };

    let candidates = candidate_runtime_roots(&roots);
    let relative = index_of(
        &candidates,
        &PathBuf::from("/opt/tokentracker/bin/../lib/tokentracker-linux"),
    )
    .expect("exe-relative prefix should be a candidate");
    let absolute = index_of(&candidates, Path::new("/usr/lib/tokentracker-linux"))
        .expect("Arch install path should always be a candidate");

    assert!(
        relative < absolute,
        "a relocated install must win over the packaged absolute path"
    );
}

/// The Arch `PKGBUILD` still installs here, so this branch must survive.
#[test]
fn arch_install_path_is_always_a_candidate() {
    let candidates = candidate_runtime_roots(&RuntimeRoots::default());
    assert!(
        candidates.contains(&PathBuf::from("/usr/lib/tokentracker-linux")),
        "the Arch package layout must never be dropped; got {candidates:?}"
    );
}

#[test]
fn development_checkout_is_probed_last_for_an_installed_binary() {
    let roots = RuntimeRoots {
        resource_dir: None,
        appdir: None,
        exe_dir: Some(PathBuf::from("/usr/bin")),
        project_dir: Some(PathBuf::from("/repo/TokenTrackerLinux")),
    };

    let candidates = candidate_runtime_roots(&roots);

    assert_eq!(
        candidates.last(),
        Some(&PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer")),
        "an installed binary must not prefer a repository checkout"
    );
}

#[test]
fn development_checkout_wins_when_the_binary_runs_from_the_checkout() {
    let roots = RuntimeRoots {
        resource_dir: None,
        appdir: None,
        exe_dir: Some(PathBuf::from(
            "/repo/TokenTrackerLinux/src-tauri/target/debug",
        )),
        project_dir: Some(PathBuf::from("/repo/TokenTrackerLinux")),
    };

    let candidates = candidate_runtime_roots(&roots);

    assert_eq!(
        candidates.first(),
        Some(&PathBuf::from("/repo/TokenTrackerLinux/EmbeddedServer")),
        "`cargo run` must use the checkout's own bundled runtime"
    );
}

#[test]
fn candidates_are_deduplicated() {
    let roots = RuntimeRoots {
        resource_dir: Some(PathBuf::from("/same")),
        appdir: Some(PathBuf::from("/same")),
        exe_dir: Some(PathBuf::from("/same")),
        project_dir: Some(PathBuf::from("/same")),
    };

    let mut candidates = candidate_runtime_roots(&roots);
    let before = candidates.len();
    candidates.sort();
    candidates.dedup();

    assert_eq!(before, candidates.len(), "candidate list must not repeat");
}

#[test]
fn resolution_prefers_the_highest_priority_root_that_exists() {
    let temp = TempDir::new("priority");
    let resource_dir = temp.path().join("resources");
    let exe_dir = temp.path().join("bin");

    // Both a resource-dir runtime and a portable side-by-side runtime exist.
    install_runtime(&resource_dir.join("EmbeddedServer"));
    install_runtime(&exe_dir.join("EmbeddedServer"));

    let resolved = resolve_runtime_paths_from(&RuntimeRoots {
        resource_dir: Some(resource_dir.clone()),
        appdir: None,
        exe_dir: Some(exe_dir),
        project_dir: None,
    })
    .expect("a runtime exists");

    assert_eq!(
        resolved,
        runtime_paths_in(&resource_dir.join("EmbeddedServer"))
    );
}

#[test]
fn resolution_falls_back_when_a_higher_priority_root_is_incomplete() {
    let temp = TempDir::new("fallback");
    let resource_dir = temp.path().join("resources");
    let exe_dir = temp.path().join("bin");

    // A resource dir that exists but holds only `node` must not be selected:
    // half a runtime is worse than the complete fallback.
    fs::create_dir_all(resource_dir.join("EmbeddedServer")).expect("dir");
    fs::write(resource_dir.join("EmbeddedServer").join("node"), b"stub").expect("node");
    install_runtime(&exe_dir.join("EmbeddedServer"));

    let resolved = resolve_runtime_paths_from(&RuntimeRoots {
        resource_dir: Some(resource_dir),
        appdir: None,
        exe_dir: Some(exe_dir.clone()),
        project_dir: None,
    })
    .expect("the complete runtime should be found");

    assert_eq!(resolved, runtime_paths_in(&exe_dir.join("EmbeddedServer")));
}

#[test]
fn resolution_reports_every_checked_location_when_nothing_is_found() {
    let temp = TempDir::new("missing");
    let error = resolve_runtime_paths_from(&RuntimeRoots {
        resource_dir: Some(temp.path().join("resources")),
        appdir: Some(temp.path().join("appdir")),
        exe_dir: Some(temp.path().join("bin")),
        project_dir: Some(temp.path().join("project")),
    })
    .expect_err("nothing was installed");

    assert!(error.contains("runtime not found"), "got {error}");
    // The message is the only diagnostic a user gets, so it must name the
    // AppImage and development locations, not just one of them.
    assert!(error.contains("appdir"), "got {error}");
    assert!(error.contains("project"), "got {error}");
    assert!(error.contains("/usr/lib/tokentracker-linux"), "got {error}");
}

#[test]
fn runtime_layout_matches_the_bundle_script_output() {
    let paths = runtime_paths_in(Path::new("/opt/runtime"));
    assert_eq!(paths.node, PathBuf::from("/opt/runtime/node"));
    assert_eq!(
        paths.tracker,
        PathBuf::from("/opt/runtime/tokentracker/bin/tracker.js")
    );
}
