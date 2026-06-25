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
