// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Host-owned browser surfaces for the unified desktop stack. The reference
// implementation talks to this narrow loopback capability endpoint and keeps
// the returned surface id opaque.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
#[cfg(test)]
use std::net::SocketAddr;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::browser_display::DisplayProviders;
use super::browser_presentation::{
    select_policy, DisplayBackend, PresentationPolicy, BROWSER_DISPLAY_ENV,
};
use super::owned_browser::{
    BrowserLaunchError, BrowserLauncher, LaunchFailure, LaunchSpec, OwnedBrowser,
    SURFACE_START_TIMEOUT,
};

const BROWSER_SURFACE_PATH: &str = "/browser-surface/leases";
/// `POST /browser-surface/leases/<surface_id>/reveal` shows a concealed
/// browser on the owner's desktop without taking focus.
const REVEAL_SUFFIX: &str = "/reveal";
/// `DELETE /browser-surface/profiles/<connector_id>/<connection_id>` resets one
/// connection's persistent profile after the owner deletes or revokes it.
/// `?legacy=remove` also removes the pre-connection per-connector profile; the
/// RI sends it only when no other connection of the connector exists.
const BROWSER_PROFILE_PATH: &str = "/browser-surface/profiles/";
const MAX_HTTP_REQUEST_BYTES: usize = 64 * 1024;
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// The acquire budget when the RI names none. It covers waiting for an
/// earlier launch, starting the display and the browser's readiness. A cold
/// first browser start on macOS has been measured at 5.9 s.
const DEFAULT_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);
/// Cap on an RI-requested budget, so one request cannot hold the launch
/// queue indefinitely.
const MAX_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(120);
const BROWSER_PROFILE_IN_USE: &str = "browser_profile_in_use";
const BROWSER_PROFILE_IN_USE_MESSAGE: &str =
    "A DataConnect browser window for this account is still open. Close it and try again.";
const INVALID_PRESENTATION_POLICY: &str = "invalid_presentation_policy";
const BROWSER_PRESENTATION_UNSUPPORTED: &str = "browser_presentation_unsupported";
/// The policy the host advertises to the RI, which sends it back with each
/// acquire.
pub(crate) const PRESENTATION_POLICY_ENV: &str = "PDPP_BROWSER_PRESENTATION_POLICY";

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
    /// Presentation policy v1. Absent keeps the legacy launch, where
    /// `headless` alone decides the engine mode on the inherited display.
    #[serde(default)]
    presentation_policy: Option<serde_json::Value>,
    /// The RI's end-to-end budget for this acquire. The RI waits a little
    /// longer than this for the response, so the host always answers first
    /// and never leaves a launched browser that nobody will lease.
    #[serde(default)]
    acquire_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct AcquireResponse {
    surface_id: String,
    cdp_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch: Option<LaunchReport>,
}

/// Launch milestones for observability. Holds no path, URL, token or page
/// content: the executable is reduced to its file name and the version is
/// the browser's product string.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct LaunchReport {
    executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    browser_version: Option<String>,
    engine_mode: String,
    display_backend: String,
    /// What the owner could see of the browser by the time it was ready, as
    /// the display backend observed it: `unknown`, `isolated-display`,
    /// `concealed`, `concealed-after-show` or `visible`.
    observed_visibility: String,
    /// False when the companion receives no frames until the browser is
    /// revealed (macOS `hidden-native`).
    streams_while_concealed: bool,
    milestones_ms: LaunchMilestones,
}

/// Milliseconds from the start of the acquire.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct LaunchMilestones {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_ready: Option<u64>,
    spawned: u64,
    cdp_ready: u64,
}

#[derive(Debug, Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn profile_in_use() -> BrowserLaunchError {
    BrowserLaunchError::new(BROWSER_PROFILE_IN_USE, BROWSER_PROFILE_IN_USE_MESSAGE)
}

fn invalid_presentation(message: impl Into<String>) -> BrowserLaunchError {
    BrowserLaunchError::new(INVALID_PRESENTATION_POLICY, message)
}

struct BrowserSurfaceLease {
    run_id: String,
    connector_id: String,
    connection_id: String,
    headless: bool,
    presentation: Option<PresentationPolicy>,
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
    launcher: BrowserLauncher,
    leases: Mutex<HashMap<String, BrowserSurfaceLease>>,
    /// Every browser this host launched whose stop is not yet confirmed,
    /// leased or not. A browser leaves this list only when its stop is
    /// confirmed, so an uncertain cleanup blocks reuse of its profile and is
    /// retried at the next acquire and at shutdown.
    browsers: Mutex<Vec<OwnedBrowser>>,
    /// Prevent a late POST from recreating a lease after its run was released.
    cancelled_runs: Mutex<HashSet<String>>,
    closed: AtomicBool,
}

