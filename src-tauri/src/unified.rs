// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The opt-in tray agent and authenticated console webview.
//!
//! The opt-in path owns the staged reference stack and the authenticated
//! console webview. Explicit RI/console URLs remain an attach-only development
//! escape hatch.

use crate::commands::process_supervisor::{
    EnvironmentSpec, EventSink, LifecycleState, ProcessLifecycleEvent, ProcessSpec, Readiness,
    RestartPolicy, StopPolicy, Supervisor, SupervisorError, SupervisorHandle,
};
use crate::commands::{
    attach_reference_server, login_reference_server_with_password,
    login_reference_server_with_password_and_host,
};
use crate::owner_credential::{
    configured_owner_password, credential_encryption_key_path, database_encryption_key_path,
    load_or_create_credential_encryption_key, load_or_create_database_encryption_key,
    load_or_create_owner_credential, owner_credential_path, DatabaseKeyError,
};
use crate::remote_access::{
    load_remote_access_config, off_remote_access_config, save_remote_access_config,
    CredentialReference, RemoteAccessConfig,
};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::Cookie;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

pub(crate) const CONSOLE_WINDOW_LABEL: &str = "console";
pub(crate) const RECOVERY_WINDOW_LABEL: &str = "recovery";
const TRAY_ICON_ID: &str = "dataconnect-tray";
const DEFAULT_CONSOLE_URL: &str = "http://localhost:3001";
const CONSOLE_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const CONSOLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const UNIFIED_PROFILE_ENV: &str = "TAURI_PROFILE";
const DEFAULT_PROFILE: &str = "release";
const RI_LABEL: &str = "reference-implementation";
const CONSOLE_LABEL: &str = "console";
const RI_HEALTH_PATH: &str = "/.well-known/oauth-protected-resource";
// pub(crate): src-tauri/src/remote_access.rs's `remote_access_config_path`
// also joins this directory, so the desktop supervisor and the reference
// server (which is given this same path as PDPP_DATA_DIR -- see
// `ri_environment` below) read and write the exact same remote-access.json.
pub(crate) const UNIFIED_DB_DIRECTORY: &str = "unified";
const UNIFIED_DB_FILE: &str = "pdpp.sqlite";
const CREDENTIAL_ENCRYPTION_KEY_ENV: &str = "PDPP_CREDENTIAL_ENCRYPTION_KEY";
const DATABASE_ENCRYPTION_KEY_ENV: &str = "PDPP_DATABASE_ENCRYPTION_KEY";
// Read by `inspectNgrok` in `reference-implementation/server/remote-access-config.ts`
// to tell a browser-reached self-hoster honestly that ngrok cannot activate
// without this supervisor's config watcher and native tunnel supervision. Set
// only when `remote_access_configuration_supported()` (see `ri_process_spec`)
// -- an attach-mode RI has no watcher and no supervisor-owned config file
// either, so it is exactly as unable to activate ngrok as a plain self-hosted
// deployment, and must report the same honest "unavailable" answer.
const MANAGED_DESKTOP_HOST_ENV: &str = "PDPP_MANAGED_DESKTOP_HOST";
const UNIFIED_SHUTDOWN_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum UnifiedStatus {
    #[default]
    Starting,
    Ready,
    Restarting,
    // Quitting is distinct from Stopped: Stopped is the terminal state after
    // shutdown finishes, Quitting covers the up-to-UNIFIED_SHUTDOWN_BUDGET
    // window while sidecars are still winding down. Without this the tray
    // silently freezes on whatever status it last had (usually "Ready")
    // for up to 10s after the window vanishes, which reads as a hang -- see
    // ai/research/desktop-app-packaging/quit-window-hide-vs-progress-indicator-2026.md
    // (NN/G: waits should show a progress indicator, not silence).
    Quitting,
    Stopped,
    Error,
    // Distinct from Error: this is the one startup failure with a real
    // owner-actionable next step (a dedicated recovery window is already
    // open waiting for a recovery code), so the tray should say so rather
    // than reuse the generic "something went wrong, nothing to do" label.
    NeedsRecovery,
}

impl UnifiedStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "Status: Starting",
            Self::Ready => "Status: Ready",
            Self::Restarting => "Status: Restarting",
            Self::Quitting => "Status: Quitting…",
            Self::Stopped => "Status: Stopped",
            Self::Error => "Status: Error",
            Self::NeedsRecovery => "Status: Needs recovery code",
        }
    }
}

#[derive(Default)]
struct UnifiedRuntimeState {
    status: Mutex<UnifiedStatus>,
    console_origin: Mutex<Option<String>>,
    /// The RI's own loopback origin from the last successful bootstrap --
    /// mirrors `console_origin`'s role, but for the RI's port. Needed
    /// because `HeldNgrok.forward_port` now tracks the CONSOLE's port (the
    /// tunnel's actual forward target -- see `start_ngrok_provider`'s doc
    /// comment), not the RI's, so the RI's own port-stability preference can
    /// no longer piggyback on the held tunnel's state the way it used to.
    ri_origin: Mutex<Option<String>>,
    session_cookie: Mutex<Option<String>>,
    sidecars_ready: Mutex<BTreeSet<String>>,
    stack: Mutex<Option<UnifiedStack>>,
    shutdown: Mutex<ShutdownState>,
    /// The live ngrok session, held OUTSIDE `stack` so a config-change
    /// restart (`restart_after_remote_access_config`, which tears down and
    /// rebuilds `stack` via `stop_stack`/`start_managed_stack`) does not drop
    /// it. On a FREE ngrok plan a new tunnel gets a new random hostname, so
    /// tearing this down on every restart the reference server needs (to
    /// pick up the previous restart's discovered origin) made the origin the
    /// owner just adopted stale before the console ever loaded it. See
    /// `reuse_or_start_ngrok_provider`.
    ngrok: Mutex<Option<HeldNgrok>>,
}

/// A live ngrok tunnel plus enough of its own configuration to tell whether
/// the NEXT `start_managed_stack` call can keep using it unchanged, or must
/// tear it down and start a new one.
struct HeldNgrok {
    provider:
        crate::remote_access_ngrok::NgrokProvider<crate::remote_access::KeychainCredentialResolver>,
    /// The loopback CONSOLE port this tunnel currently forwards to (not the
    /// RI's -- see `start_ngrok_provider`'s doc comment for why the console
    /// is the correct forward target). The console's port is re-allocated on
    /// every `Supervisor::start`, so reuse is only valid when the next
    /// console instance can be brought up on this SAME port (see
    /// `Supervisor::start_on_port`) -- otherwise the tunnel would keep
    /// forwarding to a port nothing is listening on anymore.
    forward_port: u16,
    /// Identifies the provider settings (endpoint mode, reserved domain) this
    /// tunnel was started with. A config change that alters either requires
    /// a fresh tunnel -- reuse is only correct when the owner's request is
    /// "restart the stack" (posture/provider/fields unrelated to the tunnel
    /// itself), not "change how the tunnel behaves".
    fingerprint: NgrokFingerprint,
    fields: crate::remote_access::ReachabilityFields,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NgrokFingerprint {
    endpoint_mode: crate::remote_access_providers::NgrokEndpointModeConfig,
    reserved_domain: Option<String>,
}

impl NgrokFingerprint {
    fn from_options(options: &crate::remote_access_providers::NgrokOptions) -> Self {
        Self {
            endpoint_mode: options.endpoint_mode,
            reserved_domain: options.reserved_domain.clone(),
        }
    }
}

#[derive(Default)]
struct ShutdownState {
    requested: bool,
    complete: bool,
}

struct UnifiedStack {
    ri: SupervisorHandle,
    console: SupervisorHandle,
    /// Unlike ngrok's `HeldNgrok` (held OUTSIDE `stack` in
    /// `UnifiedRuntimeState.ngrok` so a config-change restart can reuse it
    /// and avoid ngrok's free-tier random-hostname churn), a named
    /// Cloudflare tunnel has a STABLE, owner-configured hostname -- there is
    /// no churn to avoid by reusing the process across a restart, so it
    /// lives here instead and is torn down and restarted with the RI/console
    /// on every `start_managed_stack` call. Simpler, and equally correct:
    /// the origin never changes across that restart either way.
    cloudflare_tunnel: Option<
        crate::remote_access_cloudflare::CloudflareTunnelProvider<
            crate::remote_access::KeychainCredentialResolver,
        >,
    >,
}

impl UnifiedStack {
    fn stop(&mut self) -> Result<(), String> {
        self.stop_until(std::time::Instant::now() + UNIFIED_SHUTDOWN_BUDGET)
    }

    fn stop_until(&mut self, deadline: std::time::Instant) -> Result<(), String> {
        log::info!(
            "Unified sidecar shutdown started with a {:?} budget",
            UNIFIED_SHUTDOWN_BUDGET
        );
        let (console_error, ri_error) = std::thread::scope(|scope| {
            let console = scope.spawn(|| self.console.stop_until(deadline));
            let ri = scope.spawn(|| self.ri.stop_until(deadline));
            (
                console.join().unwrap_or_else(|_| {
                    Err(SupervisorError::Message(
                        "console stop thread panicked".to_string(),
                    ))
                }),
                ri.join().unwrap_or_else(|_| {
                    Err(SupervisorError::Message(
                        "RI stop thread panicked".to_string(),
                    ))
                }),
            )
        });
        if let Some(mut provider) = self.cloudflare_tunnel.take() {
            if let Err(error) =
                crate::remote_access::RemoteAccessProvider::stop(&mut provider)
            {
                log::error!("Failed to stop the Cloudflare tunnel: {error}");
            }
        }
        let console_error = console_error.err().map(|error| error.to_string());
        let ri_error = ri_error.err().map(|error| error.to_string());
        match (console_error, ri_error) {
            (None, None) => {
                log::info!("Unified sidecar shutdown completed");
                Ok(())
            }
            (Some(error), None) | (None, Some(error)) => Err(error),
            (Some(console), Some(ri)) => Err(format!(
                "console stop failed: {console}; RI stop failed: {ri}"
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrayAction {
    OpenConsole,
    OpenBrowser,
    ShowLogs,
    Quit,
    Unknown,
}

fn tray_action_for_menu_id(id: &str) -> TrayAction {
    match id {
        "open-console" => TrayAction::OpenConsole,
        "open-browser" => TrayAction::OpenBrowser,
        "show-logs" => TrayAction::ShowLogs,
        "quit" => TrayAction::Quit,
        _ => TrayAction::Unknown,
    }
}

/// Return the opt-in flag without treating any other value as enabled.
pub(crate) fn enabled_for_value(value: Option<&str>) -> bool {
    value == Some("1")
}

pub(crate) fn is_enabled() -> bool {
    enabled_for_value(std::env::var("DATACONNECT_UNIFIED_STACK").ok().as_deref())
}

pub(crate) fn remote_access_configuration_supported() -> bool {
    is_enabled() && !attach_mode()
}

fn browser_url_from_runtime_origin(console_origin: Option<&str>) -> Result<String, String> {
    console_origin
        .filter(|origin| !origin.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Console is not ready".to_string())
}

fn browser_console_url(app: &AppHandle) -> Result<String, String> {
    let runtime_origin = {
        let state = app
            .try_state::<UnifiedRuntimeState>()
            .ok_or_else(|| "Unified runtime state is unavailable".to_string())?;
        let console_origin = state
            .console_origin
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())?
            .clone();
        console_origin
    };
    if runtime_origin.is_some() {
        return browser_url_from_runtime_origin(runtime_origin.as_deref());
    }
    if attach_mode() {
        return configured_console_url();
    }
    browser_url_from_runtime_origin(None)
}

/// Parse the loopback port out of a previously bootstrapped origin
/// (`http://127.0.0.1:{port}`), so the NEXT `start_managed_stack` call can
/// ask `Supervisor::start_on_port` to reuse it for either sidecar --
/// `read_preferred_console_port` and `read_preferred_ri_port` are thin
/// wrappers over this for `UnifiedRuntimeState.console_origin`/`ri_origin`
/// respectively.
///
/// Confirmed live, 2026-09-19, for the console specifically: without this,
/// the console supervisor always called plain `Supervisor::start()` (no
/// preferred port), so a dev-domain owner's config-change restart (adopting
/// the discovered origin) silently moved the console from one random port to
/// another (43667 -> 44863). Any browser tab or bookmark pointed at the old
/// port broke with "refused to connect", and since the previous window was
/// tied to the old origin, no window reappeared automatically -- the owner
/// had to reopen from the tray. `None` (never bootstrapped yet, or the
/// stored origin does not parse) lets `start_on_port` fall back to its
/// normal fresh-allocation behavior.
///
/// The RI needed the identical fix for a different reason, confirmed live,
/// 2026-09-20: before `start_ngrok_provider` retargeted the tunnel to the
/// console's port, the RI's own port stability piggybacked on
/// `HeldNgrok.forward_port` (then still named `ri_port`) purely because that
/// field happened to hold the RI's port -- an accidental coupling, not a
/// deliberate mechanism, that broke the moment the tunnel's actual forward
/// target changed. `ri_origin` in `UnifiedRuntimeState` now gives the RI the
/// same independent, origin-based stability the console already has, rather
/// than the RI's port stability depending on an ngrok tunnel existing at
/// all.
fn preferred_port_from_origin(origin: Option<&str>) -> Option<u16> {
    origin
        .and_then(|origin| origin.parse::<tauri::Url>().ok())
        .and_then(|url| url.port())
}

fn read_preferred_console_port(app: &AppHandle) -> Option<u16> {
    let state = app.try_state::<UnifiedRuntimeState>()?;
    let console_origin = state.console_origin.lock().ok()?.clone();
    preferred_port_from_origin(console_origin.as_deref())
}

fn read_preferred_ri_port(app: &AppHandle) -> Option<u16> {
    let state = app.try_state::<UnifiedRuntimeState>()?;
    let ri_origin = state.ri_origin.lock().ok()?.clone();
    preferred_port_from_origin(ri_origin.as_deref())
}

fn configured_console_url() -> Result<String, String> {
    let raw = std::env::var("DATACONNECT_CONSOLE_URL")
        .unwrap_or_else(|_| DEFAULT_CONSOLE_URL.to_string());
    let mut url: tauri::Url = raw
        .parse()
        .map_err(|error| format!("Invalid DATACONNECT_CONSOLE_URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("DATACONNECT_CONSOLE_URL must be an http(s) URL with a host".to_string());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn build_tray_menu<M, R>(manager: &M, status: UnifiedStatus) -> tauri::Result<Menu<R>>
where
    M: Manager<R>,
    R: Runtime,
{
    let quitting = status == UnifiedStatus::Quitting;
    let status_item = MenuItem::with_id(manager, "status", status.label(), false, None::<&str>)?;
    let open_console = MenuItem::with_id(
        manager,
        "open-console",
        "Open DataConnect",
        !quitting,
        None::<&str>,
    )?;
    let open_browser = MenuItem::with_id(
        manager,
        "open-browser",
        "Open in browser",
        status == UnifiedStatus::Ready,
        None::<&str>,
    )?;
    let show_logs = MenuItem::with_id(manager, "show-logs", "Show logs", true, None::<&str>)?;
    // Disabled (not hidden) while quitting: a visible-but-inert "Quit" is
    // the field-observed pattern for "your quit request already landed,
    // there's nothing more to click" (Docker Desktop's tray shows a
    // disabled/greyed state during its own "stopping" phase) -- see
    // ai/research/desktop-app-packaging/quit-window-hide-vs-progress-indicator-2026.md.
    // A second click while disabled is a no-op, not a second concurrent
    // shutdown, because request_shutdown (lib.rs/unified.rs) is idempotent.
    let quit = MenuItem::with_id(manager, "quit", "Quit", !quitting, None::<&str>)?;
    Menu::with_items(
        manager,
        &[
            &status_item,
            &open_console,
            &open_browser,
            &show_logs,
            &quit,
        ],
    )
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(UnifiedRuntimeState::default());
    let menu = build_tray_menu(app, UnifiedStatus::Starting)?;
    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .menu(&menu)
        .tooltip("DataConnect")
        .on_menu_event(handle_tray_menu_event);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }
    tray_builder.build(app)?;

    if let Some(main_window) = app.get_webview_window("main") {
        main_window.hide()?;
    }

    // Seed the in-memory closeToTray cache once, synchronously, at startup
    // -- before any window can receive a CloseRequested event -- so the
    // window-event loop (which owns titlebar hit-testing/redraw) never has
    // to do a blocking config-file read. See
    // ai/research/desktop-app-packaging/tauri-linux-unresponsive-titlebar-is-a-tao-wayland-csd-overlay-bug-not-a-blocked-main-thread-2026.md.
    crate::commands::init_close_to_tray_cache();

    // Read once, synchronously, before spawning: this is the one bootstrap
    // call that represents "the app just launched", which is the only time
    // the start-minimized preference should suppress the initial show().
    // Every other caller of bootstrap_and_open_console (focus_or_bootstrap,
    // reached from the tray "Open console" item or single-instance
    // re-focus) is a user explicitly asking to see the window, so it always
    // passes should_show = true regardless of this preference.
    let should_show = !crate::commands::read_start_minimized_preference();
    let app_handle = app.handle().clone();
    spawn_remote_access_config_watcher(app_handle.clone());
    spawn_autostart_watcher(app_handle.clone());
    crate::commands::recovery_key::spawn_recovery_export_watcher(app_handle.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(failure) = bootstrap_and_open_console(app_handle.clone(), should_show).await {
            handle_bootstrap_failure(&app_handle, "Unified DataConnect startup", failure);
        }
    });
    Ok(())
}

pub(crate) fn focus_or_bootstrap(app: AppHandle) {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(failure) = bootstrap_and_open_console(app.clone(), true).await {
            handle_bootstrap_failure(&app, "Opening the DataConnect console", failure);
        }
    });
}

/// Shared reaction to a `bootstrap_and_open_console` failure for both of its
/// callers above: a plain error just flips the tray to "Error" (unchanged
/// behavior), but `NeedsRecovery` additionally opens the dedicated recovery
/// window so the owner has an actionable next step instead of a silent tray
/// label change.
fn handle_bootstrap_failure(app: &AppHandle, context: &str, failure: BootstrapFailure) {
    match failure {
        BootstrapFailure::NeedsRecovery => {
            log::error!(
                "{context} failed: database encryption key is missing while an encrypted vault exists"
            );
            set_status(app, UnifiedStatus::NeedsRecovery);
            open_recovery_window(app);
        }
        BootstrapFailure::Other(error) => {
            log::error!("{context} failed: {error}");
            set_status(app, UnifiedStatus::Error);
        }
    }
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match tray_action_for_menu_id(event.id().as_ref()) {
        TrayAction::OpenConsole => focus_or_bootstrap(app.clone()),
        TrayAction::OpenBrowser => match browser_console_url(app) {
            Ok(url) => {
                if let Err(error) = open::that_detached(url) {
                    log::error!("Failed to open console in the browser: {error}");
                    set_status(app, UnifiedStatus::Error);
                }
            }
            Err(error) => {
                log::error!("Failed to resolve console URL: {error}");
                set_status(app, UnifiedStatus::Error);
            }
        },
        TrayAction::ShowLogs => {
            if let Err(error) = open_log_file(app) {
                log::error!("Failed to open DataConnect logs: {error}");
                set_status(app, UnifiedStatus::Error);
            }
        }
        TrayAction::Quit => {
            log::info!("Unified tray quit requested; deferring shutdown to exit handler");
            app.exit(0);
        }
        TrayAction::Unknown => {}
    }
}

pub(crate) fn attach_mode() -> bool {
    ["DATACONNECT_RI_URL", "DATACONNECT_CONSOLE_URL"]
        .into_iter()
        .any(|name| {
            std::env::var(name)
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
        })
}

fn unified_profile() -> String {
    let fallback = || {
        if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            DEFAULT_PROFILE.to_string()
        }
    };
    std::env::var(UNIFIED_PROFILE_ENV)
        .ok()
        .filter(|profile| is_valid_profile(profile))
        .unwrap_or_else(fallback)
}

fn is_valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn resolve_staged_root(resource_dir: &Path, profile: &str, sidecar: &str) -> Option<PathBuf> {
    [
        resource_dir.join("reference-stack").join(sidecar),
        resource_dir
            .join("_up_")
            .join("reference-stack")
            .join(sidecar),
        resource_dir
            .join(profile)
            .join("reference-stack")
            .join(sidecar),
        resource_dir
            .join("_up_")
            .join(profile)
            .join("reference-stack")
            .join(sidecar),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(profile)
            .join("reference-stack")
            .join(sidecar),
    ]
    .into_iter()
    .find(|root| root.join("launch.mjs").is_file())
}

fn resolve_node_binary(resource_dir: &Path) -> Option<PathBuf> {
    let binary_roots = [
        resource_dir.join("binaries"),
        resource_dir.join("_up_").join("binaries"),
        resource_dir.to_path_buf(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"),
    ];
    for root in binary_roots {
        for name in ["pdpp-node", "pdpp-node.exe"] {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let mut sidecars = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate.is_file()
                    && candidate
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with("pdpp-node-") && !name.ends_with("-LICENSE")
                        })
            })
            .collect::<Vec<_>>();
        sidecars.sort();
        if let Some(sidecar) = sidecars.into_iter().next() {
            return Some(sidecar);
        }
    }
    None
}

fn env_map(entries: Vec<(OsString, OsString)>) -> BTreeMap<OsString, OsString> {
    entries.into_iter().collect()
}

fn add_browser_host_environment(app: &AppHandle, env: &mut BTreeMap<OsString, OsString>) {
    if let Some(pairs) = crate::commands::browser_surface_host_env_pairs(app) {
        env.extend(
            pairs
                .into_iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value))),
        );
    }
}

