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
/// `DELETE /browser-surface/profiles/<connector_id>/<connection_id>` resets one
/// connection's persistent profile after the owner deletes or revokes it.
/// `?legacy=remove` also removes the pre-connection per-connector profile; the
/// RI sends it only when no other connection of the connector exists.
const BROWSER_PROFILE_PATH: &str = "/browser-surface/profiles/";
const MAX_HTTP_REQUEST_BYTES: usize = 64 * 1024;
const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);
const DEVTOOLS_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Bytes of browser stderr kept for diagnosing a failed launch.
const STDERR_TAIL_BYTES: usize = 8 * 1024;
/// Chromium prints this when it cannot create its sandbox, for example when
/// AppArmor restricts unprivileged user namespaces (Ubuntu 23.10+).
const NO_USABLE_SANDBOX_SIGNATURE: &str = "No usable sandbox!";
pub(crate) const BROWSER_SANDBOX_UNAVAILABLE: &str = "browser_sandbox_unavailable";
const SURFACE_START_FAILED: &str = "surface_start_failed";
const BROWSER_PROFILE_IN_USE: &str = "browser_profile_in_use";
const BROWSER_PROFILE_IN_USE_MESSAGE: &str =
    "A DataConnect browser window for this account is still open. Close it and try again.";

#[derive(Debug, Deserialize)]
struct AcquireRequest {
    /// Stable idempotency key for acquisition and cancellation.
    run_id: String,
    connector_id: String,
    /// The RI connection (account) the run collects for. Every connection has
    /// its own profile, so an acquire without one is refused.
    connection_id: String,
    /// True only when this is the owner's single connection of the connector:
    /// the old per-connector profile may then be moved to this connection.
    #[serde(default)]
    migrate_connector_profile: bool,
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

/// A browser launch failure with a stable, machine-readable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserLaunchError {
    pub code: &'static str,
    pub message: String,
}

impl BrowserLaunchError {
    fn start_failed(message: impl Into<String>) -> Self {
        Self {
            code: SURFACE_START_FAILED,
            message: message.into(),
        }
    }

    fn sandbox_unavailable() -> Self {
        Self {
            code: BROWSER_SANDBOX_UNAVAILABLE,
            message: sandbox_unavailable_message(),
        }
    }

    fn profile_in_use() -> Self {
        Self {
            code: BROWSER_PROFILE_IN_USE,
            message: BROWSER_PROFILE_IN_USE_MESSAGE.into(),
        }
    }

    pub(crate) fn is_sandbox_unavailable(&self) -> bool {
        self.code == BROWSER_SANDBOX_UNAVAILABLE
    }
}

impl From<String> for BrowserLaunchError {
    fn from(message: String) -> Self {
        Self::start_failed(message)
    }
}

impl From<&str> for BrowserLaunchError {
    fn from(message: &str) -> Self {
        Self::start_failed(message)
    }
}

pub(crate) fn sandbox_unavailable_message() -> String {
    "This Linux distribution blocks the sandbox of the browser that DataConnect \
     bundles or downloads. Install Google Chrome or Chromium from a .deb package; \
     DataConnect uses the first of /usr/bin/google-chrome, \
     /usr/bin/google-chrome-stable, /usr/bin/chromium or /usr/bin/chromium-browser."
        .into()
}

struct BrowserSurfaceLease {
    run_id: String,
    connector_id: String,
    connection_id: String,
    headless: bool,
    response: AcquireResponse,
    browser_pid: u32,
}

#[derive(Debug)]
enum ProfileResetError {
    Invalid(String),
    InUse,
    Failed(String),
}

struct HostState {
    profile_root: PathBuf,
    resource_dir: Option<PathBuf>,
    browser_path_override: Option<PathBuf>,
    leases: Mutex<HashMap<String, BrowserSurfaceLease>>,
    /// Keep process handles beyond a lease if termination fails, so a later
    /// acquire can safely retry cleanup for the exact profile and process.
    browsers: Mutex<HashMap<u32, Child>>,
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
            browsers: Mutex::new(HashMap::new()),
            cancelled_runs: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn acquire(&self, request: AcquireRequest) -> Result<AcquireResponse, BrowserLaunchError> {
        validate_request_field("run_id", &request.run_id)?;
        validate_request_field("connector_id", &request.connector_id)?;
        validate_request_field("connection_id", &request.connection_id)?;

        // Admission and launch are serialized. A connection has exactly one
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
            if lease.connector_id != request.connector_id
                || lease.connection_id != request.connection_id
                || lease.headless != request.headless
            {
                return Err("Run id is already bound to a different browser request".into());
            }
            return Ok(lease.response.clone());
        }
        if leases.values().any(|lease| {
            lease.connector_id == request.connector_id
                && lease.connection_id == request.connection_id
        }) {
            return Err(BrowserLaunchError::profile_in_use());
        }

        let profile_dir = self.profile_dir(
            &request.connector_id,
            &request.connection_id,
            request.migrate_connector_profile,
        )?;
        self.recover_or_refuse_profile(&profile_dir, &leases)?;
        let _ = fs::remove_file(profile_dir.join("DevToolsActivePort"));

        let browser = self.browser_path().ok_or_else(|| {
            BrowserLaunchError::start_failed(
                "No system, downloaded, or bundled Chromium browser is available for host browser surfaces",
            )
        })?;
        let (child, endpoint) = launch_browser(&browser, &profile_dir, request.headless)?;
        let browser_pid = child.id();
        let surface_id = format!("host-surface-{}", Uuid::new_v4().as_simple());
        let response = AcquireResponse {
            surface_id: surface_id.clone(),
            cdp_url: endpoint,
        };
        let mut browsers = match self.browsers.lock() {
            Ok(browsers) => browsers,
            Err(_) => {
                let mut child = child;
                let _ = super::pdpp_browser::terminate_browser(&mut child);
                return Err("Browser process state is unavailable".into());
            }
        };
        browsers.insert(browser_pid, child);
        drop(browsers);
        leases.insert(
            surface_id.clone(),
            BrowserSurfaceLease {
                run_id: request.run_id,
                connector_id: request.connector_id,
                connection_id: request.connection_id,
                headless: request.headless,
                response: response.clone(),
                browser_pid,
            },
        );