impl HostState {
    fn new(
        profile_root: PathBuf,
        resource_dir: Option<PathBuf>,
        browser_path_override: Option<PathBuf>,
        display_providers: DisplayProviders,
    ) -> Self {
        Self {
            profile_root,
            resource_dir,
            browser_path_override,
            launcher: BrowserLauncher::new(display_providers),
            leases: Mutex::new(HashMap::new()),
            browsers: Mutex::new(Vec::new()),
            cancelled_runs: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn acquire(&self, request: AcquireRequest) -> Result<AcquireResponse, BrowserLaunchError> {
        let started = Instant::now();
        let deadline = started
            + request
                .acquire_timeout_ms
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_ACQUIRE_TIMEOUT)
                .min(MAX_ACQUIRE_TIMEOUT);
        validate_request_field("run_id", &request.run_id)?;
        validate_request_field("connector_id", &request.connector_id)?;
        validate_request_field("connection_id", &request.connection_id)?;
        let presentation = request
            .presentation_policy
            .as_ref()
            .map(PresentationPolicy::parse)
            .transpose()
            .map_err(|error| invalid_presentation(format!("{}: {}", error.code, error.message)))?;
        if let Some(policy) = presentation {
            if policy.headless() != request.headless {
                return Err(invalid_presentation(
                    "headless conflicts with the presentation policy engine_mode",
                ));
            }
            if policy.display_backend == DisplayBackend::ExternallyOwned {
                return Err(BrowserLaunchError::new(
                    BROWSER_PRESENTATION_UNSUPPORTED,
                    "The desktop host owns its displays; externally-owned is for attached browsers",
                ));
            }
        }

        // Admission and launch are serialized. A connection has exactly one
        // persistent profile, so a second launch must not race the first
        // launch or reuse its profile while the first browser is still alive.
        // Time spent waiting here counts against this acquire's deadline.
        let mut leases = lock_before(&self.leases, deadline)?;
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
                || lease.presentation != presentation
            {
                return Err("Run id is already bound to a different browser request".into());
            }
            return Ok(lease.response.clone());
        }
        if leases.values().any(|lease| {
            lease.connector_id == request.connector_id
                && lease.connection_id == request.connection_id
        }) {
            return Err(profile_in_use());
        }

        self.retry_unconfirmed_stops(&leases);
        let profile_dir = self.profile_dir(
            &request.connector_id,
            &request.connection_id,
            request.migrate_connector_profile,
        )?;
        refuse_profile_held_by_live_process(&profile_dir)?;

        let browser = self.browser_path().ok_or_else(|| {
            BrowserLaunchError::start_failed(
                "No system, downloaded, or bundled Chromium browser is available for host browser surfaces",
            )
        })?;
        let backend = presentation
            .map(|policy| policy.display_backend)
            .unwrap_or(DisplayBackend::InheritedHost);
        let launched = self.launcher.launch(&LaunchSpec {
            executable: &browser,
            profile_dir: &profile_dir,
            headless: request.headless,
            display_backend: backend,
            deadline,
        });
        let (owned, readiness) = match launched {
            Ok(launched) => launched,
            Err(LaunchFailure { error, unstopped }) => {
                if let Some(unstopped) = unstopped {
                    self.keep_until_stopped(unstopped);
                }
                return Err(error);
            }
        };
        let Some(browser_pid) = owned.pid() else {
            self.keep_until_stopped(owned);
            return Err("Launched browser has no process id".into());
        };
        let surface_id = format!("host-surface-{}", Uuid::new_v4().as_simple());
        let report = LaunchReport {
            executable: executable_name(&browser),
            browser_version: readiness.browser_version,
            engine_mode: if request.headless {
                "headless"
            } else {
                "headed"
            }
            .into(),
            display_backend: backend.as_str().into(),
            observed_visibility: owned.observed_visibility().as_str().into(),
            streams_while_concealed: owned.streams_while_concealed(),
            milestones_ms: LaunchMilestones {
                display_ready: readiness.display_ready_at.map(|at| ms_between(started, at)),
                spawned: ms_between(started, readiness.spawned_at),
                cdp_ready: ms_between(started, readiness.cdp_ready_at),
            },
        };
        log::info!(
            "Browser surface {surface_id} launched for run {}: executable={} version={} engine={} display={} visibility={:?} display_ready_ms={} spawned_ms={} cdp_ready_ms={} pid={browser_pid}",
            request.run_id,
            report.executable,
            report.browser_version.as_deref().unwrap_or("unknown"),
            report.engine_mode,
            report.display_backend,
            owned.observed_visibility(),
            report
                .milestones_ms
                .display_ready
                .map_or_else(|| "-".to_string(), |ms| ms.to_string()),
            report.milestones_ms.spawned,
            report.milestones_ms.cdp_ready,
        );
        let response = AcquireResponse {
            surface_id: surface_id.clone(),
            cdp_url: readiness.cdp_url,
            launch: Some(report),
        };
        self.keep_until_stopped(owned);
        leases.insert(
            surface_id.clone(),
            BrowserSurfaceLease {
                run_id: request.run_id,
                connector_id: request.connector_id,
                connection_id: request.connection_id,
                headless: request.headless,
                presentation,
                response: response.clone(),
                browser_pid,
            },
        );

        Ok(response)
    }

    fn keep_until_stopped(&self, mut browser: OwnedBrowser) {
        match self.browsers.lock() {
            Ok(mut browsers) => browsers.push(browser),
            Err(_) => {
                log::error!("Browser process state is poisoned; stopping the browser now");
                if !browser.terminate() {
                    log::warn!("A browser whose state could not be recorded did not stop");
                }
            }
        }
    }

    /// Retry stopping browsers that no lease holds: those whose release or
    /// failed launch could not confirm the stop.
    fn retry_unconfirmed_stops(&self, leases: &HashMap<String, BrowserSurfaceLease>) {
        let Ok(mut browsers) = self.browsers.lock() else {
            return;
        };
        browsers.retain_mut(|browser| {
            let leased = browser
                .pid()
                .is_some_and(|pid| leases.values().any(|lease| lease.browser_pid == pid));
            leased || !browser.terminate()
        });
    }