fn ri_process_spec(
    app: &AppHandle,
    node_binary: &Path,
    root: &Path,
    data_dir: &Path,
    owner_password: &str,
    credential_encryption_key: &str,
    database_encryption_key: &str,
    remote_access: &RemoteAccessConfig,
) -> ProcessSpec {
    let mut env = ri_environment(
        data_dir,
        owner_password,
        credential_encryption_key,
        database_encryption_key,
    );
    env.extend(remote_access.fields.environment());
    add_browser_host_environment(app, &mut env);
    ProcessSpec {
        label: RI_LABEL.to_string(),
        program: node_binary.to_path_buf(),
        args: vec![root.join("launch.mjs").into_os_string()],
        cwd: Some(root.to_path_buf()),
        env: EnvironmentSpec::cleared(env),
        readiness: Readiness::HttpGet {
            url_from_port: format!("http://127.0.0.1:{{port+1}}{RI_HEALTH_PATH}"),
            deadline: CONSOLE_WAIT_TIMEOUT,
            host_header: ri_readiness_host_header(&remote_access.fields.trusted_hosts),
        },
        restart: RestartPolicy::Bounded {
            max: 3,
            backoff: Duration::from_millis(500),
        },
        process_group: true,
        stop: StopPolicy {
            grace: Duration::from_secs(5),
            escalate: Duration::from_secs(3),
            total: Duration::from_secs(8),
        },
        // AS/RS stay internal (never a reverse-proxy target), so they always
        // use dynamic loopback allocation.
        requested_port: None,
    }
}

/// Once a public origin is configured, the RI's own reachability contract
/// (`reachability-contract.ts::isAllowedRequestHost`) rejects any request
/// whose `Host` header isn't in `PDPP_TRUSTED_HOSTS` -- correctly, since an
/// untrusted `Host` on a loopback connection is indistinguishable from a
/// DNS-rebound attacker request and that check exists specifically to catch
/// it. But this process's OWN readiness probe of the RI it just spawned is
/// also a loopback connection with an untrusted `Host` (`127.0.0.1`) by
/// default, so without this override the probe fails every attempt
/// post-restart and the whole stack cannot come back up after ngrok assigns
/// an origin. Presenting the trusted host here is not a security exemption
/// -- it's telling the probe to identify itself the way every other trusted
/// caller already must. `None` while `trusted_hosts` is empty (posture off,
/// or the first start before ngrok has discovered an origin) sends whatever
/// the URL's own `127.0.0.1` authority implies, which is what an ungated RI
/// expects.
fn ri_readiness_host_header(trusted_hosts: &str) -> Option<String> {
    let trimmed = trusted_hosts.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn ri_environment(
    data_dir: &Path,
    owner_password: &str,
    credential_encryption_key: &str,
    database_encryption_key: &str,
) -> BTreeMap<OsString, OsString> {
    let mut env = env_map(vec![
        (OsString::from("AS_PORT"), OsString::from("{port}")),
        (OsString::from("RS_PORT"), OsString::from("{port+1}")),
        (
            OsString::from("PDPP_DB_PATH"),
            data_dir.join(UNIFIED_DB_FILE).into_os_string(),
        ),
        (
            OsString::from("PDPP_DATA_DIR"),
            data_dir.as_os_str().to_os_string(),
        ),
        (
            OsString::from("PDPP_OWNER_PASSWORD"),
            OsString::from(owner_password),
        ),
        (
            OsString::from(CREDENTIAL_ENCRYPTION_KEY_ENV),
            OsString::from(credential_encryption_key),
        ),
        (
            OsString::from(DATABASE_ENCRYPTION_KEY_ENV),
            OsString::from(database_encryption_key),
        ),
        (
            OsString::from("PDPP_BIND_HOST"),
            OsString::from("127.0.0.1"),
        ),
        (
            OsString::from("PDPP_EMBEDDING_DOWNLOAD_ALLOWED"),
            OsString::from("0"),
        ),
        (
            OsString::from("PATCHRIGHT_SKIP_BROWSER_DOWNLOAD"),
            OsString::from("1"),
        ),
        (
            OsString::from("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"),
            OsString::from("1"),
        ),
    ]);
    if remote_access_configuration_supported() {
        env.insert(
            OsString::from(MANAGED_DESKTOP_HOST_ENV),
            OsString::from("1"),
        );
    }
    env
}

fn console_process_spec(
    node_binary: &Path,
    root: &Path,
    ri_origin: &str,
    rs_origin: &str,
    owner_password: &str,
    remote_access: &RemoteAccessConfig,
) -> ProcessSpec {
    let mut env = env_map(vec![
        (OsString::from("NODE_ENV"), OsString::from("production")),
        (OsString::from("HOSTNAME"), OsString::from("127.0.0.1")),
        (OsString::from("PORT"), OsString::from("{port}")),
        (OsString::from("PDPP_AS_URL"), OsString::from(ri_origin)),
        (OsString::from("PDPP_RS_URL"), OsString::from(rs_origin)),
        (
            OsString::from("PDPP_OWNER_PASSWORD"),
            OsString::from(owner_password),
        ),
    ]);
    env.extend(remote_access.fields.environment());
    ProcessSpec {
        label: CONSOLE_LABEL.to_string(),
        program: node_binary.to_path_buf(),
        args: vec![root.join("launch.mjs").into_os_string()],
        cwd: Some(root.to_path_buf()),
        env: EnvironmentSpec::cleared(env),
        readiness: Readiness::HttpGet {
            url_from_port: "http://127.0.0.1:{port}/".to_string(),
            deadline: CONSOLE_WAIT_TIMEOUT,
            host_header: None,
        },
        restart: RestartPolicy::Bounded {
            max: 3,
            backoff: Duration::from_millis(500),
        },
        process_group: true,
        stop: StopPolicy {
            grace: Duration::from_secs(5),
            escalate: Duration::from_secs(3),
            total: Duration::from_secs(8),
        },
        // The console is the one surface a "proxy you run" points at (it
        // fronts AS/RS internally) -- see RemoteAccessConfig::console_port's
        // doc comment. RI keeps its dynamic AS/RS allocation; only this spec
        // ever receives a pin.
        requested_port: remote_access.console_port,
    }
}

#[derive(Clone)]
struct UnifiedEventSink {
    app: AppHandle,
}

impl EventSink for UnifiedEventSink {
    fn emit(&self, event: ProcessLifecycleEvent) {
        if let Err(error) = self.app.emit("process-supervisor", event.clone()) {
            log::warn!("Failed to emit process supervisor event: {error}");
        }
        let label = event.label.clone();
        let lifecycle = event.state.clone();
        let Some(state) = self.app.try_state::<UnifiedRuntimeState>() else {
            return;
        };
        let should_be_ready = if let Ok(mut ready) = state.sidecars_ready.lock() {
            match lifecycle.clone() {
                LifecycleState::Ready => {
                    ready.insert(label.clone());
                }
                LifecycleState::Starting
                | LifecycleState::Exited { .. }
                | LifecycleState::Restarting
                | LifecycleState::Stopped => {
                    ready.remove(&label);
                }
            }
            ready.contains(RI_LABEL) && ready.contains(CONSOLE_LABEL)
        } else {
            false
        };
        let authenticated = state
            .session_cookie
            .lock()
            .ok()
            .is_some_and(|cookie| cookie.is_some());
        match lifecycle {
            LifecycleState::Restarting | LifecycleState::Exited { .. } => {
                set_status(&self.app, UnifiedStatus::Restarting)
            }
            LifecycleState::Ready if should_be_ready && authenticated => {
                set_status(&self.app, UnifiedStatus::Ready)
            }
            LifecycleState::Stopped => set_status(&self.app, UnifiedStatus::Stopped),
            _ => {}
        }
    }
}

struct ManagedStackStart {
    stack: UnifiedStack,
    ngrok: Option<HeldNgrok>,
    ri_origin: String,
    console_url: String,
}

fn start_managed_stack(
    app: &AppHandle,
    owner_password: &str,
    credential_encryption_key: &str,
    database_encryption_key: &str,
    remote_access: &RemoteAccessConfig,
    held_ngrok: Option<HeldNgrok>,
) -> Result<ManagedStackStart, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve DataConnect resource directory: {error}"))?;
    let profile = unified_profile();
    let ri_root = resolve_staged_root(&resource_dir, &profile, "ri").ok_or_else(|| {
        format!(
            "Staged RI root not found under {:?} for profile {profile}",
            resource_dir
        )
    })?;
    let console_root =
        resolve_staged_root(&resource_dir, &profile, "console").ok_or_else(|| {
            format!(
                "Staged console root not found under {:?} for profile {profile}",
                resource_dir
            )
        })?;
    let node_binary = resolve_node_binary(&resource_dir).ok_or_else(|| {
        format!(
            "Bundled pdpp-node not found under resource directory {:?}",
            resource_dir
        )
    })?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))?
        .join(UNIFIED_DB_DIRECTORY);
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Failed to create unified data directory: {error}"))?;

    let sink = UnifiedEventSink { app: app.clone() };
    // Reuse the RI's previous loopback port across a stack-level restart,
    // the same way `preferred_console_port` below keeps the console's port
    // stable -- see `preferred_port_from_origin`'s doc comment for why the
    // RI now needs this same independent mechanism rather than piggybacking
    // on the held ngrok tunnel's state. The console's env bakes in
    // `PDPP_AS_URL`/`PDPP_RS_URL` pointing at wherever the RI lands, so a
    // moved RI port would break the console's own proxy even though the
    // tunnel's forward target (the console's port) is unaffected by it.
    let preferred_ri_port = read_preferred_ri_port(app);
    let ri = Supervisor::new(
        ri_process_spec(
            app,
            &node_binary,
            &ri_root,
            &data_dir,
            owner_password,
            credential_encryption_key,
            database_encryption_key,
            remote_access,
        ),
        sink.clone(),
    )
    .start_on_port(preferred_ri_port)
    .map_err(|error| format!("Failed to start staged RI: {error}"))?;
    let ri_origin = format!("http://127.0.0.1:{}", ri.port());
    let rs_origin = format!("http://127.0.0.1:{}", ri.port().saturating_add(1));

    // The console starts BEFORE the tunnel, unlike the RI, because the
    // tunnel must forward to the CONSOLE's port -- see `start_ngrok_provider`'s
    // doc comment for why a tunnel forwarding to the bare RI left a remote
    // visitor stuck on the RI's own JSON discovery index with no way to
    // reach the console UI (confirmed live, 2026-09-20). The console's own
    // env here still carries `remote_access`'s ORIGINAL fields (pre-tunnel-
    // outcome), same as the RI always has: if this run starts a fresh
    // tunnel, the discovered origin is not baked into this boot's console
    // process, but `apply_ngrok_tunnel_outcome` below persists it and the
    // existing remote-access config watcher restarts the whole stack with
    // the real origin applied to both RI and console on the NEXT cycle --
    // exactly the same one-restart-to-settle shape the RI has always used,
    // now shared by the console instead of the console being privileged
    // with same-boot knowledge the RI never had.
    let preferred_console_port = read_preferred_console_port(app);
    let console = Supervisor::new(
        console_process_spec(
            &node_binary,
            &console_root,
            &ri_origin,
            &rs_origin,
            owner_password,
            remote_access,
        ),
        sink.clone(),
    )
    .start_on_port(preferred_console_port)
    .map_err(|error| format!("Failed to start staged console: {error}"))?;
    let console_url = format!("http://127.0.0.1:{}", console.port());

    // A tunnel failure (for example `ERR_NGROK_312`, TLS endpoints on ngrok's
    // free plan) must NOT abort the stack: the owner still needs a working
    // console to see the failure and change providers, and both sidecars are
    // already listening on loopback regardless of whether a public origin
    // exists. So this is a `match`, not a `?` -- the error is captured and
    // carried into the same config the console reads, rather than
    // propagated to `bootstrap_and_open_console`.
    let (ngrok, tunnel_error, applied_fields) =
        match reuse_or_start_ngrok_provider(remote_access, held_ngrok, console.port()) {
            Ok(Some((fields, provider, fingerprint))) => {
                let held = HeldNgrok {
                    provider,
                    forward_port: console.port(),
                    fingerprint,
                    fields: fields.clone(),
                };
                (Some(held), None, Some(fields))
            }
            Ok(None) => (None, None, None),
            Err(error) => {
                log::error!("ngrok tunnel failed to start: {error}");
                (None, Some(error), None)
            }
        };
    if let Some(fields) = applied_fields {
        apply_ngrok_tunnel_outcome(app, &fields, None);
    } else if let Some(error) = tunnel_error.as_deref() {
        apply_ngrok_tunnel_outcome(app, &remote_access.fields, Some(error));
    }

    // Cloudflare's named-tunnel hostname is stable and owner-configured
    // (unlike ngrok's free-tier random hostname), so there is nothing to
    // reuse across a restart the way `reuse_or_start_ngrok_provider` reuses
    // a held tunnel -- `start_cloudflare_tunnel_provider` always starts
    // fresh, forwarding to the CONSOLE's port (same target the ngrok tunnel
    // above forwards to, for the same reason: a tunnel forwarding to the
    // bare RI leaves a remote visitor stuck on the RI's JSON discovery
    // index). A tunnel failure (missing `cloudflared` binary, bad token)
    // must not abort the stack either, for the same reason ngrok's failure
    // doesn't: the owner still needs a working console to see the failure
    // and fix it. If BOTH ngrok and Cloudflare somehow produced a
    // `tunnel_error` (should not happen -- only one provider is selected at
    // a time), the Cloudflare message wins because it is applied second;
    // this is a defensive ordering choice, not a claim that this can
    // currently occur.
    let (cloudflare_tunnel, tunnel_error, applied_fields) =
        match start_cloudflare_tunnel_provider(remote_access, console.port()) {
            Ok(Some((fields, provider))) => (Some(provider), None, Some(fields)),
            Ok(None) => (None, None, None),
            Err(error) => {
                log::error!("Cloudflare tunnel failed to start: {error}");
                (None, Some(error), None)
            }
        };
    if let Some(fields) = applied_fields {
        apply_ngrok_tunnel_outcome(app, &fields, None);
    } else if let Some(error) = tunnel_error.as_deref() {
        apply_ngrok_tunnel_outcome(app, &remote_access.fields, Some(error));
    }

    Ok(ManagedStackStart {
        stack: UnifiedStack {
            ri,
            console,
            cloudflare_tunnel,
        },
        ngrok,
        ri_origin,
        console_url,
    })
}