        Ok(response)
    }

    fn release(&self, surface_id: &str) {
        let Ok(mut leases) = self.leases.lock() else {
            log::error!("Browser surface lease state is poisoned during release");
            return;
        };
        let Some(lease) = leases.remove(surface_id) else {
            // DELETE is deliberately idempotent for RI cleanup retries.
            return;
        };
        if !self.terminate_tracked_browser(lease.browser_pid) {
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
            if let Some(lease) = leases.remove(&surface_id) {
                if !self.terminate_tracked_browser(lease.browser_pid) {
                    log::warn!("Browser surface {surface_id} did not terminate cleanly");
                }
            }
        }
    }

    fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.release_all_leases();
        if let Ok(mut browsers) = self.browsers.lock() {
            for (pid, child) in browsers.iter_mut() {
                if !super::pdpp_browser::terminate_browser(child) {
                    log::warn!("Tracked browser {pid} did not terminate cleanly during shutdown");
                }
            }
            browsers.clear();
        }
    }

    fn release_all_leases(&self) {
        let Ok(mut leases) = self.leases.lock() else {
            log::error!("Browser surface lease state is poisoned during stack teardown");
            return;
        };
        for (surface_id, lease) in leases.drain() {
            if let Ok(mut cancelled_runs) = self.cancelled_runs.lock() {
                cancelled_runs.insert(lease.run_id);
            }
            if !self.terminate_tracked_browser(lease.browser_pid) {
                log::warn!(
                    "Browser surface {surface_id} did not terminate cleanly during stack teardown"
                );
            }
        }
    }

    fn terminate_tracked_browser(&self, pid: u32) -> bool {
        let Ok(mut browsers) = self.browsers.lock() else {
            log::error!("Browser process state is poisoned during termination");
            return false;
        };
        let Some(child) = browsers.get_mut(&pid) else {
            log::error!("Browser process {pid} is missing from host state");
            return false;
        };
        if super::pdpp_browser::terminate_browser(child) {
            browsers.remove(&pid);
            true
        } else {
            false
        }
    }

    fn recover_or_refuse_profile(
        &self,
        profile_dir: &Path,
        leases: &HashMap<String, BrowserSurfaceLease>,
    ) -> Result<(), BrowserLaunchError> {
        #[cfg(target_os = "linux")]
        {
            let lock = profile_dir.join("SingletonLock");
            let target = match fs::read_link(&lock) {
                Ok(target) => target,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err(BrowserLaunchError::profile_in_use()),
            };
            let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
                .map_err(|_| BrowserLaunchError::profile_in_use())?;
            let Some(pid) = target
                .to_string_lossy()
                .strip_prefix(&format!("{}-", hostname.trim()))
                .and_then(|pid| pid.parse::<u32>().ok())
            else {
                return Ok(());
            };
            if !Path::new("/proc").join(pid.to_string()).exists() {
                return Ok(());
            }
            if !process_uses_profile(pid, profile_dir) {
                return Err(BrowserLaunchError::profile_in_use());
            }
            let process_group =
                process_group_for_pid(pid).ok_or_else(BrowserLaunchError::profile_in_use)?;

            let mut browsers = self
                .browsers
                .lock()
                .map_err(|_| BrowserLaunchError::profile_in_use())?;
            let Some(child) = browsers.get_mut(&process_group) else {
                return Err(BrowserLaunchError::profile_in_use());
            };
            if leases
                .values()
                .any(|lease| lease.browser_pid == process_group)
            {
                return Err(BrowserLaunchError::profile_in_use());
            }
            if !super::pdpp_browser::terminate_browser(child) {
                return Err(BrowserLaunchError::profile_in_use());
            }
            browsers.remove(&process_group);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (profile_dir, leases);
        Ok(())
    }

    /// Deletes one connection's persistent profile (its logged-in session),
    /// and the old per-connector profile when `remove_legacy` is set. Refuses
    /// while that connection has a live lease, and holds the lease lock so an
    /// acquire cannot race the removal. Never follows a symlink out of the
    /// profile root. Returns whether a profile existed.
    fn reset_profile(
        &self,
        connector_id: &str,
        connection_id: &str,
        remove_legacy: bool,
    ) -> Result<bool, ProfileResetError> {
        validate_request_field("connector_id", connector_id).map_err(ProfileResetError::Invalid)?;
        validate_request_field("connection_id", connection_id)
            .map_err(ProfileResetError::Invalid)?;
        let leases = self.leases.lock().map_err(|_| {
            ProfileResetError::Failed("Browser surface lease state is unavailable".into())
        })?;
        if leases
            .values()
            .any(|lease| lease.connector_id == connector_id && lease.connection_id == connection_id)
        {
            return Err(ProfileResetError::InUse);
        }
        let mut removed =
            self.remove_profile_segment(&connection_profile_segment(connector_id, connection_id))?;
        if remove_legacy {
            removed |= self.remove_profile_segment(&stable_segment(connector_id))?;
        }
        drop(leases);
        Ok(removed)
    }

    fn remove_profile_segment(&self, segment: &str) -> Result<bool, ProfileResetError> {
        let candidate = self.profile_root.join(segment);
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(ProfileResetError::Failed(format!(
                    "Failed to inspect browser profile: {error}"
                )))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ProfileResetError::Failed(
                "Browser surface profile is not a real directory".into(),
            ));
        }
        let canonical_root = fs::canonicalize(&self.profile_root).map_err(|error| {
            ProfileResetError::Failed(format!("Failed to confine browser surface root: {error}"))
        })?;
        let canonical_profile = fs::canonicalize(&candidate).map_err(|error| {
            ProfileResetError::Failed(format!("Failed to confine browser profile: {error}"))
        })?;
        if canonical_profile == canonical_root || !canonical_profile.starts_with(&canonical_root) {
            return Err(ProfileResetError::Failed(
                "Browser surface profile escaped its root".into(),
            ));
        }
        fs::remove_dir_all(&canonical_profile).map_err(|error| {
            ProfileResetError::Failed(format!("Failed to delete browser profile: {error}"))
        })?;
        Ok(true)
    }

    /// The connection's profile directory. Before profiles were keyed by
    /// connection, the host kept one profile per connector. When this
    /// connection has no profile yet and that old profile exists, it is moved
    /// here only if `migrate_connector_profile` says this is the owner's single
    /// connection of the connector; otherwise the old profile is left alone and
    /// this connection starts clean, because it cannot be told whose it is.
    fn profile_dir(
        &self,
        connector_id: &str,
        connection_id: &str,
        migrate_connector_profile: bool,
    ) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.profile_root)
            .map_err(|error| format!("Failed to create browser surface root: {error}"))?;
        let canonical_root = fs::canonicalize(&self.profile_root)
            .map_err(|error| format!("Failed to confine browser surface root: {error}"))?;
        let profile_dir =
            canonical_root.join(connection_profile_segment(connector_id, connection_id));
        let legacy_dir = canonical_root.join(stable_segment(connector_id));
        let legacy_is_real_dir = fs::symlink_metadata(&legacy_dir)
            .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            .unwrap_or(false);
        if !profile_dir.exists() && legacy_is_real_dir {
            if migrate_connector_profile {
                fs::rename(&legacy_dir, &profile_dir)
                    .map_err(|error| format!("Failed to move browser profile: {error}"))?;
                log::info!(
                    "Moved the per-connector browser profile of {connector_id:?} to connection {connection_id:?}"
                );
            } else {
                log::warn!(
                    "Left the per-connector browser profile of {connector_id:?} in place: the owner has more than one connection of it, so connection {connection_id:?} starts with a new profile"
                );
            }
        }
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

