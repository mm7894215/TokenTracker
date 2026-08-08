use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use tokentracker_linux::server::{sync_args, BACKGROUND_SYNC_INTERVAL};

#[test]
fn background_sync_scans_all_local_sources_without_publishing() {
    let args = sync_args(Path::new("/opt/tokentracker/bin/tracker.js"));
    assert_eq!(
        args,
        vec![
            OsString::from("/opt/tokentracker/bin/tracker.js"),
            OsString::from("sync"),
            OsString::from("--auto"),
            OsString::from("--background"),
            OsString::from("--all-local-sources"),
        ]
    );
    assert!(!args.contains(&OsString::from("--publish-account")));
}

#[test]
fn background_sync_uses_the_native_five_minute_cadence() {
    assert_eq!(BACKGROUND_SYNC_INTERVAL, Duration::from_secs(300));
}