/// Resolve the ngrok options `remote_access` currently selects, or `None` if
/// ngrok is not the selected provider/posture. Split out from starting the
/// tunnel so `reuse_or_start_ngrok_provider` can compute the desired
/// `NgrokFingerprint` before deciding whether a held tunnel is still valid,
/// without starting anything.
fn resolve_ngrok_options(
    remote_access: &RemoteAccessConfig,
) -> Result<Option<crate::remote_access_providers::NgrokOptions>, String> {
    use crate::remote_access::RemoteAccessPosture;
    use crate::remote_access_ngrok::NGROK_PROVIDER_ID;
    use crate::remote_access_providers::{resolve_public_url_provider, PublicUrlProvider};

    if remote_access.provider.as_deref() != Some(NGROK_PROVIDER_ID) {
        return Ok(None);
    }
    if !matches!(remote_access.posture, RemoteAccessPosture::PublicUrl) {
        return Ok(None);
    }
    let PublicUrlProvider::Ngrok(options) = resolve_public_url_provider(
        &remote_access.posture,
        remote_access.provider.as_deref(),
        remote_access.ngrok.as_ref(),
        remote_access.cloudflare_tunnel.as_ref(),
    )?
    else {
        return Ok(None);
    };
    Ok(Some(options))
}

/// Start a brand-new ngrok tunnel forwarding to `forward_port`, when
/// `remote_access` selects the ngrok provider. `Ok(None)` for every other
/// provider -- not an error, just "no tunnel to start".
///
/// `forward_port` is the CONSOLE's loopback port, not the RI's. Confirmed
/// live, 2026-09-20: this tunnel used to forward to the bare RI, whose own
/// root page is a JSON discovery index (`{"links":{"connectors":"/v1/connectors"...}`),
/// not a usable UI -- and that RI page's own "console origin" text pointed
/// right back at the tunnel's own public URL, a dead end with no way to
/// reach the actual console. The console is the correct forward target
/// because it already proxies every API surface the RI/RS expose under its
/// own origin (`apps/console/src/app/v1/[...path]/route.ts` and its
/// siblings for `owner`/`device`/`consent`/`oauth`/`mcp`/etc., all via
/// `reference-proxy.ts`) -- so a remote owner gets a working UI on the bare
/// origin, and any API client hitting `/v1/*` (or any other proxied path)
/// still reaches the RS exactly as before, just one hop further through the
/// console's own proxy route instead of landing on the RI directly.
///
/// The authtoken is read back out of the OS keychain
/// (`KeychainCredentialResolver`), never carried in `remote_access` itself:
/// `owner-remote-access.ts`'s POST handler only ever seals it into
/// `ngrok_authtoken_sealed`, and `apply_pending_ngrok_authtoken` (the config
/// watcher) is the only thing that ever decrypts it, storing the plaintext
/// in the keychain and nothing else. If no credential is stored yet (the
/// owner just submitted one and the watcher hasn't caught up, or submitted
/// none at all), this fails with a clear error instead of starting sidecars
/// nothing outside this device can reach.
fn start_ngrok_provider(
    remote_access: &RemoteAccessConfig,
    forward_port: u16,
) -> Result<
    Option<(
        crate::remote_access::ReachabilityFields,
        crate::remote_access_ngrok::NgrokProvider<crate::remote_access::KeychainCredentialResolver>,
        NgrokFingerprint,
    )>,
    String,
> {
    use crate::remote_access::{
        CancellationToken, CredentialReference, CredentialResolver, KeychainCredentialResolver,
        LoopbackTarget, RemoteAccessContractConfig, RemoteAccessPosture, RemoteAccessProvider,
    };
    use crate::remote_access_ngrok::{NgrokProvider, NGROK_PROVIDER_ID};

    let Some(options) = resolve_ngrok_options(remote_access)? else {
        return Ok(None);
    };
    let fingerprint = NgrokFingerprint::from_options(&options);

    let resolver = KeychainCredentialResolver;
    let credential = resolver
        .resolve(NGROK_PROVIDER_ID)
        .map_err(|error| format!("Could not read the ngrok authtoken from the keychain: {error}"))?
        .ok_or_else(|| {
            "ngrok is configured but no authtoken is stored yet. Submit one from Settings."
                .to_string()
        })?;

    let mut provider = NgrokProvider::with_reserved_domain(
        RemoteAccessContractConfig {
            provider_id: NGROK_PROVIDER_ID.to_string(),
            posture: RemoteAccessPosture::PublicUrl,
            user_supplied_origin: None,
            credential_reference: match &credential {
                CredentialReference::Stored(token) => Some(token.clone()),
                CredentialReference::NotRequired => None,
            },
        },
        resolver,
        options.endpoint_mode.into(),
        options.reserved_domain.clone(),
    )?;

    let handle = provider.start(
        LoopbackTarget {
            host: "127.0.0.1".to_string(),
            port: forward_port,
        },
        credential,
        CancellationToken::new(),
    )?;
    let fields = NgrokProvider::<KeychainCredentialResolver>::reachability_fields(&handle.origin)?;
    log::info!("ngrok tunnel is up at {}", handle.origin);
    Ok(Some((fields, provider, fingerprint)))
}

/// Start a Cloudflare named tunnel forwarding to `forward_port` (the
/// console's port -- see the tunnel-forwards-to-the-console comment in
/// `start_managed_stack`), when `remote_access` selects the Cloudflare
/// tunnel provider. `Ok(None)` for
/// every other provider -- not an error, just "no tunnel to start". Mirrors
/// `start_ngrok_provider` above; the one structural difference is there is
/// no fingerprint/reuse concept here (see `UnifiedStack::cloudflare_tunnel`'s
/// doc comment for why a named tunnel's stable, owner-configured hostname
/// makes that optimization unnecessary).
fn start_cloudflare_tunnel_provider(
    remote_access: &RemoteAccessConfig,
    forward_port: u16,
) -> Result<
    Option<(
        crate::remote_access::ReachabilityFields,
        crate::remote_access_cloudflare::CloudflareTunnelProvider<
            crate::remote_access::KeychainCredentialResolver,
        >,
    )>,
    String,
> {
    use crate::remote_access::{
        CancellationToken, CredentialReference, CredentialResolver, KeychainCredentialResolver,
        LoopbackTarget, RemoteAccessContractConfig, RemoteAccessPosture, RemoteAccessProvider,
    };
    use crate::remote_access_cloudflare::{CloudflareTunnelProvider, CLOUDFLARE_TUNNEL_PROVIDER_ID};
    use crate::remote_access_providers::{resolve_public_url_provider, PublicUrlProvider};

    if remote_access.provider.as_deref() != Some(CLOUDFLARE_TUNNEL_PROVIDER_ID) {
        return Ok(None);
    }
    if !matches!(remote_access.posture, RemoteAccessPosture::PublicUrl) {
        return Ok(None);
    }
    let PublicUrlProvider::CloudflareTunnel(options) = resolve_public_url_provider(
        &remote_access.posture,
        remote_access.provider.as_deref(),
        remote_access.ngrok.as_ref(),
        remote_access.cloudflare_tunnel.as_ref(),
    )?
    else {
        return Ok(None);
    };

    let resolver = KeychainCredentialResolver;
    let credential = resolver
        .resolve(CLOUDFLARE_TUNNEL_PROVIDER_ID)
        .map_err(|error| {
            format!("Could not read the Cloudflare tunnel token from the keychain: {error}")
        })?
        .ok_or_else(|| {
            "Cloudflare tunnel is configured but no token is stored yet. Submit one from Settings."
                .to_string()
        })?;

    let mut provider = CloudflareTunnelProvider::new(
        RemoteAccessContractConfig {
            provider_id: CLOUDFLARE_TUNNEL_PROVIDER_ID.to_string(),
            posture: RemoteAccessPosture::PublicUrl,
            user_supplied_origin: None,
            credential_reference: match &credential {
                CredentialReference::Stored(token) => Some(token.clone()),
                CredentialReference::NotRequired => None,
            },
        },
        resolver,
        options.hostname.clone(),
    )?;

    let handle = provider.start(
        LoopbackTarget {
            host: "127.0.0.1".to_string(),
            port: forward_port,
        },
        credential,
        CancellationToken::new(),
    )?;
    let fields = CloudflareTunnelProvider::<KeychainCredentialResolver>::reachability_fields(
        &options.hostname,
    )?;
    log::info!("Cloudflare tunnel is up at {}", handle.origin);
    Ok(Some((fields, provider)))
}

/// Pure reuse decision, split out from `reuse_or_start_ngrok_provider` so it
/// is unit-testable without a real `NgrokProvider` (which needs a live
/// network session to construct meaningfully). `None` for either side means
/// "no tunnel" -- posture off, provider not ngrok, or nothing held yet.
///
/// Reuse requires ALL of:
/// - `remote_access` still selects ngrok, with the SAME endpoint mode and
///   reserved domain the held tunnel was started with (a different mode or
///   domain changes what the tunnel itself must do, which nothing short of a
///   new tunnel can apply).
/// - The console was brought up on the SAME loopback port the held tunnel
///   already forwards to (see `Supervisor::start_on_port` in
///   `start_managed_stack`) -- otherwise the tunnel would keep forwarding to
///   a port nothing is listening on.
fn should_reuse_ngrok_tunnel(
    held_fingerprint: Option<&NgrokFingerprint>,
    held_forward_port: Option<u16>,
    desired_fingerprint: Option<&NgrokFingerprint>,
    forward_port: u16,
) -> bool {
    match (held_fingerprint, held_forward_port, desired_fingerprint) {
        (Some(held), Some(held_port), Some(desired)) => held == desired && held_port == forward_port,
        _ => false,
    }
}

/// How long to wait for the held tunnel's own public origin to answer before
/// concluding it is dead. Short: this runs synchronously on the bootstrap
/// path before the console can open, and a live tunnel answers in well
/// under a second -- this only needs to be long enough to not misclassify a
/// slow-but-live edge as dead.
const NGROK_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// ngrok's edge sets this response header on ITS OWN synthetic error pages
/// (for example `ERR_NGROK_3200`, "endpoint is offline") -- it is never
/// forwarded through from the local origin. Its presence, or the request
/// failing outright, is the signal that the held tunnel's ngrok-side session
/// has died even though nothing in this process observed that (see
/// `probe_ngrok_tunnel_is_live`'s doc comment for why an in-process check
/// alone cannot catch this).
const NGROK_ERROR_CODE_HEADER: &str = "ngrok-error-code";

/// ngrok shows a one-time browser interstitial ("You are about to visit...")
/// to any request whose `User-Agent` looks like a browser, on the free plan
/// -- by design, not a bug (see the ngrok option copy in `remote-access.ts`
/// for the owner-facing note about this). A request FROM this app to its own
/// public origin (the liveness probe below) is not a real visitor and must
/// never be shown that page: an interstitial response still returns 200 with
/// no `ngrok-error-code` header, so without this the probe would misread a
/// live-but-warned tunnel as dead. This exact header, sent on any request,
/// makes ngrok's edge skip the interstitial and forward straight through.
const NGROK_SKIP_BROWSER_WARNING_HEADER: &str = "ngrok-skip-browser-warning";
const NGROK_SKIP_BROWSER_WARNING_VALUE: &str = "true";

/// Confirm a held ngrok tunnel is still actually reachable from the public
/// internet before trusting it enough to reuse, by making one real request
/// to its own discovered origin.
///
/// This is necessary, not merely cautious: reproduced live tonight against a
/// real ngrok tunnel, the ngrok Rust SDK's `Forwarder` gives no reliable
/// in-process signal that the edge-side session has died. Its background
/// forwarding task only exits when the local tunnel stream itself closes
/// (`NgrokTunnel::is_forwarding_finished`, used by `NgrokProvider::health`),
/// but an edge session that silently drops -- observed here across a
/// sidecar restart cycle -- leaves that task running forever, so `health()`
/// keeps reporting the tunnel as connected while every public request to it
/// returns ngrok's own `ERR_NGROK_3200` "endpoint is offline" page. A
/// simultaneous loopback request to the exact same RI, presenting the exact
/// same trusted Host, still returned 200 the whole time -- proving the RI
/// and the fix in `isAllowedRequestHost` are correct, and the failure is
/// entirely in the held tunnel's dead ngrok-side session. Only an actual
/// round trip through ngrok's edge can catch this.
fn probe_ngrok_tunnel_is_live(origin: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(NGROK_LIVENESS_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("Could not build a client to probe the held ngrok tunnel: {error}");
            return false;
        }
    };
    match client
        .get(origin)
        .header(NGROK_SKIP_BROWSER_WARNING_HEADER, NGROK_SKIP_BROWSER_WARNING_VALUE)
        .send()
    {
        Ok(response) => !response.headers().contains_key(NGROK_ERROR_CODE_HEADER),
        Err(error) => {
            log::warn!("Held ngrok tunnel liveness probe failed: {error}");
            false
        }
    }
}

/// Decide whether a held ngrok tunnel from a previous run can be reused for
/// this `start_managed_stack` call (see `should_reuse_ngrok_tunnel`), or
/// start a fresh one via `start_ngrok_provider` -- accepting a new random
/// hostname on ngrok's free plan, which is unavoidable whenever the tunnel
/// itself must actually change (no held tunnel, provider/posture turned off,
/// settings changed, the preferred forward port could not be reused, or the
/// held tunnel's ngrok-side session has silently died -- see
/// `probe_ngrok_tunnel_is_live`).
fn reuse_or_start_ngrok_provider(
    remote_access: &RemoteAccessConfig,
    held: Option<HeldNgrok>,
    forward_port: u16,
) -> Result<
    Option<(
        crate::remote_access::ReachabilityFields,
        crate::remote_access_ngrok::NgrokProvider<crate::remote_access::KeychainCredentialResolver>,
        NgrokFingerprint,
    )>,
    String,
> {
    let desired_fingerprint = resolve_ngrok_options(remote_access)?
        .as_ref()
        .map(NgrokFingerprint::from_options);

    let reuse_candidate = should_reuse_ngrok_tunnel(
        held.as_ref().map(|held| &held.fingerprint),
        held.as_ref().map(|held| held.forward_port),
        desired_fingerprint.as_ref(),
        forward_port,
    );

    let reuse = reuse_candidate
        && held.as_ref().is_some_and(|held| {
            held.fields
                .reference_origin
                .as_deref()
                .is_some_and(probe_ngrok_tunnel_is_live)
        });

    if reuse {
        let held = held.expect("reuse is only true when held is Some");
        log::info!(
            "Reusing the existing ngrok tunnel at {:?}; forward port {forward_port} is unchanged and the tunnel answered live",
            held.fields.reference_origin
        );
        return Ok(Some((held.fields, held.provider, held.fingerprint)));
    }

    if let Some(mut held) = held {
        if reuse_candidate {
            log::warn!(
                "Held ngrok tunnel at {:?} is unreachable from the public internet; starting a fresh tunnel instead of reusing it",
                held.fields.reference_origin
            );
        } else {
            log::info!("ngrok settings or the forward port changed; starting a fresh tunnel");
        }
        if let Err(error) = crate::remote_access::RemoteAccessProvider::stop(&mut held.provider) {
            log::error!("Failed to stop the previous ngrok tunnel before replacing it: {error}");
        }
    }
    start_ngrok_provider(remote_access, forward_port)
}

