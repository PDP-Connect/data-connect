// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Host-owned browser surfaces for the unified desktop stack. The reference
// implementation talks to this narrow loopback capability endpoint and keeps
// the returned surface id opaque.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(test)]
use std::net::SocketAddr;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const BROWSER_SURFACE_PATH: &str = "/browser-surface/leases";
const MAX_HTTP_REQUEST_BYTES: usize = 64 * 1024;
const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct AcquireRequest {
    /// Stable idempotency key for acquisition and cancellation.
    run_id: String,
    connector_id: String,
    #[serde(default)]
    headless: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct AcquireResponse {
    surface_id: String,
    cdp_url: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

struct BrowserSurfaceLease {
    run_id: String,
    connector_id: String,
    headless: bool,
    response: AcquireResponse,
    child: Child,
}

struct HostState {
    profile_root: PathBuf,
    resource_dir: Option<PathBuf>,
    browser_path_override: Option<PathBuf>,
    leases: Mutex<HashMap<String, BrowserSurfaceLease>>,
    /// Prevent a late POST from recreating a lease after its run was released.
    cancelled_runs: Mutex<HashSet<String>>,
    closed: AtomicBool,
}

impl HostState {
    fn new(
        profile_root: PathBuf,
        resource_dir: Option<PathBuf>,
        browser_path_override: Option<PathBuf>,
    ) -> Self {
        Self {
            profile_root,
            resource_dir,
            browser_path_override,
            leases: Mutex::new(HashMap::new()),
            cancelled_runs: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn acquire(&self, request: AcquireRequest) -> Result<AcquireResponse, String> {
        validate_request_field("run_id", &request.run_id)?;
        validate_request_field("connector_id", &request.connector_id)?;

        // Admission and launch are serialized. A connector has exactly one
        // persistent profile, so a second launch must not race the first
        // launch or reuse its profile while the first browser is still alive.
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| "Browser surface lease state is unavailable".to_string())?;
        if self.closed.load(Ordering::Acquire) {
            return Err("Browser surface host is shutting down".into());
        }
        if self
            .cancelled_runs
            .lock()
            .map_err(|_| "Browser surface lease state is unavailable".to_string())?
            .contains(&request.run_id)
        {
            return Err("Run id has already been released".into());
        }
        if let Some(lease) = leases.values().find(|lease| lease.run_id == request.run_id) {
            if lease.connector_id != request.connector_id || lease.headless != request.headless {
                return Err("Run id is already bound to a different browser request".into());
            }
            return Ok(lease.response.clone());
        }
        if leases
            .values()
            .any(|lease| lease.connector_id == request.connector_id)
        {
            return Err(format!(
                "Connector {:?} already owns a browser surface",
                request.connector_id
            ));
        }

        let profile_dir = self.profile_dir(&request.connector_id)?;
        let _ = fs::remove_file(profile_dir.join("DevToolsActivePort"));

        let browser = self.browser_path().ok_or_else(|| {
            "No system, downloaded, or bundled Chromium browser is available for host browser surfaces".to_string()
        })?;
        let (child, endpoint) = launch_browser(&browser, &profile_dir, request.headless)?;
        let surface_id = format!("host-surface-{}", Uuid::new_v4().as_simple());
        let response = AcquireResponse {
            surface_id: surface_id.clone(),
            cdp_url: endpoint,
        };
        leases.insert(
            surface_id.clone(),
            BrowserSurfaceLease {
                run_id: request.run_id,
                connector_id: request.connector_id,
                headless: request.headless,
                response: response.clone(),
                child,
            },
        );

        Ok(response)
    }

    fn release(&self, surface_id: &str) {
        let Ok(mut leases) = self.leases.lock() else {
            log::error!("Browser surface lease state is poisoned during release");
            return;
        };
        let Some(mut lease) = leases.remove(surface_id) else {
            // DELETE is deliberately idempotent for RI cleanup retries.
            return;
        };
        if !super::pdpp_browser::terminate_browser(&mut lease.child) {
            log::warn!("Browser surface {surface_id} did not terminate cleanly");
        }
    }

    fn release_run(&self, run_id: &str) {
        let Ok(mut leases) = self.leases.lock() else {
            log::error!("Browser surface lease state is poisoned during run release");
            return;
        };
        let Ok(mut cancelled_runs) = self.cancelled_runs.lock() else {
            log::error!("Browser surface cancellation state is poisoned during run release");
            return;
        };
        cancelled_runs.insert(run_id.to_string());
        let surface_id = leases
            .iter()
            .find_map(|(surface_id, lease)| (lease.run_id == run_id).then(|| surface_id.clone()));
        if let Some(surface_id) = surface_id {
            if let Some(mut lease) = leases.remove(&surface_id) {
                if !super::pdpp_browser::terminate_browser(&mut lease.child) {
                    log::warn!("Browser surface {surface_id} did not terminate cleanly");
                }
            }
        }
    }

    fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let Ok(mut leases) = self.leases.lock() else {
            log::error!("Browser surface lease state is poisoned during shutdown");
            return;
        };
        for (surface_id, mut lease) in leases.drain() {
            if !super::pdpp_browser::terminate_browser(&mut lease.child) {
                log::warn!("Browser surface {surface_id} did not terminate cleanly");
            }
        }
    }

    fn profile_dir(&self, connector_id: &str) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.profile_root)
            .map_err(|error| format!("Failed to create browser surface root: {error}"))?;
        let canonical_root = fs::canonicalize(&self.profile_root)
            .map_err(|error| format!("Failed to confine browser surface root: {error}"))?;
        let profile_dir = canonical_root.join(stable_segment(connector_id));
        fs::create_dir_all(&profile_dir)
            .map_err(|error| format!("Failed to create browser profile: {error}"))?;
        let canonical_profile = fs::canonicalize(&profile_dir)
            .map_err(|error| format!("Failed to confine browser profile: {error}"))?;
        if !canonical_profile.starts_with(&canonical_root) {
            return Err("Browser surface profile escaped its root".into());
        }
        Ok(canonical_profile)
    }

    fn browser_path(&self) -> Option<PathBuf> {
        self.browser_path_override.clone().or_else(|| {
            super::connector::resolve_automation_browser_path(self.resource_dir.as_deref())
        })
    }
}

