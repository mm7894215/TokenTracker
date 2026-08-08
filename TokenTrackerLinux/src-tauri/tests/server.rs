//! Server lifecycle details that are easy to break silently: the port fallback
//! that OAuth depends on, the argument shapes passed to the bundled CLI, and the
//! log file handling that used to `panic!` and grow without bound.

use std::ffi::OsString;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tokentracker_linux::server::{
    dashboard_url, pick_available_port, rotate_log_if_oversized, serve_args, server_log_paths,
    sync_args, MAX_LOG_BYTES,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

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

const PREFERRED_PORT: u16 = 17680;

#[test]
fn preferred_port_is_used_when_free() {
    // Only meaningful when nothing else on the machine holds 17680.
    let Ok(probe) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) else {
        eprintln!("port {PREFERRED_PORT} is busy on this machine; skipping");
        return;
    };
    drop(probe);

    let port = pick_available_port().expect("a port should be available");
    assert_eq!(
        port, PREFERRED_PORT,
        "OAuth redirect URLs are registered against the fixed port, so it must be preferred"
    );
}

#[test]
fn port_selection_falls_back_when_the_preferred_port_is_taken() {
    // Hold the preferred port for the duration of the call.
    let Ok(holder) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) else {
        eprintln!("port {PREFERRED_PORT} is busy on this machine; skipping");
        return;
    };

    let port = pick_available_port().expect("fallback port should be assigned");
    assert_ne!(
        port, PREFERRED_PORT,
        "must not report a port that is already held"
    );
    assert!(port > 0);
    TcpListener::bind(("127.0.0.1", port)).expect("fallback port should be bindable");

    drop(holder);
}

#[test]
fn dashboard_url_is_loopback_only() {
    // Binding to 127.0.0.1 rather than 0.0.0.0 keeps usage data off the LAN.
    assert_eq!(dashboard_url(17680), "http://127.0.0.1:17680");
    assert!(!dashboard_url(17680).contains("0.0.0.0"));
    assert!(!dashboard_url(17680).contains("localhost"));
}

#[test]
fn serve_args_disable_browser_launch_and_startup_sync() {
    let args = serve_args(Path::new("/opt/tokentracker/bin/tracker.js"), 34567);
    assert_eq!(
        args,
        vec![
            OsString::from("/opt/tokentracker/bin/tracker.js"),
            OsString::from("serve"),
            OsString::from("--port"),
            OsString::from("34567"),
            OsString::from("--no-open"),
            OsString::from("--no-sync"),
        ],
    );
}

#[test]
fn serve_args_carry_the_selected_port() {
    // A hardcoded port here would leave the webview pointing at a dead server
    // whenever the fallback path is taken.
    let args = serve_args(Path::new("/x/tracker.js"), 45678);
    let port_index = args
        .iter()
        .position(|arg| arg == &OsString::from("--port"))
        .expect("--port should be present");
    assert_eq!(args[port_index + 1], OsString::from("45678"));
}

#[test]
fn sync_args_scan_local_sources_without_publishing() {
    let args = sync_args(Path::new("/opt/tokentracker/bin/tracker.js"));
    assert_eq!(
        args,
        vec![
            OsString::from("/opt/tokentracker/bin/tracker.js"),
            OsString::from("sync"),
            OsString::from("--auto"),
            OsString::from("--background"),
            OsString::from("--all-local-sources"),
        ],
    );
    // Background sync must never publish to the cloud on the user's behalf.
    assert!(!args.contains(&OsString::from("--publish-account")));
}

#[test]
fn log_paths_prefer_xdg_state_home() {
    let paths = server_log_paths(
        Some(PathBuf::from("/home/u/.local/state")),
        Some(PathBuf::from("/home/u")),
    );

    assert_eq!(
        paths.first(),
        Some(&PathBuf::from(
            "/home/u/.local/state/tokentracker/server.log"
        ))
    );
    // /tmp is always the last resort so a read-only home never loses logging.
    assert_eq!(
        paths.last(),
        Some(&PathBuf::from("/tmp/tokentracker-server.log"))
    );
}

#[test]
fn log_paths_fall_back_to_home_then_tmp() {
    let paths = server_log_paths(None, Some(PathBuf::from("/home/u")));
    assert_eq!(
        paths,
        vec![
            PathBuf::from("/home/u/.local/state/tokentracker/server.log"),
            PathBuf::from("/tmp/tokentracker-server.log"),
        ]
    );
}

#[test]
fn log_paths_survive_a_missing_home() {
    let paths = server_log_paths(None, None);
    assert_eq!(paths, vec![PathBuf::from("/tmp/tokentracker-server.log")]);
}

#[test]
fn log_paths_do_not_duplicate_when_xdg_and_home_agree() {
    let paths = server_log_paths(
        Some(PathBuf::from("/home/u/.local/state")),
        Some(PathBuf::from("/home/u")),
    );
    let mut deduped = paths.clone();
    deduped.dedup();
    assert_eq!(paths.len(), deduped.len(), "got {paths:?}");
}

#[test]
fn small_logs_are_left_alone() {
    let temp = TempDir::new("log-small");
    let log = temp.path().join("server.log");
    fs::write(&log, b"a few lines\n").expect("write log");

    assert!(!rotate_log_if_oversized(&log, MAX_LOG_BYTES));
    assert_eq!(fs::read(&log).expect("log still there"), b"a few lines\n");
}

#[test]
fn oversized_logs_rotate_to_a_single_previous_generation() {
    let temp = TempDir::new("log-rotate");
    let log = temp.path().join("server.log");
    fs::write(&log, vec![b'x'; 64]).expect("write log");

    assert!(
        rotate_log_if_oversized(&log, 32),
        "a log over the limit should rotate"
    );

    let rotated = temp.path().join("server.log.1");
    assert!(rotated.exists(), "previous generation should be kept");
    assert_eq!(fs::read(&rotated).expect("rotated readable").len(), 64);
    assert!(!log.exists(), "the live log is recreated on next open");
}

#[test]
fn rotation_replaces_an_older_generation_so_growth_stays_bounded() {
    let temp = TempDir::new("log-bounded");
    let log = temp.path().join("server.log");
    fs::write(temp.path().join("server.log.1"), vec![b'o'; 8]).expect("old generation");
    fs::write(&log, vec![b'n'; 64]).expect("write log");

    assert!(rotate_log_if_oversized(&log, 32));

    // Exactly one previous generation, and it is the newer content.
    let rotated = fs::read(temp.path().join("server.log.1")).expect("rotated readable");
    assert_eq!(rotated.len(), 64);
    assert!(rotated.iter().all(|byte| *byte == b'n'));
    assert!(!temp.path().join("server.log.2").exists());
}

#[test]
fn rotating_a_missing_log_is_a_no_op() {
    let temp = TempDir::new("log-absent");
    assert!(!rotate_log_if_oversized(
        &temp.path().join("server.log"),
        MAX_LOG_BYTES
    ));
}

/// Guard against someone effectively disabling rotation by raising the cap to
/// absurdity, or making it so small the log is useless. Evaluated at compile
/// time because both sides are constants.
const _: () = {
    assert!(MAX_LOG_BYTES >= 1024 * 1024);
    assert!(MAX_LOG_BYTES <= 64 * 1024 * 1024);
};