/// Persist the outcome of this run's ngrok start attempt -- either the
/// discovered origin (`tunnel_error: None`) or the failure message
/// (`fields` unchanged, `tunnel_error: Some(..)`) -- so the console can read
/// it from the same `RemoteAccessConfig` it already polls, instead of an
/// error that only ever reached the app log.
///
/// The origin half: the NEXT stack restart needs it to start the RI itself
/// with the correct `PDPP_REFERENCE_ORIGIN` / `PDPP_TRUSTED_HOSTS` --
/// required because the RI (unlike the console, which gets the discovered
/// fields for THIS run directly in `start_managed_stack`) already started
/// with empty fields before the tunnel's origin was known (see
/// `start_managed_stack`'s ordering comment) and enforces its allowed-host
/// contract from env parsed once at its own startup
/// (`reachability-contract.ts`). A FRESH ngrok origin on every restart (the
/// free-tier random-hostname case) will still cause one restart per session
/// start, which is inherent to ngrok's free tier, not something this
/// function can fix -- a reserved domain (paid plan) keeps the origin stable
/// across restarts and settles after exactly one.
///
/// The error half: cleared (`None`) as soon as a start succeeds, and written
/// whenever the failure message changes from the last persisted one --
/// including from `None`, so the first failure in a session always writes.
/// A repeat of the SAME message is still a no-op, same as the origin case,
/// so a config-watcher restart that hits the identical failure again
/// (for example TLS passthrough is still on the free plan) does not loop:
/// it costs exactly one extra restart cycle to settle, not a retry storm --
/// the watcher's `current == last_applied` check in
/// `spawn_remote_access_config_watcher` only sees a difference for the
/// restart that FIRST writes the message, not the one after.
fn apply_ngrok_tunnel_outcome(
    app: &AppHandle,
    fields: &crate::remote_access::ReachabilityFields,
    tunnel_error: Option<&str>,
) {
    let current = match load_remote_access_config(app) {
        Ok(config) => config,
        Err(error) => {
            log::error!("Could not read the remote-access config to persist the ngrok tunnel outcome: {error}");
            return;
        }
    };
    let tunnel_error = tunnel_error.map(str::to_string);
    if &current.fields == fields && current.tunnel_error == tunnel_error {
        return;
    }
    let updated = RemoteAccessConfig {
        fields: fields.clone(),
        tunnel_error,
        ..current
    };
    if let Err(error) = save_remote_access_config(app, updated) {
        log::error!("Could not persist the ngrok tunnel outcome: {error}");
    }
}

fn store_stack(app: &AppHandle, stack: UnifiedStack) -> Result<(), String> {
    let state = app.state::<UnifiedRuntimeState>();
    let mut stored = state
        .stack
        .lock()
        .map_err(|_| "Unified runtime state is poisoned".to_string())?;
    if stored.is_some() {
        return Err("Unified sidecars are already running".to_string());
    }
    *stored = Some(stack);
    Ok(())
}

fn take_stack(app: &AppHandle) -> Result<Option<UnifiedStack>, String> {
    let state = app.state::<UnifiedRuntimeState>();
    state
        .stack
        .lock()
        .map_err(|_| "Unified runtime state is poisoned".to_string())
        .map(|mut stack| stack.take())
}

fn take_held_ngrok<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Option<HeldNgrok>, String> {
    let state = app.state::<UnifiedRuntimeState>();
    state
        .ngrok
        .lock()
        .map_err(|_| "Unified runtime state is poisoned".to_string())
        .map(|mut held| held.take())
}

fn store_held_ngrok(app: &AppHandle, held: HeldNgrok) -> Result<(), String> {
    let state = app.state::<UnifiedRuntimeState>();
    *state
        .ngrok
        .lock()
        .map_err(|_| "Unified runtime state is poisoned".to_string())? = Some(held);
    Ok(())
}

/// Stop and drop any held ngrok tunnel. Only called where the tunnel is
/// actually meant to go away: full app shutdown, startup-error cleanup, and
/// a config-change restart whose new settings require a different tunnel
/// (see `reuse_or_start_ngrok_provider`). A config-change restart that keeps
/// the same provider settings must NOT call this -- that is the whole point
/// of holding the tunnel outside `UnifiedStack`.
fn stop_held_ngrok<R: tauri::Runtime>(app: &AppHandle<R>) {
    match take_held_ngrok(app) {
        Ok(Some(mut held)) => {
            if let Err(error) = crate::remote_access::RemoteAccessProvider::stop(&mut held.provider)
            {
                log::error!("Failed to stop the ngrok tunnel: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => log::error!("Could not read the held ngrok tunnel to stop it: {error}"),
    }
}

/// Why a teardown is happening.
///
/// Teardown used to be five near-identical functions, each of which decided
/// for itself what to spare. The thing they actually differed on was one
/// question -- does the ngrok tunnel survive? -- and that question is a
/// property of the REASON, not of the call site. Naming the reason makes the
/// answer a table (`StopReason::stops_tunnel`) that can be read and tested
/// exhaustively, instead of a decision re-made by hand at every caller.
///
/// The tunnel's lifetime is deliberately longer than the sidecars': it is
/// held outside `UnifiedStack` (see `UnifiedRuntimeState::ngrok`) so a
/// restart can reuse it, because a free-plan tunnel gets a NEW random
/// hostname every time it is restarted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopReason {
    /// The owner changed remote-access settings, so the sidecars must be
    /// rebuilt with new env. The tunnel is unaffected by this and is the
    /// expensive thing to lose, so it survives for
    /// `reuse_or_start_ngrok_provider` to pick back up.
    ConfigChange,
    /// Bootstrap failed at a step DOWNSTREAM of the tunnel (login, console
    /// readiness, cookie, window creation). Confirmed live, 2026-09-19: such
    /// a failure says nothing about whether the tunnel is healthy, and a
    /// tunnel that just proved itself live is exactly the one the liveness
    /// probe is designed to reuse -- so it survives.
    BootstrapFailed,
    /// A vault/database-key attempt failed. Unlike `BootstrapFailed`, any
    /// tunnel here was started fresh during this very attempt and has not
    /// been adopted by anything, so nothing should survive.
    VaultKeyRejected,
    /// The app is quitting. Nothing survives.
    AppQuit,
}

impl StopReason {
    /// The whole former five-function fork, as data: does the held ngrok
    /// tunnel go away for this reason?
    fn stops_tunnel(self) -> bool {
        match self {
            StopReason::ConfigChange | StopReason::BootstrapFailed => false,
            StopReason::VaultKeyRejected | StopReason::AppQuit => true,
        }
    }
}

/// The one teardown path. Stops the RI and console, and stops the held ngrok
/// tunnel only when `reason` says it should.
///
/// Replaces `stop_stack_and_ngrok`, `stop_stack_keep_ngrok`,
/// `cleanup_managed_stack_on_error` and
/// `cleanup_managed_stack_on_error_keep_ngrok`.
fn teardown(app: &AppHandle, reason: StopReason) -> Result<(), String> {
    let stack = take_stack(app)?;
    teardown_stack(app, reason, stack, None)
}

/// `teardown` for a stack the caller already holds, optionally bounded by a
/// deadline.
///
/// The app-quit path takes the stack itself before spawning (it has to wait
/// for a stack that startup may still be constructing) and must finish inside
/// `UNIFIED_SHUTDOWN_BUDGET`, so it cannot call `teardown` directly. It used
/// to inline its own copy of stop-sidecars-then-stop-tunnel, which made app
/// quit a SIXTH teardown implementation that no `StopReason` covered. Sharing
/// this function keeps the tunnel decision in one place for every reason.
///
/// Generic over the Tauri runtime so tests can drive it with
/// `tauri::test::mock_app()`. Without this the only way to check teardown in
/// a unit test is to re-implement it, and a test that re-implements the
/// logic it checks cannot fail when that logic breaks.
fn teardown_stack<R: tauri::Runtime>(
    app: &AppHandle<R>,
    reason: StopReason,
    stack: Option<UnifiedStack>,
    deadline: Option<std::time::Instant>,
) -> Result<(), String> {
    let result = stack.map_or(Ok(()), |mut stack| match deadline {
        Some(deadline) => stack.stop_until(deadline),
        None => stack.stop(),
    });
    if reason.stops_tunnel() {
        stop_held_ngrok(app);
    }
    result
}

/// `teardown` for the startup-error paths, which are no-ops when the stack
/// is not ours to stop (attach mode) and which log rather than propagate.
fn teardown_managed_on_error(app: &AppHandle, managed: bool, reason: StopReason) {
    if managed {
        if let Err(error) = teardown(app, reason) {
            log::error!("Failed to clean up unified sidecars after startup error: {error}");
        }
    }
}

fn mark_shutdown_complete(app: &AppHandle) {
    if let Ok(mut shutdown) = app.state::<UnifiedRuntimeState>().shutdown.lock() {
        shutdown.complete = true;
    } else {
        log::error!("Unified shutdown state was poisoned before completion");
    }
}

enum ShutdownRequest {
    Start,
    Pending,
    Complete,
}

fn startup_is_in_progress(app: &AppHandle) -> bool {
    app.state::<UnifiedRuntimeState>()
        .status
        .lock()
        .map(|status| *status == UnifiedStatus::Starting)
        .unwrap_or(false)
}

fn begin_background_shutdown(app: &AppHandle, initial_stack: Option<UnifiedStack>, exit_code: i32) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + UNIFIED_SHUTDOWN_BUDGET;
        let stack = initial_stack.or_else(|| {
            while std::time::Instant::now() < deadline && startup_is_in_progress(&app) {
                if let Ok(Some(stack)) = take_stack(&app) {
                    return Some(stack);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            take_stack(&app).ok().flatten()
        });

        let result = teardown_stack(&app, StopReason::AppQuit, stack, Some(deadline));
        match result {
            Ok(()) => log::info!("Unified shutdown finished within its budget"),
            Err(error) => log::error!("Unified shutdown finished with errors: {error}"),
        }
        set_status(&app, UnifiedStatus::Stopped);
        mark_shutdown_complete(&app);
        log::info!("Unified app exit is now allowed");
        app.exit(exit_code);
    });
}

/// Hide every visible webview window immediately.
///
/// Tauri's `ExitRequested` handler calls `prevent_exit()` while the sidecar
/// stack winds down in the background (up to `UNIFIED_SHUTDOWN_BUDGET`), so
/// the OS process keeps running for that whole window. Without this, the
/// window(s) stay on screen — visible but unresponsive to close — for the
/// full shutdown budget, which reads as a hang even though nothing is
/// actually stuck. Hiding here is a UI-perception fix only: it does not
/// touch the SIGTERM/SIGKILL escalation or shutdown budget in
/// `process_supervisor.rs`, which still run to completion in the
/// background.
///
/// This is this app's own design choice, not a copy of an industry norm —
/// researched prior art was mixed/negative on "hide immediately, clean up
/// silently" as a general pattern (Docker Desktop shows a visible blocking
/// "Turning off the Docker Engine" screen on quit; VS Code's extension-host
/// shutdown is a documented *visible* hang, not a hide-first design; NN/G's
/// guidance for 8-10s waits is to show a progress indicator, not hide the
/// UI). What does apply here: this app keeps a tray icon after the window
/// disappears, so hiding reads as "gone to tray", the same mental model
/// Electron's `before-quit`/`will-quit` cleanup idiom and Signal Desktop's
/// close-to-tray handler both rely on (hide first, then the process does
/// its own async teardown). See
/// ai/research/desktop-app-packaging/quit-window-hide-vs-progress-indicator-2026.md
/// for the full sourced findings and why this repo departs from the NN/G
/// default recommendation.
fn hide_all_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if let Err(error) = window.hide() {
            log::warn!("Failed to hide window '{label}' during shutdown: {error}");
        }
    }
}

pub(crate) fn request_shutdown(app: &AppHandle, exit_code: i32) -> bool {
    let state = app.state::<UnifiedRuntimeState>();
    let request = state
        .shutdown
        .lock()
        .map(|mut shutdown| {
            if shutdown.complete {
                return ShutdownRequest::Complete;
            }
            if shutdown.requested {
                return ShutdownRequest::Pending;
            }
            shutdown.requested = true;
            ShutdownRequest::Start
        })
        .unwrap_or(ShutdownRequest::Pending);
    match request {
        ShutdownRequest::Complete => return false,
        ShutdownRequest::Pending => return true,
        ShutdownRequest::Start => {}
    }

    // Hide immediately so the app disappears from the user's perspective
    // right away, even though the background stop below can still take up
    // to UNIFIED_SHUTDOWN_BUDGET to finish (see hide_all_windows doc comment).
    hide_all_windows(app);

    log::info!("Unified shutdown requested; stopping managed sidecars asynchronously");
    let initial_stack = take_stack(app).ok().flatten();
    if initial_stack.is_none() && !startup_is_in_progress(app) {
        log::info!("No managed unified sidecars are running; allowing app exit");
        mark_shutdown_complete(app);
        return false;
    }

    // Set after the early-return above: that path exits immediately with
    // nothing to wait on, so there is nothing for a "Quitting…" status to
    // usefully describe. Only the real up-to-UNIFIED_SHUTDOWN_BUDGET wait
    // below gets the indicator.
    set_status(app, UnifiedStatus::Quitting);
    begin_background_shutdown(app, initial_stack, exit_code);
    true
}

/// Exit-time diagnostic. Despite its former name (`cleanup`) this tears
/// nothing down -- it only asserts that the asynchronous shutdown started by
/// `request_shutdown` actually finished before the process exited.
pub(crate) fn assert_stack_released_at_exit(app: &AppHandle) {
    let stack_still_registered = app
        .state::<UnifiedRuntimeState>()
        .stack
        .lock()
        .map(|stack| stack.is_some())
        .unwrap_or(true);
    if stack_still_registered {
        log::error!("Unified exit reached before asynchronous sidecar shutdown completed");
    }
}

fn open_log_file(app: &AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve DataConnect log directory: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create DataConnect log directory: {error}"))?;
    let log_file = log_dir.join("DataConnect.log");
    if !log_file.exists() {
        fs::File::create(&log_file)
            .map_err(|error| format!("Failed to create DataConnect log file: {error}"))?;
    }
    open::that_detached(log_file).map_err(|error| format!("Failed to open log file: {error}"))
}

/// Resolve the unified SQLite database path -- the same
/// `<app-data-dir>/unified/pdpp.sqlite` path every one of `ri_environment`,
/// `start_managed_stack`, and `load_bootstrap_secrets` needs, pulled into one
/// place so the recovery-key command/watcher (`commands/recovery_key.rs`) can
/// resolve it identically without re-deriving the join by hand.
pub(crate) fn unified_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))?
        .join(UNIFIED_DB_DIRECTORY)
        .join(UNIFIED_DB_FILE))
}

/// Local secrets/config the sidecars need before they can start: the owner
/// password plus (when managed, not attach mode) the database and
/// credential encryption keys and the remote-access config. Loaded together
/// because every one of them is a synchronous OS keychain (D-Bus
/// secret-service on Linux) or filesystem call -- see
/// owner_credential.rs::load_or_create_owner_credential and its
/// load_or_create_*_encryption_key siblings, all backed by SystemKeyring.
struct BootstrapSecrets {
    password: String,
    remote_access: RemoteAccessConfig,
    credential_encryption_key: Option<String>,
    database_encryption_key: Option<String>,
}

/// Load `BootstrapSecrets` synchronously. Must run inside spawn_blocking:
/// every call here can block on a D-Bus round trip to the OS keychain
/// (gnome-keyring/kwallet via the `keyring` crate's secret-service backend)
/// or on disk I/O, none of which should run inline on a Tokio worker thread
/// borrowed from the shared async runtime.
///
/// Returns `DatabaseKeyError` (not a plain `String`) specifically so the one
/// caller below can distinguish "the database key is missing while an
/// encrypted vault exists" -- which should open the recovery window -- from
/// every other bootstrap failure, which should not.
fn load_bootstrap_secrets(
    app: &AppHandle,
    attach_mode: bool,
) -> Result<BootstrapSecrets, DatabaseKeyError> {
    let credential_path =
        owner_credential_path(app).map_err(DatabaseKeyError::Other)?;
    let stored_credential =
        load_or_create_owner_credential(&credential_path).map_err(DatabaseKeyError::Other)?;
    let password = configured_owner_password().unwrap_or(stored_credential);
    let remote_access = if attach_mode {
        off_remote_access_config()
    } else {
        load_remote_access_config(app).map_err(DatabaseKeyError::Other)?
    };

    let (credential_encryption_key, database_encryption_key) = if attach_mode {
        (None, None)
    } else {
        let credential_encryption_key_path =
            credential_encryption_key_path(app).map_err(DatabaseKeyError::Other)?;
        let database_encryption_key_path =
            database_encryption_key_path(app).map_err(DatabaseKeyError::Other)?;
        let database_path = unified_database_path(app).map_err(DatabaseKeyError::Other)?;
        let database_encryption_key = load_or_create_database_encryption_key(
            &database_encryption_key_path,
            &database_path,
        )?;
        (
            Some(
                load_or_create_credential_encryption_key(
                    &credential_encryption_key_path,
                    &database_path,
                )
                .map_err(DatabaseKeyError::Other)?,
            ),
            Some(database_encryption_key),
        )
    };

    Ok(BootstrapSecrets {
        password,
        remote_access,
        credential_encryption_key,
        database_encryption_key,
    })
}

/// Bootstrap failure shapes `bootstrap_and_open_console` needs to react to
/// differently: `NeedsRecovery` opens the dedicated recovery window instead
/// of just flipping the tray to an inert "Error" state, because this one
/// failure has a real owner-actionable next step (import a recovery code)
/// that no other bootstrap failure has.
enum BootstrapFailure {
    NeedsRecovery,
    Other(String),
}