/// The loopback host capability endpoint owned by the Tauri process.
pub struct BrowserSurfaceHost {
    state: Arc<HostState>,
    #[cfg(test)]
    address: SocketAddr,
    endpoint: String,
    token: String,
    stop: Arc<AtomicBool>,
    server_thread: Mutex<Option<JoinHandle<()>>>,
}

impl BrowserSurfaceHost {
    /// Start a host endpoint on an OS-assigned loopback port.
    pub fn start(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Result<Self, String> {
        Self::start_with_browser(app_data_dir, resource_dir, None)
    }

    fn start_with_browser(
        app_data_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        browser_path_override: Option<PathBuf>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Failed to bind browser surface host: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Failed to configure browser surface host: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Failed to read browser surface host address: {error}"))?;
        let token = host_token();
        let state = Arc::new(HostState::new(
            app_data_dir.join("browser-surface").join("profiles"),
            resource_dir,
            browser_path_override,
        ));
        let stop = Arc::new(AtomicBool::new(false));
        let server_state = Arc::clone(&state);
        let server_stop = Arc::clone(&stop);
        let server_token = token.clone();
        let server_thread = thread::Builder::new()
            .name("pdpp-browser-surface-host".into())
            .spawn(move || run_server(listener, server_state, server_token, server_stop))
            .map_err(|error| format!("Failed to start browser surface host: {error}"))?;

        Ok(Self {
            state,
            #[cfg(test)]
            address,
            endpoint: format!("http://{address}"),
            token,
            stop,
            server_thread: Mutex::new(Some(server_thread)),
        })
    }

    /// Return the environment pairs the supervisor must pass to the RI.
    pub fn env_pairs(&self) -> Vec<(&'static str, String)> {
        vec![
            ("PDPP_BROWSER_SURFACE_MODE", "host".into()),
            ("PDPP_BROWSER_SURFACE_HOST_ENDPOINT", self.endpoint.clone()),
            ("PDPP_BROWSER_SURFACE_HOST_TOKEN", self.token.clone()),
        ]
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Stop the HTTP listener and kill every browser owned by this host.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        self.state.shutdown();
        if let Ok(mut server_thread) = self.server_thread.lock() {
            if let Some(server_thread) = server_thread.take() {
                let _ = server_thread.join();
            }
        }
    }

    #[cfg(test)]
    fn address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for BrowserSurfaceHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Get host-mode environment pairs from the Tauri-managed host, if enabled.
/// The supervisor owns applying these pairs to the RI child process.
pub fn browser_surface_host_env_pairs(app: &AppHandle) -> Option<Vec<(&'static str, String)>> {
    app.try_state::<BrowserSurfaceHost>()
        .map(|host| host.env_pairs())
}

pub fn cleanup_browser_surface_host(app: &AppHandle) {
    if let Some(host) = app.try_state::<BrowserSurfaceHost>() {
        host.shutdown();
    }
}

pub fn unified_stack_enabled() -> bool {
    std::env::var("DATACONNECT_LEGACY_STACK")
        .map(|value| value != "1")
        .unwrap_or(true)
}

fn host_token() -> String {
    format!(
        "{}{}",
        Uuid::new_v4().as_simple(),
        Uuid::new_v4().as_simple()
    )
}

fn validate_request_field(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(format!("{name} must be a non-empty URL-safe value"));
    }
    Ok(())
}

fn stable_segment(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn launch_browser(
    browser: &Path,
    profile_dir: &Path,
    headless: bool,
) -> Result<(Child, String), String> {
    let mut command = super::pdpp_browser::browser_command(browser, profile_dir, headless);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch host browser: {error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = super::pdpp_browser::terminate_browser(&mut child);
            return Err("Host browser stdout was not piped".into());
        }
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    wait_for_devtools_endpoint(profile_dir, child, receiver)
}

fn wait_for_devtools_endpoint(
    profile_dir: &Path,
    mut child: Child,
    receiver: mpsc::Receiver<String>,
) -> Result<(Child, String), String> {
    let deadline = Instant::now() + BROWSER_START_TIMEOUT;
    let active_port = profile_dir.join("DevToolsActivePort");
    while Instant::now() < deadline {
        for line in receiver.try_iter() {
            if let Some(url) = cdp_url_from_json(&line) {
                return Ok((child, url));
            }
        }
        if let Ok(contents) = fs::read_to_string(&active_port) {
            if let Some(port) = contents
                .lines()
                .next()
                .and_then(|port| port.trim().parse::<u16>().ok())
                .filter(|port| *port != 0)
            {
                return Ok((child, format!("http://127.0.0.1:{port}")));
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Host browser exited before becoming ready: {status}"
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }

    let terminated = super::pdpp_browser::terminate_browser(&mut child);
    if terminated {
        Err("Timed out waiting for host browser CDP endpoint".into())
    } else {
        Err("Timed out waiting for host browser CDP endpoint; termination failed".into())
    }
}

fn cdp_url_from_json(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let candidate = value
        .as_str()
        .or_else(|| value.get("cdp_url").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("cdpUrl").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("url").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("endpoint").and_then(serde_json::Value::as_str))?;
    is_http_url(candidate).then(|| candidate.to_string())
}

fn is_http_url(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

fn run_server(listener: TcpListener, state: Arc<HostState>, token: String, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let connection_state = Arc::clone(&state);
                let connection_token = token.clone();
                thread::spawn(move || {
                    handle_connection(stream, connection_state, &connection_token)
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                log::error!("Browser surface host listener failed: {error}");
                break;
            }
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn handle_connection(mut stream: TcpStream, state: Arc<HostState>, token: &str) {
    let _ = stream.set_read_timeout(Some(HTTP_READ_TIMEOUT));
    let response = match read_request(&mut stream) {
        Ok(request) if request.authorization.as_deref() != Some(&format!("Bearer {token}")) => {
            json_response(
                "401 Unauthorized",
                &ErrorResponse {
                    error: "unauthorized",
                    message: None,
                },
                Some("WWW-Authenticate: Bearer\r\n"),
            )
        }
        Ok(request) => dispatch_request(request, state),
        Err(error) => json_response(
            "400 Bad Request",
            &ErrorResponse {
                error: "bad_request",
                message: Some(error),
            },
            None,
        ),
    };
    let _ = stream.write_all(&response);
}

fn dispatch_request(request: HttpRequest, state: Arc<HostState>) -> Vec<u8> {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", BROWSER_SURFACE_PATH) => {
            let Ok(payload) = serde_json::from_slice::<AcquireRequest>(&request.body) else {
                return json_response(
                    "400 Bad Request",
                    &ErrorResponse {
                        error: "bad_request",
                        message: Some("Invalid acquire request JSON".into()),
                    },
                    None,
                );
            };
            match state.acquire(payload) {
                Ok(response) => json_response("200 OK", &response, None),
                Err(error) => json_response(
                    "500 Internal Server Error",
                    &ErrorResponse {
                        error: "surface_start_failed",
                        message: Some(error),
                    },
                    None,
                ),
            }
        }
        ("DELETE", path) if path.starts_with("/browser-surface/leases/") => {
            let surface_id = &path[BROWSER_SURFACE_PATH.len() + 1..];
            if surface_id.is_empty() || surface_id.contains('/') {
                return json_response(
                    "400 Bad Request",
                    &ErrorResponse {
                        error: "bad_request",
                        message: Some("Invalid surface id".into()),
                    },
                    None,
                );
            }
            state.release(surface_id);
            empty_response("204 No Content")
        }
        ("DELETE", path) if path.starts_with("/browser-surface/runs/") => {
            let run_id = &path["/browser-surface/runs/".len()..];
            if run_id.is_empty() || run_id.contains('/') {
                return json_response(
                    "400 Bad Request",
                    &ErrorResponse {
                        error: "bad_request",
                        message: Some("Invalid run id".into()),
                    },
                    None,
                );
            }
            state.release_run(run_id);
            empty_response("204 No Content")
        }
        _ => empty_response("404 Not Found"),
    }
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("Failed to read HTTP request: {error}"))?;
        if read == 0 {
            return Err("HTTP request ended before headers".into());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_HTTP_REQUEST_BYTES {
            return Err("HTTP request is too large".into());
        }
        if let Some(index) = find_header_end(&bytes) {
            break index;
        }
    };

    let header_text = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "HTTP headers are not UTF-8".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("HTTP request line is missing")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or("HTTP method is missing")?
        .to_string();
    let path = request_parts
        .next()
        .ok_or("HTTP path is missing")?
        .to_string();
    let version = request_parts.next().ok_or("HTTP version is missing")?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err("Unsupported HTTP version".into());
    }

    let mut authorization = None;
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("Malformed HTTP header".into());
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.trim().to_string()),
            "content-length" => {
                content_length = value
                    .trim()
                    .parse()
                    .map_err(|_| "Invalid content length".to_string())?;
            }
            _ => {}
        }
    }
    let body_start = header_end + 4;
    let total_length = body_start
        .checked_add(content_length)
        .ok_or("HTTP request length overflow")?;
    if total_length > MAX_HTTP_REQUEST_BYTES {
        return Err("HTTP request is too large".into());
    }
    while bytes.len() < total_length {
        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("Failed to read HTTP body: {error}"))?;
        if read == 0 {
            return Err("HTTP request ended before body".into());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }

