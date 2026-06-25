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