impl From<DatabaseKeyError> for BootstrapFailure {
    fn from(error: DatabaseKeyError) -> Self {
        match error {
            DatabaseKeyError::Missing(_) => Self::NeedsRecovery,
            DatabaseKeyError::Other(message) => Self::Other(message),
        }
    }
}

impl From<String> for BootstrapFailure {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

async fn bootstrap_and_open_console(app: AppHandle, should_show: bool) -> Result<(), BootstrapFailure> {
    set_status(&app, UnifiedStatus::Starting);

    let attach = attach_mode();
    let secrets_app = app.clone();
    let BootstrapSecrets {
        password,
        remote_access,
        credential_encryption_key,
        database_encryption_key,
    } = tokio::task::spawn_blocking(move || load_bootstrap_secrets(&secrets_app, attach))
        .await
        .map_err(|error| BootstrapFailure::Other(format!("Bootstrap secrets task failed: {error}")))?
        .map_err(BootstrapFailure::from)?;

    let (ri_origin, console_url, managed) = if attach_mode() {
        let reference_status = attach_reference_server(app.clone()).await?;
        let ri_origin = reference_status
            .origin
            .ok_or_else(|| "Reference server reported ready without an origin".to_string())?;
        (ri_origin, configured_console_url()?, false)
    } else {
        let password_for_sidecar = password.clone();
        let credential_encryption_key_for_sidecar =
            credential_encryption_key.clone().ok_or_else(|| {
                "Unified RI credential encryption key was not provisioned".to_string()
            })?;
        let database_encryption_key_for_sidecar = database_encryption_key
            .clone()
            .ok_or_else(|| "Unified RI database encryption key was not provisioned".to_string())?;
        let app_for_sidecars = app.clone();
        let remote_access_for_sidecars = remote_access.clone();
        let held_ngrok = take_held_ngrok(&app)?;
        let result = tokio::task::spawn_blocking(move || {
            start_managed_stack(
                &app_for_sidecars,
                &password_for_sidecar,
                &credential_encryption_key_for_sidecar,
                &database_encryption_key_for_sidecar,
                &remote_access_for_sidecars,
                held_ngrok,
            )
        })
        .await
        .map_err(|error| format!("Unified sidecar startup task failed: {error}"))??;
        let ri_origin = result.ri_origin.clone();
        let console_url = result.console_url.clone();
        store_stack(&app, result.stack)?;
        if let Some(ngrok) = result.ngrok {
            store_held_ngrok(&app, ngrok)?;
        }
        (ri_origin, console_url, true)
    };

    finish_bootstrap(
        &app,
        &password,
        ri_origin,
        console_url,
        managed,
        should_show,
        &remote_access.fields.trusted_hosts,
    )
    .await
    .map_err(BootstrapFailure::from)
}

/// The shared tail of bootstrap once an RI origin and console URL exist,
/// regardless of whether they came from the normal managed-stack/attach path
/// above or from the recovery window's `import_database_encryption_recovery_code`
/// command retrying `start_managed_stack` with a just-verified candidate key.
/// Owner login, console readiness, session cookie, runtime state, and the
/// console window itself all happen here exactly once so the two callers
/// can't drift.
///
/// `trusted_hosts` mirrors `ri_readiness_host_header`'s contract: once a
/// public origin is configured, the reference server's own login route
/// enforces the same trusted-Host allowlist its readiness probe does, so
/// this login call -- also dialed over loopback -- must present a Host the
/// server already trusts. Empty (posture off, or no origin discovered yet)
/// sends whatever the URL's own authority implies, same as before.
///
/// Every failure branch below tears down with `StopReason::BootstrapFailed`,
/// which spares the tunnel: by this point in bootstrap the RI/console
/// sidecars (and any ngrok tunnel) already started, so a failure here --
/// login, console readiness, window creation -- is downstream of the tunnel
/// and says nothing about whether the tunnel itself is healthy. See
/// `StopReason`'s doc comment for the live incident this fixes.
async fn finish_bootstrap(
    app: &AppHandle,
    password: &str,
    ri_origin: String,
    console_url: String,
    managed: bool,
    should_show: bool,
    trusted_hosts: &str,
) -> Result<(), String> {
    let host_header = ri_readiness_host_header(trusted_hosts);
    let ri_origin_for_state = ri_origin.clone();
    let login = match login_reference_server_with_password_and_host(
        ri_origin,
        password,
        host_header.as_deref(),
    )
    .await
    {
        Ok(login) => login,
        Err(error) => {
            teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
            return Err(error);
        }
    };

    if let Err(error) = wait_for_console(&console_url).await {
        teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
        return Err(error);
    }
    let console_origin = console_url
        .parse()
        .map_err(|error| format!("Invalid console URL: {error}"));
    let console_origin = match console_origin {
        Ok(origin) => origin,
        Err(error) => {
            teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
            return Err(error);
        }
    };
    let cookie = match owner_session_cookie(&console_origin, &login.session_cookie) {
        Ok(cookie) => cookie,
        Err(error) => {
            teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
            return Err(error);
        }
    };

    let state_update = (|| -> Result<(), String> {
        let state = app.state::<UnifiedRuntimeState>();
        *state
            .console_origin
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? = Some(console_url);
        *state
            .ri_origin
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? =
            Some(ri_origin_for_state);
        *state
            .session_cookie
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? =
            Some(login.session_cookie);
        Ok(())
    })();
    if let Err(error) = state_update {
        teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
        return Err(error);
    }

    if let Err(error) = create_or_update_console_window(app, console_origin, cookie, should_show) {
        teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
        return Err(error);
    }
    set_status(app, UnifiedStatus::Ready);
    close_recovery_window(app);
    Ok(())
}

/// Recovery-window command: verify a candidate recovery code by actually
/// starting the managed stack with it (Rust cannot decrypt/verify a
/// SQLCipher file itself -- only `assertDatabaseKey` in
/// `reference-implementation/server/sqlite-encryption.ts`, on the Node side,
/// can), then either finish bootstrapping normally or leave the recovery
/// window open with a clear rejection.
///
/// Never logs `code` or the decoded candidate key -- only the pass/fail
/// outcome and generic stage names.
#[tauri::command]
pub(crate) async fn import_database_encryption_recovery_code(
    app: AppHandle,
    code: String,
) -> Result<(), String> {
    let candidate_key = crate::recovery_code::decode(&code).map_err(|error| {
        log::info!("Recovery import: rejected at decode stage ({error})");
        "That code is not a valid recovery code. Check for a typo and try again.".to_string()
    })?;

    let secrets_app = app.clone();
    let attach = attach_mode();
    let secrets = tokio::task::spawn_blocking(move || load_bootstrap_secrets(&secrets_app, attach))
        .await
        .map_err(|error| format!("Bootstrap secrets task failed: {error}"))?;
    // Only the database key was missing (that's the precondition for this
    // command being reachable at all -- the recovery window only opens on
    // DatabaseKeyError::Missing). Owner password, remote-access config, and
    // the credential encryption key must already have loaded successfully;
    // load_bootstrap_secrets fails all-or-nothing per encryption key, so a
    // fresh Missing here (keychain still down) or an unrelated Other error
    // both need to surface rather than be silently retried.
    let (password, remote_access, credential_encryption_key) = match secrets {
        Ok(secrets) => (
            secrets.password,
            secrets.remote_access,
            secrets.credential_encryption_key.ok_or_else(|| {
                "Credential encryption key was not provisioned; cannot attempt recovery.".to_string()
            })?,
        ),
        Err(DatabaseKeyError::Missing(_)) => {
            // Try the candidate anyway with what we CAN load independently:
            // owner password and remote-access config never depended on the
            // database key, and the credential encryption key is derived
            // the same missing-secret-safe way -- if IT also can't load,
            // that's a different, unrelated failure this command should not
            // paper over.
            let secrets_app = app.clone();
            let owner_password = tokio::task::spawn_blocking(move || {
                owner_credential_path(&secrets_app)
                    .and_then(|path| load_or_create_owner_credential(&path))
            })
            .await
            .map_err(|error| format!("Owner password task failed: {error}"))??;
            let remote_access = if attach_mode() {
                off_remote_access_config()
            } else {
                load_remote_access_config(&app)?
            };
            let credential_key_app = app.clone();
            let credential_encryption_key = tokio::task::spawn_blocking(move || {
                let credential_encryption_key_path =
                    credential_encryption_key_path(&credential_key_app)?;
                let database_path = unified_database_path(&credential_key_app)?;
                load_or_create_credential_encryption_key(
                    &credential_encryption_key_path,
                    &database_path,
                )
            })
            .await
            .map_err(|error| format!("Credential encryption key task failed: {error}"))??;
            (
                configured_owner_password().unwrap_or(owner_password),
                remote_access,
                credential_encryption_key,
            )
        }
        Err(DatabaseKeyError::Other(message)) => return Err(message),
    };

    let app_for_attempt = app.clone();
    let password_for_attempt = password.clone();
    let remote_access_for_attempt = remote_access.clone();
    let candidate_key_for_attempt = candidate_key.clone();
    let attempt = tokio::task::spawn_blocking(move || {
        // No held ngrok tunnel to reuse here: this command only runs after
        // the initial bootstrap attempt already failed on a missing database
        // key, and that failure's teardown (`StopReason::VaultKeyRejected`)
        // already tore down anything that was running, including any tunnel.
        // This is a fresh start, not a config-change restart.
        start_managed_stack(
            &app_for_attempt,
            &password_for_attempt,
            &credential_encryption_key,
            &candidate_key_for_attempt,
            &remote_access_for_attempt,
            None,
        )
    })
    .await
    .map_err(|error| format!("Recovery attempt task failed: {error}"))?;

    let result = match attempt {
        Ok(started) => {
            store_stack(&app, started.stack)?;
            if let Some(ngrok) = started.ngrok {
                store_held_ngrok(&app, ngrok)?;
            }
            log::info!("Recovery import: candidate code started the managed stack successfully");
            Ok((started.ri_origin, started.console_url))
        }
        Err(error) => {
            log::info!("Recovery import: candidate code failed to start the managed stack");
            Err(error)
        }
    };

    let (ri_origin, console_url) = match result {
        Ok(value) => value,
        Err(_) => {
            // start_managed_stack failing partway through can leave one
            // sidecar up and the other not -- e.g. the RI itself refused to
            // open the vault (assertDatabaseKey threw). stop_stack's
            // take_stack is a safe no-op when nothing was ever stored (the
            // Err branch above never calls store_stack), so this is safe to
            // call unconditionally: it is exactly what every other bootstrap
            // failure path in this file already does.
            teardown_managed_on_error(&app, true, StopReason::VaultKeyRejected);
            return Err(
                "That code did not open your vault. Check for a typo and try again.".to_string(),
            );
        }
    };

    // The candidate key actually opened the vault: it is safe to trust and
    // persist now, before finishing the rest of bootstrap (which can itself
    // still fail for unrelated reasons -- login, console readiness -- but
    // the key having worked is independent of those).
    if let Err(error) = crate::owner_credential::save_database_encryption_key(&app, &candidate_key)
    {
        log::error!("Recovery import: verified key could not be persisted to the OS keychain: {error}");
        teardown_managed_on_error(&app, true, StopReason::VaultKeyRejected);
        return Err(format!(
            "The code worked, but the key could not be saved for future launches: {error}"
        ));
    }

    finish_bootstrap(
        &app,
        &password,
        ri_origin,
        console_url,
        true,
        true,
        &remote_access.fields.trusted_hosts,
    )
    .await
}

pub(crate) async fn restart_after_remote_access_config(app: AppHandle) -> Result<(), String> {
    if !remote_access_configuration_supported() {
        return Err("Remote access requires the managed desktop stack".into());
    }
    set_status(&app, UnifiedStatus::Restarting);
    tokio::task::spawn_blocking({
        let app = app.clone();
        move || teardown(&app, StopReason::ConfigChange)
    })
    .await
    .map_err(|error| format!("Remote-access shutdown task failed: {error}"))??;
    // A restart after a config change is always user-initiated from a
    // visible settings surface, so the console must reappear regardless of
    // the start-minimized preference (that preference only governs the
    // very first launch of the app).
    //
    // A NeedsRecovery failure here is surfaced the same way every other
    // bootstrap failure from this call site always has been (as a returned
    // error string for the watcher to log) rather than opening the recovery
    // window directly -- restarting after a remote-access config change is
    // not the moment to also introduce new recovery-window UI; the tray
    // status still reaches NeedsRecovery on the NEXT natural bootstrap
    // attempt (app relaunch or "Open console"), which does open it.
    bootstrap_and_open_console(app, true)
        .await
        .map_err(|failure| match failure {
            BootstrapFailure::NeedsRecovery => {
                "Database encryption key is missing while an encrypted SQLite vault exists"
                    .to_string()
            }
            BootstrapFailure::Other(message) => message,
        })
}

const REMOTE_ACCESS_CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(3);
const AUTOSTART_STATE_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Watch the remote-access config file for changes made from OUTSIDE this
/// process and restart the managed stack when one lands.
///
/// The console can no longer call `configure_remote_access` /
/// `set_remote_access_config` for the `user_supplied_origin` provider --
/// Tauri never injects `invoke()` into the console's `http://127.0.0.1:{port}`
/// window (see `local/HOST-BRIDGE-DESIGN-0918.md`). It now writes the SAME
/// file directly over HTTP (`server/routes/owner-remote-access.ts`, via
/// `remote_access_config_path`, which both processes now agree on). Nothing
/// else notifies this process that the file changed, and the four PDPP_*
/// reachability fields are only read once at RI/console process startup, so
/// applying a change still means restarting those sidecars -- this task is
/// what makes that restart automatic instead of requiring the owner to
/// manually quit and reopen DataConnect.
///
/// Polls rather than uses a filesystem-notify crate: this repo has no
/// existing file-watch dependency, the codebase's own idiom for this shape of
/// wait is already a short interval poll (`CONSOLE_POLL_INTERVAL`, ~15 lines
/// above `bootstrap_and_open_console`), and a settings change is a rare,
/// human-paced event where a few seconds of latency is unobservable.
///
/// Spawned exactly once from `setup()`, before the first
/// `bootstrap_and_open_console` call. `last_applied` seeds from the config
/// file's state at that moment -- the same read `bootstrap_and_open_console`
/// is about to make to launch the stack for the first time -- so the first
/// poll tick never fires spuriously. A restart this task itself triggers
/// updates `last_applied` before handing control to
/// `restart_after_remote_access_config`, so that restart's own (unchanged)
/// config read never re-triggers a loop; every subsequent Tauri-side restart
/// (from `set_remote_access_config` / `configure_remote_access`, or a later
/// external change) is likewise absorbed into `last_applied` as it happens,
/// since this is the only task that ever advances it.
/// Decrypt a pending `ngrok_authtoken_sealed` (written by `owner-remote-access.ts`'s
/// POST handler, see `RemoteAccessConfig::ngrok_authtoken_sealed`'s doc comment
/// in `remote_access.rs`) into the OS keychain, then blank the sealed field
/// back to `None` on disk. Returns the config with the field cleared either
/// way -- on decrypt failure the sealed token is dropped rather than retried
/// forever, since a bad token needs the owner to resubmit it, not a poll loop
/// hammering the same ciphertext every 3 seconds.
///
/// Must run BEFORE `restart_after_remote_access_config`: the restart's own
/// `start_managed_stack` reads the ngrok authtoken back out of the keychain
/// (`sealed_credential` only ever writes there, never returns the plaintext
/// to a caller that might restart the tunnel with it directly) to start the
/// tunnel, so the keychain write must already be durable by the time that
/// runs.
fn apply_pending_ngrok_authtoken(
    app: &AppHandle,
    config: RemoteAccessConfig,
) -> RemoteAccessConfig {
    let Some(sealed) = config.ngrok_authtoken_sealed.clone() else {
        return config;
    };
    let outcome = (|| -> Result<(), String> {
        let key_path = credential_encryption_key_path(app)?;
        let database_path = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))?
            .join(UNIFIED_DB_DIRECTORY)
            .join(UNIFIED_DB_FILE);
        let credential_encryption_key =
            load_or_create_credential_encryption_key(&key_path, &database_path)?;
        let token = crate::sealed_credential::open_sealed_credential(
            &sealed,
            &credential_encryption_key,
        )
        .map_err(|error| format!("Failed to decrypt the pending ngrok authtoken: {error}"))?;
        crate::owner_credential::store_provider_credential_reference(
            crate::remote_access_ngrok::NGROK_PROVIDER_ID,
            &token,
        )
    })();
    if let Err(error) = outcome {
        log::error!("Could not apply the pending ngrok authtoken: {error}");
    }
    let cleared = RemoteAccessConfig {
        ngrok_authtoken_sealed: None,
        ..config
    };
    match save_remote_access_config(app, cleared.clone()) {
        Ok(saved) => saved,
        Err(error) => {
            log::error!("Could not clear the pending ngrok authtoken from disk: {error}");
            cleared
        }
    }
}