    /// Show a leased browser on the owner's desktop without taking focus.
    /// Returns None when no such lease exists.
    fn reveal(&self, surface_id: &str) -> Option<Result<(), String>> {
        let leases = self.leases.lock().ok()?;
        let pid = leases.get(surface_id)?.browser_pid;
        let mut browsers = self.browsers.lock().ok()?;
        let browser = browsers
            .iter_mut()
            .find(|browser| browser.pid() == Some(pid))?;
        let result = browser.reveal();
        log::info!(
            "Browser surface {surface_id} reveal: {}",
            result
                .as_ref()
                .map_or_else(|error| error.as_str(), |()| "shown")
        );
        Some(result)
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
            for browser in browsers.iter_mut() {
                if !browser.terminate() {
                    log::warn!(
                        "Browser {:?} did not terminate cleanly during shutdown",
                        browser.pid()
                    );
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
        let Some(index) = browsers
            .iter()
            .position(|browser| browser.pid() == Some(pid))
        else {
            log::error!("Browser process {pid} is missing from host state");
            return false;
        };
        let started = Instant::now();
        // Includes what happened after launch, such as a popup that showed
        // before it was concealed.
        let visibility = browsers[index].observed_visibility();
        if browsers[index].terminate() {
            browsers.remove(index);
            log::info!(
                "Browser {pid} and its display stopped: cleanup_ms={} observed_visibility={visibility:?}",
                elapsed_ms(started)
            );
            true
        } else {
            false
        }
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
    presentation_policy: Option<PresentationPolicy>,
    stop: Arc<AtomicBool>,
    server_thread: Mutex<Option<JoinHandle<()>>>,
}

impl BrowserSurfaceHost {
    /// Start a host endpoint on an OS-assigned loopback port.
    pub fn start(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Result<Self, String> {
        let display_providers =
            DisplayProviders::discover(&app_data_dir.join("browser-surface").join("displays"));
        let presentation_policy = select_policy(
            std::env::var(BROWSER_DISPLAY_ENV).ok().as_deref(),
            std::env::var("PDPP_BROWSER_HEADLESS").is_ok_and(|value| value.trim() == "1"),
            &display_providers.installed_backends(),
        )?;
        log::info!(
            "Connector browsers use display {}",
            presentation_policy.map_or("inherited-host (legacy)", |policy| policy
                .display_backend
                .as_str())
        );
        Self::start_with_browser(
            app_data_dir,
            resource_dir,
            None,
            display_providers,
            presentation_policy,
        )
    }

    fn start_with_browser(
        app_data_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        browser_path_override: Option<PathBuf>,
        display_providers: DisplayProviders,
        presentation_policy: Option<PresentationPolicy>,
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
            display_providers,
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
            presentation_policy,
            stop,
            server_thread: Mutex::new(Some(server_thread)),
        })
    }

    /// Return the environment pairs the supervisor must pass to the RI.
    pub fn env_pairs(&self) -> Vec<(&'static str, String)> {
        let mut pairs = vec![
            ("PDPP_BROWSER_SURFACE_MODE", "host".into()),
            ("PDPP_BROWSER_SURFACE_HOST_ENDPOINT", self.endpoint.clone()),
            ("PDPP_BROWSER_SURFACE_HOST_TOKEN", self.token.clone()),
        ];
        if let Some(policy) = self.presentation_policy {
            if let Ok(policy) = serde_json::to_string(&policy) {
                pairs.push((PRESENTATION_POLICY_ENV, policy));
            }
        }
        pairs
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

/// Lock `mutex`, waiting no later than `deadline`. A std mutex has no timed
/// lock, so this polls; the wait is short and only behind another launch.
fn lock_before<T>(
    mutex: &Mutex<T>,
    deadline: Instant,
) -> Result<MutexGuard<'_, T>, BrowserLaunchError> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => {
                return Err("Browser surface lease state is unavailable".into())
            }
            Err(TryLockError::WouldBlock) if Instant::now() >= deadline => {
                return Err(BrowserLaunchError::new(
                    SURFACE_START_TIMEOUT,
                    "The browser launch deadline passed while waiting for another launch",
                ))
            }
            Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// Refuse a profile whose Chromium singleton lock names a live process. By
/// the time this runs, every browser this host launched and no longer
/// leases has had its stop retried, so a live holder is either a browser
/// that will not stop or a process the host does not own; neither may be
/// shared.
fn refuse_profile_held_by_live_process(profile_dir: &Path) -> Result<(), BrowserLaunchError> {
    #[cfg(target_os = "linux")]
    {
        let lock = profile_dir.join("SingletonLock");
        let target = match fs::read_link(&lock) {
            Ok(target) => target,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(profile_in_use()),
        };
        let hostname =
            fs::read_to_string("/proc/sys/kernel/hostname").map_err(|_| profile_in_use())?;
        let Some(pid) = target
            .to_string_lossy()
            .strip_prefix(&format!("{}-", hostname.trim()))
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            return Ok(());
        };
        if Path::new("/proc").join(pid.to_string()).exists()
            && process_uses_profile(pid, profile_dir)
        {
            return Err(profile_in_use());
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = profile_dir;
    Ok(())
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

fn ms_between(start: Instant, end: Instant) -> u64 {
    end.saturating_duration_since(start).as_millis() as u64
}

/// The executable's file name only; its directory can name the owner.
fn executable_name(browser: &Path) -> String {
    browser
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into())
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
                    let status = if error.code == INVALID_PRESENTATION_POLICY {
                        "400 Bad Request"
                    } else {
                        "500 Internal Server Error"
                    };
                    json_response(
                        status,
                        &ErrorResponse {
                            error: error.code,
                            message: Some(error.message),
                        },
                        None,
                    )
                }
            }
        }
        ("POST", path)
            if path.starts_with("/browser-surface/leases/") && path.ends_with(REVEAL_SUFFIX) =>
        {
            let surface_id =
                &path[BROWSER_SURFACE_PATH.len() + 1..path.len() - REVEAL_SUFFIX.len()];
            match state.reveal(surface_id) {
                Some(Ok(())) => empty_response("204 No Content"),
                None => empty_response("404 Not Found"),
                Some(Err(message)) => json_response(
                    "409 Conflict",
                    &ErrorResponse {
                        error: "browser_reveal_failed",
                        message: Some(message),
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
    use super::super::browser_display::{BrowserDisplayLaunch, DisplaySession, ObservedVisibility};
    use super::super::owned_browser::BROWSER_DISPLAY_UNAVAILABLE;
    #[cfg(target_os = "linux")]
    use super::super::owned_browser::{NO_USABLE_SANDBOX_SIGNATURE, SURFACE_START_FAILED};
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    #[cfg(target_os = "linux")]
    use std::process::Stdio;
    use tempfile::TempDir;

    #[cfg(target_os = "linux")]
    fn process_group_for_pid(pid: u32) -> Option<u32> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, fields) = stat.rsplit_once(") ")?;
        fields.split_whitespace().nth(2)?.parse().ok()
    }

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
printf 'DISPLAY=%s\nXAUTHORITY=%s\nHOME=%s\n' "${DISPLAY-unset}" "${XAUTHORITY-unset}" "${HOME-unset}" > "$profile/env.txt"
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
            DisplayProviders::default(),
            None,
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

    /// Runs `script <cdp_url>` with node and returns its last output line.
    fn run_cdp_script(env: &str, cdp_url: &str) -> Option<(bool, String)> {
        let script = std::env::var(env).ok()?;
        let output = Command::new("node")
            .arg(&script)
            .arg(cdp_url)
            .output()
            .expect("run CDP script");
        let stdout = String::from_utf8_lossy(&output.stdout);
        Some((
            output.status.success(),
            stdout.lines().last().unwrap_or_default().to_string(),
        ))
    }

    /// The macOS `hidden-native` path with a real Chrome. Evidence of what
    /// the owner saw comes from an independent observer
    /// (DATACONNECT_OBSERVE_PHASE_FILE names the file this test writes its
    /// phase to); the test itself proves collection while concealed, then
    /// companion frames and input after reveal.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a real Chrome (DATACONNECT_REAL_BROWSER) in a logged-in macOS session"]
    fn real_chrome_hidden_native_stays_concealed() {
        let phase = |name: &str| {
            if let Ok(path) = std::env::var("DATACONNECT_OBSERVE_PHASE_FILE") {
                fs::write(path, name).expect("write phase");
            }
        };
        let temp = tempfile::tempdir().expect("isolated tempdir");
        let browser = PathBuf::from(
            std::env::var("DATACONNECT_REAL_BROWSER").expect("DATACONNECT_REAL_BROWSER"),
        );
        let providers = DisplayProviders::discover(temp.path());
        assert_eq!(
            providers.installed_backends(),
            vec![DisplayBackend::HiddenNative]
        );
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(browser),
            providers,
            Some(PresentationPolicy::HIDDEN_NATIVE),
        )
        .expect("start host");
        phase("launch");
        let response = acquire_with_policy(
            &host,
            "run-hidden",
            "chase",
            false,
            serde_json::to_value(PresentationPolicy::HIDDEN_NATIVE).expect("policy"),
        );
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let acquired: AcquireResponse = serde_json::from_slice(&response.body).expect("body");
        let launch = acquired.launch.clone().expect("launch report");
        println!("launch report: {launch:?}");
        assert_eq!(launch.display_backend, "hidden-native");
        assert!(!launch.streams_while_concealed);

        phase("collect");
        if let Some((ok, line)) =
            run_cdp_script("DATACONNECT_LIVE_COLLECTION_CHECK", &acquired.cdp_url)
        {
            println!("collection while concealed: {line}");
            assert!(ok, "collection failed while concealed: {line}");
        }
        // Lets an outside sampler measure the concealment watch's cost.
        if let Ok(seconds) = std::env::var("DATACONNECT_LIVE_HOLD_SECS") {
            println!("holding concealed: pid {}", std::process::id());
            thread::sleep(Duration::from_secs(seconds.parse().expect("hold seconds")));
        }
        thread::sleep(Duration::from_millis(500));
        phase("reveal");
        let revealed = reveal(&host, &acquired.surface_id);
        assert_eq!(
            revealed.status,
            204,
            "{}",
            String::from_utf8_lossy(&revealed.body)
        );
        thread::sleep(Duration::from_millis(500));
        phase("companion");
        if let Some((ok, line)) = run_cdp_script("DATACONNECT_LIVE_CDP_CHECK", &acquired.cdp_url) {
            println!("companion after reveal: {line}");
            assert!(ok, "companion check failed after reveal: {line}");
        }
        phase("release");
        let pid = host.state.leases.lock().expect("leases")[&acquired.surface_id].browser_pid;
        release_surface(&host, &acquired.surface_id);
        assert!(host.state.browsers.lock().expect("browsers").is_empty());
        // SAFETY: signal 0 only checks whether the group still exists.
        let group_alive = unsafe { libc::kill(-(pid as libc::pid_t), 0) } == 0;
        assert!(!group_alive, "the browser's process group is gone");
        phase("done");
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
            DisplayProviders::default(),
            None,
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
            DisplayProviders::default(),
            None,
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
        let owner = super::super::browser_display::spawn_retrying_busy_executable(&mut command)
            .expect("start tracked fake browser");
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
        let _ = group_id;
        host.state
            .browsers
            .lock()
            .expect("browser state")
            .push(OwnedBrowser::from_child(owner));

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

        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        wait_for_process_exit(pid);
    }

    #[cfg(target_os = "linux")]
    fn process_group_members(group: u32) -> Vec<u32> {
        fs::read_dir("/proc")
            .expect("read /proc")
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| process_group_for_pid(*pid) == Some(group))
            .collect()
    }

    /// The X11 and Wayland server sockets that these processes are connected
    /// to, from `ss -xpn`: a client socket's peer inode names the server's
    /// listening path.
    #[cfg(target_os = "linux")]
    fn display_sockets_of(pids: &[u32]) -> Vec<String> {
        let output = Command::new("ss").arg("-xpn").output().expect("run ss");
        let text = String::from_utf8_lossy(&output.stdout);
        let rows: Vec<Vec<&str>> = text
            .lines()
            .skip(1)
            .map(|line| line.split_whitespace().collect())
            .filter(|fields: &Vec<&str>| fields.len() >= 8)
            .collect();
        let paths: HashMap<&str, &str> = rows
            .iter()
            .filter(|fields| fields[4] != "*")
            .map(|fields| (fields[5], fields[4]))
            .collect();
        rows.iter()
            .filter(|fields| {
                let process = fields[8..].join(" ");
                pids.iter()
                    .any(|pid| process.contains(&format!("pid={pid},")))
            })
            .filter_map(|fields| paths.get(fields[7]).map(|path| path.to_string()))
            .filter(|path| path.contains("X11-unix") || path.contains("wayland"))
            .collect()
    }

    /// The real Linux path: Xvfb, then Chromium on it. Every browser
    /// process must point at the private display and none may see the
    /// owner's Wayland or X display. With DATACONNECT_LIVE_CDP_CHECK naming
    /// `scripts/verify-private-display-cdp.mjs`, it also proves screencast
    /// frames and input over CDP, which is what the companion uses.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires real Chromium (DATACONNECT_REAL_BROWSER) and Xvfb"]
    fn real_chrome_on_private_xvfb_stays_off_the_owner_display() {
        let temp = tempfile::tempdir().expect("isolated tempdir");
        let browser = PathBuf::from(
            std::env::var("DATACONNECT_REAL_BROWSER").expect("DATACONNECT_REAL_BROWSER"),
        );
        let runtime = temp.path().join("displays");
        let provider = super::super::browser_display::xvfb::XvfbProvider::removing_stale_sessions(
            PathBuf::from("/usr/bin/Xvfb"),
            runtime.clone(),
        );
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(browser),
            DisplayProviders::default().with(Arc::new(provider)),
            Some(PresentationPolicy::PRIVATE_XVFB),
        )
        .expect("start host");
        let owner_display = std::env::var("DISPLAY").ok();
        let response =
            acquire_with_policy(&host, "run-live", "chase", false, private_xvfb_policy());
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let acquired: AcquireResponse = serde_json::from_slice(&response.body).expect("body");
        let pid = host.state.leases.lock().expect("leases")[&acquired.surface_id].browser_pid;
        println!("launch report: {:?}", acquired.launch);

        let members = process_group_members(pid);
        assert!(!members.is_empty());
        // Chromium rewrites its own environ (process titles), so prove the
        // display by the sockets the browser processes are connected to.
        let sockets = display_sockets_of(&members);
        assert!(
            !sockets.is_empty(),
            "the browser is connected to no display"
        );
        let private_socket = sockets[0].clone();
        assert!(
            sockets.iter().all(|socket| socket == &private_socket),
            "the browser reaches more than one display: {sockets:?}"
        );
        assert!(
            private_socket.contains("/tmp/.X11-unix/X"),
            "{private_socket}"
        );
        if let Some(owner) = owner_display
            .as_deref()
            .and_then(|value| value.strip_prefix(':'))
        {
            assert!(
                !private_socket.ends_with(&format!("/tmp/.X11-unix/X{owner}")),
                "the browser is on the owner's X display"
            );
        }
        println!(
            "{} browser processes; display connections: {} to {private_socket}, none to Wayland",
            members.len(),
            sockets.len()
        );

        if let Ok(script) = std::env::var("DATACONNECT_LIVE_CDP_CHECK") {
            let output = Command::new("node")
                .arg(&script)
                .arg(&acquired.cdp_url)
                .output()
                .expect("run CDP check");
            println!(
                "CDP check: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            );
            assert!(
                output.status.success(),
                "CDP check failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        release_surface(&host, &acquired.surface_id);
        assert!(
            process_group_members(pid).is_empty(),
            "browser processes remain"
        );
        assert_eq!(fs::read_dir(&runtime).expect("runtime dir").count(), 0);
        println!("REAL PRIVATE XVFB BROWSER TEST RAN");
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
            DisplayProviders::default(),
            None,
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

    #[test]
    fn env_pairs_advertise_the_host_presentation_policy() {
        let temp = tempfile::tempdir().expect("tempdir");
        assert!(!start_test_host(&temp)
            .env_pairs()
            .iter()
            .any(|(name, _)| *name == PRESENTATION_POLICY_ENV));
        let (host, _) = start_display_host(&temp, true);
        let pairs = host.env_pairs();
        let policy = &pairs
            .iter()
            .find(|(name, _)| *name == PRESENTATION_POLICY_ENV)
            .expect("policy pair")
            .1;
        let policy: serde_json::Value = serde_json::from_str(policy).expect("policy JSON");
        assert_eq!(
            PresentationPolicy::parse(&policy),
            Ok(PresentationPolicy::PRIVATE_XVFB)
        );
    }

    /// Records display lifecycle events. Stop order relative to the browser
    /// is proven in `owned_browser`; these tests prove the host wiring.
    #[derive(Clone, Default)]
    struct DisplayLog {
        events: Arc<Mutex<Vec<String>>>,
        fail_start: Arc<AtomicBool>,
        /// Stops that fail before one succeeds, for each display started.
        stop_failures: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl DisplayLog {
        fn events(&self) -> Vec<String> {
            self.events.lock().expect("events").clone()
        }
    }

    struct FakeDisplayProvider(DisplayLog);

    impl super::super::browser_display::DisplayProvider for FakeDisplayProvider {
        fn backend(&self) -> DisplayBackend {
            DisplayBackend::PrivateXvfb
        }

        fn start(&self, _deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
            if self.0.fail_start.load(Ordering::Acquire) {
                self.0
                    .events
                    .lock()
                    .expect("events")
                    .push("start-failed".into());
                return Err("fake display did not start".into());
            }
            self.0.events.lock().expect("events").push("start".into());
            Ok(Box::new(FakeDisplaySession {
                log: self.0.clone(),
                launch: BrowserDisplayLaunch {
                    env: vec![
                        ("DISPLAY".into(), ":4242".into()),
                        ("XAUTHORITY".into(), "/fake/client.xauth".into()),
                    ],
                    // HOME is always set in the test process, so its absence
                    // in the browser proves removal reaches the child only.
                    env_remove: vec!["HOME"],
                    args: vec!["--ozone-platform=x11".into()],
                    pages_open_in_background: false,
                },
                stopped: false,
            }))
        }
    }

    struct FakeDisplaySession {
        log: DisplayLog,
        launch: BrowserDisplayLaunch,
        stopped: bool,
    }

    impl DisplaySession for FakeDisplaySession {
        fn browser_launch(&self) -> &BrowserDisplayLaunch {
            &self.launch
        }

        fn observed_visibility(&self) -> ObservedVisibility {
            ObservedVisibility::IsolatedDisplay
        }

        fn terminate(&mut self) -> bool {
            if self.log.stop_failures.load(Ordering::Acquire) > 0 {
                self.log.stop_failures.fetch_sub(1, Ordering::AcqRel);
                self.log
                    .events
                    .lock()
                    .expect("events")
                    .push("stop-failed".into());
                return false;
            }
            if !self.stopped {
                self.log.events.lock().expect("events").push("stop".into());
                self.stopped = true;
            }
            true
        }
    }

    fn start_display_host(temp: &TempDir, with_provider: bool) -> (BrowserSurfaceHost, DisplayLog) {
        let log = DisplayLog::default();
        let providers = if with_provider {
            DisplayProviders::default().with(Arc::new(FakeDisplayProvider(log.clone())))
        } else {
            DisplayProviders::default()
        };
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(fake_browser(temp)),
            providers,
            Some(PresentationPolicy::PRIVATE_XVFB),
        )
        .expect("start display test host");
        (host, log)
    }

    fn acquire_with_policy(
        host: &BrowserSurfaceHost,
        run_id: &str,
        connector_id: &str,
        headless: bool,
        policy: serde_json::Value,
    ) -> TestResponse {
        request(
            host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(host)),
            json!({
                "run_id": run_id,
                "connector_id": connector_id,
                "connection_id": format!("cin-{connector_id}"),
                "headless": headless,
                "presentation_policy": policy,
            }),
        )
    }

    fn private_xvfb_policy() -> serde_json::Value {
        serde_json::to_value(PresentationPolicy::PRIVATE_XVFB).expect("policy")
    }

    fn error_code(response: &TestResponse) -> String {
        serde_json::from_slice::<serde_json::Value>(&response.body).expect("error body")["error"]
            .as_str()
            .expect("error code")
            .to_string()
    }

    fn profile_was_launched(host: &BrowserSurfaceHost, connector_id: &str) -> bool {
        host.state
            .profile_dir(connector_id, &format!("cin-{connector_id}"), false)
            .map(|dir| dir.join("args.txt").exists())
            .unwrap_or(false)
    }

    #[test]
    fn private_display_starts_first_reaches_only_the_browser_and_stops_last() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        let home_before = std::env::var_os("HOME");
        let response =
            acquire_with_policy(&host, "run-xvfb", "chase", false, private_xvfb_policy());
        assert_eq!(response.status, 200);
        let acquired: AcquireResponse = serde_json::from_slice(&response.body).expect("body");
        assert_eq!(log.events(), vec!["start"]);

        let profile_dir = host
            .state
            .profile_dir("chase", "cin-chase", false)
            .expect("profile dir");
        let env = fs::read_to_string(profile_dir.join("env.txt")).expect("fake env");
        assert!(env.contains("DISPLAY=:4242\n"), "{env}");
        assert!(env.contains("XAUTHORITY=/fake/client.xauth\n"), "{env}");
        assert!(env.contains("HOME=unset\n"), "{env}");
        assert_eq!(
            std::env::var_os("HOME"),
            home_before,
            "the host env is unchanged"
        );
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(args.contains("--ozone-platform=x11\n"));
        assert!(!args.contains("--headless"));
        assert!(
            args.ends_with("about:blank\n"),
            "start URL stays last: {args}"
        );

        // Phase 0 launch report: milestones in order, nothing sensitive.
        let launch = acquired.launch.expect("launch report");
        assert_eq!(launch.display_backend, "private-xvfb");
        assert_eq!(launch.engine_mode, "headed");
        assert_eq!(launch.observed_visibility, "isolated-display");
        assert!(launch.streams_while_concealed);
        assert_eq!(launch.executable, "fake-browser.sh");
        let display_ready = launch
            .milestones_ms
            .display_ready
            .expect("display milestone");
        assert!(display_ready <= launch.milestones_ms.spawned);
        assert!(launch.milestones_ms.spawned <= launch.milestones_ms.cdp_ready);
        let launch_json = serde_json::from_slice::<serde_json::Value>(&response.body)
            .expect("body")["launch"]
            .to_string();
        assert!(
            !launch_json.contains('/'),
            "no path or URL in {launch_json}"
        );
        assert!(!launch_json.contains(host_token(&host)));

        let pid = host
            .state
            .leases
            .lock()
            .expect("leases")
            .get(&acquired.surface_id)
            .expect("lease")
            .browser_pid;
        release_surface(&host, &acquired.surface_id);
        wait_for_process_exit(pid);
        assert_eq!(log.events(), vec!["start", "stop"]);
        assert!(host.state.browsers.lock().expect("browsers").is_empty());
    }

    fn acquire_with_budget(
        host: &BrowserSurfaceHost,
        run_id: &str,
        budget_ms: u64,
    ) -> TestResponse {
        request(
            host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(host)),
            json!({
                "run_id": run_id,
                "connector_id": "chase",
                "connection_id": "cin-chase",
                "headless": true,
                "acquire_timeout_ms": budget_ms,
            }),
        )
    }

    #[test]
    fn the_acquire_budget_bounds_browser_readiness() {
        let temp = tempfile::tempdir().expect("tempdir");
        let never_ready = temp.path().join("never-ready-browser.sh");
        fs::write(
            &never_ready,
            "#!/bin/sh
trap 'exit 0' TERM INT
while :; do sleep 1; done
",
        )
        .expect("write never-ready browser");
        fs::set_permissions(&never_ready, fs::Permissions::from_mode(0o755)).expect("chmod");
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(never_ready),
            DisplayProviders::default(),
            None,
        )
        .expect("start test host");
        let started = Instant::now();
        let response = acquire_with_budget(&host, "run-slow", 600);
        assert_eq!(response.status, 500);
        assert_eq!(error_code(&response), SURFACE_START_TIMEOUT);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "readiness used the request budget, not a fresh browser timeout: {:?}",
            started.elapsed()
        );
        assert!(host.state.browsers.lock().expect("browsers").is_empty());
    }

    #[test]
    fn waiting_behind_another_launch_counts_against_the_acquire_budget() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = start_test_host(&temp);
        // Stands in for a launch in progress: admission holds this lock.
        let in_progress = host.state.leases.lock().expect("leases");
        let started = Instant::now();
        let response = thread::scope(|scope| {
            scope
                .spawn(|| acquire_with_budget(&host, "run-queued", 300))
                .join()
                .expect("acquire thread")
        });
        drop(in_progress);
        assert_eq!(response.status, 500);
        assert_eq!(error_code(&response), SURFACE_START_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!profile_was_launched(&host, "chase"));
    }

    fn reveal(host: &BrowserSurfaceHost, surface_id: &str) -> TestResponse {
        request(
            host,
            "POST",
            &format!("{BROWSER_SURFACE_PATH}/{surface_id}{REVEAL_SUFFIX}"),
            Some(host_token(host)),
            json!({}),
        )
    }

    #[test]
    fn reveal_reaches_the_leased_browser_and_reports_what_happened() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, _) = start_display_host(&temp, true);
        let isolated =
            acquire_with_policy(&host, "run-xvfb", "chase", false, private_xvfb_policy());
        let isolated: AcquireResponse = serde_json::from_slice(&isolated.body).expect("body");
        let refused = reveal(&host, &isolated.surface_id);
        assert_eq!(refused.status, 409, "an isolated display cannot be shown");
        assert_eq!(error_code(&refused), "browser_reveal_failed");

        // A browser on the inherited display is already on the desktop.
        let (legacy, _, _) = acquire_with_headless(&host, "github", false);
        assert_eq!(reveal(&host, &legacy).status, 204);
        assert_eq!(reveal(&host, "host-surface-unknown").status, 404);
    }

    #[test]
    fn a_display_whose_stop_fails_is_kept_and_retried_by_the_next_acquire() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        let first = acquire_with_policy(&host, "run-first", "chase", false, private_xvfb_policy());
        assert_eq!(first.status, 200);
        let first: AcquireResponse = serde_json::from_slice(&first.body).expect("body");
        log.stop_failures.store(1, Ordering::Release);
        release_surface(&host, &first.surface_id);
        assert_eq!(log.events(), vec!["start", "stop-failed"]);
        assert_eq!(
            host.state.browsers.lock().expect("browsers").len(),
            1,
            "an unconfirmed stop keeps the browser and its display"
        );

        let second =
            acquire_with_policy(&host, "run-second", "chase", false, private_xvfb_policy());
        assert_eq!(second.status, 200);
        assert_eq!(
            log.events(),
            vec!["start", "stop-failed", "stop", "start"],
            "the leftover display is stopped before the next launch"
        );
        assert_eq!(host.state.browsers.lock().expect("browsers").len(), 1);
    }

    #[test]
    fn display_failure_fails_the_launch_without_spawning_a_browser() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        log.fail_start.store(true, Ordering::Release);
        let response =
            acquire_with_policy(&host, "run-fail", "chase", false, private_xvfb_policy());
        assert_eq!(response.status, 500);
        assert_eq!(error_code(&response), BROWSER_DISPLAY_UNAVAILABLE);
        assert!(
            !profile_was_launched(&host, "chase"),
            "no fallback onto the desktop"
        );
        assert!(host.state.leases.lock().expect("leases").is_empty());

        // The host recovers once the display can start.
        log.fail_start.store(false, Ordering::Release);
        let response = acquire_with_policy(&host, "run-ok", "chase", false, private_xvfb_policy());
        assert_eq!(response.status, 200);
    }

    #[test]
    fn a_missing_display_backend_refuses_the_launch() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, _) = start_display_host(&temp, false);
        let response =
            acquire_with_policy(&host, "run-none", "chase", false, private_xvfb_policy());
        assert_eq!(response.status, 500);
        assert_eq!(error_code(&response), BROWSER_DISPLAY_UNAVAILABLE);
        assert!(!profile_was_launched(&host, "chase"));
    }

    #[test]
    fn a_browser_that_fails_after_its_display_started_stops_the_display() {
        let temp = tempfile::tempdir().expect("tempdir");
        let log = DisplayLog::default();
        let host = BrowserSurfaceHost::start_with_browser(
            temp.path().join("app-data"),
            None,
            Some(sandbox_blocked_browser(&temp)),
            DisplayProviders::default().with(Arc::new(FakeDisplayProvider(log.clone()))),
            Some(PresentationPolicy::PRIVATE_XVFB),
        )
        .expect("start test host");
        let response =
            acquire_with_policy(&host, "run-crash", "chase", false, private_xvfb_policy());
        assert_eq!(response.status, 500);
        assert_eq!(log.events(), vec!["start", "stop"]);
        assert!(host.state.browsers.lock().expect("browsers").is_empty());
    }

    #[test]
    fn invalid_or_unexecutable_policies_are_refused_before_spawn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        let mut wrong_version = private_xvfb_policy();
        wrong_version["version"] = json!(2);
        let mut hidden_desktop = private_xvfb_policy();
        hidden_desktop["display_backend"] = json!("inherited-host");
        let mut external = private_xvfb_policy();
        external["display_backend"] = json!("externally-owned");
        let cases = [
            (
                "bad-version",
                false,
                wrong_version,
                400,
                INVALID_PRESENTATION_POLICY,
            ),
            (
                "bad-combo",
                false,
                hidden_desktop,
                400,
                INVALID_PRESENTATION_POLICY,
            ),
            (
                "bad-shape",
                false,
                json!("private-xvfb"),
                400,
                INVALID_PRESENTATION_POLICY,
            ),
            // The legacy flag must agree with the policy's engine mode.
            (
                "conflict",
                true,
                private_xvfb_policy(),
                400,
                INVALID_PRESENTATION_POLICY,
            ),
            (
                "external",
                false,
                external,
                500,
                BROWSER_PRESENTATION_UNSUPPORTED,
            ),
        ];
        for (connector, headless, policy, status, code) in cases {
            let response = acquire_with_policy(&host, connector, connector, headless, policy);
            assert_eq!(response.status, status, "{connector}");
            assert_eq!(error_code(&response), code, "{connector}");
            assert!(
                !profile_was_launched(&host, connector),
                "{connector} spawned"
            );
        }
        assert!(
            log.events().is_empty(),
            "no display starts for a refused policy"
        );
    }

    #[test]
    fn a_retried_run_must_repeat_the_same_presentation_policy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        let first = acquire_with_policy(&host, "run-same", "chase", false, private_xvfb_policy());
        assert_eq!(first.status, 200);
        let retry = acquire_with_policy(&host, "run-same", "chase", false, private_xvfb_policy());
        assert_eq!(retry.status, 200);
        assert_eq!(first.body, retry.body, "a retry returns the same surface");
        let legacy =
            acquire_connection_for_run(&host, "run-other", "github", "cin-github", true, false);
        assert!(legacy.1.starts_with("http://127.0.0.1:"));
        let mismatch = request(
            &host,
            "POST",
            BROWSER_SURFACE_PATH,
            Some(host_token(&host)),
            json!({
                "run_id": "run-same",
                "connector_id": "chase",
                "connection_id": "cin-chase",
                "headless": false,
            }),
        );
        assert_eq!(mismatch.status, 500);
        assert_eq!(log.events(), vec!["start"], "only one display for one run");
    }

    #[test]
    fn a_legacy_request_without_a_policy_keeps_the_inherited_display() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (host, log) = start_display_host(&temp, true);
        let (surface_id, _, _) = acquire_with_headless(&host, "chase", false);
        assert!(log.events().is_empty(), "no display for a legacy request");
        let profile_dir = host
            .state
            .profile_dir("chase", "cin-chase", false)
            .expect("profile dir");
        let env = fs::read_to_string(profile_dir.join("env.txt")).expect("fake env");
        assert!(!env.contains("DISPLAY=:4242"));
        assert!(!env.contains("HOME=unset"));
        let args = fs::read_to_string(profile_dir.join("args.txt")).expect("fake args");
        assert!(!args.contains("--ozone-platform"));
        let lease_launch = host.state.leases.lock().expect("leases")[&surface_id]
            .response
            .launch
            .clone()
            .expect("launch report");
        assert_eq!(lease_launch.display_backend, "inherited-host");
        assert_eq!(lease_launch.observed_visibility, "unknown");
        assert_eq!(lease_launch.milestones_ms.display_ready, None);
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