/// Release all browsers after the managed RI stack stops while keeping the
/// app-level host available for the replacement RI process.
pub fn release_browser_surface_host_leases<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(host) = app.try_state::<BrowserSurfaceHost>() {
        host.state.release_all_leases();
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

/// One profile per connection: the connector id and the RI connection id
/// together name the directory, so two accounts never share a session.
fn connection_profile_segment(connector_id: &str, connection_id: &str) -> String {
    stable_segment(&format!("{connector_id}:{connection_id}"))
}

fn stable_segment(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub(crate) fn launch_browser(
    browser: &Path,
    profile_dir: &Path,
    headless: bool,
) -> Result<(Child, String), BrowserLaunchError> {
    let mut command = super::pdpp_browser::browser_command_with_args(
        browser,
        profile_dir,
        headless,
        &[
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch host browser: {error}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = super::pdpp_browser::terminate_browser(&mut child);
        return Err("Host browser output was not piped".to_string().into());
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_tail = StderrTail::default();
    let stderr_reader = stderr_tail.clone();
    // Keep draining after readiness so a chatty browser never blocks on a
    // full pipe; only the bounded tail is retained.
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
            stderr_reader.push_line(&String::from_utf8_lossy(&line));
            line.clear();
        }
    });

    wait_for_devtools_endpoint(profile_dir, child, receiver, &stderr_tail)
}

/// The last `STDERR_TAIL_BYTES` of browser stderr, with URL query strings
/// removed. Chromium stderr can name the pages it loads.
#[derive(Clone, Default)]
struct StderrTail(Arc<Mutex<std::collections::VecDeque<String>>>);

impl StderrTail {
    fn push_line(&self, line: &str) {
        let line = redact_query_strings(line.trim_end());
        let Ok(mut lines) = self.0.lock() else {
            return;
        };
        lines.push_back(line);
        let mut total: usize = lines.iter().map(String::len).sum();
        while total > STDERR_TAIL_BYTES {
            match lines.pop_front() {
                Some(dropped) => total -= dropped.len(),
                None => break,
            }
        }
    }

    fn snapshot(&self) -> String {
        self.0
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

fn redact_query_strings(line: &str) -> String {
    line.split(' ')
        .map(|word| match (word.contains("://"), word.find(['?', '#'])) {
            (true, Some(index)) => format!("{}?<redacted>", &word[..index]),
            _ => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn wait_for_devtools_endpoint(
    profile_dir: &Path,
    mut child: Child,
    receiver: mpsc::Receiver<String>,
    stderr_tail: &StderrTail,
) -> Result<(Child, String), BrowserLaunchError> {
    let deadline = Instant::now() + BROWSER_START_TIMEOUT;
    let active_port = profile_dir.join("DevToolsActivePort");
    let probe = reqwest::blocking::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| {
            terminate_failed_launch(
                &mut child,
                BrowserLaunchError::start_failed(error.to_string()),
            )
        })?;
    while Instant::now() < deadline {
        if super::pdpp_browser::browser_child_exited(&mut child) {
            let error = exited_before_ready(stderr_tail);
            return Err(terminate_failed_launch(&mut child, error));
        }
        for line in receiver.try_iter().take(1) {
            if let Some(url) = cdp_url_from_json(&line) {
                if devtools_http_ready(&probe, &url, deadline) {
                    if super::pdpp_browser::browser_child_exited(&mut child) {
                        let error = exited_before_ready(stderr_tail);
                        return Err(terminate_failed_launch(&mut child, error));
                    }
                    return Ok((child, url));
                }
            }
        }
        if let Ok(contents) = fs::read_to_string(&active_port) {
            if let Some(port) = contents
                .lines()
                .next()
                .and_then(|port| port.trim().parse::<u16>().ok())
                .filter(|port| *port != 0)
            {
                let url = format!("http://127.0.0.1:{port}");
                if devtools_http_ready(&probe, &url, deadline) {
                    if super::pdpp_browser::browser_child_exited(&mut child) {
                        let error = exited_before_ready(stderr_tail);
                        return Err(terminate_failed_launch(&mut child, error));
                    }
                    return Ok((child, url));
                }
            }
        }
        if super::pdpp_browser::browser_child_exited(&mut child) {
            let error = exited_before_ready(stderr_tail);
            return Err(terminate_failed_launch(&mut child, error));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(Duration::from_millis(25).min(remaining));
    }

    Err(terminate_failed_launch(
        &mut child,
        BrowserLaunchError::start_failed("Timed out waiting for host browser CDP endpoint"),
    ))
}

fn terminate_failed_launch(child: &mut Child, mut error: BrowserLaunchError) -> BrowserLaunchError {
    if !super::pdpp_browser::terminate_browser(child) {
        error.message.push_str("; termination failed");
    }
    error
}

#[cfg(target_os = "linux")]
fn process_uses_profile(pid: u32, profile_dir: &Path) -> bool {
    let Ok(command_line) = fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    let expected = format!("--user-data-dir={}", profile_dir.display());
    command_line
        .split(|byte| *byte == 0)
        .any(|argument| argument == expected.as_bytes())
}

#[cfg(target_os = "linux")]
fn process_group_for_pid(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    fields.split_whitespace().nth(2)?.parse().ok()
}

fn devtools_http_ready(
    client: &reqwest::blocking::Client,
    cdp_url: &str,
    deadline: Instant,
) -> bool {
    let Some(timeout) = devtools_probe_timeout(deadline) else {
        return false;
    };
    let request = client
        .get(format!("{cdp_url}/json/version"))
        .timeout(timeout);
    if Instant::now() >= deadline {
        return false;
    }
    let Ok(response) = request.send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(version) = response.json::<serde_json::Value>() else {
        return false;
    };
    let has_browser_websocket = version
        .get("webSocketDebuggerUrl")
        .and_then(serde_json::Value::as_str)
        .is_some_and(is_websocket_url);
    if !has_browser_websocket {
        return false;
    }

    let Some(timeout) = devtools_probe_timeout(deadline) else {
        return false;
    };
    let request = client.get(format!("{cdp_url}/json/list")).timeout(timeout);
    if Instant::now() >= deadline {
        return false;
    }
    let Ok(response) = request.send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(targets) = response.json::<Vec<serde_json::Value>>() else {
        return false;
    };
    targets.iter().any(|target| {
        target.get("type").and_then(serde_json::Value::as_str) == Some("page")
            && target
                .get("webSocketDebuggerUrl")
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_websocket_url)
    })
}

fn devtools_probe_timeout(deadline: Instant) -> Option<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    (!remaining.is_zero()).then_some(DEVTOOLS_PROBE_TIMEOUT.min(remaining))
}

fn is_websocket_url(url: &str) -> bool {
    url.starts_with("ws://") || url.starts_with("wss://")
}

fn exited_before_ready(stderr_tail: &StderrTail) -> BrowserLaunchError {
    // The stderr reader may still hold the last lines; give it a moment.
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut tail = stderr_tail.snapshot();
    while !tail.contains(NO_USABLE_SANDBOX_SIGNATURE) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
        tail = stderr_tail.snapshot();
    }
    log::warn!("Host browser exited before becoming ready; stderr tail:\n{tail}");
    if tail.contains(NO_USABLE_SANDBOX_SIGNATURE) {
        BrowserLaunchError::sandbox_unavailable()
    } else {
        BrowserLaunchError::start_failed("Host browser exited before becoming ready")
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
            let run_id = payload.run_id.clone();
            let connector_id = payload.connector_id.clone();
            let connection_id = payload.connection_id.clone();
            match state.acquire(payload) {
                Ok(response) => json_response("200 OK", &response, None),
                Err(error) => {
                    log::warn!(
                        "Refused browser surface lease for run {run_id} ({connector_id}/{connection_id}): {} ({})",
                        error.message,
                        error.code
                    );
                    json_response(
                        "500 Internal Server Error",
                        &ErrorResponse {
                            error: error.code,
                            message: Some(error.message),
                        },
                        None,
                    )
                }
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
        ("DELETE", path) if path.starts_with(BROWSER_PROFILE_PATH) => {
            let (target, query) = path[BROWSER_PROFILE_PATH.len()..]
                .split_once('?')
                .unwrap_or((&path[BROWSER_PROFILE_PATH.len()..], ""));
            let remove_legacy = query == "legacy=remove";
            let Some((connector_id, connection_id)) = target.split_once('/') else {
                return json_response(
                    "400 Bad Request",
                    &ErrorResponse {
                        error: "bad_request",
                        message: Some(
                            "Expected /browser-surface/profiles/<connector>/<connection>".into(),
                        ),
                    },
                    None,
                );
            };
            match state.reset_profile(connector_id, connection_id, remove_legacy) {
                Ok(true) => empty_response("204 No Content"),
                Ok(false) => empty_response("404 Not Found"),
                Err(ProfileResetError::Invalid(message)) => json_response(
                    "400 Bad Request",
                    &ErrorResponse {
                        error: "bad_request",
                        message: Some(message),
                    },
                    None,
                ),
                Err(ProfileResetError::InUse) => json_response(
                    "409 Conflict",
                    &ErrorResponse {
                        error: "profile_in_use",
                        message: Some(
                            "A browser surface for this connection is still running".into(),
                        ),
                    },
                    None,
                ),
                Err(ProfileResetError::Failed(message)) => {
                    log::error!("Browser profile reset failed: {message}");
                    json_response(
                        "500 Internal Server Error",
                        &ErrorResponse {
                            error: "profile_reset_failed",
                            message: Some(message),
                        },
                        None,
                    )
                }
            }
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
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::TempDir;

    #[cfg(target_os = "linux")]
    fn hostname() -> String {
        fs::read_to_string("/proc/sys/kernel/hostname")
            .expect("read isolated test hostname")
            .trim()
            .to_string()
    }

    struct TestResponse {
        status: u16,
        body: Vec<u8>,
    }

    fn fake_browser(temp: &TempDir) -> PathBuf {
        let path = temp.path().join("fake-browser.sh");
        fs::write(
            temp.path().join("fake-devtools.py"),
            r#"from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import sys
import time

profile = Path(sys.argv[1])
started = time.monotonic()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/json/version":
            value = {"webSocketDebuggerUrl": f"ws://127.0.0.1:{self.server.server_port}/devtools/browser/test"}
        elif self.path == "/json/list":
            value = [] if time.monotonic() - started < 0.3 else [{
                "type": "page",
                "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.server.server_port}/devtools/page/test",
            }]
        else:
            self.send_error(404)
            return
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

server = HTTPServer(("127.0.0.1", 0), Handler)
(profile / "DevToolsActivePort").write_text(f"{server.server_port}\n/devtools/browser/test\n")
server.serve_forever()
"#,
        )
        .expect("write fake DevTools server");
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
python3 "$(dirname "$0")/fake-devtools.py" "$profile" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; exit 0' TERM INT
wait "$server_pid"
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
        acquire_connection(
            host,
            connector_id,
            &format!("cin-{connector_id}"),
            headless,
            false,
        )
    }

    fn acquire_connection(
        host: &BrowserSurfaceHost,
        connector_id: &str,
        connection_id: &str,
        headless: bool,
        migrate_connector_profile: bool,
    ) -> (String, String, u32) {
        acquire_connection_for_run(
            host,
            &format!("run-{connector_id}-{connection_id}"),
            connector_id,
            connection_id,
            headless,
            migrate_connector_profile,
        )
    }

    fn acquire_connection_for_run(
        host: &BrowserSurfaceHost,
        run_id: &str,
        connector_id: &str,
        connection_id: &str,
        headless: bool,
        migrate_connector_profile: bool,
    ) -> (String, String, u32) {
        let response = request(
            host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(host)),
            json!({
                "run_id": run_id,
                "connector_id": connector_id,
                "connection_id": connection_id,
                "migrate_connector_profile": migrate_connector_profile,
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
            .browser_pid;
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
                "connection_id": "cin-github",
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
        let started = Instant::now();
        let (surface_id, cdp_url, _) = acquire(&host, "github");
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "acquire must wait until /json/list has a usable page target"
        );
        assert!(cdp_url.starts_with("http://127.0.0.1:"));
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);

        let profile_dir = host
            .state
            .profile_dir("github", "cin-github", false)
            .expect("profile dir");
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(args.contains("--headless=new"));
        assert!(args.contains("--remote-debugging-port=0"));
        assert!(args.contains("--disable-background-timer-throttling"));
        assert!(args.contains("--disable-renderer-backgrounding"));
        assert!(args.contains("--disable-backgrounding-occluded-windows"));

        let (surface_id, cdp_url, _) = acquire_with_headless(&host, "chase", false);
        assert!(cdp_url.starts_with("http://127.0.0.1:"));
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 204);
        let profile_dir = host
            .state
            .profile_dir("chase", "cin-chase", false)
            .expect("profile dir");
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(!args.contains("--headless=new"));
    }

    #[test]
    fn slow_stdout_probes_do_not_extend_the_launch_deadline() {
        let temp = tempfile::tempdir().expect("tempdir");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind slow DevTools server");
        let address = listener.local_addr().expect("server address");
        let stop_server = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop_server);
        let server = thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("make slow server nonblocking");
            let deadline = Instant::now() + BROWSER_START_TIMEOUT + Duration::from_secs(1);
            while Instant::now() < deadline && !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0; 1024];
                        let _ = stream.read(&mut request);
                        thread::sleep(Duration::from_millis(250));
                        let _ = stream.write_all(
                            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        let browser = temp.path().join("fake-browser-slow.sh");
        fs::write(
            &browser,
            format!(
                "#!/bin/sh\nfor i in $(seq 1 100); do printf '{{\"cdp_url\":\"http://{address}\"}}\\n'; done\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n"
            ),
        )
        .expect("write slow fake browser");
        fs::set_permissions(&browser, fs::Permissions::from_mode(0o755))
            .expect("make slow fake browser executable");
        let profile = temp.path().join("profile");
        fs::create_dir_all(&profile).expect("create profile");

        let started = Instant::now();
        let result = launch_browser(&browser, &profile, true);
        let elapsed = started.elapsed();
        stop_server.store(true, Ordering::Release);
        let server_joined = server.join();

        assert!(result.is_err(), "unready endpoint must time out");
        assert!(
            elapsed <= BROWSER_START_TIMEOUT + Duration::from_millis(300),
            "launch took {elapsed:?}, beyond the deadline and one short probe"
        );
        server_joined.expect("slow server thread");
    }

    #[test]
    fn acquire_waits_until_the_devtools_http_endpoint_is_ready() {
        let temp = tempfile::tempdir().expect("tempdir");
        let reservation = TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let address = reservation.local_addr().expect("port address");
        drop(reservation);

        let ready_server = thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            let listener = TcpListener::bind(address).expect("bind delayed DevTools endpoint");
            listener
                .set_nonblocking(true)
                .expect("make DevTools endpoint nonblocking");
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut requests = 0;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0; 1024];
                        let _ = stream.read(&mut request);
                        let body = if request.starts_with(b"GET /json/version ") {
                            format!(
                                r#"{{"webSocketDebuggerUrl":"ws://{}/devtools/browser/test"}}"#,
                                address
                            )
                        } else {
                            format!(
                                r#"[{{"type":"page","webSocketDebuggerUrl":"ws://{}/devtools/page/test"}}]"#,
                                address
                            )
                        };
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .expect("write DevTools version response");
                        requests += 1;
                        if requests == 2 {
                            return true;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return false,
                }
            }
            false
        });

        let browser = temp.path().join("fake-browser-delayed.sh");
        fs::write(
            &browser,
            format!(
                "#!/bin/sh\nprofile=\"\"\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    --user-data-dir=*) profile=\"${{arg#*=}}\" ;;\n  esac\ndone\nprintf '%s\\n' {} > \"$profile/DevToolsActivePort\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
                address.port()
            ),
        )
        .expect("write delayed fake browser");
        fs::set_permissions(&browser, fs::Permissions::from_mode(0o755))
            .expect("make delayed fake browser executable");
        let profile = temp.path().join("profile");
        fs::create_dir_all(&profile).expect("create profile");

        let started = Instant::now();
        let launched = launch_browser(&browser, &profile, true);
        let elapsed = started.elapsed();
        let launch_succeeded = match launched {
            Ok((mut child, endpoint)) => {
                let _ = super::super::pdpp_browser::terminate_browser(&mut child);
                assert_eq!(endpoint, format!("http://{address}"));
                true
            }
            Err(_) => false,
        };
        let server_ready = ready_server.join().expect("DevTools server thread");

        assert!(
            server_ready,
            "host must wait for a live /json/version response"
        );
        assert!(elapsed >= Duration::from_millis(200));
        assert!(launch_succeeded);
    }

    #[test]
    fn profile_reset_deletes_the_connector_profile_and_refuses_a_live_lease() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (surface_id, _, _) = acquire(&host, "amazon");
        let profile_dir = host
            .state
            .profile_dir("amazon", "cin-amazon", false)
            .expect("profile dir");
        fs::write(profile_dir.join("Cookies"), "session").expect("seed cookie");
        let other_profile = host
            .state
            .profile_dir("reddit", "cin-reddit", false)
            .expect("other profile dir");

        let refused = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin-amazon"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(refused.status, 409);
        assert!(
            profile_dir.join("Cookies").exists(),
            "a live lease keeps its profile"
        );

        let released = request(
            &host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(released.status, 204);

        let unauthorized = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin-amazon"),
            None,
            json!({}),
        );
        assert_eq!(unauthorized.status, 401);
        assert!(profile_dir.exists());

        let reset = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin-amazon"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(reset.status, 204);
        assert!(!profile_dir.exists(), "the profile is gone");
        assert!(
            other_profile.exists(),
            "another connector's profile is untouched"
        );

        let again = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin-amazon"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(
            again.status, 404,
            "an absent profile is reported, not an error"
        );
    }

    #[test]
    fn profile_reset_refuses_path_escapes_and_symlinks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        for target in [
            "../cin",
            "a%2F../cin",
            "a/b/c",
            "",
            "amazon",
            "amazon/..",
            "amazon/",
        ] {
            let response = request(
                &host,
                "DELETE",
                &format!("{BROWSER_PROFILE_PATH}{target}"),
                Some(host_token(&host)),
                json!({}),
            );
            assert!(
                response.status == 400 || response.status == 404,
                "{target:?} must be refused, got {}",
                response.status
            );
        }

        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::write(outside.join("keep"), "precious").expect("outside file");
        fs::create_dir_all(&host.state.profile_root).expect("profile root");
        std::os::unix::fs::symlink(
            &outside,
            host.state
                .profile_root
                .join(connection_profile_segment("linked", "cin-linked")),
        )
        .expect("symlink");
        let response = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}linked/cin-linked"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(response.status, 500);
        assert!(outside.join("keep").exists(), "the symlink target survives");
    }

    fn profile_dirs(host: &BrowserSurfaceHost) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(&host.state.profile_root)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                    .filter(|path| path.is_dir())
                    .collect()
            })
            .unwrap_or_default();
        dirs.sort();
        dirs
    }

    fn release_surface(host: &BrowserSurfaceHost, surface_id: &str) {
        let response = request(
            host,
            "DELETE",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}"),
            Some(host_token(host)),
            json!({}),
        );
        assert_eq!(response.status, 204);
    }

    /// The owner's test: two accounts of one connector each keep their own
    /// signed-in profile, and removing one leaves the other signed in.
    #[test]
    fn two_connections_of_one_connector_keep_separate_profiles_and_reset_removes_only_one() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);

        let (surface_a, _, _) = acquire_connection(&host, "amazon", "cin_a", true, false);
        let dirs = profile_dirs(&host);
        assert_eq!(dirs.len(), 1);
        let dir_a = dirs[0].clone();
        fs::write(dir_a.join("Cookies"), "session-a").expect("seed cookie a");
        release_surface(&host, &surface_a);

        let (surface_b, _, _) = acquire_connection(&host, "amazon", "cin_b", true, false);
        let dirs = profile_dirs(&host);
        assert_eq!(
            dirs.len(),
            2,
            "each connection gets its own profile directory"
        );
        let dir_b = dirs
            .iter()
            .find(|dir| **dir != dir_a)
            .expect("second profile")
            .clone();
        assert!(
            !dir_b.join("Cookies").exists(),
            "connection b does not see connection a's session"
        );
        fs::write(dir_b.join("Cookies"), "session-b").expect("seed cookie b");
        release_surface(&host, &surface_b);

        let reset = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin_a"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(reset.status, 204);
        assert!(!dir_a.exists(), "the removed connection's profile is gone");
        assert_eq!(
            fs::read_to_string(dir_b.join("Cookies")).expect("cookie b"),
            "session-b",
            "the other connection's session is untouched"
        );

        let (surface_b, _, _) = acquire_connection(&host, "amazon", "cin_b", true, false);
        assert_eq!(profile_dirs(&host), vec![dir_b.clone()]);
        assert_eq!(
            fs::read_to_string(dir_b.join("Cookies")).expect("cookie b"),
            "session-b",
            "the other connection can still acquire its signed-in profile"
        );
        release_surface(&host, &surface_b);
    }

    #[test]
    fn two_connections_of_one_connector_can_hold_surfaces_at_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (surface_a, _, _) = acquire_connection(&host, "amazon", "cin_a", true, false);
        let (surface_b, _, _) = acquire_connection(&host, "amazon", "cin_b", true, false);
        assert_ne!(surface_a, surface_b);
        let refused = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin_a"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(refused.status, 409, "a live connection keeps its profile");
        release_surface(&host, &surface_a);
        release_surface(&host, &surface_b);
    }

    #[test]
    fn acquire_without_a_connection_id_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({ "run_id": "run-1", "connector_id": "amazon", "headless": true }),
        );
        assert_eq!(response.status, 400);
        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({ "run_id": "run-2", "connector_id": "amazon", "connection_id": "../x", "headless": true }),
        );
        assert_eq!(response.status, 500);
        assert!(
            profile_dirs(&host).is_empty(),
            "no shared profile is created"
        );
    }

    fn seed_legacy_profile(host: &BrowserSurfaceHost, connector_id: &str) -> PathBuf {
        let legacy = host.state.profile_root.join(stable_segment(connector_id));
        fs::create_dir_all(legacy.join("Default")).expect("legacy profile");
        fs::write(legacy.join("Default").join("Cookies"), "legacy-session").expect("legacy cookie");
        legacy
    }

    #[test]
    fn a_single_connection_takes_over_the_old_per_connector_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let legacy = seed_legacy_profile(&host, "amazon");

        let (surface, _, _) = acquire_connection(&host, "amazon", "cin_only", true, true);
        release_surface(&host, &surface);

        assert!(!legacy.exists(), "the old profile was moved, not copied");
        let moved = host
            .state
            .profile_dir("amazon", "cin_only", false)
            .expect("profile dir");
        assert_eq!(
            fs::read_to_string(moved.join("Default").join("Cookies")).expect("moved cookie"),
            "legacy-session",
            "the owner stays signed in"
        );
    }

    #[test]
    fn with_several_connections_the_old_profile_is_left_and_each_starts_clean() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let legacy = seed_legacy_profile(&host, "amazon");

        let (surface_a, _, _) = acquire_connection(&host, "amazon", "cin_a", true, false);
        let (surface_b, _, _) = acquire_connection(&host, "amazon", "cin_b", true, false);
        release_surface(&host, &surface_a);
        release_surface(&host, &surface_b);

        assert!(legacy.join("Default").join("Cookies").exists());
        for connection in ["cin_a", "cin_b"] {
            let dir = host
                .state
                .profile_dir("amazon", connection, false)
                .expect("profile dir");
            assert!(!dir.join("Default").join("Cookies").exists());
        }
    }

    #[test]
    fn reset_with_legacy_remove_also_deletes_the_old_per_connector_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let legacy = seed_legacy_profile(&host, "amazon");
        let kept = seed_legacy_profile(&host, "reddit");

        let reset = request(
            &host,
            "DELETE",
            &format!("{BROWSER_PROFILE_PATH}amazon/cin_only?legacy=remove"),
            Some(host_token(&host)),
            json!({}),
        );
        assert_eq!(reset.status, 204);
        assert!(!legacy.exists());
        assert!(kept.exists(), "another connector's profile is untouched");
    }

    /// A browser that aborts the way Chromium does when AppArmor blocks its
    /// user-namespace sandbox. The FATAL line is truncated before Chromium's
    /// own workaround advice.
    fn sandbox_blocked_browser(temp: &TempDir) -> PathBuf {
        let path = temp.path().join("sandbox-blocked-browser.sh");
        fs::write(
            &path,
            r#"#!/bin/sh
echo '[1:1:0928/165834.918776:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md?from=test' >&2
exit 133
"#,
        )
        .expect("write sandbox-blocked browser");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("make sandbox-blocked browser executable");
        path
    }

    #[test]
    fn sandbox_abort_returns_browser_sandbox_unavailable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(sandbox_blocked_browser(&temp)),
        )
        .expect("start test host");
        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-sandbox",
                "connector_id": "github",
                "connection_id": "cin-github",
                "headless": false,
            }),
        );
        assert_eq!(response.status, 500);
        let body: serde_json::Value = serde_json::from_slice(&response.body).expect("error body");
        assert_eq!(body["error"], "browser_sandbox_unavailable");
        let message = body["message"].as_str().expect("error message");
        assert!(message.contains("Install Google Chrome or Chromium from a .deb package"));
        assert!(message.contains("/usr/bin/google-chrome"));
    }

    /// Live check against a real Chromium, for example Playwright's, on a
    /// host that restricts unprivileged user namespaces:
    /// `DATACONNECT_LIVE_BROWSER=/path/to/chrome cargo test --lib live_browser -- --ignored`.
    /// Run it on a private display with an isolated HOME.
    #[test]
    #[ignore = "needs a real Chromium in DATACONNECT_LIVE_BROWSER"]
    fn live_browser_launch_is_ready_or_reports_sandbox_unavailable() {
        let browser = PathBuf::from(
            std::env::var("DATACONNECT_LIVE_BROWSER").expect("DATACONNECT_LIVE_BROWSER"),
        );
        let temp = tempfile::tempdir().expect("tempdir");
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(browser),
        )
        .expect("start test host");
        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-live",
                "connector_id": "github",
                "connection_id": "cin-github",
                "headless": false,
            }),
        );
        let body: serde_json::Value = serde_json::from_slice(&response.body).expect("body");
        eprintln!("live host response: HTTP {} {body}", response.status);
        assert!(
            response.status == 200 || body["error"] == "browser_sandbox_unavailable",
            "unexpected host response: HTTP {} {body}",
            response.status
        );
    }

    #[test]
    fn early_exit_without_sandbox_signature_stays_surface_start_failed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("crashing-browser.sh");
        fs::write(&path, "#!/bin/sh\necho 'some other failure' >&2\nexit 1\n")
            .expect("write crashing browser");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        let error = launch_browser(&path, temp.path(), true).expect_err("launch must fail");
        assert_eq!(error.code, "surface_start_failed");
        assert!(error.message.contains("exited before becoming ready"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn acquire_refuses_a_live_foreign_process_holding_the_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let profile = host
            .state
            .profile_dir("github", "cin-github", false)
            .expect("profile dir");
        let mut owner = Command::new("python3")
            .args([
                "-c",
                "import time; time.sleep(30)",
                "fake-chrome",
                &format!("--user-data-dir={}", profile.display()),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start isolated fake profile owner");
        let lock = profile.join("SingletonLock");
        symlink(format!("{}-{}", hostname(), owner.id()), &lock).expect("write fake Chromium lock");

        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-foreign-profile",
                "connector_id": "github",
                "connection_id": "cin-github",
                "headless": true,
            }),
        );
        let body: serde_json::Value = serde_json::from_slice(&response.body).expect("body");
        let owner_still_running = owner.try_wait().expect("check owner").is_none();
        let _ = owner.kill();
        let _ = owner.wait();
        assert_eq!(body["error"], "browser_profile_in_use");
        assert_eq!(
            body["message"],
            "A DataConnect browser window for this account is still open. Close it and try again."
        );
        assert!(
            owner_still_running,
            "foreign profile owner must not be killed"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn acquire_terminates_a_tracked_orphan_holding_the_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let profile = host
            .state
            .profile_dir("github", "cin-github", false)
            .expect("profile dir");
        let browser = temp.path().join("orphan-browser.sh");
        let pid_file = profile.join("orphan.pid");
        fs::write(
            &browser,
            format!(
                "#!/bin/sh\nprofile=\"\"\nfor arg in \"$@\"; do case \"$arg\" in --user-data-dir=*) profile=\"${{arg#*=}}\" ;; esac; done\npython3 -c 'import time; time.sleep(30)' --user-data-dir=\"$profile\" &\necho $! > {}\nexit 0\n",
                pid_file.display()
            ),
        )
        .expect("write orphan browser");
        fs::set_permissions(&browser, fs::Permissions::from_mode(0o755)).expect("chmod");
        let mut command = Command::new(&browser);
        command.arg(format!("--user-data-dir={}", profile.display()));
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let owner = command.spawn().expect("start tracked fake browser");
        let group_id = owner.id();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let pid = fs::read_to_string(&pid_file)
            .expect("orphan browser pid")
            .trim()
            .parse::<u32>()
            .expect("valid pid");
        symlink(
            format!("{}-{pid}", hostname()),
            profile.join("SingletonLock"),
        )
        .expect("write fake Chromium lock");
        host.state
            .browsers
            .lock()
            .expect("browser state")
            .insert(group_id, owner);

        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-after-orphan",
                "connector_id": "github",
                "connection_id": "cin-github",
                "headless": true,
            }),
        );

        assert_eq!(response.status, 200);
        wait_for_process_exit(pid);
    }

    #[test]
    fn readiness_failure_terminates_descendant_browser_processes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let profile = temp.path().join("profile");
        fs::create_dir_all(&profile).expect("profile dir");
        let pid_file = profile.join("orphan.pid");
        let browser = temp.path().join("handoff-browser.sh");
        fs::write(
            &browser,
            format!(
                "#!/bin/sh\npython3 -c 'import time; time.sleep(30)' --user-data-dir={} &\necho $! > {}\nexit 1\n",
                profile.display(),
                pid_file.display()
            ),
        )
        .expect("write fake handoff browser");
        fs::set_permissions(&browser, fs::Permissions::from_mode(0o755)).expect("chmod");

        assert!(launch_browser(&browser, &profile, true).is_err());
        let pid = fs::read_to_string(pid_file)
            .expect("handoff process pid")
            .trim()
            .parse::<u32>()
            .expect("valid pid");
        wait_for_process_exit(pid);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires real Chromium and an isolated Xvfb display"]
    fn real_chrome_profile_reuse_does_not_add_blank_targets() {
        let temp = tempfile::tempdir().expect("isolated tempdir");
        let browser = PathBuf::from(
            std::env::var("DATACONNECT_REAL_BROWSER").expect("DATACONNECT_REAL_BROWSER"),
        );
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(browser.clone()),
        )
        .expect("start isolated test host");
        let profile = host
            .state
            .profile_dir("reddit", "cin-isolated", false)
            .expect("isolated profile dir");
        let mut owner = super::super::pdpp_browser::browser_command(&browser, &profile, false)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start isolated real Chromium");

        let result = (|| {
            let deadline = Instant::now() + Duration::from_secs(15);
            let active_port = profile.join("DevToolsActivePort");
            let port = loop {
                if let Ok(contents) = fs::read_to_string(&active_port) {
                    if let Some(port) = contents
                        .lines()
                        .next()
                        .and_then(|value| value.parse::<u16>().ok())
                    {
                        break port;
                    }
                }
                if Instant::now() >= deadline {
                    return Err("isolated Chromium did not publish its DevTools port".to_string());
                }
                if let Ok(Some(status)) = owner.try_wait() {
                    let mut stderr = String::new();
                    if let Some(mut stream) = owner.stderr.take() {
                        let _ = stream.read_to_string(&mut stderr);
                    }
                    let sandbox_unavailable = stderr.contains(NO_USABLE_SANDBOX_SIGNATURE);
                    let diagnostic = stderr
                        .lines()
                        .find(|line| {
                            ["ERROR", "FATAL", "sandbox", "X11", "display"]
                                .iter()
                                .any(|needle| line.contains(needle))
                        })
                        .unwrap_or("<no matching browser diagnostic>");
                    return Err(format!(
                        "isolated Chromium exited before DevTools became ready ({status}); sandbox_unavailable={sandbox_unavailable}; {diagnostic}"
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            };
            let cdp_url = format!("http://127.0.0.1:{port}");
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(1))
                .build()
                .map_err(|error| error.to_string())?;
            let mut targets = real_browser_page_targets(&client, &cdp_url);
            let ready_deadline = Instant::now() + Duration::from_secs(5);
            while targets.is_empty() && Instant::now() < ready_deadline {
                thread::sleep(Duration::from_millis(25));
                targets = real_browser_page_targets(&client, &cdp_url);
            }
            if targets.is_empty() {
                return Err("isolated Chromium has no DevTools page target".to_string());
            }

            let expected_mode = std::env::var("DATACONNECT_PROFILE_REUSE_MODE")
                .expect("DATACONNECT_PROFILE_REUSE_MODE");
            if expected_mode != "base" && expected_mode != "fixed" {
                return Err("DATACONNECT_PROFILE_REUSE_MODE must be base or fixed".to_string());
            }
            let mut measurements = Vec::new();
            for retry in 1..=2 {
                let before = targets
                    .iter()
                    .filter(|target| target.as_str() == "about:blank")
                    .count();
                let response = request(
                    &host,
                    "POST",
                    BROWSER_SURFACE_PATH,
                    Some(host_token(&host)),
                    json!({
                        "run_id": format!("run-real-retry-{retry}"),
                        "connector_id": "reddit",
                        "connection_id": "cin-isolated",
                        "headless": false,
                    }),
                );
                let body: serde_json::Value =
                    serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
                thread::sleep(Duration::from_millis(250));
                targets = real_browser_page_targets(&client, &cdp_url);
                let after = targets
                    .iter()
                    .filter(|target| target.as_str() == "about:blank")
                    .count();
                let code = body["error"].as_str().unwrap_or("acquired");
                eprintln!(
                    "real Chromium retry {retry}: about:blank targets {before} -> {after}; {code}"
                );
                measurements.push((before, after, code.to_string()));
            }

            for (before, after, code) in &measurements {
                if expected_mode == "base" {
                    if code.as_str() != SURFACE_START_FAILED || *after != *before + 1 {
                        return Err(format!(
                            "base retry expected surface_start_failed and one new blank target, got {code} and {before}->{after}"
                        ));
                    }
                } else if expected_mode == "fixed"
                    && (code.as_str() != "browser_profile_in_use" || after != before)
                {
                    return Err(format!(
                        "fixed retry expected browser_profile_in_use and no new blank target, got {code} and {before}->{after}"
                    ));
                }
            }
            Ok(measurements)
        })();

        host.shutdown();
        let owner_stopped = super::super::pdpp_browser::terminate_browser(&mut owner);
        assert!(owner_stopped, "isolated Chromium process group must stop");
        result.expect("real Chromium profile reuse measurements");
    }

    #[cfg(target_os = "linux")]
    fn real_browser_page_targets(client: &reqwest::blocking::Client, cdp_url: &str) -> Vec<String> {
        client
            .get(format!("{cdp_url}/json/list"))
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(|response| response.json::<Vec<serde_json::Value>>())
            .map(|targets| {
                targets
                    .iter()
                    .filter(|target| target["type"] == "page")
                    .filter_map(|target| target["url"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn stderr_tail_is_bounded_and_redacts_query_strings() {
        let tail = StderrTail::default();
        tail.push_line("loading https://bank.example/login?session=secret#frag done\n");
        assert_eq!(
            tail.snapshot(),
            "loading https://bank.example/login?<redacted> done"
        );
        for _ in 0..2_000 {
            tail.push_line("0123456789");
        }
        let snapshot = tail.snapshot();
        assert!(snapshot.len() <= STDERR_TAIL_BYTES + 2_000);
        assert!(!snapshot.contains("secret"));
    }

    #[test]
    fn retry_after_lost_response_reuses_surface_and_run_delete_releases_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let payload = json!({
            "run_id": "run-lost-response",
            "connector_id": "github",
                "connection_id": "cin-github",
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
            .browser_pid;
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
                "connection_id": "cin-github",
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
    fn duplicate_live_connection_lease_is_refused_by_the_host_guard() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (_, _, first_pid) = acquire_connection_for_run(
            &host,
            "run-before-restart",
            "reddit",
            "cin_shared",
            true,
            false,
        );

        let response = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-after-restart",
                "connector_id": "reddit",
                "connection_id": "cin_shared",
                "headless": true,
            }),
        );

        assert_eq!(response.status, 500);
        let body: serde_json::Value = serde_json::from_slice(&response.body).expect("error body");
        assert_eq!(body["error"], BROWSER_PROFILE_IN_USE);
        assert_eq!(body["message"], BROWSER_PROFILE_IN_USE_MESSAGE);
        host.shutdown();
        wait_for_process_exit(first_pid);
    }

    #[test]
    fn stack_restart_release_allows_the_connection_to_acquire_again() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        let (_, _, old_pid) = acquire_connection_for_run(
            &host,
            "run-before-restart",
            "reddit",
            "cin_shared",
            true,
            false,
        );

        let app = tauri::test::mock_app();
        app.manage(host);
        let host = app.state::<BrowserSurfaceHost>();
        crate::unified::teardown_config_change_without_stack_for_test(&app.handle().clone())
            .expect("stack restart teardown");
        wait_for_process_exit(old_pid);
        let (surface_id, _, new_pid) = acquire_connection_for_run(
            &host,
            "run-after-restart",
            "reddit",
            "cin_shared",
            true,
            false,
        );

        assert!(host
            .state
            .leases
            .lock()
            .expect("lease state")
            .contains_key(&surface_id));
        assert_ne!(old_pid, new_pid);
        host.shutdown();
        wait_for_process_exit(new_pid);
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