/// Decrypt a pending `cloudflare_tunnel_token_sealed` into the OS keychain,
/// then blank the sealed field back to `None` on disk. Mirrors
/// `apply_pending_ngrok_authtoken` exactly -- see that function's doc
/// comment for the full handoff sequence and why it must run before
/// `restart_after_remote_access_config`.
fn apply_pending_cloudflare_tunnel_token(
    app: &AppHandle,
    config: RemoteAccessConfig,
) -> RemoteAccessConfig {
    let Some(sealed) = config.cloudflare_tunnel_token_sealed.clone() else {
        return config;
    };
    let outcome = (|| -> Result<(), String> {
        let key_path = credential_encryption_key_path(app)?;
        let database_path = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))?
            .join(UNIFIED_DB_DIRECTORY)
            .join(UNIFIED_DB_FILE);
        let credential_encryption_key =
            load_or_create_credential_encryption_key(&key_path, &database_path)?;
        let token = crate::sealed_credential::open_sealed_credential(
            &sealed,
            &credential_encryption_key,
        )
        .map_err(|error| {
            format!("Failed to decrypt the pending Cloudflare tunnel token: {error}")
        })?;
        crate::owner_credential::store_provider_credential_reference(
            crate::remote_access_cloudflare::CLOUDFLARE_TUNNEL_PROVIDER_ID,
            &token,
        )
    })();
    if let Err(error) = outcome {
        log::error!("Could not apply the pending Cloudflare tunnel token: {error}");
    }
    let cleared = RemoteAccessConfig {
        cloudflare_tunnel_token_sealed: None,
        ..config
    };
    match save_remote_access_config(app, cleared.clone()) {
        Ok(saved) => saved,
        Err(error) => {
            log::error!("Could not clear the pending Cloudflare tunnel token from disk: {error}");
            cleared
        }
    }
}

pub(crate) fn spawn_remote_access_config_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_applied = load_remote_access_config(&app).unwrap_or_else(|error| {
            log::warn!("Remote-access config watcher could not seed its baseline: {error}");
            off_remote_access_config()
        });
        loop {
            tokio::time::sleep(REMOTE_ACCESS_CONFIG_POLL_INTERVAL).await;
            if !remote_access_configuration_supported() {
                continue;
            }
            let current = match load_remote_access_config(&app) {
                Ok(config) => config,
                Err(error) => {
                    log::warn!(
                        "Remote-access config watcher could not read the config file: {error}"
                    );
                    continue;
                }
            };
            let current = if current.ngrok_authtoken_sealed.is_some() {
                apply_pending_ngrok_authtoken(&app, current)
            } else {
                current
            };
            let current = if current.cloudflare_tunnel_token_sealed.is_some() {
                apply_pending_cloudflare_tunnel_token(&app, current)
            } else {
                current
            };
            if current == last_applied {
                continue;
            }
            log::info!("Remote-access config changed on disk; restarting the managed stack");
            last_applied = current;
            if let Err(error) = restart_after_remote_access_config(app.clone()).await {
                log::error!(
                    "Automatic restart after a remote-access config change failed: {error}"
                );
            }
        }
    });
}

/// Watch `autostart.json` for requests written by the reference server
/// (`server/routes/owner-autostart.ts` via `server/autostart-store.ts`) and
/// apply them with `tauri_plugin_autostart`, the only process that can
/// perform this OS-level action (see `commands/desktop_settings.rs`'s
/// `AutostartState` doc comment for why the server cannot do this itself).
///
/// Modeled directly on `spawn_remote_access_config_watcher` above: same poll
/// shape, same rationale for polling over a file-watch crate. Unlike that
/// watcher, which restarts sidecars on ANY external change, this one seeds
/// the state file from real `is_enabled()` truth on first read (never
/// mutating for a request nobody made) and then only acts when
/// `request_id != applied_request_id` -- see
/// `desktop_settings::apply_autostart_desired_state`, which holds the pure
/// decision logic this loop drives.
pub(crate) fn spawn_autostart_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = tick_autostart_watcher(&app) {
                log::warn!("Autostart watcher tick failed: {error}");
            }
            tokio::time::sleep(AUTOSTART_STATE_POLL_INTERVAL).await;
        }
    });
}

fn tick_autostart_watcher(app: &AppHandle) -> Result<(), String> {
    use crate::commands::desktop_settings::{
        apply_autostart_desired_state, autostart_state_path, load_autostart_state,
        save_autostart_state,
    };
    use tauri_plugin_autostart::ManagerExt;

    let path = autostart_state_path(app)?;
    let current = load_autostart_state(&path)?;
    let manager = app.autolaunch();
    let next = apply_autostart_desired_state(
        current,
        || {
            manager
                .is_enabled()
                .map_err(|error| format!("Failed to read autostart state: {error}"))
        },
        || {
            manager
                .enable()
                .map_err(|error| format!("Failed to enable autostart: {error}"))
        },
        || {
            manager
                .disable()
                .map_err(|error| format!("Failed to disable autostart: {error}"))
        },
    )?;
    save_autostart_state(&path, &next)
}

/// Open the standalone recovery-code entry window, or focus it if it's
/// already open (a repeat bootstrap failure, e.g. after a rejected code,
/// must not stack duplicate windows).
///
/// `WebviewUrl::App` (NOT `WebviewUrl::External`, unlike the console window)
/// so `invoke()` actually works here -- Tauri only injects its IPC bridge
/// into app-origin (`tauri://localhost`) webviews, never into externally
/// loaded http(s) origins like the console's. `withGlobalTauri` is already
/// `true` app-wide in tauri.conf.json (an app-level build setting, not
/// per-window), so `window.__TAURI__.core.invoke` is available on this page
/// with no npm `@tauri-apps/api` import. That flag does not regress the
/// console window's invoke()-lessness: Tauri never injects the global into
/// `WebviewUrl::External` webviews regardless of `withGlobalTauri`, so the
/// console keeps behaving exactly as `local/HOST-BRIDGE-DESIGN-0918.md`
/// (Task 1) requires.
///
/// `recovery.html` resolves against `frontendDist` (`../dist`), the same
/// asset root every other `WebviewUrl::App` reference in this codebase
/// resolves against -- see `WebviewBuilder::prepare_webview` in the `tauri`
/// crate, which joins the `WebviewUrl::App` path onto `get_app_url()`. It is
/// a plain static file placed in `public/recovery.html` (Vite's
/// copy-verbatim-to-dist-root convention -- no bundler, no build step), not
/// a bundled *resource* (`tauri.conf.json`'s `bundle.resources`), because
/// `WebviewUrl::App` paths are frontend-asset-root-relative, not
/// resource-root-relative.
fn open_recovery_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(RECOVERY_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        RECOVERY_WINDOW_LABEL,
        WebviewUrl::App("recovery.html".into()),
    )
    .title("DataConnect — Restore vault access")
    .inner_size(560.0, 420.0)
    .min_inner_size(480.0, 360.0)
    .center()
    .resizable(true)
    .build();
    match result {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => log::error!("Failed to open the DataConnect recovery window: {error}"),
    }
}

/// Close the recovery window after a successful import, or after any other
/// path that resolves the missing-key state. A no-op if it was never opened.
fn close_recovery_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(RECOVERY_WINDOW_LABEL) {
        let _ = window.close();
    }
}

async fn wait_for_console(url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + CONSOLE_WAIT_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(url).send().await {
            if response.status().is_success() || response.status().is_redirection() {
                return Ok(());
            }
        }
        tokio::time::sleep(CONSOLE_POLL_INTERVAL).await;
    }
    Err(format!(
        "Console did not answer {url} within {CONSOLE_WAIT_TIMEOUT:?}"
    ))
}

fn owner_session_cookie(url: &tauri::Url, value: &str) -> Result<Cookie<'static>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Console URL has no cookie host".to_string())?
        .to_string();
    Ok(Cookie::build(("pdpp_owner_session", value.to_string()))
        .domain(host)
        .path("/")
        .http_only(true)
        .build())
}

fn set_cookie_then_navigate<SetCookie, Navigate>(
    set_cookie: SetCookie,
    navigate: Navigate,
) -> Result<(), String>
where
    SetCookie: FnOnce() -> Result<(), String>,
    Navigate: FnOnce() -> Result<(), String>,
{
    set_cookie()?;
    navigate()
}

fn create_or_update_console_window(
    app: &AppHandle,
    url: tauri::Url,
    cookie: Cookie<'static>,
    should_show: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        set_cookie_then_navigate(
            || {
                window
                    .set_cookie(cookie.clone())
                    .map_err(|error| format!("Failed to set owner session cookie: {error}"))
            },
            || {
                window
                    .navigate(url.clone())
                    .map_err(|error| format!("Failed to navigate console: {error}"))
            },
        )?;
        if should_show {
            window
                .show()
                .map_err(|error| format!("Failed to show console: {error}"))?;
            window
                .set_focus()
                .map_err(|error| format!("Failed to focus console: {error}"))?;
        }
        return Ok(());
    }

    let blank_url: tauri::Url = "about:blank"
        .parse()
        .map_err(|error| format!("Failed to create blank console URL: {error}"))?;
    let window =
        WebviewWindowBuilder::new(app, CONSOLE_WINDOW_LABEL, WebviewUrl::External(blank_url))
            .title("DataConnect")
            .visible(false)
            // Sizing grounded in measured prior art, not a round number —
            // see ai/research/desktop-app-packaging/vscode-electron-window-state-sizing-precedent-2026.md.
            // Minimum tracks the sidebar's own collapse breakpoint in
            // apps/console DashboardShell (`md:` = 768px CSS width), with margin.
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            // Clamp to the monitor's work area so the window never opens
            // larger than a small display (checked on creation only).
            .prevent_overflow()
            .center()
            .build()
            .map_err(|error| format!("Failed to create console window: {error}"))?;

    set_cookie_then_navigate(
        || {
            window
                .set_cookie(cookie)
                .map_err(|error| format!("Failed to set owner session cookie: {error}"))
        },
        || {
            window
                .navigate(url)
                .map_err(|error| format!("Failed to navigate console: {error}"))
        },
    )?;

    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Cached, in-memory read only -- this handler runs on the
            // GTK/tao window-event thread, which also owns titlebar
            // hit-testing/redraw, so it must never block on disk I/O. See
            // ai/research/desktop-app-packaging/tauri-linux-unresponsive-titlebar-is-a-tao-wayland-csd-overlay-bug-not-a-blocked-main-thread-2026.md
            // (hypothesis H3) for why the previous `fs::read_to_string`
            // call here was a defect regardless of whether it was the root
            // cause of any specific reported freeze.
            if crate::commands::cached_close_to_tray_preference() {
                api.prevent_close();
                let _ = window_for_close.hide();
                // Off the window-event thread onto a blocking-friendly
                // worker: this does a state-file read/write plus a
                // notification-daemon round trip, both of which are
                // exactly the kind of blocking work this handler must not
                // do inline (see the comment above), and exactly the kind
                // of work that must not run on a plain (non-blocking)
                // async task either.
                let window_for_notice = window_for_close.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    notify_close_to_tray_once(&window_for_notice);
                });
            }
            // else: let the close proceed. With no other windows open this
            // drops to zero webview windows, which fires RunEvent::ExitRequested
            // (handled in lib.rs -> request_shutdown), so disabling the
            // preference still gets a clean sidecar shutdown, not a bare kill.
        }
    });
    // tauri-plugin-window-state restores a saved SIZE in physical pixels with
    // no monitor/work-area check (only saved POSITION is validated against
    // available_monitors() before being applied) — see
    // ai/research/desktop-app-packaging/tauri-2-window-sizing-is-logical-pixels-but-window-state-restore-size-skips-monitor-clamping-2026.md.
    // A size saved while a larger/differently-scaled monitor was connected
    // can be re-applied verbatim to a smaller current monitor. Its restore
    // runs via the plugin's on_window_ready hook, which fires synchronously
    // during WebviewWindowBuilder::build() above, so by this point any
    // restored size is already applied and safe to re-clamp.
    clamp_to_current_monitor(&window);
    if should_show {
        window
            .show()
            .map_err(|error| format!("Failed to show console: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Failed to focus console: {error}"))?;
    }
    Ok(())
}

/// Show a one-time "DataConnect keeps running in the tray" toast the first
/// time the window is closed-to-tray (never again after that), so a user's
/// first "did it actually close?" moment gets an answer instead of just a
/// window disappearing. Steady-state visibility is already covered by the
/// tray icon's own status label (`UnifiedStatus` in the tray menu) -- this
/// covers only the one-time first-use gap identified in
/// ai/research/desktop-app-packaging/orphaned-sidecar-processes-need-kernel-level-lifecycle-ownership-not-just-a-catchable-signal-handler-2026.md
/// section 5, item 5.
///
/// Best-effort: any failure (state-file I/O, notification permission, no
/// notification daemon running) is logged and swallowed, never surfaced to
/// the user or allowed to affect the close-to-tray behavior itself, which
/// has already completed (`prevent_close` + `hide`) by the time this runs.
fn notify_close_to_tray_once(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    match crate::commands::desktop_settings::mark_close_to_tray_notice_shown_if_first_time(app) {
        Ok(true) => {
            if let Err(error) = app
                .notification()
                .builder()
                .title("DataConnect")
                .body("DataConnect keeps running in the tray. Reopen it anytime from the tray icon, or quit from there.")
                .show()
            {
                log::warn!("Failed to show close-to-tray notice: {error}");
            }
        }
        Ok(false) => {
            // Already shown in a previous session -- steady-state, not an
            // error.
        }
        Err(error) => {
            log::warn!("Failed to read/write close-to-tray notice state: {error}");
        }
    }
}

/// Re-clamp a window's size (and, if it now falls outside the monitor,
/// position) to the monitor it currently resides on. A no-op when the
/// window already fits, when it isn't on the primary/current monitor's
/// detected bounds, or when the current monitor can't be determined
/// (headless/CI environments, or a mid-hotplug race) — in all of those
/// cases we leave the OS/compositor's own placement alone rather than
/// risk moving the window somewhere worse.
fn clamp_to_current_monitor(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    let Some((clamped_size, clamped_position)) =
        clamp_bounds_to_monitor(size, position, *monitor.size(), *monitor.position())
    else {
        return;
    };

    log::info!(
        "Clamping console window to current monitor ({}x{} at {},{}): size {}x{}, position {},{}",
        monitor.size().width,
        monitor.size().height,
        monitor.position().x,
        monitor.position().y,
        clamped_size.width,
        clamped_size.height,
        clamped_position.x,
        clamped_position.y
    );
    let _ = window.set_size(clamped_size);
    let _ = window.set_position(clamped_position);
}

/// Pure geometry: shrink `size` to fit within `monitor_size` and clamp
/// `position` so the (possibly-shrunk) window's bounds stay within
/// `monitor_position`..`monitor_position + monitor_size`. Returns `None` if
/// the input already fits (no-op), so callers can skip the write-back.
///
/// Isolated from `Window`/`Monitor` so the clamping math itself is
/// unit-testable without a live windowing system.
fn clamp_bounds_to_monitor(
    mut size: tauri::PhysicalSize<u32>,
    mut position: tauri::PhysicalPosition<i32>,
    monitor_size: tauri::PhysicalSize<u32>,
    monitor_position: tauri::PhysicalPosition<i32>,
) -> Option<(tauri::PhysicalSize<u32>, tauri::PhysicalPosition<i32>)> {
    let mut changed = false;
    if size.width > monitor_size.width || size.height > monitor_size.height {
        size.width = size.width.min(monitor_size.width);
        size.height = size.height.min(monitor_size.height);
        changed = true;
    }
    let max_x = (monitor_position.x + monitor_size.width as i32 - size.width as i32)
        .max(monitor_position.x);
    let max_y = (monitor_position.y + monitor_size.height as i32 - size.height as i32)
        .max(monitor_position.y);
    if position.x < monitor_position.x || position.x > max_x {
        position.x = position.x.clamp(monitor_position.x, max_x);
        changed = true;
    }
    if position.y < monitor_position.y || position.y > max_y {
        position.y = position.y.clamp(monitor_position.y, max_y);
        changed = true;
    }

    changed.then_some((size, position))
}