    Ok(HttpRequest {
        method,
        path,
        authorization,
        body: bytes[body_start..total_length].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn json_response<T: Serialize>(status: &str, body: &T, extra_headers: Option<&str>) -> Vec<u8> {
    let body = serde_json::to_vec(body).expect("JSON response types are serializable");
    let extra_headers = extra_headers.unwrap_or("");
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n",
        body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(body)
    .collect()
}

fn empty_response(status: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    struct TestResponse {
        status: u16,
        body: Vec<u8>,
    }

    fn fake_browser(temp: &TempDir) -> PathBuf {
        let path = temp.path().join("fake-browser.sh");
        fs::write(
            &path,
            r#"#!/bin/sh
profile=""
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*) profile="${arg#*=}" ;;
  esac
done
printf '%s\n' "$@" > "$profile/args.txt"
printf '%s\n' '{"cdp_url":"http://127.0.0.1:9222"}'
trap 'exit 0' TERM INT
while :; do sleep 1; done
"#,
        )
        .expect("write fake browser");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("make fake browser executable");
        path
    }

    fn start_test_host(temp: &TempDir) -> BrowserSurfaceHost {
        BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(fake_browser(temp)),
        )
        .expect("start test host")
    }

    fn request(
        host: &BrowserSurfaceHost,
        method: &str,
        path: &str,
        authorization: Option<&str>,
        body: serde_json::Value,
    ) -> TestResponse {
        let mut stream = TcpStream::connect(host.address()).expect("connect host");
        let body = serde_json::to_vec(&body).expect("serialize request");
        let authorization = authorization
            .map(|value| format!("Authorization: Bearer {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .expect("write request headers");
        stream.write_all(&body).expect("write request body");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("read response");
        let header_end = find_header_end(&response).expect("response headers");
        let headers = std::str::from_utf8(&response[..header_end]).expect("response utf8");
        let status = headers
            .split_whitespace()
            .nth(1)
            .expect("response status")
            .parse()
            .expect("numeric response status");
        TestResponse {
            status,
            body: response[header_end + 4..].to_vec(),
        }
    }

    fn host_token(host: &BrowserSurfaceHost) -> &str {
        &host.token
    }

    fn acquire(host: &BrowserSurfaceHost, connector_id: &str) -> (String, String, u32) {
        acquire_with_headless(host, connector_id, true)
    }

    fn acquire_with_headless(
        host: &BrowserSurfaceHost,
        connector_id: &str,
        headless: bool,
    ) -> (String, String, u32) {
        let response = request(
            host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(host)),
            json!({
                "run_id": format!("run-{connector_id}"),
                "connector_id": connector_id,
                "headless": headless,
            }),
        );
        assert_eq!(response.status, 200);
        let value: AcquireResponse = serde_json::from_slice(&response.body).expect("acquire body");
        let pid = host
            .state
            .leases
            .lock()
            .expect("lease state")
            .get(&value.surface_id)
            .expect("lease exists")
            .child
            .id();
        (value.surface_id, value.cdp_url, pid)
    }

    #[test]
    fn token_is_required_for_host_requests() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            None,
            json!({
                "run_id": "run-1",
                "connector_id": "github",
                "headless": true,
            }),
        );
        assert_eq!(response.status, 401);

        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some("wrong-token"),
            json!({}),
        );
        assert_eq!(response.status, 401);
    }

    #[test]
    fn acquire_launches_fake_browser_and_returns_cdp_url() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (surface_id, cdp_url, _) = acquire(&host, "github");
        assert_eq!(cdp_url, "http://127.0.0.1:9222");
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);

        let profile_dir = host.state.profile_dir("github").expect("profile dir");
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(args.contains("--headless=new"));
        assert!(args.contains("--remote-debugging-port=0"));

        let (surface_id, cdp_url, _) = acquire_with_headless(&host, "chase", false);
        assert_eq!(cdp_url, "http://127.0.0.1:9222");
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);
        let profile_dir = host.state.profile_dir("chase").expect("profile dir");
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(!args.contains("--headless=new"));
    }

    #[test]
    fn retry_after_lost_response_reuses_surface_and_run_delete_releases_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let payload = json!({
            "run_id": "run-lost-response",
            "connector_id": "github",
            "headless": true,
        });

        // The first response is deliberately discarded, matching a client
        // that timed out after the host launched the browser.
        let discarded = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            payload.clone(),
        );
        assert_eq!(discarded.status, 200);

        let retry = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            payload,
        );
        assert_eq!(retry.status, 200);
        assert_eq!(retry.body, discarded.body);
        let response: AcquireResponse = serde_json::from_slice(&retry.body).expect("response");
        let pid = host
            .state
            .leases
            .lock()
            .expect("lease state")
            .get(&response.surface_id)
            .expect("single owned surface")
            .child
            .id();
        assert_eq!(host.state.leases.lock().expect("lease state").len(), 1);

        let released = request(
            &host,
            "DELETE",
            "/browser-surface/runs/run-lost-response",
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(released.status, 204);
        wait_for_process_exit(pid);
        assert!(host.state.leases.lock().expect("lease state").is_empty());

        // A late POST cannot resurrect a run whose cancellation was already
        // observed by the host.
        let late_acquire = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-lost-response",
                "connector_id": "github",
                "headless": true,
            }),
        );
        assert_eq!(late_acquire.status, 500);
        assert!(host.state.leases.lock().expect("lease state").is_empty());
    }

    #[test]
    fn release_kills_browser_and_is_idempotent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (surface_id, _, pid) = acquire(&host, "github");
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);
        wait_for_process_exit(pid);

        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);
    }

    #[test]
    fn shutdown_kills_all_leased_browsers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (_, _, first_pid) = acquire(&host, "github");
        let (_, _, second_pid) = acquire(&host, "chase");
        host.shutdown();
        wait_for_process_exit(first_pid);
        wait_for_process_exit(second_pid);
    }

    #[test]
    fn env_pairs_describe_the_host_endpoint_and_secret() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let pairs = host.env_pairs();
        assert_eq!(pairs[0], ("PDPP_BROWSER_SURFACE_MODE", "host".into()));
        assert_eq!(pairs[1].0, "PDPP_BROWSER_SURFACE_HOST_ENDPOINT");
        assert_eq!(pairs[1].1, host.endpoint());
        assert_eq!(pairs[2].0, "PDPP_BROWSER_SURFACE_HOST_TOKEN");
        assert!(!pairs[2].1.is_empty());
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let alive = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
            if !alive {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("process {pid} did not exit");
    }
}