fn set_status(app: &AppHandle, status: UnifiedStatus) {
    if let Ok(state) = app.state::<UnifiedRuntimeState>().status.lock() {
        let mut state = state;
        *state = status;
    }
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    match build_tray_menu(app, status) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                log::error!("Failed to update tray status: {error}");
            }
        }
        Err(error) => log::error!("Failed to build tray status menu: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io;
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant;
    use tempfile::{tempdir, NamedTempFile};

    #[derive(Clone, Default)]
    struct RecordingSink(Arc<Mutex<Vec<ProcessLifecycleEvent>>>);

    impl EventSink for RecordingSink {
        fn emit(&self, event: ProcessLifecycleEvent) {
            self.0.lock().expect("lifecycle events lock").push(event);
        }
    }

    fn node_program() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").expect("test PATH"))
            .map(|directory| directory.join("node"))
            .find(|candidate| candidate.is_file())
            .unwrap_or_else(|| PathBuf::from("node"))
    }

    fn write_script(source: String) -> NamedTempFile {
        let script = NamedTempFile::new().expect("fake launcher file");
        fs::write(script.path(), source).expect("fake launcher source");
        script
    }

    fn fake_ri_script(
        login_log: &Path,
        crash_marker: Option<&Path>,
        child_done: Option<&Path>,
        child_pid: Option<&Path>,
    ) -> NamedTempFile {
        let login_log = serde_json::to_string(&login_log.to_string_lossy()).unwrap();
        let mut source = format!(
            r#"const fs = require('node:fs');
const http = require('node:http');
const loginLog = {login_log};
"#,
        );
        if let Some(marker) = crash_marker {
            source.push_str(&format!(
                "const crashMarker = {};\nif (!fs.existsSync(crashMarker)) {{ fs.writeFileSync(crashMarker, 'first'); setTimeout(() => process.exit(17), 100); }}\n",
                serde_json::to_string(&marker.to_string_lossy()).unwrap()
            ));
        }
        if let (Some(done), Some(pid)) = (child_done, child_pid) {
            source.push_str(&format!(
                r#"const {{ spawn }} = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {{ require('node:fs').writeFileSync(process.env.DONE, 'terminated'); process.exit(0); }}); setInterval(() => {{}}, 1000);"], {{ env: {{ DONE: {} }}, stdio: 'ignore' }});
fs.writeFileSync({}, String(child.pid));
"#,
                serde_json::to_string(&done.to_string_lossy()).unwrap(),
                serde_json::to_string(&pid.to_string_lossy()).unwrap()
            ));
        }
        source.push_str(
            r#"
const asServer = http.createServer((request, response) => {
  if (request.url === '/owner/login' && request.method === 'POST') {
    fs.appendFileSync(loginLog, 'login\n');
    response.writeHead(302, { 'set-cookie': 'pdpp_owner_session=fake-session; Path=/' });
  } else {
    response.writeHead(200);
  }
  response.end('ok');
});
const rsServer = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end('healthy');
});
asServer.listen(Number(process.env.AS_PORT), '127.0.0.1');
rsServer.listen(Number(process.env.RS_PORT), '127.0.0.1');
"#,
        );
        write_script(source)
    }

    fn fake_console_script() -> NamedTempFile {
        write_script(
            r#"const http = require('node:http');
const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end('console');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
"#
            .to_string(),
        )
    }

    fn fake_spec(
        label: &str,
        script: &Path,
        env: BTreeMap<OsString, OsString>,
        readiness: Readiness,
        restart: RestartPolicy,
    ) -> ProcessSpec {
        ProcessSpec {
            label: label.to_string(),
            program: node_program(),
            args: vec![script.as_os_str().to_os_string()],
            cwd: None,
            env: EnvironmentSpec::cleared(env),
            readiness,
            restart,
            process_group: true,
            stop: StopPolicy {
                grace: Duration::from_millis(300),
                escalate: Duration::from_secs(1),
                total: Duration::from_secs(2),
            },
            requested_port: None,
        }
    }

    fn fake_stack(
        ri_script: &Path,
        console_script: &Path,
        sink: RecordingSink,
        ri_restart: RestartPolicy,
        ri_extra_env: BTreeMap<OsString, OsString>,
    ) -> (UnifiedStack, u16, u16) {
        let mut ri_env = BTreeMap::from([
            (OsString::from("AS_PORT"), OsString::from("{port}")),
            (OsString::from("RS_PORT"), OsString::from("{port+1}")),
        ]);
        ri_env.extend(ri_extra_env);
        let ri = Supervisor::new(
            fake_spec(
                RI_LABEL,
                ri_script,
                ri_env,
                Readiness::HttpGet {
                    url_from_port: format!("http://127.0.0.1:{{port+1}}{RI_HEALTH_PATH}"),
                    deadline: Duration::from_secs(3),
                    host_header: None,
                },
                ri_restart,
            ),
            sink.clone(),
        )
        .start()
        .expect("fake RI should become ready");
        let ri_port = ri.port();
        let console = Supervisor::new(
            fake_spec(
                CONSOLE_LABEL,
                console_script,
                BTreeMap::from([(OsString::from("PORT"), OsString::from("{port}"))]),
                Readiness::HttpGet {
                    url_from_port: "http://127.0.0.1:{port}/".to_string(),
                    deadline: Duration::from_secs(3),
                    host_header: None,
                },
                RestartPolicy::Bounded {
                    max: 1,
                    backoff: Duration::from_millis(25),
                },
            ),
            sink,
        )
        .start()
        .expect("fake console should become ready");
        let console_port = console.port();
        (
            UnifiedStack {
                ri,
                console,
                cloudflare_tunnel: None,
            },
            ri_port,
            console_port,
        )
    }

    #[test]
    fn unified_stack_requires_exact_one_flag() {
        assert!(enabled_for_value(Some("1")));
        assert!(!enabled_for_value(Some("0")));
        assert!(!enabled_for_value(Some("true")));
        assert!(!enabled_for_value(None));
    }

    #[test]
    fn ri_readiness_host_header_trusts_the_configured_ngrok_host() {
        assert_eq!(
            ri_readiness_host_header("vault.ngrok-free.app"),
            Some("vault.ngrok-free.app".to_string())
        );
    }

    #[test]
    fn ri_readiness_host_header_is_none_when_no_public_origin_is_configured() {
        assert_eq!(ri_readiness_host_header(""), None);
        assert_eq!(ri_readiness_host_header("   "), None);
    }

    fn ngrok_fingerprint() -> NgrokFingerprint {
        NgrokFingerprint {
            endpoint_mode:
                crate::remote_access_providers::NgrokEndpointModeConfig::HttpsEdgeTermination,
            reserved_domain: None,
        }
    }

    fn ngrok_fingerprint_with_dev_domain(domain: &str) -> NgrokFingerprint {
        NgrokFingerprint {
            endpoint_mode:
                crate::remote_access_providers::NgrokEndpointModeConfig::HttpsEdgeTermination,
            reserved_domain: Some(domain.to_string()),
        }
    }

    /// The tunnel-survival rule, stated once, exhaustively, as data.
    ///
    /// This replaces a static source-text check that counted
    /// `cleanup_managed_stack_on_error_keep_ngrok(` occurrences inside
    /// `finish_bootstrap`'s body. That check could only ever assert which
    /// FUNCTION NAME was spelled at a call site; it could not assert what
    /// the call did. Now that the fork is a value rather than a function,
    /// the rule itself is directly testable, and the match below is
    /// exhaustive -- adding a `StopReason` without deciding its tunnel
    /// semantics fails to compile rather than silently defaulting.
    #[test]
    fn stop_reasons_decide_tunnel_survival_exhaustively() {
        for reason in [
            StopReason::ConfigChange,
            StopReason::BootstrapFailed,
            StopReason::VaultKeyRejected,
            StopReason::AppQuit,
        ] {
            let expected = match reason {
                // A config-change restart must reuse the tunnel: on a free
                // plan a fresh tunnel means a fresh random hostname, which
                // invalidates the origin the owner just adopted.
                StopReason::ConfigChange => false,
                // Confirmed live, 2026-09-19: a failure downstream of the
                // tunnel (login, console readiness, cookie, window) says
                // nothing about tunnel health, and the tunnel just proved
                // itself live.
                StopReason::BootstrapFailed => false,
                // Any tunnel here was started fresh inside this failed
                // attempt and adopted by nothing.
                StopReason::VaultKeyRejected => true,
                StopReason::AppQuit => true,
            };
            assert_eq!(
                reason.stops_tunnel(),
                expected,
                "{reason:?} has the wrong tunnel-survival semantics"
            );
        }
    }

    /// Guards the specific regression the deleted source-text test was
    /// written for: every `finish_bootstrap` failure branch must tear down
    /// with a reason whose tunnel survives.
    #[test]
    fn finish_bootstrap_failures_preserve_the_tunnel() {
        assert!(
            !StopReason::BootstrapFailed.stops_tunnel(),
            "finish_bootstrap's failure branches must never stop the held tunnel"
        );
    }

    /// Call-site coverage for the rule asserted semantically above.
    ///
    /// `stop_reasons_decide_tunnel_survival_exhaustively` proves
    /// `BootstrapFailed` spares the tunnel; this proves every failure branch
    /// in `finish_bootstrap` actually passes that reason. A runtime test
    /// cannot cover this here: `tauri::test::mock_app()` returns a
    /// mock-runtime handle incompatible with this file's real-runtime
    /// `AppHandle`, so the call sites stay source-checked while the
    /// semantics are checked directly.
    #[test]
    fn finish_bootstrap_tears_down_with_a_tunnel_preserving_reason() {
        let source = include_str!("unified.rs");
        let start = source
            .find("async fn finish_bootstrap(")
            .expect("finish_bootstrap must exist");
        let body_end = source[start..]
            .find("\n/// Recovery-window command")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..body_end];

        let preserving = body
            .matches("teardown_managed_on_error(app, managed, StopReason::BootstrapFailed)")
            .count();
        assert!(
            preserving >= 6,
            "expected every finish_bootstrap failure branch (6 as of this fix) to tear \
             down with StopReason::BootstrapFailed; found {preserving}"
        );
        for stopping in ["StopReason::AppQuit", "StopReason::VaultKeyRejected"] {
            assert!(
                !body.contains(stopping),
                "finish_bootstrap must never tear down with {stopping}: it would stop a \
                 tunnel that just proved itself live"
            );
        }
    }

    #[test]
    fn the_ngrok_tunnel_forwards_to_the_console_port_not_the_bare_ri() {
        // Confirmed live, 2026-09-20: the tunnel used to forward to
        // `ri.port()`, so a remote visitor following the public URL landed
        // on the RI's own JSON discovery index (`{"links":{"connectors":
        // "/v1/connectors"...}`), not a usable UI -- and that page's own
        // "console origin" text pointed right back at the same public URL,
        // a dead end. `start_managed_stack` must call
        // `reuse_or_start_ngrok_provider` with `console.port()`, matching
        // `start_ngrok_provider`'s doc comment on why the console -- which
        // already proxies every RI/RS API surface under its own origin -- is
        // the correct forward target. Asserted on source text:
        // `start_managed_stack` resolves real staged RI/console binaries and
        // starts real `Supervisor` processes plus a live ngrok session, none
        // of which this file's tests otherwise fake -- unlike `fake_stack`,
        // which only substitutes fake RI/console launcher scripts for the
        // sidecar-lifecycle tests further below, with no ngrok involved.
        let source = include_str!("unified.rs");
        let start = source
            .find("fn start_managed_stack(")
            .expect("start_managed_stack must exist");
        let body_end = source[start..]
            .find("\n/// Resolve the ngrok options")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..body_end];

        assert!(
            body.contains("reuse_or_start_ngrok_provider(remote_access, held_ngrok, console.port())"),
            "start_managed_stack must start/reuse the ngrok tunnel targeting the console's port"
        );
        assert!(
            !body.contains("reuse_or_start_ngrok_provider(remote_access, held_ngrok, ri.port())"),
            "the ngrok tunnel must never forward to the bare RI's port again"
        );
    }

    #[test]
    fn a_free_plan_owner_with_a_configured_dev_domain_gets_a_stable_hostname_across_restarts() {
        // The end-to-end property the brief requires a test for: a
        // free-plan owner who pasted their dev domain into settings
        // (`NgrokOptions::reserved_domain`, which flows into this
        // fingerprint via `NgrokFingerprint::from_options`) keeps the exact
        // same hostname across a config-change restart, because the
        // fingerprint the reuse decision is keyed on includes the domain --
        // two restarts naming the SAME domain are the SAME fingerprint, so
        // `should_reuse_ngrok_tunnel` says reuse, and even if reuse is
        // rejected for an unrelated reason (RI port moved), a fresh tunnel
        // still requests this literal domain (`start_ngrok_provider` reads
        // `options.reserved_domain` on every call), not a random one.
        let dev_domain = "moderately-worthy-tetra.ngrok-free.app";
        let first_boot = ngrok_fingerprint_with_dev_domain(dev_domain);
        let restart = ngrok_fingerprint_with_dev_domain(dev_domain);

        assert!(should_reuse_ngrok_tunnel(
            Some(&first_boot),
            Some(4310),
            Some(&restart),
            4310,
        ));

        // The stability claim survives even when the RI's port changes
        // (forcing a fresh tunnel, not a reuse): the two fingerprints still
        // name the same domain, so whatever starts the fresh tunnel is
        // still asking ngrok for the owner's one stable hostname, not a
        // random one -- reuse is an optimization, the domain is the
        // property that must not regress.
        assert_eq!(first_boot.reserved_domain, restart.reserved_domain);
        assert_eq!(first_boot.reserved_domain.as_deref(), Some(dev_domain));
    }

    #[test]
    fn a_dev_domain_change_is_a_different_fingerprint_and_forces_a_fresh_tunnel() {
        // If the owner replaces the domain they've configured (typo fix,
        // switching to a paid custom domain), that is a genuine settings
        // change and must NOT be silently ignored by treating it as
        // reusable -- ngrok cannot repoint an existing tunnel to a
        // different domain, so this has to mint a fresh one.
        let old_domain = ngrok_fingerprint_with_dev_domain("old-domain.ngrok-free.app");
        let new_domain = ngrok_fingerprint_with_dev_domain("new-domain.ngrok-free.app");
        assert!(!should_reuse_ngrok_tunnel(
            Some(&old_domain),
            Some(4310),
            Some(&new_domain),
            4310,
        ));
    }

    #[test]
    fn should_reuse_ngrok_tunnel_when_settings_and_forward_port_are_unchanged() {
        // The shape a config-change restart (`restart_after_remote_access_config`)
        // hits every time on a FREE ngrok plan: same provider settings, and
        // the console came back up on the same port (via
        // `Supervisor::start_on_port` preferring the held tunnel's port).
        // This is the case that must NOT create a new tunnel, or the
        // owner's just-adopted origin goes stale before the console even
        // loads it.
        let fingerprint = ngrok_fingerprint();
        assert!(should_reuse_ngrok_tunnel(
            Some(&fingerprint),
            Some(4310),
            Some(&fingerprint),
            4310,
        ));
    }

    #[test]
    fn should_not_reuse_ngrok_tunnel_when_the_forward_port_changed() {
        // The console's preferred port could not be reused (something else
        // bound it in the gap) -- the held tunnel is forwarding to a port
        // nothing is listening on anymore, so it cannot be kept.
        let fingerprint = ngrok_fingerprint();
        assert!(!should_reuse_ngrok_tunnel(
            Some(&fingerprint),
            Some(4310),
            Some(&fingerprint),
            4311,
        ));
    }

    #[test]
    fn should_not_reuse_ngrok_tunnel_when_provider_settings_changed() {
        let held = ngrok_fingerprint();
        let desired = NgrokFingerprint {
            endpoint_mode:
                crate::remote_access_providers::NgrokEndpointModeConfig::TlsPassthrough,
            reserved_domain: None,
        };
        assert!(!should_reuse_ngrok_tunnel(
            Some(&held),
            Some(4310),
            Some(&desired),
            4310,
        ));
    }

    #[test]
    fn should_not_reuse_ngrok_tunnel_when_nothing_is_held() {
        let fingerprint = ngrok_fingerprint();
        assert!(!should_reuse_ngrok_tunnel(None, None, Some(&fingerprint), 4310));
    }

    #[test]
    fn should_not_reuse_ngrok_tunnel_when_remote_access_no_longer_wants_ngrok() {
        // Turning remote access off (or switching away from ngrok) must
        // start a fresh tunnel the next time ngrok is selected again, not
        // resurrect the old one -- see the "off then on starts fresh" test
        // requirement.
        let fingerprint = ngrok_fingerprint();
        assert!(!should_reuse_ngrok_tunnel(
            Some(&fingerprint),
            Some(4310),
            None,
            4310,
        ));
    }

    /// Binds a loopback listener that answers exactly one HTTP request with
    /// `response_head` and no body, then stops. Enough to control response
    /// headers precisely without pulling in a real HTTP server dependency --
    /// `probe_ngrok_tunnel_is_live` only inspects headers on the response.
    fn respond_once_with(response_head: &'static str) -> String {
        let (url, _) = respond_once_with_and_capture_request(response_head);
        url
    }

    /// Same as `respond_once_with`, but also returns the raw request bytes
    /// the probe sent, so a test can assert on the REQUEST headers this
    /// process sends (e.g. `ngrok-skip-browser-warning`), not just how it
    /// interprets the response.
    fn respond_once_with_and_capture_request(
        response_head: &'static str,
    ) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buffer = [0_u8; 1024];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let _ = sender.send(buffer[..read].to_vec());
                let _ = stream.write_all(response_head.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}/"), receiver)
    }

    #[test]
    fn probe_ngrok_tunnel_is_live_true_for_an_ordinary_response() {
        let origin = respond_once_with("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        assert!(probe_ngrok_tunnel_is_live(&origin));
    }

    #[test]
    fn probe_ngrok_tunnel_is_live_false_when_ngrok_reports_its_own_error() {
        // The exact shape of ngrok's edge answering for a session that has
        // silently died: a real HTTP response (not a connection failure),
        // carrying `ngrok-error-code` -- reproduced live tonight as
        // ERR_NGROK_3200 "endpoint is offline" while the same request
        // against the actual RI, over loopback, returned 200 the whole
        // time. The RI is not in a position to ever set this header itself,
        // so its presence is unambiguous.
        let origin = respond_once_with(
            "HTTP/1.1 404 Not Found\r\nngrok-error-code: ERR_NGROK_3200\r\nContent-Length: 0\r\n\r\n",
        );
        assert!(!probe_ngrok_tunnel_is_live(&origin));
    }

    #[test]
    fn probe_ngrok_tunnel_is_live_false_when_the_request_fails_outright() {
        // No listener at all: the probe must fail closed (treat "could not
        // even connect" the same as "connected but ngrok says it's dead"),
        // not panic or default to true.
        assert!(!probe_ngrok_tunnel_is_live("http://127.0.0.1:1/"));
    }

    #[test]
    fn probe_ngrok_tunnel_is_live_sends_the_skip_browser_warning_header() {
        // Confirmed live, 2026-09-20: ngrok's free plan shows a one-time
        // browser interstitial to any request that looks like it came from a
        // browser. An interstitial response is a real 200 with no
        // `ngrok-error-code` header, so a liveness probe that got shown the
        // interstitial instead of the real origin would misread a live
        // tunnel as reachable while never actually confirming the app
        // behind it answered -- and this app should never see that page for
        // its OWN requests to its OWN public origin in the first place.
        let (origin, request_received) =
            respond_once_with_and_capture_request("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        assert!(probe_ngrok_tunnel_is_live(&origin));
        let request = request_received
            .recv_timeout(Duration::from_secs(1))
            .expect("the probe request must have been sent");
        let request = String::from_utf8_lossy(&request).to_lowercase();
        assert!(
            request.contains("ngrok-skip-browser-warning"),
            "expected the liveness probe to send ngrok-skip-browser-warning; request was:\n{request}"
        );
    }

    #[test]
    fn ri_environment_passes_secrets_only_to_the_ri_allowlist_without_debug_values() {
        let owner_password = "owner-password-test";
        let credential_key = "credential-key-test";
        let database_key = "database-key-test";
        let environment = ri_environment(
            Path::new("/tmp/unified"),
            owner_password,
            credential_key,
            database_key,
        );

        assert_eq!(
            environment.get(std::ffi::OsStr::new(CREDENTIAL_ENCRYPTION_KEY_ENV)),
            Some(&OsString::from(credential_key))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new(DATABASE_ENCRYPTION_KEY_ENV)),
            Some(&OsString::from(database_key))
        );
        let debug = format!("{:?}", EnvironmentSpec::cleared(environment));
        assert!(!debug.contains(owner_password));
        assert!(!debug.contains(credential_key));
        assert!(!debug.contains(database_key));
    }

    #[test]
    fn a_pinned_console_port_reaches_the_console_process_spec() {
        let mut remote_access = off_remote_access_config();
        remote_access.console_port = Some(4310);

        // The console is the one surface a "proxy you run" points at (it
        // fronts AS/RS internally), so it is the only spec that ever
        // receives a pin -- ri_process_spec's literal always sets
        // `requested_port: None` (AS/RS keep dynamic allocation).
        let console_spec = console_process_spec(
            &node_program(),
            Path::new("/tmp/console-root"),
            "http://127.0.0.1:7662",
            "http://127.0.0.1:7663",
            "owner-password-test",
            &remote_access,
        );
        assert_eq!(console_spec.requested_port, Some(4310));

        let unpinned_console_spec = console_process_spec(
            &node_program(),
            Path::new("/tmp/console-root"),
            "http://127.0.0.1:7662",
            "http://127.0.0.1:7663",
            "owner-password-test",
            &off_remote_access_config(),
        );
        assert_eq!(unpinned_console_spec.requested_port, None);
    }

    #[test]
    fn staged_roots_resolve_the_profile_scoped_dev_layout() {
        let directory = tempdir().expect("staged root temp directory");
        let root = directory
            .path()
            .join("debug")
            .join("reference-stack")
            .join("ri");
        fs::create_dir_all(&root).expect("staged root directory");
        fs::write(root.join("launch.mjs"), "// fake launcher").expect("staged launcher");

        assert_eq!(
            resolve_staged_root(directory.path(), "debug", "ri"),
            Some(root)
        );
        assert!(is_valid_profile("release"));
        assert!(!is_valid_profile("../release"));
    }

    #[test]
    fn quitting_status_disables_quit_and_open_console_tray_items() {
        let app = tauri::test::mock_app();

        let quitting_menu =
            build_tray_menu(&app, UnifiedStatus::Quitting).expect("quitting menu should build");
        let quit_item = quitting_menu
            .get("quit")
            .and_then(|item| item.as_menuitem().cloned())
            .expect("quit item should exist");
        let open_console_item = quitting_menu
            .get("open-console")
            .and_then(|item| item.as_menuitem().cloned())
            .expect("open-console item should exist");
        assert!(
            !quit_item.is_enabled().expect("quit enabled state"),
            "Quit must be disabled while a shutdown is already in flight, \
             since request_shutdown is idempotent but a second click should \
             not look like it did anything"
        );
        assert!(
            !open_console_item
                .is_enabled()
                .expect("open-console enabled state"),
            "Open DataConnect must be disabled while quitting: the window \
             is already hidden and sidecars are winding down, so reopening \
             it makes no sense mid-shutdown"
        );

        let ready_menu =
            build_tray_menu(&app, UnifiedStatus::Ready).expect("ready menu should build");
        let quit_item = ready_menu
            .get("quit")
            .and_then(|item| item.as_menuitem().cloned())
            .expect("quit item should exist");
        assert!(
            quit_item.is_enabled().expect("quit enabled state"),
            "Quit must stay enabled outside of an in-flight shutdown"
        );
    }

    #[test]
    fn quitting_status_label_reads_as_a_visible_progress_indicator() {
        assert_eq!(UnifiedStatus::Quitting.label(), "Status: Quitting…");
    }

    #[test]
    fn tray_menu_actions_dispatch_to_the_expected_action() {
        assert_eq!(
            tray_action_for_menu_id("open-console"),
            TrayAction::OpenConsole
        );
        assert_eq!(
            tray_action_for_menu_id("open-browser"),
            TrayAction::OpenBrowser
        );
        assert_eq!(tray_action_for_menu_id("show-logs"), TrayAction::ShowLogs);
        assert_eq!(tray_action_for_menu_id("quit"), TrayAction::Quit);
        assert_eq!(tray_action_for_menu_id("status"), TrayAction::Unknown);
    }

    #[test]
    fn browser_open_uses_the_bootstrapped_console_origin() {
        assert_eq!(
            browser_url_from_runtime_origin(Some("http://127.0.0.1:43127")),
            Ok("http://127.0.0.1:43127".to_string())
        );
        assert_eq!(
            browser_url_from_runtime_origin(None),
            Err("Console is not ready".to_string())
        );
    }

    #[test]
    fn a_config_change_restart_requests_the_consoles_previous_port() {
        // Confirmed live, 2026-09-19: a dev-domain owner's config-change
        // restart (adopting the discovered origin) silently moved the
        // console from port 43667 to 44863. Any open tab/bookmark broke with
        // "refused to connect". `start_managed_stack` now asks
        // `Supervisor::start_on_port` to reuse this parsed port -- the same
        // helper the RI's own port stability now also depends on (see
        // `read_preferred_ri_port`).
        assert_eq!(
            preferred_port_from_origin(Some("http://127.0.0.1:43667")),
            Some(43667)
        );
    }

    #[test]
    fn no_previous_origin_falls_back_to_a_fresh_port_allocation() {
        // First launch, or a stored origin that does not parse: `None` lets
        // `start_on_port` behave exactly like `start()` always did. Shared
        // by both the console's and the RI's port-stability readers.
        assert_eq!(preferred_port_from_origin(None), None);
        assert_eq!(preferred_port_from_origin(Some("not a url")), None);
    }

    #[test]
    fn clamp_to_monitor_is_a_noop_when_the_window_already_fits() {
        let size = tauri::PhysicalSize::new(1280, 800);
        let position = tauri::PhysicalPosition::new(100, 100);
        let monitor_size = tauri::PhysicalSize::new(1920, 1080);
        let monitor_position = tauri::PhysicalPosition::new(0, 0);

        assert_eq!(
            clamp_bounds_to_monitor(size, position, monitor_size, monitor_position),
            None
        );
    }

    #[test]
    fn clamp_to_monitor_shrinks_a_size_saved_on_a_larger_now_absent_monitor() {
        // Simulates: size persisted while a 1920x1080 external monitor was
        // connected, restored verbatim after it's unplugged and the window
        // lands on a smaller 1280x720 laptop panel.
        let size = tauri::PhysicalSize::new(1920, 1080);
        let position = tauri::PhysicalPosition::new(0, 0);
        let monitor_size = tauri::PhysicalSize::new(1280, 720);
        let monitor_position = tauri::PhysicalPosition::new(0, 0);

        let (clamped_size, clamped_position) =
            clamp_bounds_to_monitor(size, position, monitor_size, monitor_position)
                .expect("oversized window should be clamped");
        assert_eq!(clamped_size, tauri::PhysicalSize::new(1280, 720));
        assert_eq!(clamped_position, tauri::PhysicalPosition::new(0, 0));
    }

    #[test]
    fn clamp_to_monitor_pulls_an_off_screen_position_back_into_the_work_area() {
        // Simulates: position persisted on a monitor to the right of the
        // primary display, restored after that monitor is unplugged so the
        // saved x-coordinate now falls off the remaining screen entirely.
        let size = tauri::PhysicalSize::new(1280, 800);
        let position = tauri::PhysicalPosition::new(2400, 200);
        let monitor_size = tauri::PhysicalSize::new(1920, 1080);
        let monitor_position = tauri::PhysicalPosition::new(0, 0);

        let (clamped_size, clamped_position) =
            clamp_bounds_to_monitor(size, position, monitor_size, monitor_position)
                .expect("off-screen position should be clamped");
        assert_eq!(clamped_size, size);
        assert_eq!(clamped_position.x, 1920 - 1280);
        assert_eq!(clamped_position.y, 200);
    }

    #[test]
    fn clamp_to_monitor_respects_a_non_origin_monitor_offset() {
        // A secondary monitor positioned to the right of the primary one
        // (e.g. primary is 1920 wide, secondary starts at x=1920) must not
        // be clamped back toward x=0 — that would move the window onto a
        // different monitor than the one it's actually on.
        let size = tauri::PhysicalSize::new(1280, 800);
        let position = tauri::PhysicalPosition::new(1920, 50);
        let monitor_size = tauri::PhysicalSize::new(1280, 1024);
        let monitor_position = tauri::PhysicalPosition::new(1920, 0);

        assert_eq!(
            clamp_bounds_to_monitor(size, position, monitor_size, monitor_position),
            None
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fake_sidecars_start_before_owner_login_is_attempted() {
        let directory = tempdir().expect("fake stack temp directory");
        let login_log = directory.path().join("login.log");
        let ri_script = fake_ri_script(&login_log, None, None, None);
        let console_script = fake_console_script();
        let events = RecordingSink::default();
        let (mut stack, ri_port, console_port) = fake_stack(
            ri_script.path(),
            console_script.path(),
            events,
            RestartPolicy::Never,
            BTreeMap::new(),
        );

        assert!(TcpListener::bind(("127.0.0.1", ri_port)).is_err());
        assert!(TcpListener::bind(("127.0.0.1", ri_port + 1)).is_err());
        assert!(TcpListener::bind(("127.0.0.1", console_port)).is_err());
        assert!(!login_log.exists());

        let login = login_reference_server_with_password(
            format!("http://127.0.0.1:{ri_port}"),
            "test-owner-password",
        )
        .await
        .expect("owner login should run after both readiness gates");
        assert_eq!(login.session_cookie, "fake-session");
        assert_eq!(fs::read_to_string(&login_log).unwrap(), "login\n");
        stack.stop().expect("fake stack should stop");
    }

    #[cfg(unix)]
    #[test]
    fn quit_stops_the_fake_sidecar_process_group() {
        let directory = tempdir().expect("fake stack temp directory");
        let login_log = directory.path().join("login.log");
        let child_done = directory.path().join("child.done");
        let child_pid = directory.path().join("child.pid");
        let ri_script = fake_ri_script(&login_log, None, Some(&child_done), Some(&child_pid));
        let console_script = fake_console_script();
        let (mut stack, _, _) = fake_stack(
            ri_script.path(),
            console_script.path(),
            RecordingSink::default(),
            RestartPolicy::Never,
            BTreeMap::new(),
        );

        stack.stop().expect("fake stack should stop");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && !child_done.exists() {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(&child_done).unwrap(), "terminated");
        let child_pid = fs::read_to_string(&child_pid)
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    /// Real-process check that `teardown_stack` stops sidecars on both the
    /// deadline arm (app quit) and the plain arm.
    ///
    /// `teardown_stack` is the single function app quit, config-change
    /// restart and every bootstrap-failure branch now funnel through, so it
    /// must kill a real process group -- not merely compile. It is called
    /// here directly rather than re-implemented, so the signature and the
    /// deadline plumbing are exercised for real.
    ///
    /// Known oracle limit, measured by sabotage rather than assumed: because
    /// the stack is passed BY VALUE and `SupervisorHandle::drop` calls
    /// `stop()`, the sidecars die even if this function's body is emptied --
    /// so this test cannot by itself detect a broken teardown body. The
    /// behavior that actually differs between the reasons is the TUNNEL
    /// decision, and that is guarded by
    /// `stop_reasons_decide_tunnel_survival_exhaustively` (verified to fail
    /// when the rule is inverted) and
    /// `finish_bootstrap_tears_down_with_a_tunnel_preserving_reason`
    /// (verified to fail when a call site passes the wrong reason).
    #[test]
    fn teardown_stack_stops_real_sidecars_on_both_deadline_arms() {
        for deadline in [None, Some(Instant::now() + Duration::from_secs(5))] {
            let directory = tempdir().expect("fake stack temp directory");
            let login_log = directory.path().join("login.log");
            let child_done = directory.path().join("child.done");
            let child_pid_path = directory.path().join("child.pid");
            let ri_script =
                fake_ri_script(&login_log, None, Some(&child_done), Some(&child_pid_path));
            let console_script = fake_console_script();
            let (stack, _, _) = fake_stack(
                ri_script.path(),
                console_script.path(),
                RecordingSink::default(),
                RestartPolicy::Never,
                BTreeMap::new(),
            );

            // Calls the real `teardown_stack`, not a copy of it: a test that
            // re-implements the logic it is checking cannot fail when that
            // logic breaks.
            let app = tauri::test::mock_app();
            app.manage(UnifiedRuntimeState::default());
            teardown_stack(
                &app.handle().clone(),
                StopReason::AppQuit,
                Some(stack),
                deadline,
            )
            .expect("teardown should stop the fake stack");

            let wait_until = Instant::now() + Duration::from_secs(2);
            while Instant::now() < wait_until && !child_done.exists() {
                thread::sleep(Duration::from_millis(20));
            }
            let child_pid = fs::read_to_string(&child_pid_path)
                .expect("fake RI should record its grandchild pid")
                .parse::<libc::pid_t>()
                .expect("grandchild pid");
            assert_eq!(
                unsafe { libc::kill(child_pid, 0) },
                -1,
                "teardown must leave no surviving grandchild (deadline: {})",
                deadline.is_some()
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
    }

    #[test]
    fn fake_ri_crash_restarts_within_the_bounded_policy() {
        let directory = tempdir().expect("fake stack temp directory");
        let login_log = directory.path().join("login.log");
        let crash_marker = directory.path().join("crash.marker");
        let ri_script = fake_ri_script(&login_log, Some(&crash_marker), None, None);
        let console_script = fake_console_script();
        let events = RecordingSink::default();
        let observed = Arc::clone(&events.0);
        let (mut stack, _, _) = fake_stack(
            ri_script.path(),
            console_script.path(),
            events,
            RestartPolicy::Bounded {
                max: 1,
                backoff: Duration::from_millis(25),
            },
            BTreeMap::new(),
        );

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let events = observed.lock().expect("lifecycle events lock");
            let ready_count = events
                .iter()
                .filter(|event| {
                    event.label == RI_LABEL && matches!(event.state, LifecycleState::Ready)
                })
                .count();
            let restarted = events.iter().any(|event| {
                event.label == RI_LABEL && matches!(event.state, LifecycleState::Restarting)
            });
            drop(events);
            if ready_count >= 2 && restarted {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let events = observed.lock().expect("lifecycle events lock");
        assert!(events.iter().any(|event| {
            event.label == RI_LABEL && matches!(event.state, LifecycleState::Restarting)
        }));
        assert!(
            events
                .iter()
                .filter(|event| {
                    event.label == RI_LABEL && matches!(event.state, LifecycleState::Ready)
                })
                .count()
                >= 2
        );
        drop(events);
        stack.stop().expect("fake stack should stop");
    }

    #[test]
    fn console_cookie_is_set_before_navigation() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let set_events = Arc::clone(&events);
        let navigate_events = Arc::clone(&events);

        set_cookie_then_navigate(
            || {
                set_events
                    .lock()
                    .expect("set events lock")
                    .push("set_cookie");
                Ok(())
            },
            || {
                let mut events = navigate_events.lock().expect("navigate events lock");
                assert_eq!(events.as_slice(), ["set_cookie"]);
                events.push("navigate");
                Ok(())
            },
        )
        .expect("navigation ordering");

        assert_eq!(
            events.lock().expect("events lock").as_slice(),
            ["set_cookie", "navigate"]
        );
    }
}
