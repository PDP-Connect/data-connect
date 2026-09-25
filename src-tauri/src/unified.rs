// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The default tray agent and authenticated console webview.
//!
//! This path owns the staged reference stack and the authenticated console
//! webview, and runs by default. `DATACONNECT_LEGACY_STACK=1` opts a
//! developer out, back to the legacy `main` window, kept only as a design
//! reference. Explicit RI/console URLs remain an attach-only development
//! escape hatch.

use crate::commands::process_supervisor::{
    allocate_loopback_port, loopback_port_range_is_free, EnvironmentSpec, EventSink,
    LifecycleState, ProcessLifecycleEvent, ProcessSpec, Readiness, RestartPolicy, StopPolicy,
    Supervisor, SupervisorError, SupervisorHandle,
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
/// How long one readiness ROUND waits before reporting the console as not
/// yet answering. Reaching it is not a verdict that the console is broken
/// -- see `wait_for_console_with_retry`.
const CONSOLE_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const CONSOLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Total time a console is given to answer across all rounds before
/// bootstrap gives up.
///
/// A fixed 45s budget whose failure mode is a destructive teardown is the
/// shape that cost real debugging time: a console that is merely SLOW gets
/// killed, and killing it does not make the next attempt faster. Ten
/// minutes is chosen to sit well above a cold first boot (a from-scratch
/// console build is tens of seconds on a warm machine and minutes on a
/// cold one), so the timeout stops being a race against machine speed.
const CONSOLE_TOTAL_WAIT_BUDGET: Duration = Duration::from_secs(600);
/// Pause between readiness rounds, doubling up to `CONSOLE_RETRY_MAX_BACKOFF`.
const CONSOLE_RETRY_INITIAL_BACKOFF: Duration = Duration::from_secs(2);
const CONSOLE_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(30);

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
const OWNER_PASSWORD_SOURCE_ENV: &str = "PDPP_OWNER_PASSWORD_SOURCE";
const OWNER_PASSWORD_SOURCE_DESKTOP_GENERATED: &str = "desktop_generated";
const OWNER_CREDENTIAL_REVEAL_PROOF_ENV: &str = "PDPP_OWNER_CREDENTIAL_REVEAL_PROOF";
const OWNER_CREDENTIAL_REVEAL_COOKIE: &str = "pdpp_owner_credential_reveal";
/// Set to "1" or "0" alongside `MANAGED_DESKTOP_HOST_ENV`, reporting whether
/// `cloudflared` is on `PATH` at RS-spawn time -- see
/// `remote_access_cloudflare::cloudflared_binary_is_installed`'s doc comment
/// for why this must be knowable before the owner commits to the Cloudflare
/// Tunnel option, not discovered only as a spawn failure after they submit a
/// token.
const CLOUDFLARED_BINARY_PRESENT_ENV: &str = "PDPP_CLOUDFLARED_BINARY_PRESENT";
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

/// Return whether the legacy opt-out flag disables the unified stack, without
/// treating any other value as a disable. Unified is the default; setting
/// `DATACONNECT_LEGACY_STACK=1` is a deliberate developer opt-out kept for
/// design reference, never a supported end-user path.
pub(crate) fn disabled_for_value(value: Option<&str>) -> bool {
    value == Some("1")
}

pub(crate) fn is_enabled() -> bool {
    !disabled_for_value(std::env::var("DATACONNECT_LEGACY_STACK").ok().as_deref())
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
/// respectively. For the console this in-memory hint is now only the
/// fallback when its persisted port (`crate::console_port`) is taken: it
/// lives only as long as the app process, so on its own it could not keep
/// the port across a relaunch or rebuild.
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

/// Persist the console's port when `crate::console_port::port_to_persist`
/// says so, and never let a lost stable port pass silently: a tunnel route
/// or proxy that points at `stable` stops working the moment the console
/// lands elsewhere. The console's Settings page names both ports as well
/// (it receives `stable` in `STABLE_PORT_ENV`); the notification covers an
/// owner who does not open Settings.
fn report_console_port_outcome(
    app: &AppHandle,
    data_dir: &Path,
    pinned: Option<u16>,
    persisted: Option<u16>,
    stable: u16,
    actual: u16,
) {
    if let Some(port) = crate::console_port::port_to_persist(pinned, persisted, actual) {
        if let Err(error) = crate::console_port::write_persisted_console_port(data_dir, port) {
            log::error!("{error}; the console may use a different port on the next launch");
        }
    }
    if actual == stable {
        return;
    }
    let message = crate::console_port::moved_port_message(stable, actual);
    log::warn!("{message}");
    if let Err(error) = app
        .notification()
        .builder()
        .title("DataConnect is on a different port")
        .body(&message)
        .show()
    {
        log::warn!("Failed to show the console port notification: {error}");
    }
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
    report_unhandled_deep_links(app);

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
    // Before anything is spawned: a previous session's orphan may still be
    // holding the loopback port this session is about to ask for.
    reap_orphans_from_dead_sessions(&app_handle);
    spawn_remote_access_config_watcher(app_handle.clone());
    spawn_autostart_watcher(app_handle.clone());
    spawn_origin_verification_watcher(app_handle.clone());
    crate::commands::recovery_key::spawn_recovery_export_watcher(app_handle.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(failure) =
            bootstrap_and_open_console(app_handle.clone(), should_show, None).await
        {
            handle_bootstrap_failure(&app_handle, "Unified DataConnect startup", failure);
        }
    });
    Ok(())
}

/// Unified mode does not build the legacy window, which is the only consumer
/// of `vana://` links. Record each one received so a dropped link shows in
/// the log instead of vanishing. Whether unified mode should serve these
/// links is an open product decision; this boundary only reports.
fn report_unhandled_deep_links(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in &urls {
            log::warn!("{}", unhandled_deep_link_notice(url));
        }
    }
    app.deep_link().on_open_url(|event| {
        for url in &event.urls() {
            log::warn!("{}", unhandled_deep_link_notice(url));
        }
    });
}

/// Log line for an unhandled deep link. Grant links carry a session secret
/// in the query, so only the scheme and host are included.
fn unhandled_deep_link_notice(url: &tauri::Url) -> String {
    format!(
        "Ignoring a {}://{} link: unified mode has no handler for incoming links",
        url.scheme(),
        url.host_str().unwrap_or("")
    )
}

pub(crate) fn focus_or_bootstrap(app: AppHandle) {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(failure) = bootstrap_and_open_console(app.clone(), true, None).await {
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
    owner_password_source: OwnerPasswordSource,
    owner_credential_reveal_proof: &str,
    credential_encryption_key: &str,
    database_encryption_key: &str,
    remote_access: &RemoteAccessConfig,
) -> ProcessSpec {
    let mut env = ri_environment(
        data_dir,
        owner_password,
        owner_password_source,
        owner_credential_reveal_proof,
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
    owner_password_source: OwnerPasswordSource,
    owner_credential_reveal_proof: &str,
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
            OsString::from(OWNER_CREDENTIAL_REVEAL_PROOF_ENV),
            OsString::from(owner_credential_reveal_proof),
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
        if matches!(owner_password_source, OwnerPasswordSource::DesktopGenerated) {
            env.insert(
                OsString::from(OWNER_PASSWORD_SOURCE_ENV),
                OsString::from(OWNER_PASSWORD_SOURCE_DESKTOP_GENERATED),
            );
        }
        // The owner needs to know whether `cloudflared` is already installed
        // BEFORE they pick the Cloudflare Tunnel option and paste a token --
        // see `cloudflared_binary_is_installed`'s doc comment. Checked here,
        // at the same RS-spawn boundary `MANAGED_DESKTOP_HOST_ENV` already
        // uses, so `inspectCloudflareTunnel` (the RS-side TypeScript mirror)
        // can fold it into the same capability probe the console already
        // polls before rendering the provider picker.
        env.insert(
            OsString::from(CLOUDFLARED_BINARY_PRESENT_ENV),
            OsString::from(if crate::remote_access_cloudflare::cloudflared_binary_is_installed() {
                "1"
            } else {
                "0"
            }),
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
    owner_credential_reveal_proof: &str,
    remote_access: &RemoteAccessConfig,
    stable_port: u16,
) -> ProcessSpec {
    // The console is the only process a LAN device ever connects to
    // directly (AS/RS stay internal loopback-only, see `ri_process_spec`'s
    // doc comment) -- so `my_devices_only` binding a LAN address means THIS
    // listener, not the RS's `PDPP_BIND_HOST`, even though both end up
    // carrying the same detected address via `remote_access.fields`. Every
    // other posture keeps today's hardcoded loopback exactly as before.
    let console_hostname = match remote_access.posture {
        crate::remote_access::RemoteAccessPosture::MyDevicesOnly => {
            remote_access.fields.bind_host.clone()
        }
        _ => "127.0.0.1".to_string(),
    };
    let mut env = env_map(vec![
        (OsString::from("NODE_ENV"), OsString::from("production")),
        (OsString::from("HOSTNAME"), OsString::from(console_hostname)),
        (OsString::from("PORT"), OsString::from("{port}")),
        (OsString::from("PDPP_AS_URL"), OsString::from(ri_origin)),
        (OsString::from("PDPP_RS_URL"), OsString::from(rs_origin)),
        (
            OsString::from("PDPP_OWNER_PASSWORD"),
            OsString::from(owner_password),
        ),
        (
            OsString::from(ORIGIN_PROOF_KEY_ENV),
            OsString::from(origin_proof_key()),
        ),
        (
            OsString::from(OWNER_CREDENTIAL_REVEAL_PROOF_ENV),
            OsString::from(owner_credential_reveal_proof),
        ),
        (
            OsString::from(crate::console_port::STABLE_PORT_ENV),
            OsString::from(stable_port.to_string()),
        ),
    ]);
    if let Some(provider) = remote_access.provider.as_deref() {
        env.insert(
            OsString::from("PDPP_ACTIVE_TUNNEL_PROVIDER"),
            OsString::from(provider),
        );
    }
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
        // The console is the one surface a proxy or tunnel route points at
        // (it fronts AS/RS internally) -- see RemoteAccessConfig::console_port's
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
    owner_password_source: OwnerPasswordSource,
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
    let owner_credential_reveal_proof = owner_credential_reveal_proof_key()?;

    let sink = UnifiedEventSink { app: app.clone() };
    // One observer per supervisor (each owns its own label's lease file).
    // Built here rather than passed in so a lease-directory failure degrades
    // to "no lease for this run" instead of failing the whole stack start:
    // a missing lease costs cleanup on a later boot, while a failed start
    // costs the owner their session.
    let lease_observer = || RunLeaseObserver::new(app);
    // Reuse the RI's previous loopback port across a stack-level restart
    // (the console's own port is persisted on disk instead, see
    // `crate::console_port`) -- see `preferred_port_from_origin`'s doc comment for why the
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
            owner_password_source,
            owner_credential_reveal_proof,
            credential_encryption_key,
            database_encryption_key,
            remote_access,
        ),
        sink.clone(),
    )
    .with_observer(lease_observer())
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
    //
    // The console's port is persisted on disk, not only remembered for this
    // session: see `crate::console_port` for why, and for the order of
    // choices (pin, persisted port, this session's port, fresh).
    let persisted_console_port = crate::console_port::read_persisted_console_port(&data_dir);
    let console_port_plan = crate::console_port::plan_console_port(
        remote_access.console_port,
        persisted_console_port,
        read_preferred_console_port(app),
        |port| loopback_port_range_is_free(port, false),
        || allocate_loopback_port(false, None).ok(),
    );
    let console = Supervisor::new(
        console_process_spec(
            &node_binary,
            &console_root,
            &ri_origin,
            &rs_origin,
            owner_password,
            owner_credential_reveal_proof,
            remote_access,
            console_port_plan.stable,
        ),
        sink.clone(),
    )
    .with_observer(lease_observer())
    .start_on_port(console_port_plan.preferred)
    .map_err(|error| format!("Failed to start staged console: {error}"))?;
    report_console_port_outcome(
        app,
        &data_dir,
        remote_access.console_port,
        persisted_console_port,
        console_port_plan.stable,
        console.port(),
    );
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
        match start_cloudflare_tunnel_provider(app, remote_access, console.port()) {
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
    app: &AppHandle,
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
    )?
    .with_lease_hook(CloudflaredLeaseObserver {
        lease: RunLeaseObserver::new(app),
    });
    // Download-on-first-use only actually downloads when no system
    // `cloudflared` is on PATH -- see `ensure_cloudflared_available`'s doc
    // comment. `<app-data>/cloudflared/` mirrors `run_lease_root`'s
    // `<app-data>/run/` shape: a per-install cache, not shared across
    // profiles or machines.
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        provider = provider.with_cache_dir(app_data_dir.join("cloudflared"));
    }

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
    // Registered with the provider is all this start proves. Where the
    // hostname leads is not the adapter's to set (see
    // `PublicUrlProvider::origin_binding`), so it is not claimed here; the
    // origin verification watcher reports it.
    log::info!(
        "cloudflared registered a tunnel connection for {}; whether it reaches this console is not yet verified",
        handle.origin
    );
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

/// How long to wait for the public origin to answer before concluding
/// nothing is there. Short: the ngrok reuse decision runs this synchronously
/// on the bootstrap path before the console can open, and a live tunnel
/// answers in well under a second -- this only needs to be long enough to
/// not misclassify a slow-but-live edge as dead.
const ORIGIN_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// ngrok shows a one-time browser interstitial ("You are about to visit...")
/// to any request whose `User-Agent` looks like a browser, on the free plan
/// -- by design, not a bug (see the ngrok option copy in `remote-access.ts`
/// for the owner-facing note about this). A request FROM this app to its own
/// public origin (the probe below) is not a real visitor and must never be
/// shown that page: the interstitial would stand between the probe and the
/// console's origin-proof answer. This exact header, sent on any request,
/// makes ngrok's edge skip the interstitial and forward straight through.
/// Every other provider ignores an unknown request header, so the probe
/// sends it unconditionally rather than branching on the provider.
const NGROK_SKIP_BROWSER_WARNING_HEADER: &str = "ngrok-skip-browser-warning";
const NGROK_SKIP_BROWSER_WARNING_VALUE: &str = "true";

/// The console route that answers an origin-proof challenge
/// (`apps/console/src/app/api/origin-proof/route.ts`). Served by the console
/// itself, never proxied to the RI: a public origin that reaches the bare RI
/// port is exactly one of the misroutes this must catch.
const ORIGIN_PROOF_PATH: &str = "/api/origin-proof";

/// The console's environment variable holding this process's origin-proof
/// key. Listed in `CONSOLE_RUNTIME_ENV` (`scripts/ensure-console-stack.js`).
const ORIGIN_PROOF_KEY_ENV: &str = "PDPP_ORIGIN_PROOF_KEY";

/// A random key generated once per app process and given only to the
/// console this process starts. It is not a credential: it grants nothing
/// and guards nothing. It lets the console prove "I am the console this
/// process started" in a way an old console on a stale port, the RI, a
/// different DataConnect, or anything that once saw an answer cannot
/// imitate, because the probe sends a fresh challenge every time and the
/// key itself never leaves loopback.
fn origin_proof_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let mut bytes = [0_u8; 32];
        // A failed OS RNG leaves the key all zeros. The proof then still
        // identifies "a DataConnect console" but no longer "this one". That
        // weakens the check; it does not make it claim more than it did.
        if let Err(error) = getrandom::fill(&mut bytes) {
            log::warn!("Could not generate the origin-proof key: {error}");
        }
        hex::encode(bytes)
    })
}

/// A random proof generated once per app process for owner-password reveal.
/// Unlike `origin_proof_key`, this is authorization material: the RI accepts
/// it before returning the generated owner password. If the OS RNG fails,
/// startup must fail closed rather than fall back to a predictable value.
fn owner_credential_reveal_proof_key() -> Result<&'static str, String> {
    static KEY: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map(|()| hex::encode(bytes))
            .map_err(|error| format!("Could not generate the owner credential reveal proof: {error}"))
    })
    .as_deref()
    .map_err(ToString::to_string)
}

/// HMAC-SHA256 (RFC 2104) over `message`, hex-encoded. Written out over the
/// `sha2` crate already in the tree instead of adding an `hmac` dependency
/// for one call; pinned by the RFC 4231 test vector in this file's tests.
/// The console computes the same value with Node's `createHmac`.
fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut block_key = [0_u8; BLOCK];
    if key.len() > BLOCK {
        block_key[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block_key.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block_key.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    hex::encode(outer.finalize())
}

/// Ask `origin` to prove it is this process's console, and report what
/// answered.
///
/// Provider-neutral: it is an HTTP round trip through whatever the public
/// origin leads to, the same for every provider. That is the point. Two
/// failures were each invisible to an in-process check:
///
/// - ngrok: the SDK's `Forwarder` gives no reliable in-process signal that
///   the edge-side session has died. Its forwarding task only exits when
///   the local tunnel stream closes (`NgrokTunnel::is_forwarding_finished`),
///   but an edge session that silently drops leaves that task running while
///   every public request gets ngrok's `ERR_NGROK_3200` "endpoint is
///   offline" page (reproduced live, 2026-09-20).
/// - Cloudflare: a dashboard-managed tunnel ignores the `--url` the adapter
///   passes, so `cloudflared` stays connected and healthy while the
///   hostname routes to a console port from before a rebuild, answering
///   with some other service's 404 (reproduced live, 2026-09-22).
///
/// The previous check counted any response without an ngrok error header
/// as "reachable", so it passed the second case. Only a fresh challenge
/// answered with this process's key shows that the origin reaches THIS
/// console.
///
/// Redirects are not followed: the proof route never redirects, so a
/// redirect means something else answered (an access gateway, a login
/// page), and its status says more than wherever it led would.
fn probe_public_origin(origin: &str, key: &str) -> crate::remote_access::OriginProbeOutcome {
    use crate::remote_access::OriginProbeOutcome;
    let challenge = {
        let mut bytes = [0_u8; 16];
        let _ = getrandom::fill(&mut bytes);
        hex::encode(bytes)
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(ORIGIN_PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return OriginProbeOutcome::Unreachable {
                reason: format!("could not build an HTTP client: {error}"),
            }
        }
    };
    let url = format!(
        "{}{ORIGIN_PROOF_PATH}?challenge={challenge}",
        origin.trim_end_matches('/')
    );
    let response = match client
        .get(url)
        .header(NGROK_SKIP_BROWSER_WARNING_HEADER, NGROK_SKIP_BROWSER_WARNING_VALUE)
        .send()
    {
        Ok(response) => response,
        Err(error) => {
            return OriginProbeOutcome::Unreachable {
                reason: error_chain(&error.without_url()),
            }
        }
    };
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    classify_origin_proof(
        status,
        &body,
        &hmac_sha256_hex(key.as_bytes(), challenge.as_bytes()),
    )
}

/// `reqwest`'s own message is only "error sending request"; the cause the
/// owner can act on (DNS, TLS, refused) is further down the source chain.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// The pure half of `probe_public_origin`: did the answer carry the proof?
fn classify_origin_proof(
    status: u16,
    body: &str,
    expected_proof: &str,
) -> crate::remote_access::OriginProbeOutcome {
    use crate::remote_access::OriginProbeOutcome;
    if status == 200 && body.trim() == expected_proof {
        OriginProbeOutcome::ReachesThisConsole
    } else {
        OriginProbeOutcome::ReachesSomethingElse { status }
    }
}

/// Decide whether a held ngrok tunnel from a previous run can be reused for
/// this `start_managed_stack` call (see `should_reuse_ngrok_tunnel`), or
/// start a fresh one via `start_ngrok_provider` -- accepting a new random
/// hostname on ngrok's free plan, which is unavoidable whenever the tunnel
/// itself must actually change (no held tunnel, provider/posture turned off,
/// settings changed, the preferred forward port could not be reused, or the
/// held tunnel no longer reaches this console -- see `probe_public_origin`).
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
                .is_some_and(|origin| {
                    probe_public_origin(origin, origin_proof_key())
                        == crate::remote_access::OriginProbeOutcome::ReachesThisConsole
                })
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

/// Seconds between re-checks that the public origin is still reachable.
///
/// A tunnel is not a fact established once at startup; it is a claim that
/// decays. ngrok's agent can lose its session, the upstream endpoint can be
/// revoked, and the process can keep running throughout -- which is exactly
/// the case where the app used to keep reporting "up" indefinitely.
const ORIGIN_VERIFY_INTERVAL: Duration = Duration::from_secs(60);

/// How old a reading may be before it stops counting as evidence. Two
/// verification intervals, so one missed probe does not flip the status,
/// but a watcher that has actually stopped does. Written into every record
/// (`OriginVerification::stale_after`) so the console decays a reading by
/// the same rule instead of keeping its own copy of the number.
const ORIGIN_VERIFY_STALE_AFTER: u64 = 150;

/// Record an OBSERVATION of the public origin, with the time it was made.
///
/// Before this, the probe's answer was computed and then discarded, and
/// the record that did exist was never read by the console: the app knew
/// whether the tunnel was live and did not say so anywhere the owner could
/// see.
fn record_origin_verification(
    app: &AppHandle,
    origin: &str,
    outcome: crate::remote_access::OriginProbeOutcome,
    binding: crate::remote_access::OriginBinding,
    agent: Option<crate::remote_access::TunnelAgentHealth>,
) {
    let current = match load_remote_access_config(app) {
        Ok(config) => config,
        Err(error) => {
            log::error!(
                "Could not read the remote-access config to record a reachability check: {error}"
            );
            return;
        }
    };
    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let verification = crate::remote_access::OriginVerification {
        origin: origin.to_string(),
        checked_at,
        stale_after: ORIGIN_VERIFY_STALE_AFTER,
        outcome,
        binding,
        agent,
    };
    if current.origin_verified.as_ref() == Some(&verification) {
        return;
    }
    let updated = RemoteAccessConfig {
        origin_verified: Some(verification),
        ..current
    };
    if let Err(error) = save_remote_access_config(app, updated) {
        log::error!("Could not persist the origin reachability check: {error}");
    }
}

/// Read the selected provider's local agent health, if this process holds
/// one. The first runtime caller of either adapter's `health()`; before
/// this, both were reachable only from tests.
///
/// Observe-only and non-blocking: `try_lock`, so a tick that lands during a
/// stack restart reports `None` (no reading) instead of waiting on, or
/// interfering with, the restart. `health()` takes `&mut self` only to poll
/// a join handle or an exit flag; it never stops or restarts anything.
///
/// The two lookups mirror where each adapter's runtime lives today (see
/// `UnifiedRuntimeState::ngrok` and `UnifiedStack::cloudflare_tunnel`);
/// at most one is ever populated, because only one provider is selected.
fn read_tunnel_agent_health(app: &AppHandle) -> Option<crate::remote_access::TunnelAgentHealth> {
    let state = app.try_state::<UnifiedRuntimeState>()?;
    if let Ok(mut held) = state.ngrok.try_lock() {
        if let Some(held) = held.as_mut() {
            return Some(held.provider.health());
        }
    }
    let mut stack = state.stack.try_lock().ok()?;
    stack
        .as_mut()?
        .cloudflare_tunnel
        .as_mut()
        .map(|tunnel| tunnel.health())
}

/// Re-verify the public origin on an interval, so a tunnel that dies after a
/// successful start stops reporting as healthy, and a route that never
/// reached this console is reported instead of assumed.
///
/// Uses `probe_public_origin`, the same check the ngrok reuse path uses, so
/// there is exactly one definition of what reaching the console means. The
/// binding recorded next to it comes from the provider's own
/// `origin_binding()` answer; nothing here branches on the provider.
///
/// Cancellation: this returns as soon as shutdown has been requested, which
/// makes `Quitting` absorbing for this watcher -- it cannot write a fresh
/// "verified just now" record while the stack it describes is being torn
/// down.
pub(crate) fn spawn_origin_verification_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ORIGIN_VERIFY_INTERVAL).await;
            if shutdown_has_been_requested(&app) {
                log::debug!("Origin verification watcher stopping: shutdown requested");
                return;
            }
            let Ok(config) = load_remote_access_config(&app) else {
                continue;
            };
            let Some(origin) = config.fields.reference_origin.clone() else {
                continue;
            };
            if origin.trim().is_empty() {
                continue;
            }
            // Only a Public URL provider has a binding to report; any other
            // posture has nothing public to verify.
            let Ok(provider) = crate::remote_access_providers::resolve_public_url_provider(
                &config.posture,
                config.provider.as_deref(),
                config.ngrok.as_ref(),
                config.cloudflare_tunnel.as_ref(),
            ) else {
                continue;
            };
            let binding = provider.origin_binding();
            let agent = read_tunnel_agent_health(&app);
            let probe_app = app.clone();
            let probed = tauri::async_runtime::spawn_blocking(move || {
                let outcome = probe_public_origin(&origin, origin_proof_key());
                (origin, outcome)
            })
            .await;
            let Ok((origin, outcome)) = probed else {
                continue;
            };
            if outcome != crate::remote_access::OriginProbeOutcome::ReachesThisConsole {
                log::warn!(
                    "Public origin {origin} did not prove it reaches this console ({outcome:?}); \
                     reported as such rather than assumed up"
                );
            }
            record_origin_verification(&probe_app, &origin, outcome, binding, agent);
        }
    });
}

/// Has a shutdown been requested? Used to make `Quitting` absorbing for the
/// background watchers, which otherwise keep running (and can keep acting on
/// the stack) for the whole shutdown budget.
fn shutdown_has_been_requested(app: &AppHandle) -> bool {
    app.try_state::<UnifiedRuntimeState>()
        .and_then(|state| {
            state
                .shutdown
                .lock()
                .ok()
                .map(|shutdown| shutdown.requested || shutdown.complete)
        })
        .unwrap_or(false)
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
/// Where run leases live: `<app-data>/run/<label>.json`.
///
/// Resolved from the same `app_data_dir()` every other piece of app state
/// uses, so a lease is per-install and travels with the data it describes.
pub(crate) fn run_lease_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// Keeps one run lease in step with a supervised child.
///
/// The supervisor restarts children on its own, so this republishes on every
/// spawn (each restart is a new pid) and revokes when the supervisor finally
/// stops. A lease that outlives its process is not dangerous -- the reaper
/// verifies the pid's identity before acting -- but it is noise, and a lease
/// that is missing while the process runs is a real orphan risk.
struct RunLeaseObserver {
    /// `None` when the app-data directory could not be resolved. The
    /// observer then does nothing rather than failing the spawn: a missing
    /// lease costs cleanup on a later boot, a failed start costs the owner
    /// their session.
    app_data_dir: Option<PathBuf>,
    owner_pid: i32,
    owner_started_at_ticks: u64,
}

impl RunLeaseObserver {
    fn new(app: &AppHandle) -> Self {
        let owner_pid = std::process::id() as i32;
        let app_data_dir = run_lease_root(app)
            .inspect_err(|error| {
                log::warn!("Run leases are disabled for this session: {error}");
            })
            .ok();
        Self {
            app_data_dir,
            owner_pid,
            owner_started_at_ticks: crate::run_lease::process_start_ticks(owner_pid).unwrap_or(0),
        }
    }
}

impl crate::commands::process_supervisor::ProcessObserver for RunLeaseObserver {
    fn spawned(&self, label: &str, pid: u32, pgid: Option<i32>, port: u16) {
        let Some(app_data_dir) = self.app_data_dir.as_deref() else {
            return;
        };
        let pid = pid as i32;
        // Read the child's own start time rather than trusting "now": the
        // reaper compares this exact value to decide whether a pid still
        // belongs to us, so it has to come from the same source
        // (/proc/<pid>/stat) the reaper will read later.
        let Some(started_at_ticks) = crate::run_lease::process_start_ticks(pid) else {
            log::warn!(
                "Could not read the start time of '{label}' (pid {pid}); skipping its run lease"
            );
            return;
        };
        let lease = crate::run_lease::RunLease {
            label: label.to_string(),
            pid,
            pgid,
            started_at_ticks,
            owner_pid: self.owner_pid,
            owner_started_at_ticks: self.owner_started_at_ticks,
            port: Some(port),
        };
        if let Err(error) = lease.publish(app_data_dir) {
            // A missing lease costs cleanup on a later boot; it does not stop
            // this session working, so it must not fail the spawn.
            log::warn!("Failed to publish the run lease for '{label}': {error}");
        }
    }

    fn reaped(&self, label: &str) {
        let Some(app_data_dir) = self.app_data_dir.as_deref() else {
            return;
        };
        if let Err(error) = crate::run_lease::RunLease::revoke(app_data_dir, label) {
            log::warn!("Failed to revoke the run lease for '{label}': {error}");
        }
    }
}

/// Label for the `cloudflared` child's run lease.
///
/// `cloudflared` is the only Public URL provider that spawns an OS process:
/// ngrok is an embedded Rust SDK whose tunnel dies with this process's own
/// threads, so it has nothing to orphan and needs no lease.
pub(crate) const CLOUDFLARED_LEASE_LABEL: &str = "cloudflared";

/// Adapts the cloudflared provider's start/stop hook onto the same run-lease
/// machinery the supervised sidecars use.
struct CloudflaredLeaseObserver {
    lease: RunLeaseObserver,
}

impl crate::remote_access_cloudflare::CloudflaredLeaseHook for CloudflaredLeaseObserver {
    fn started(&self, pid: u32, pgid: Option<i32>, forwarded_port: u16) {
        use crate::commands::process_supervisor::ProcessObserver;
        // `forwarded_port` is the console's port, not a port cloudflared
        // binds itself; recorded for diagnosis only, and the reaper never
        // kills by port.
        self.lease
            .spawned(CLOUDFLARED_LEASE_LABEL, pid, pgid, forwarded_port);
    }

    fn stopped(&self) {
        use crate::commands::process_supervisor::ProcessObserver;
        self.lease.reaped(CLOUDFLARED_LEASE_LABEL);
    }
}

/// Reap sidecars left behind by app sessions that died without cleaning up.
///
/// Runs once at startup, BEFORE any sidecar is spawned, so a port an orphan
/// was holding is free by the time this session asks for one. Never kills a
/// process belonging to a live session -- see `run_lease::decide`.
pub(crate) fn reap_orphans_from_dead_sessions(app: &AppHandle) {
    let Ok(app_data_dir) = run_lease_root(app) else {
        log::warn!("Could not resolve the app-data directory; skipping orphan reaping");
        return;
    };
    let decisions = crate::run_lease::reap_orphans(&app_data_dir, std::process::id() as i32);
    let reaped = decisions
        .iter()
        .filter(|(_, decision)| matches!(decision, crate::run_lease::ReapDecision::Reaped { .. }))
        .count();
    if reaped > 0 {
        log::info!("Reaped {reaped} orphaned sidecar(s) left by earlier app sessions");
    }
}

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
    owner_password_source: OwnerPasswordSource,
    remote_access: RemoteAccessConfig,
    credential_encryption_key: Option<String>,
    database_encryption_key: Option<String>,
}

#[derive(Clone, Copy)]
enum OwnerPasswordSource {
    Configured,
    DesktopGenerated,
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
    let configured_password = configured_owner_password();
    let owner_password_source = if configured_password.is_some() {
        OwnerPasswordSource::Configured
    } else {
        OwnerPasswordSource::DesktopGenerated
    };
    let password = configured_password.unwrap_or(stored_credential);
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
        owner_password_source,
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

async fn bootstrap_and_open_console(
    app: AppHandle,
    should_show: bool,
    preserved_path: Option<String>,
) -> Result<(), BootstrapFailure> {
    set_status(&app, UnifiedStatus::Starting);

    let attach = attach_mode();
    let secrets_app = app.clone();
    let BootstrapSecrets {
        password,
        owner_password_source,
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
                owner_password_source,
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
        preserved_path,
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
    preserved_path: Option<String>,
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

    // A slow console is not a broken console. This retries with backoff for
    // the whole `CONSOLE_TOTAL_WAIT_BUDGET` and only reaches teardown once
    // waiting provably cannot help -- the sidecars are gone, or the budget
    // is spent. See `wait_for_console_with_retry`.
    if let Err(error) = wait_for_console_with_retry(
        &console_url,
        || managed_stack_is_registered(app, managed),
        CONSOLE_TOTAL_WAIT_BUDGET,
        CONSOLE_WAIT_TIMEOUT,
    )
    .await
    {
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
    let owner_cookie = match owner_session_cookie(&console_origin, &login.session_cookie) {
        Ok(cookie) => cookie,
        Err(error) => {
            teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
            return Err(error);
        }
    };
    let reveal_cookie = if managed {
        match owner_credential_reveal_proof_key().and_then(|proof| owner_credential_reveal_cookie(&console_origin, proof)) {
            Ok(cookie) => Some(cookie),
            Err(error) => {
                teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
                return Err(error);
            }
        }
    } else {
        None
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

    let console_origin_for_health_watch = console_origin.to_string();
    // `console_origin` is the bare, freshly-resolved origin this process
    // just started listening on -- see `console_url_preserving_path`'s doc
    // comment for why the navigation target's scheme/host/port must ALWAYS
    // come from here and never from `preserved_path`.
    let navigate_to = console_url_preserving_path(&console_origin, preserved_path.as_deref());
    let mut cookies = vec![owner_cookie];
    if let Some(cookie) = reveal_cookie {
        cookies.push(cookie);
    }

    if let Err(error) = create_or_update_console_window(app, navigate_to, cookies, should_show) {
        teardown_managed_on_error(app, managed, StopReason::BootstrapFailed);
        return Err(error);
    }
    spawn_console_deep_health_watch(console_origin_for_health_watch);
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
            if configured_owner_password().is_some() {
                OwnerPasswordSource::Configured
            } else {
                OwnerPasswordSource::DesktopGenerated
            },
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
        // Recovery always lands the owner at root: there is no "page they
        // were on" to return to -- the recovery window is a distinct
        // surface from the console, and the console had never successfully
        // opened yet in this session.
        None,
    )
    .await
}

/// The console window's current path+query, read BEFORE `teardown()` runs --
/// once teardown starts the window (and whatever page it was showing) is
/// gone, so this has to happen first or there is nothing left to read.
/// Never fails the caller: a missing window, an unreadable URL, or a path
/// that fails `ConsolePathAndQuery::parse`'s validation all fall back to
/// `None` (root) rather than blocking or erroring the restart -- per
/// `console_url_preserving_path`'s doc comment, reopening at root is a
/// papercut, failing to reopen at all is a brick.
fn console_path_before_restart(app: &AppHandle) -> Option<String> {
    let window = app.get_webview_window(CONSOLE_WINDOW_LABEL)?;
    let url = window
        .url()
        .inspect_err(|error| {
            log::warn!("console_path_before_restart: could not read the console window's URL, falling back to root: {error}");
        })
        .ok()?;
    let mut path_and_query = url.path().to_string();
    if let Some(query) = url.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    match ConsolePathAndQuery::parse(&path_and_query) {
        Some(_) => Some(path_and_query),
        None => {
            // `Url::path()` on a URL this process itself just navigated to
            // should never fail this validation -- if it somehow does
            // (a future `tauri::Url` behavior change, a scheme this
            // function was not written against), fail closed rather than
            // propagate a shape `console_url_preserving_path` was not
            // proven safe for.
            log::warn!(
                "console_path_before_restart: console URL path {path_and_query:?} failed validation, falling back to root"
            );
            None
        }
    }
}

pub(crate) async fn restart_after_remote_access_config(app: AppHandle) -> Result<(), String> {
    if !remote_access_configuration_supported() {
        return Err("Remote access requires the managed desktop stack".into());
    }
    let preserved_path = console_path_before_restart(&app);
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
    bootstrap_and_open_console(app, true, preserved_path)
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
///
/// Synchronous like `load_bootstrap_secrets` above, for the same reason: it
/// calls `load_or_create_credential_encryption_key`, which can block on a
/// D-Bus round trip to the OS keychain. Its caller in
/// `spawn_remote_access_config_watcher` must run it inside
/// `tokio::task::spawn_blocking`, never inline on the watcher's async task.
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

/// The view of `RemoteAccessConfig` that actually decides whether
/// `spawn_remote_access_config_watcher` should restart the stack.
///
/// `origin_verified` (`OriginVerification`, written by
/// `record_origin_verification` on every `ORIGIN_VERIFY_INTERVAL` tick --
/// currently 60s) carries a `checked_at` TIMESTAMP the app itself rewrites
/// on every reachability check, whether or not reachability actually
/// changed. Comparing the whole struct with `==` (the derived `PartialEq`,
/// which includes this field) meant the watcher's own downstream OBSERVER
/// (`spawn_origin_verification_watcher`) rewriting a timestamp looked
/// identical to an owner editing the file -- the watcher restarted the
/// entire managed stack roughly every 60 seconds, forever, for as long as
/// remote access was on. Confirmed live 2026-09-22: this is why remote
/// access was left OFF on Tim's machine. Same defect FAMILY as #208 (a
/// health check tearing down what it observes) and the pre-#218
/// `wait_for_console` (a timeout tearing down what it observes) -- here the
/// observer and the actor are two different watchers sharing one file, and
/// the actor's blunt whole-struct equality check could not tell "the app's
/// own other watcher just recorded an observation" from "the owner changed
/// something that needs a real restart."
///
/// `apply_ngrok_tunnel_outcome` (above) already solved this correctly for
/// its own writes back to this same file -- it compares only `fields` and
/// `tunnel_error` before writing, specifically so a config-watcher restart
/// settles instead of looping. This function generalizes that same
/// discipline to the READ side: strip every field this app itself
/// populates as an OBSERVATION (currently just `origin_verified`) before
/// comparing, so only a change an owner actually made -- or a real ngrok/
/// Cloudflare outcome landing -- looks like a change worth restarting for.
fn restart_relevant_view(config: &RemoteAccessConfig) -> RemoteAccessConfig {
    RemoteAccessConfig {
        origin_verified: None,
        ..config.clone()
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
            // `Quitting` is absorbing: without this the watcher can see a
            // config change and call `restart_after_remote_access_config`
            // -- rebuilding the very stack shutdown is tearing down -- for
            // the whole shutdown budget.
            if shutdown_has_been_requested(&app) {
                log::debug!("Remote-access config watcher stopping: shutdown requested");
                return;
            }
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
                let blocking_app = app.clone();
                match tokio::task::spawn_blocking(move || {
                    apply_pending_ngrok_authtoken(&blocking_app, current)
                })
                .await
                {
                    Ok(config) => config,
                    Err(error) => {
                        log::error!("Pending ngrok authtoken task failed: {error}");
                        continue;
                    }
                }
            } else {
                current
            };
            let current = if current.cloudflare_tunnel_token_sealed.is_some() {
                let blocking_app = app.clone();
                match tokio::task::spawn_blocking(move || {
                    apply_pending_cloudflare_tunnel_token(&blocking_app, current)
                })
                .await
                {
                    Ok(config) => config,
                    Err(error) => {
                        log::error!("Pending Cloudflare tunnel token task failed: {error}");
                        continue;
                    }
                }
            } else {
                current
            };
            if restart_relevant_view(&current) == restart_relevant_view(&last_applied) {
                last_applied = current;
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
            if shutdown_has_been_requested(&app) {
                log::debug!("Autostart watcher stopping: shutdown requested");
                return;
            }
        }
    });
}

fn tick_autostart_watcher(app: &AppHandle) -> Result<(), String> {
    use crate::commands::desktop_settings::{
        apply_autostart_desired_state, autostart_state_path, load_autostart_state,
        save_autostart_state, LoadedAutostartState,
    };
    use tauri_plugin_autostart::ManagerExt;

    let path = autostart_state_path(app)?;
    // A missing file needs no repair (normal on first-ever launch); a
    // CORRUPT file (e.g. zero bytes from a process killed mid-write) is
    // repaired immediately below by seeding+persisting the default state,
    // so the identical parse failure cannot recur on the next tick. This
    // is the fix for the reported incident: before this, a corrupt file
    // was a hard error with no recovery, so the same "Failed to parse
    // autostart state: EOF while parsing a value at line 1 column 0"
    // fired every ~3s forever.
    let current = match load_autostart_state(&path)? {
        LoadedAutostartState::Present(state) => Some(state),
        LoadedAutostartState::Missing => None,
        LoadedAutostartState::Corrupt(error) => {
            log::warn!(
                "Autostart state file was empty or corrupt ({error}); resetting it to a fresh default instead of retrying the same parse failure forever"
            );
            None
        }
    };
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

/// `wait_for_console` gates bootstrap: while it returns `Err`, `finish_bootstrap`
/// tears down the whole managed stack (console + reference implementation)
/// and retries from scratch (see `finish_bootstrap`'s caller). That makes it
/// the one check in this file where a false negative is not merely
/// unhelpful -- it is destructive. A prior version of this function required
/// EVERY route in `CONSOLE_HEALTH_CHECK_PATHS` (including `/connect`, an
/// owner-session-gated route -- see its server component's `refFetch` ->
/// `verifyDashboardSession` call) to pass a deep asset-reference check
/// before counting the console as up. Confirmed live: this made a
/// perfectly healthy console -- serving `/settings` with 0 JS errors, 0
/// 5xx -- report unhealthy forever, because the health check's bare
/// `reqwest::Client` carries no owner session cookie and `/connect` never
/// answers that check the way an authenticated browser tab would. The
/// stack tore down, restarted, and repeated the same failure in a loop:
/// the exact "console reports unhealthy" incident this whole chain of
/// fixes exists to catch, except the health check itself was now the
/// cause, not the cure.
///
/// So `wait_for_console` only proves LIVENESS: does the console's HTTP
/// port answer at all, with a status that isn't a server error. That is
/// the one fact bootstrap actually needs before it is safe to open the
/// window and hand control to the owner -- and it is also the one fact
/// that stays true regardless of which route happens to need a session
/// this bare client doesn't carry. The deeper stale-build check (does the
/// page's own referenced asset actually resolve, across more than one
/// route) still exists -- see `spawn_console_deep_health_watch` below --
/// but it runs AFTER the window is already open and NEVER tears anything
/// down on failure, only logs. A health check must be able to say "I
/// don't know" without being able to say "so I killed it."
async fn wait_for_console(url: &str) -> Result<(), String> {
    wait_for_console_round(url, CONSOLE_WAIT_TIMEOUT).await
}

/// One readiness round with an explicit budget, so tests can exercise the
/// retry behaviour without waiting out the production round length.
async fn wait_for_console_round(url: &str, round_timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + round_timeout;
    let mut last_error = "no attempt completed".to_string();
    while tokio::time::Instant::now() < deadline {
        match client.get(url).send().await {
            Ok(response) if response_proves_the_server_is_alive(response.status()) => return Ok(()),
            Ok(response) => last_error = format!("page responded {}", response.status()),
            Err(error) => last_error = format!("page request failed: {error}"),
        }
        tokio::time::sleep(CONSOLE_POLL_INTERVAL).await;
    }
    Err(format!(
        "Console at {url} did not answer within {round_timeout:?}: {last_error}"
    ))
}

/// Is a managed sidecar stack still registered with the app?
///
/// Used as the "waiting longer could still help" signal while the console
/// starts. The stack is taken out of `UnifiedRuntimeState` by every
/// teardown path, so its absence means the supervisor is no longer running
/// these sidecars and no amount of further polling will produce a console.
/// In attach mode there is no managed stack to lose, so this reports true
/// and the total budget alone bounds the wait.
fn managed_stack_is_registered(app: &AppHandle, managed: bool) -> bool {
    if !managed {
        return true;
    }
    app.try_state::<UnifiedRuntimeState>()
        .and_then(|state| state.stack.lock().ok().map(|stack| stack.is_some()))
        .unwrap_or(false)
}

/// Wait for the console to answer, retrying with backoff, and only give up
/// when the console PROCESS is gone or the total budget is spent.
///
/// The principle this enforces, earned the hard way: **an observation
/// mechanism must never be able to destroy the thing it observes.** #216
/// neutralised the deep multi-route check, which could report a working
/// console unhealthy and tear the stack down. This closes the same PATTERN
/// one level up: `wait_for_console`'s own fixed 45s bare-liveness timeout
/// still fed an unconditional, non-retrying `teardown_managed_on_error`.
/// A console that is merely SLOW would be killed for being slow, and the
/// kill makes the retry strictly worse, not better -- the next attempt
/// starts from nothing.
///
/// So a round that times out is now a REPORT ("not answering yet"), not a
/// verdict. Rounds repeat with exponential backoff until either the
/// console answers, the total budget is spent, or `console_is_running`
/// says the process itself has exited -- the one condition where waiting
/// longer genuinely cannot help, and the only one that should end in
/// teardown.
async fn wait_for_console_with_retry<IsRunning>(
    url: &str,
    console_is_running: IsRunning,
    total_budget: Duration,
    round_timeout: Duration,
) -> Result<(), String>
where
    IsRunning: Fn() -> bool,
{
    let started = tokio::time::Instant::now();
    let mut backoff = CONSOLE_RETRY_INITIAL_BACKOFF;
    let mut round = 1u32;
    let mut last_error;

    loop {
        match wait_for_console_round(url, round_timeout).await {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }

        // The process is gone: more waiting cannot help, and the supervisor
        // has already surfaced the real reason.
        if !console_is_running() {
            return Err(format!(
                "Console process exited before it answered: {last_error}"
            ));
        }

        let elapsed = started.elapsed();
        if elapsed >= total_budget {
            return Err(format!(
                "Console at {url} did not answer within {total_budget:?} across {round} \
                 attempts: {last_error}"
            ));
        }

        log::warn!(
            "Console has not answered after {elapsed:?} (attempt {round}); it is still \
             running, so retrying in {backoff:?} rather than stopping it: {last_error}"
        );
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(CONSOLE_RETRY_MAX_BACKOFF);
        round += 1;
    }
}

/// Routes the best-effort deep health watch checks after the console window
/// is already open. `/connect` is included deliberately, in spite of it
/// being the exact route whose owner-session gate caused the fatal-teardown
/// incident this file's history records -- the fix for that incident is
/// "never fatal", not "stop checking the route that matters", and
/// `verify_console_serves_a_real_route` now treats a 401/403 (or a
/// redirect, which an authenticated retry will naturally follow once a
/// session exists) as proof of life rather than a failure. See
/// `response_proves_the_server_is_alive`.
const CONSOLE_HEALTH_CHECK_PATHS: [&str; 2] = ["", "connect"];
const CONSOLE_DEEP_HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Runs after the console window is already open and the owner already has
/// control. Polls `CONSOLE_HEALTH_CHECK_PATHS` on a slow interval for as
/// long as the app runs and logs a warning on failure -- this is
/// observability, not a gate. Nothing in this function is allowed to call
/// `teardown_managed_on_error` or any other stack-affecting action; that is
/// the entire point of separating it from `wait_for_console`. See
/// `wait_for_console`'s doc comment for the incident this split exists to
/// prevent from recurring.
pub(crate) fn spawn_console_deep_health_watch(url: String) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            tokio::time::sleep(CONSOLE_DEEP_HEALTH_CHECK_INTERVAL).await;
            if let Err(error) = verify_console_health_check_routes(&client, &url).await {
                log::warn!(
                    "Console deep health check failed (not fatal, no action taken): {error}"
                );
            }
        }
    });
}

/// One attempt across every route in `CONSOLE_HEALTH_CHECK_PATHS`. All must
/// pass for the console to count as healthy -- see `wait_for_console`'s doc
/// comment for why checking only one route is not enough, and why this
/// function's own failures are logged, never fatal.
async fn verify_console_health_check_routes(client: &reqwest::Client, base_url: &str) -> Result<(), String> {
    let trimmed_base = base_url.trim_end_matches('/');
    for path in CONSOLE_HEALTH_CHECK_PATHS {
        let route_url = format!("{trimmed_base}/{path}");
        verify_console_serves_a_real_route(client, &route_url)
            .await
            .map_err(|error| format!("route {route_url}: {error}"))?;
    }
    Ok(())
}

/// One attempt: fetch `url`, extract a static asset it references, fetch
/// that asset too. Both requests must succeed for the console to count as
/// genuinely serving a real route -- see `wait_for_console`'s doc comment
/// for why a bare shell-HTML 200 is not enough.
/// A route this process itself gates behind the owner session
/// (`verifyDashboardSession` / `refFetch` in the console's own TypeScript --
/// see `/connect`'s server component, which calls `listCimdClientDocuments`)
/// answers a health-check request that carries no session cookie with a 401
/// or 403, or Next's `redirect()` to `/owner/login`. Both are proof the
/// server is alive and serving real application logic, not the stale-build
/// symptom this check exists to catch (a stale build answers 200 from
/// memory with broken asset references, not an auth challenge) -- treating
/// either as unhealthy previously killed a perfectly working stack every
/// time the health check reached an authenticated route without a session.
/// See `wait_for_console`'s doc comment for the incident this caused.
fn response_proves_the_server_is_alive(status: reqwest::StatusCode) -> bool {
    status.is_success()
        || status.is_redirection()
        || status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
}

async fn verify_console_serves_a_real_route(client: &reqwest::Client, url: &str) -> Result<(), String> {
    let page = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("page request failed: {error}"))?;
    let status = page.status();
    if !response_proves_the_server_is_alive(status) {
        return Err(format!("page responded {status}"));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // An auth challenge has no page to extract an asset from (and no
        // reason to have one) -- the challenge itself is the proof of life.
        return Ok(());
    }
    let page_url = page.url().clone();
    // A redirect actually happened if the final URL differs from the one
    // requested (`reqwest::Client::new()` follows redirects by default and
    // updates `.url()` to the final landing page -- see its docs). Confirmed
    // live against this repo's own RS: an unauthenticated `/connect`
    // redirects to `/owner/login`, a plain server-rendered HTML page with NO
    // Next.js build (no `/_next/` reference at all -- it is not part of the
    // console's Next app; see `owner-login-ui.ts`). That is legitimate,
    // proven-alive routing logic, the opposite of the stale-build symptom
    // this check exists to catch (which answers 200 on the SAME url with a
    // broken asset reference, never redirects anywhere). Only a same-URL
    // response with no asset to check is treated as suspicious.
    let followed_a_redirect = page_url.as_str() != url;
    let body = page
        .text()
        .await
        .map_err(|error| format!("failed to read page body: {error}"))?;

    let Some(asset_path) = extract_first_static_asset_url(&body) else {
        if followed_a_redirect {
            return Ok(());
        }
        return Err("page HTML referenced no static asset to verify".to_string());
    };
    let asset_url = page_url
        .join(&asset_path)
        .map_err(|error| format!("could not resolve asset URL {asset_path:?}: {error}"))?;

    let asset = client
        .get(asset_url.clone())
        .send()
        .await
        .map_err(|error| format!("asset request to {asset_url} failed: {error}"))?;
    if !asset.status().is_success() {
        return Err(format!(
            "page HTML referenced {asset_url}, which responded {} -- the running build's HTML and its own assets disagree, the exact stale-build symptom this check exists to catch",
            asset.status()
        ));
    }
    Ok(())
}

/// Pull the first `/_next/static/...` (or any `/_next/...`) asset path out
/// of a Next.js page's `src="..."` / `href="..."` attributes. Kept as a
/// pure string function, separate from the network calls in
/// `verify_console_serves_a_real_route`, so the extraction logic itself can
/// be unit-tested against real captured HTML without a running server.
fn extract_first_static_asset_url(html: &str) -> Option<String> {
    const NEEDLE: &str = "/_next/";
    let mut search_from = 0usize;
    while let Some(relative_start) = html[search_from..].find(NEEDLE) {
        let start = search_from + relative_start;
        // The needle must be the start of a quoted attribute value
        // (src="..." or href="...") -- reject a bare text mention so this
        // can't be fooled by, say, a copyright comment containing the
        // string "/_next/".
        let quote_ok = start > 0
            && matches!(html.as_bytes()[start - 1], b'"' | b'\'');
        if quote_ok {
            let quote = html.as_bytes()[start - 1];
            if let Some(end_offset) = html[start..].find(quote as char) {
                return Some(html[start..start + end_offset].to_string());
            }
        }
        search_from = start + NEEDLE.len();
    }
    None
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

fn owner_credential_reveal_cookie(url: &tauri::Url, value: &str) -> Result<Cookie<'static>, String> {
    let _host = url
        .host_str()
        .ok_or_else(|| "Console URL has no cookie host".to_string())?;
    Ok(Cookie::build((OWNER_CREDENTIAL_REVEAL_COOKIE, value.to_string()))
        .path("/")
        .http_only(true)
        .build())
}

/// Opens an external link clicked inside the console window in the owner's
/// real system browser, instead of navigating the console window itself
/// away from the console entirely.
///
/// This is `on_navigation`, which fires on every navigation attempt inside
/// the webview -- including a plain `<a>` click with no `target="_blank"`
/// needed, unlike `on_new_window` (which only fires for `window.open()`,
/// confirmed NOT to fire for anchor activation on WebKitGTK by an actual
/// click in Tim's real build: a plain `target="_blank"` anchor did nothing,
/// twice, across two design rounds). `on_navigation` has no such gap: it is
/// the same hook Tauri's own docs recommend for navigation allowlisting,
/// and it requires no trusted user-gesture context the way `window.open()`
/// does (WebKit blocks `window.open` from synthetic/untrusted event
/// contexts, which independently made that path hard to verify without a
/// real human click).
///
/// Returning `false` cancels the navigation; the console window itself
/// never navigates away. Returning `true` lets it proceed normally --
/// required for the console's OWN pages (moving between `/settings`,
/// `/connect`, etc., and the one-time initial `window.navigate(url)` call
/// in `create_or_update_console_window` below, which this same handler also
/// sees). `is_console_origin` below is what tells the two cases apart: same
/// scheme+host+port as the console's own origin is allowed through
/// unconditionally; anything else is treated as an external link.
///
/// Three prior fixes (#186's capability grant, #200's `"__TAURI__" in
/// window` check, #209's `pdpp_desktop_bridge` marker cookie) all died the
/// same way: a JS-side check deciding whether to attempt the native path,
/// which either evaluated false unconditionally (#186, #200) or measurably
/// never received the signal it was waiting for (#209 -- the cookie never
/// landed in the real webview's cookie store before the page ran). This
/// handler has no such check to fail: it is attached to the window object
/// itself in Rust at construction time, independent of anything the page's
/// own JS can observe or get wrong.
///
/// `https:` only for anything treated as external -- this is the one place
/// a URL from the console can reach `open::that_detached` at all, so the
/// allowlist lives entirely here now. Rejects `file:`, `javascript:`,
/// `data:`, and deliberately excludes `http:` too (which would let a
/// compromised page target loopback services via the OS opener) -- the
/// same rationale the now-deleted HTTP-bridge design's `open_external_url.
/// rs::validate_external_url` used, just enforced once here instead of
/// twice across a process boundary that no longer exists.
fn is_console_origin(url: &tauri::Url, console_origin: &tauri::Url) -> bool {
    url.scheme() == console_origin.scheme()
        && url.host_str() == console_origin.host_str()
        && url.port_or_known_default() == console_origin.port_or_known_default()
}

/// Set to `1` to make `decide_console_navigation` log what it WOULD open
/// instead of actually calling `open::that_detached` -- for verification
/// runs (this file's own unit tests, a standalone repro binary, or a
/// scripted click against a real build) that need to prove the decision
/// fires correctly without launching the OS's real system browser. `open::
/// that_detached` shells out to `xdg-open` on Linux, which talks to
/// whatever desktop session is actually running, NOT the `DISPLAY` the
/// calling process was launched with -- wrapping a verification run in an
/// isolated Xvfb display does not contain this, confirmed the hard way: an
/// earlier verification run under this exact wrapper still opened a tab in
/// the owner's real, already-running browser, because `xdg-open`'s
/// single-instance handoff reaches the owner's live session regardless of
/// which display launched the calling process. Unset (the production
/// default) leaves behavior unchanged.
const OPEN_EXTERNAL_DRY_RUN_ENV_VAR: &str = "PDPP_OPEN_EXTERNAL_DRY_RUN";

fn open_external_dry_run_is_enabled() -> bool {
    std::env::var(OPEN_EXTERNAL_DRY_RUN_ENV_VAR).as_deref() == Ok("1")
}

/// Logs every navigation decision at `info`, unconditionally -- no debug
/// build needed -- so a real click against a packaged app is independently
/// checkable from the ordinary app log, not just from this file's own unit
/// tests. Three outcomes, one line each: `allowed-internal` (navigation
/// matches the console's own origin, proceeds normally),
/// `opened-externally` (denied in-app, handed to `open::that_detached`),
/// `refused` (denied, non-`https:` scheme, nothing opened). This is the
/// single place all three are decided, so this is also the single place
/// that needs to log them.
fn decide_console_navigation(url: &tauri::Url, console_origin: &tauri::Url) -> bool {
    if is_console_origin(url, console_origin) {
        log::info!("on_navigation: url={url} decision=allowed-internal");
        return true;
    }
    if url.scheme() == "https" {
        if open_external_dry_run_is_enabled() {
            log::info!("on_navigation: url={url} decision=opened-externally (dry run: would open {url})");
        } else {
            match open::that_detached(url.as_str()) {
                Ok(()) => log::info!("on_navigation: url={url} decision=opened-externally"),
                Err(error) => log::error!(
                    "on_navigation: url={url} decision=opened-externally failed to open: {error}"
                ),
            }
        }
    } else {
        log::warn!("on_navigation: url={url} decision=refused (non-https scheme)");
    }
    false
}

fn set_cookies_then_navigate<SetCookies, Navigate>(
    set_cookies: SetCookies,
    navigate: Navigate,
) -> Result<(), String>
where
    SetCookies: FnOnce() -> Result<(), String>,
    Navigate: FnOnce() -> Result<(), String>,
{
    set_cookies()?;
    navigate()
}

/// A path+query string safe to append to a FRESH console origin this
/// process just built (never to a URL parsed from anywhere else). Rejects
/// anything that is not exactly one leading `/` followed by no further `/`
/// at the start (which would make it protocol-relative, e.g. `//evil.example`
/// resolving off-host per the browser's own URL-resolution rules -- the
/// same class of bug as the `is_local_url` CVE documented in
/// `local/HOST-BRIDGE-DESIGN-0918.md`) and rejects any backslash (some
/// browser/webview URL parsers normalize `\` to `/`, which can smuggle a
/// second slash past a naive `starts_with("//")` check).
///
/// Deliberately a NEWTYPE, not a bare `String`: the only way to get one is
/// through `parse`, which enforces the invariant once, so nothing downstream
/// can accidentally construct or receive an unvalidated path here — the
/// compiler, not code review, is what stops a future caller from skipping
/// validation.
struct ConsolePathAndQuery(String);

impl ConsolePathAndQuery {
    fn parse(raw: &str) -> Option<Self> {
        if !raw.starts_with('/') || raw.starts_with("//") || raw.contains('\\') {
            return None;
        }
        Some(Self(raw.to_string()))
    }
}

/// Rebuilds a console URL to navigate to after a restart: the origin ALWAYS
/// comes from `console_origin` (the freshly resolved `http://127.0.0.1:{new
/// port}` this process just started listening on, never from anything
/// carried over) — only the path+query may survive from `previous_path`.
/// This is the one place scheme/host/port could leak from an untrusted
/// source into the URL this app navigates its own authenticated webview to,
/// so it is structured so that cannot happen even if a caller passes a
/// malicious `previous_path`: `ConsolePathAndQuery::parse` is the only
/// entry point for the path half, and it fails closed to `console_origin`
/// unchanged (no path) rather than erroring, matching "reopening at root is
/// a papercut, refusing to reopen is a brick."
fn console_url_preserving_path(
    console_origin: &tauri::Url,
    previous_path: Option<&str>,
) -> tauri::Url {
    let Some(raw) = previous_path else {
        return console_origin.clone();
    };
    let Some(path_and_query) = ConsolePathAndQuery::parse(raw) else {
        log::warn!(
            "console_url_preserving_path: rejected path {raw:?} for restart redirect, falling back to root"
        );
        return console_origin.clone();
    };
    let mut url = console_origin.clone();
    // `set_path` alone would percent-encode a literal `?` in the query
    // string into the path segment; splitting query off first keeps it in
    // `Url`'s own query slot, which is what `Url`'s output rendering and
    // every consumer of this URL (the webview, `is_console_origin`) expects.
    match path_and_query.0.split_once('?') {
        Some((path, query)) => {
            url.set_path(path);
            url.set_query(Some(query));
        }
        None => {
            url.set_path(&path_and_query.0);
            url.set_query(None);
        }
    }
    url
}

fn create_or_update_console_window(
    app: &AppHandle,
    url: tauri::Url,
    cookies: Vec<Cookie<'static>>,
    should_show: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        set_cookies_then_navigate(
            || {
                for cookie in &cookies {
                    window
                        .set_cookie(cookie.clone())
                        .map_err(|error| format!("Failed to set console cookie: {error}"))?;
                }
                Ok(())
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
    let console_origin_for_navigation = url.clone();
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
            // See `decide_console_navigation`'s doc comment for why this
            // exists and why it lives here (set once, on the builder, at
            // the console window's own construction) rather than as
            // anything the page's JS decides.
            .on_navigation(move |url| decide_console_navigation(url, &console_origin_for_navigation))
            .build()
            .map_err(|error| format!("Failed to create console window: {error}"))?;

    set_cookies_then_navigate(
        || {
            for cookie in cookies {
                window
                    .set_cookie(cookie)
                    .map_err(|error| format!("Failed to set console cookie: {error}"))?;
            }
            Ok(())
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
            // with no exit code. lib.rs keeps unified mode resident in the
            // tray for that case, as it was while a hidden legacy window
            // existed; the tray's Quit is what reaches request_shutdown.
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

    #[test]
    fn unhandled_deep_link_notice_omits_the_grant_secret() {
        let url: tauri::Url = "vana://connect?sessionId=s-1&secret=hunter2&scopes=a"
            .parse()
            .expect("url");
        let notice = unhandled_deep_link_notice(&url);
        assert!(notice.contains("vana://connect"), "{notice}");
        assert!(!notice.contains("hunter2") && !notice.contains("s-1"), "{notice}");
    }

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

    // Captured verbatim from this repo's own `apps/console/.next/server/
    // app/_global-error.html` (a real Next.js standalone-mode server-
    // rendered response), so this test exercises the real HTML shape, not
    // a hand-simplified fixture that might not match what Next actually
    // emits.
    const REAL_NEXT_HTML_FRAGMENT: &str = r#"<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-1965db51f108a349.js"/><script src="/_next/static/chunks/87c73c54-fe9448718f10265c.js" async=""></script></head><body></body></html>"#;

    #[test]
    fn extract_first_static_asset_url_finds_the_preload_link_in_real_next_html() {
        assert_eq!(
            extract_first_static_asset_url(REAL_NEXT_HTML_FRAGMENT),
            Some("/_next/static/chunks/webpack-1965db51f108a349.js".to_string())
        );
    }

    #[test]
    fn extract_first_static_asset_url_prefers_the_first_reference_in_document_order() {
        let html = r#"<html><head><script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script></head></html>"#;
        assert_eq!(
            extract_first_static_asset_url(html),
            Some("/_next/static/chunks/a.js".to_string())
        );
    }

    #[test]
    fn extract_first_static_asset_url_ignores_an_unquoted_mention() {
        // A copyright string or comment containing the literal text must
        // not be mistaken for a real asset reference -- only a quoted
        // attribute value counts.
        let html = "<!-- built from /_next/internal-tooling --><html></html>";
        assert_eq!(extract_first_static_asset_url(html), None);
    }

    #[test]
    fn extract_first_static_asset_url_returns_none_for_a_page_with_no_next_assets() {
        assert_eq!(
            extract_first_static_asset_url("<html><body>plain</body></html>"),
            None
        );
    }

    #[test]
    fn extract_first_static_asset_url_handles_single_quoted_attributes() {
        let html = r#"<script src='/_next/static/chunks/single-quoted.js'></script>"#;
        assert_eq!(
            extract_first_static_asset_url(html),
            Some("/_next/static/chunks/single-quoted.js".to_string())
        );
    }

    /// A minimal single-connection-at-a-time raw-TCP HTTP server for testing
    /// `verify_console_serves_a_real_route` against real network I/O without
    /// pulling in a full Node fixture (the `node_script` pattern
    /// `process_supervisor.rs` uses for its `Readiness::HttpGet` tests) --
    /// this only needs to serve two fixed, scripted responses, so a raw
    /// listener is simpler than shelling out. Serves requests on a
    /// background thread until `shutdown` is called; each response is
    /// looked up by exact request path from `routes`.
    struct FakeHttpServer {
        addr: std::net::SocketAddr,
        shutdown: Arc<std::sync::atomic::AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl FakeHttpServer {
        /// Answers 503 until `ready` flips to true, then 200.
        ///
        /// Models a console that is still starting: the port is bound (so
        /// the connection succeeds) but the app is not serving yet, which
        /// is exactly the state a cold boot sits in for a while.
        fn start_gated(ready: Arc<std::sync::atomic::AtomicBool>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake http server");
            listener
                .set_nonblocking(true)
                .expect("nonblocking listener");
            let addr = listener.local_addr().expect("listener addr");
            let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let shutdown_for_thread = Arc::clone(&shutdown);
            let handle = thread::spawn(move || {
                use std::io::{Read, Write};
                while !shutdown_for_thread.load(std::sync::atomic::Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                            let mut buf = [0u8; 4096];
                            let _ = stream.read(&mut buf).unwrap_or(0);
                            let serving = ready.load(std::sync::atomic::Ordering::SeqCst);
                            let status = if serving {
                                "200 OK"
                            } else {
                                "503 Service Unavailable"
                            };
                            let body = if serving { "<html>up</html>" } else { "" };
                            let response = format!(
                                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                addr,
                shutdown,
                handle: Some(handle),
            }
        }

        /// `routes` maps a request path (e.g. `"/"`) to `(status_line,
        /// body)`, e.g. `("200 OK", "<html>...")`.
        fn start(routes: Vec<(&'static str, (&'static str, &'static str))>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake http server");
            listener.set_nonblocking(true).expect("nonblocking listener");
            let addr = listener.local_addr().expect("listener addr");
            let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let shutdown_for_thread = Arc::clone(&shutdown);
            let handle = thread::spawn(move || {
                use std::io::{Read, Write};
                while !shutdown_for_thread.load(std::sync::atomic::Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .ok();
                            let mut buf = [0u8; 4096];
                            let read = stream.read(&mut buf).unwrap_or(0);
                            let request = String::from_utf8_lossy(&buf[..read]);
                            let path = request
                                .lines()
                                .next()
                                .and_then(|line| line.split_whitespace().nth(1))
                                .unwrap_or("/");
                            let (status, body) = routes
                                .iter()
                                .find(|(route_path, _)| *route_path == path)
                                .map(|(_, response)| *response)
                                .unwrap_or(("404 Not Found", ""));
                            // A body prefixed "REDIRECT_TO:<path>" encodes a
                            // real `Location` header instead of a response
                            // body -- lets a test exercise an actual
                            // followed redirect (reqwest::Client::new()
                            // follows redirects by default) without adding
                            // a whole separate response-header API to this
                            // minimal fake server.
                            let location_header = body
                                .strip_prefix("REDIRECT_TO:")
                                .map(|target| format!("Location: {target}\r\n"))
                                .unwrap_or_default();
                            let response_body = if location_header.is_empty() { body } else { "" };
                            let response = format!(
                                "HTTP/1.1 {status}\r\n{location_header}Content-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                                response_body.len()
                            );
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(ref error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                addr,
                shutdown,
                handle: Some(handle),
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }
    }

    impl Drop for FakeHttpServer {
        fn drop(&mut self) {
            self.shutdown.store(true, std::sync::atomic::Ordering::Release);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_passes_when_the_page_and_its_own_asset_both_resolve() {
        let server = FakeHttpServer::start(vec![
            (
                "/",
                (
                    "200 OK",
                    r#"<html><head><script src="/_next/static/chunks/app.js"></script></head></html>"#,
                ),
            ),
            ("/_next/static/chunks/app.js", ("200 OK", "console.log(1)")),
        ]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/")).await;
        assert!(result.is_ok(), "expected success, got {result:?}");
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_fails_the_exact_stale_build_shape_html_200_asset_404() {
        // This is the actual incident: the shell HTML answers 200 from a
        // build the process still has in memory, but the asset that same
        // HTML references 404s because the on-disk directory moved under
        // it. A bare status-code check on `/` alone would call this
        // healthy; this function must not.
        let server = FakeHttpServer::start(vec![(
            "/",
            (
                "200 OK",
                r#"<html><head><script src="/_next/static/chunks/stale-chunk.js"></script></head></html>"#,
            ),
        )]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/")).await;
        assert!(result.is_err(), "expected the stale-build shape to be rejected");
        let message = result.unwrap_err();
        assert!(
            message.contains("stale-chunk.js"),
            "error should name the asset that failed, got: {message}"
        );
        assert!(
            message.contains("404"),
            "error should surface the asset's real status, got: {message}"
        );
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_fails_honestly_when_the_page_has_no_asset_to_check() {
        // A page whose HTML never references a /_next/ asset at all --
        // this function must refuse to call that a pass rather than
        // silently skipping the check it exists to perform.
        let server = FakeHttpServer::start(vec![("/", ("200 OK", "<html><body>empty</body></html>"))]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/")).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no static asset"));
    }

    #[tokio::test]
    async fn verify_console_health_check_routes_passes_when_every_checked_route_is_healthy() {
        let server = FakeHttpServer::start(vec![
            (
                "/",
                (
                    "200 OK",
                    r#"<html><head><script src="/_next/static/chunks/root.js"></script></head></html>"#,
                ),
            ),
            ("/_next/static/chunks/root.js", ("200 OK", "console.log('root')")),
            (
                "/connect",
                (
                    "200 OK",
                    r#"<html><head><script src="/_next/static/chunks/connect.js"></script></head></html>"#,
                ),
            ),
            ("/_next/static/chunks/connect.js", ("200 OK", "console.log('connect')")),
        ]);
        let client = reqwest::Client::new();
        let result = verify_console_health_check_routes(&client, &server.url("")).await;
        assert!(result.is_ok(), "expected success, got {result:?}");
    }

    #[tokio::test]
    async fn verify_console_health_check_routes_catches_a_route_specific_failure_the_root_alone_would_miss() {
        // Each App Router route has its OWN client-reference manifest, loaded
        // from disk lazily on that route's first request in the process's
        // lifetime (see this module's `CONSOLE_HEALTH_CHECK_PATHS` doc
        // comment) -- so a healthy `/` proves nothing about `/connect`
        // specifically. This is the actual incident's shape one level up:
        // the root looks completely fine, but the route a user actually
        // needs (the one named in the real `InvariantError`) is broken.
        // Checking only `/` would report this console healthy; it must not.
        let server = FakeHttpServer::start(vec![
            (
                "/",
                (
                    "200 OK",
                    r#"<html><head><script src="/_next/static/chunks/root.js"></script></head></html>"#,
                ),
            ),
            ("/_next/static/chunks/root.js", ("200 OK", "console.log('root')")),
            (
                "/connect",
                (
                    "200 OK",
                    r#"<html><head><script src="/_next/static/chunks/connect-stale.js"></script></head></html>"#,
                ),
            ),
            // Deliberately no route registered for connect-stale.js -- the
            // FakeHttpServer's default 404 fallback stands in for the exact
            // incident shape (HTML 200, its own referenced asset 404).
        ]);
        let client = reqwest::Client::new();
        let result = verify_console_health_check_routes(&client, &server.url("")).await;
        assert!(
            result.is_err(),
            "a broken /connect must fail the combined check even though / is healthy"
        );
        let message = result.unwrap_err();
        assert!(
            message.contains("/connect"),
            "error should name which route failed, got: {message}"
        );
        assert!(
            message.contains("connect-stale.js"),
            "error should still name the specific asset that failed, got: {message}"
        );
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_treats_401_as_proof_of_life() {
        // The actual incident this test guards against: /connect is gated
        // behind the owner session (verifyDashboardSession -> refFetch in
        // the console's own TypeScript), and the health check's bare
        // reqwest::Client carries no session cookie. Rejecting a 401 as
        // "unhealthy" made a perfectly working console fail its own health
        // check forever, tearing down the whole stack in a loop -- see
        // wait_for_console's doc comment for the full incident.
        let server = FakeHttpServer::start(vec![("/connect", ("401 Unauthorized", "unauthorized"))]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/connect")).await;
        assert!(result.is_ok(), "a 401 must count as proof the server is alive, got {result:?}");
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_treats_403_as_proof_of_life() {
        let server = FakeHttpServer::start(vec![("/connect", ("403 Forbidden", "forbidden"))]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/connect")).await;
        assert!(result.is_ok(), "a 403 must count as proof the server is alive, got {result:?}");
    }

    #[test]
    fn response_proves_the_server_is_alive_covers_success_redirect_and_auth_challenge_but_not_server_error() {
        assert!(response_proves_the_server_is_alive(reqwest::StatusCode::OK));
        assert!(response_proves_the_server_is_alive(reqwest::StatusCode::FOUND));
        assert!(response_proves_the_server_is_alive(reqwest::StatusCode::TEMPORARY_REDIRECT));
        assert!(response_proves_the_server_is_alive(reqwest::StatusCode::UNAUTHORIZED));
        assert!(response_proves_the_server_is_alive(reqwest::StatusCode::FORBIDDEN));
        assert!(!response_proves_the_server_is_alive(reqwest::StatusCode::NOT_FOUND));
        assert!(!response_proves_the_server_is_alive(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(!response_proves_the_server_is_alive(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
    }

    /// The retry wrapper itself must never be able to stop the stack.
    ///
    /// The same structural rule #216 established for the deep health
    /// watch, applied one level up to the readiness wait. Teardown is the
    /// CALLER's decision, made only after this function has exhausted
    /// every non-destructive option; this function may report and retry,
    /// never destroy.
    #[test]
    fn the_console_wait_cannot_tear_down_what_it_observes() {
        let source = include_str!("unified.rs");
        let start = source
            .find("async fn wait_for_console_with_retry")
            .expect("the retry wrapper must exist");
        let end = source[start..]
            .find("\n/// Routes the best-effort deep health watch")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..end];
        for forbidden in [
            "teardown(",
            "teardown_managed_on_error",
            "app.exit",
            "set_status",
            "request_shutdown",
        ] {
            assert!(
                !body.contains(forbidden),
                "the console readiness wait must never reach {forbidden}: a check that \
                 can stop what it is checking turns slowness into an outage"
            );
        }
    }

    /// A console that is merely SLOW must not be killed for being slow.
    ///
    /// This is the residual the reviewer caught after #216: the deep check
    /// could no longer tear the stack down, but `wait_for_console`'s own
    /// fixed 45s bare-liveness timeout still fed an unconditional,
    /// non-retrying teardown. A cold first boot that needs longer than one
    /// round would therefore be destroyed on a perfectly healthy machine,
    /// and destroying it makes the next attempt start from nothing.
    ///
    /// Here the console answers nothing for the first round and then comes
    /// up. With retry it must succeed; the round timeout is a report, not
    /// a verdict.
    #[tokio::test]
    async fn a_slow_but_healthy_console_survives_and_is_not_torn_down() {
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server = FakeHttpServer::start_gated(ready.clone());
        // Flip to serving only after the first round has already timed out.
        let flip = ready.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            flip.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        let result = wait_for_console_with_retry(
            &server.url("/"),
            || true, // the console process is alive the whole time
            Duration::from_secs(20),
            Duration::from_millis(300),
        )
        .await;
        assert!(
            result.is_ok(),
            "a slow console that comes up must be waited for, not torn down: {result:?}"
        );
    }

    /// The one case where waiting provably cannot help: the console process
    /// is gone. Then, and only then, may this give up (and its caller tear
    /// down).
    #[tokio::test]
    async fn a_dead_console_process_stops_the_wait_instead_of_burning_the_budget() {
        let started = tokio::time::Instant::now();
        let result = wait_for_console_with_retry(
            "http://127.0.0.1:1/",
            || false, // the supervisor no longer has these sidecars
            Duration::from_secs(600),
            Duration::from_millis(300),
        )
        .await;
        let error = result.expect_err("a dead console must not report ready");
        assert!(
            error.contains("exited before it answered"),
            "the error should name the real reason, got: {error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "a dead console must fail fast rather than waiting out the full budget"
        );
    }

    #[tokio::test]
    async fn wait_for_console_succeeds_on_bare_liveness_even_when_the_page_would_fail_the_deep_asset_check() {
        // The core of the fix: wait_for_console (the function that GATES
        // bootstrap and can trigger a full-stack teardown on failure) must
        // succeed on liveness alone, even against a page that would fail
        // the deep multi-route asset-reference check (no /_next/ asset to
        // verify here at all). Before this fix, wait_for_console called the
        // deep check directly and would have retried this for the full
        // CONSOLE_WAIT_TIMEOUT and then torn the stack down -- exactly the
        // reported incident. Bootstrap does not need the deep check to
        // proceed; it only needs to know the console answered.
        let server = FakeHttpServer::start(vec![("/", ("200 OK", "<html><body>no next assets here</body></html>"))]);
        let result = wait_for_console(&server.url("/")).await;
        assert!(
            result.is_ok(),
            "wait_for_console must succeed on bare liveness, not require the deep asset check to pass: {result:?}"
        );
    }

    #[tokio::test]
    async fn wait_for_console_succeeds_against_an_owner_session_gated_401_response() {
        // Direct regression test for the reported incident: a route gated
        // behind an owner session (like the real /connect) answering 401 to
        // a session-less health-check request must not be treated as a
        // reason to keep retrying until timeout and tear the stack down.
        let server = FakeHttpServer::start(vec![("/", ("401 Unauthorized", "unauthorized"))]);
        let result = wait_for_console(&server.url("/")).await;
        assert!(result.is_ok(), "wait_for_console must accept a 401 as liveness: {result:?}");
    }

    #[tokio::test]
    async fn wait_for_console_still_fails_on_a_genuine_server_error() {
        // The liveness-only relaxation must not become "anything counts" --
        // a real 500 (the server itself is broken, not just gating a route)
        // must still fail so bootstrap does not open a window onto a
        // console that cannot serve anything at all.
        let server = FakeHttpServer::start(vec![("/", ("500 Internal Server Error", "broken"))]);
        let result = tokio::time::timeout(Duration::from_secs(1), wait_for_console(&server.url("/"))).await;
        // wait_for_console retries for CONSOLE_WAIT_TIMEOUT (45s) before
        // giving up, so bound this test's own wait rather than actually
        // waiting out the full timeout; a real 500 must never resolve Ok
        // within the bounded window, which is enough to prove it is not
        // being treated as healthy.
        assert!(
            result.is_err() || matches!(result, Ok(Err(_))),
            "a persistent 500 must never be treated as console liveness"
        );
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_treats_a_redirect_to_a_non_next_login_page_as_healthy() {
        // The ACTUAL root cause, confirmed live against a real running
        // reference server + console: an unauthenticated GET /connect
        // returns a genuine 307 to /owner/login, a plain server-rendered
        // HTML page (owner-login-ui.ts) that is NOT part of the console's
        // Next.js app at all -- no /_next/ reference anywhere in it. The
        // prior version of this check already accepted the redirect status
        // itself, then failed on "no static asset to verify" once it
        // followed the redirect and read the login page's body. That is
        // legitimate proven-alive routing logic (a real page, at a real
        // URL, doing real auth-gating), not the stale-build symptom this
        // check exists to catch -- which always answers on the SAME url
        // with a broken asset reference, never redirects.
        let server = FakeHttpServer::start(vec![
            ("/connect", ("307 Temporary Redirect", "REDIRECT_TO:/owner/login")),
            (
                "/owner/login",
                (
                    "200 OK",
                    "<!DOCTYPE html><html><head><title>Owner sign-in</title></head><body>no next assets here, this is a plain server-rendered page</body></html>",
                ),
            ),
        ]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/connect")).await;
        assert!(
            result.is_ok(),
            "a redirect landing on a real, asset-free login page must count as healthy: {result:?}"
        );
    }

    #[tokio::test]
    async fn verify_console_serves_a_real_route_still_fails_a_same_url_asset_free_response() {
        // The redirect tolerance above must not swallow the real stale-build
        // symptom: a response at the SAME url with no asset to check is
        // still suspicious and must still fail.
        let server = FakeHttpServer::start(vec![("/", ("200 OK", "<html><body>empty</body></html>"))]);
        let client = reqwest::Client::new();
        let result = verify_console_serves_a_real_route(&client, &server.url("/")).await;
        assert!(
            result.is_err(),
            "a same-url response with no asset to verify must still fail, not be waved through"
        );
    }

    #[tokio::test]
    async fn wait_for_console_succeeds_against_the_real_unauthenticated_connect_redirect_shape() {
        // End-to-end version of the fix at the level that actually gates
        // bootstrap: wait_for_console itself must succeed against the exact
        // response shape /connect gives an unauthenticated request (a bare
        // 307, no body needed -- wait_for_console does not follow redirects
        // or read bodies at all, unlike the deep check).
        let server = FakeHttpServer::start(vec![
            ("/", ("307 Temporary Redirect", "REDIRECT_TO:/owner/login")),
            ("/owner/login", ("200 OK", "<html><body>sign in</body></html>")),
        ]);
        let result = wait_for_console(&server.url("/")).await;
        assert!(result.is_ok(), "wait_for_console must accept the real /connect redirect shape: {result:?}");
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
    fn legacy_stack_opt_out_requires_exact_one_flag() {
        assert!(disabled_for_value(Some("1")));
        assert!(!disabled_for_value(Some("0")));
        assert!(!disabled_for_value(Some("true")));
        assert!(!disabled_for_value(None));
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

    /// Source-level guard for the whole point of this fix: the deep,
    /// multi-route health watch that runs after the console window is
    /// already open must NEVER be able to affect the running stack. A
    /// runtime test of the spawned task's actual behavior would need the
    /// same real-`AppHandle` machinery `finish_bootstrap`'s failure
    /// branches already document as untestable here (see the test above),
    /// so this checks the one thing that matters structurally: nothing in
    /// `spawn_console_deep_health_watch`'s body can reach
    /// `teardown_managed_on_error`, `app.exit`, `set_status`, or any other
    /// stack-affecting call -- only `log::warn!`.
    #[test]
    fn console_deep_health_watch_can_only_log_never_act() {
        let source = include_str!("unified.rs");
        let start = source
            .find("pub(crate) fn spawn_console_deep_health_watch(")
            .expect("spawn_console_deep_health_watch must exist");
        let body_end = source[start..]
            .find("\n/// One attempt across every route")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..body_end];

        for forbidden in [
            "teardown_managed_on_error",
            "app.exit",
            "set_status(",
            "StopReason::",
        ] {
            assert!(
                !body.contains(forbidden),
                "spawn_console_deep_health_watch must never reach {forbidden:?} -- a \
                 background health observation must not be able to affect a running \
                 stack, which is the entire reason this function is separate from \
                 wait_for_console. Found it in the function body."
            );
        }
        assert!(
            body.contains("log::warn!"),
            "a failed deep health check must still be visible somewhere, just not fatal"
        );
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
    /// headers precisely without pulling in a real HTTP server dependency.
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

    /// An observer must never be able to destroy what it observes.
    ///
    /// #208 proved this is not theoretical: a health check that could reach
    /// `teardown_managed_on_error` reported a WORKING console as unhealthy
    /// (its startup page is server-rendered and has no `/_next/` asset) and
    /// took the whole stack down in a loop. #216 fixes that case and makes
    /// the rule structural for the console's deep check.
    ///
    /// The origin-verification watcher here is the same shape -- a periodic
    /// health probe -- so it carries the same guarantee, enforced the same
    /// way: nothing in its body may reach a call that stops the stack,
    /// exits the app, or changes user-visible status. The worst a failed
    /// probe may do is record what it observed and log. A source-level
    /// check because a runtime test of the spawned task needs a real
    /// `AppHandle`, which this file's other tests already document as
    /// unavailable here.
    #[test]
    fn the_origin_watcher_cannot_tear_down_what_it_observes() {
        let source = include_str!("unified.rs");
        // The watcher plus everything it calls that lives in this file: the
        // recorder and the agent-health reader (one contiguous block ending
        // at the shutdown guard), and the probe (its own block).
        let regions = [
            (
                "fn record_origin_verification(",
                "\n/// Has a shutdown been requested?",
            ),
            (
                "const ORIGIN_PROBE_TIMEOUT",
                "\n/// Decide whether a held ngrok tunnel",
            ),
        ];
        for (from, to) in regions {
            let start = source
                .find(from)
                .unwrap_or_else(|| panic!("{from} must exist"));
            let end = source[start..]
                .find(to)
                .map(|offset| start + offset)
                .unwrap_or_else(|| panic!("{to} must follow {from}"));
            let body = &source[start..end];
            assert!(
                from != "fn record_origin_verification("
                    || body.contains("pub(crate) fn spawn_origin_verification_watcher"),
                "the scanned region must include the watcher itself"
            );

            for forbidden in [
                "teardown(",
                "teardown_managed_on_error",
                "app.exit",
                "set_status",
                "request_shutdown",
                "stop_held_ngrok",
                "stop_owned",
                "stop_stack",
                "RemoteAccessProvider::stop",
                ".start(",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "the origin verification watcher must never reach {forbidden}: a health \
                     check that can stop the stack turns a false negative into an outage \
                     (see #208)"
                );
            }
        }
    }

    /// Shutdown is absorbing for the background watchers.
    ///
    /// Each watcher is an infinite `loop` with a discarded `JoinHandle`, so
    /// before this they kept running for the whole shutdown budget. The
    /// remote-access one is the dangerous case: it can call
    /// `restart_after_remote_access_config` and rebuild the very stack
    /// shutdown is tearing down. This asserts the guard every watcher now
    /// consults, rather than the loops themselves (which need a real
    /// `AppHandle`).
    fn watcher_declaration_body<'a>(source: &'a str, watcher_name: &str) -> &'a str {
        let declaration = format!("pub(crate) fn {watcher_name}(");
        let matches = rust_declaration_starts(source, &declaration);
        let [start] = matches.as_slice() else {
            if matches.is_empty() {
                panic!("{watcher_name} must have an exact pub(crate) fn declaration");
            }
            panic!("{watcher_name} must have exactly one pub(crate) fn declaration");
        };
        let body_open = find_code_byte(source, *start + declaration.len(), b'{')
            .unwrap_or_else(|| panic!("{watcher_name} declaration must have a function body"));
        let body_close = matching_body_close(source, body_open).unwrap_or_else(|| {
            panic!("{watcher_name} declaration must have a balanced function body")
        });
        &source[body_open + 1..body_close]
    }

    fn rust_declaration_starts(source: &str, declaration: &str) -> Vec<usize> {
        let mut starts = Vec::new();
        let mut index = 0;
        let mut brace_depth = 0;
        while index < source.len() {
            if brace_depth == 0
                && starts_line_declaration(source, index)
                && source[index..].starts_with(declaration)
            {
                starts.push(index);
                index += declaration.len();
                continue;
            }
            match source.as_bytes()[index] {
                b'{' => brace_depth += 1,
                b'}' => brace_depth = brace_depth.saturating_sub(1),
                _ => {}
            }
            index = next_code_index(source, index);
        }
        starts
    }

    fn starts_line_declaration(source: &str, index: usize) -> bool {
        let line_start = source[..index]
            .rfind('\n')
            .map(|offset| offset + 1)
            .unwrap_or(0);
        source[line_start..index].trim().is_empty()
    }

    fn contains_code(source: &str, token: &str) -> bool {
        let mut index = 0;
        while index < source.len() {
            if source[index..].starts_with(token) {
                return true;
            }
            index = next_code_index(source, index);
        }
        false
    }

    fn find_code_byte(source: &str, mut index: usize, target: u8) -> Option<usize> {
        while index < source.len() {
            if source.as_bytes()[index] == target {
                return Some(index);
            }
            index = next_code_index(source, index);
        }
        None
    }

    fn matching_body_close(source: &str, body_open: usize) -> Option<usize> {
        let mut depth = 1;
        let mut index = body_open + 1;
        while index < source.len() {
            match source.as_bytes()[index] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index);
                    }
                }
                _ => {}
            }
            index = next_code_index(source, index);
        }
        None
    }

    fn next_code_index(source: &str, index: usize) -> usize {
        if source[index..].starts_with("//") {
            return source[index..]
                .find('\n')
                .map(|offset| index + offset + 1)
                .unwrap_or(source.len());
        }
        if source[index..].starts_with("/*") {
            return block_comment_end(source, index + 2);
        }
        if let Some(end) = raw_string_end(source, index) {
            return end;
        }
        if let Some(end) = char_literal_end(source, index) {
            return end;
        }
        if source.as_bytes()[index] == b'"' {
            return string_end(source, index + 1);
        }
        index + source[index..].chars().next().unwrap().len_utf8()
    }

    fn char_literal_end(source: &str, index: usize) -> Option<usize> {
        let bytes = source.as_bytes();
        let quote = if bytes.get(index) == Some(&b'b') && bytes.get(index + 1) == Some(&b'\'') {
            index + 1
        } else if bytes.get(index) == Some(&b'\'') {
            index
        } else {
            return None;
        };
        let mut cursor = quote + 1;
        if bytes.get(cursor) == Some(&b'\\') {
            cursor += 2;
        } else {
            cursor += source.get(cursor..)?.chars().next()?.len_utf8();
        }
        (bytes.get(cursor) == Some(&b'\'')).then_some(cursor + 1)
    }

    fn block_comment_end(source: &str, mut index: usize) -> usize {
        let mut depth = 1;
        while index < source.len() {
            if source[index..].starts_with("/*") {
                depth += 1;
                index += 2;
            } else if source[index..].starts_with("*/") {
                depth -= 1;
                index += 2;
                if depth == 0 {
                    return index;
                }
            } else {
                index += source[index..].chars().next().unwrap().len_utf8();
            }
        }
        source.len()
    }

    fn string_end(source: &str, mut index: usize) -> usize {
        let mut escaped = false;
        while index < source.len() {
            let byte = source.as_bytes()[index];
            index += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                return index;
            }
        }
        source.len()
    }

    fn raw_string_end(source: &str, index: usize) -> Option<usize> {
        let bytes = source.as_bytes();
        if bytes[index] != b'r' {
            return None;
        }
        let mut hashes = 0;
        let mut cursor = index + 1;
        while cursor < source.len() && bytes[cursor] == b'#' {
            hashes += 1;
            cursor += 1;
        }
        if cursor >= source.len() || bytes[cursor] != b'"' {
            return None;
        }
        cursor += 1;
        while cursor < source.len() {
            if bytes[cursor] == b'"' {
                let suffix_end = cursor + 1 + hashes;
                if suffix_end <= source.len()
                    && source[cursor + 1..suffix_end]
                        .bytes()
                        .all(|byte| byte == b'#')
                {
                    return Some(suffix_end);
                }
            }
            cursor += source[cursor..].chars().next().unwrap().len_utf8();
        }
        Some(source.len())
    }

    #[test]
    fn watchers_stop_once_shutdown_is_requested() {
        let source = include_str!("unified.rs");
        for watcher in [
            "spawn_remote_access_config_watcher",
            "spawn_autostart_watcher",
            "spawn_origin_verification_watcher",
        ] {
            let body = watcher_declaration_body(source, watcher);
            assert!(
                contains_code(body, "shutdown_has_been_requested"),
                "{watcher} must stop once shutdown is requested, or it can act \
                 on the stack while it is being torn down"
            );
        }
    }

    #[test]
    fn watcher_declaration_scan_requires_a_real_declaration() {
        let source = r##"
            fn mentions_spawn_remote_access_config_watcher() {}
            // pub(crate) fn spawn_remote_access_config_watcher() { fake_line_comment(); }
            const NOTE: &str = "pub(crate) fn spawn_remote_access_config_watcher() { fake_string(); }";
            const RAW: &str = r#"pub(crate) fn spawn_remote_access_config_watcher() { fake_raw_string(); }"#;
            /* pub(crate) fn spawn_remote_access_config_watcher() { fake_block_comment(); } */
            pub(crate) fn spawn_remote_access_config_watcher_for_test() {}
            pub(crate) fn spawn_remote_access_config_watcher() {
                shutdown_has_been_requested();
            }
        "##;

        let body = watcher_declaration_body(source, "spawn_remote_access_config_watcher");

        assert!(body.contains("shutdown_has_been_requested"));
        assert!(!body.contains("fake_line_comment"));
        assert!(!body.contains("fake_string"));
        assert!(!body.contains("fake_raw_string"));
        assert!(!body.contains("fake_block_comment"));
    }

    #[test]
    #[should_panic(expected = "must have an exact pub(crate) fn declaration")]
    fn watcher_declaration_scan_rejects_missing_targets() {
        let source = r##"
            // pub(crate) fn spawn_open_external_url_watcher() {}
            const NOTE: &str = "pub(crate) fn spawn_open_external_url_watcher() {}";
            const RAW: &str = r#"pub(crate) fn spawn_open_external_url_watcher() {}"#;
            /* pub(crate) fn spawn_open_external_url_watcher() {} */
        "##;

        let _body = watcher_declaration_body(source, "spawn_open_external_url_watcher");
    }

    #[test]
    #[should_panic(expected = "must have an exact pub(crate) fn declaration")]
    fn watcher_declaration_scan_rejects_nested_fake_targets() {
        let source = r#"
            fn unrelated_helper() {
                pub(crate) fn spawn_open_external_url_watcher() {
                    shutdown_has_been_requested();
                }
            }
        "#;

        let _body = watcher_declaration_body(source, "spawn_open_external_url_watcher");
    }

    #[test]
    #[should_panic(expected = "must have exactly one pub(crate) fn declaration")]
    fn watcher_declaration_scan_rejects_ambiguous_targets() {
        let source = r#"
            pub(crate) fn spawn_autostart_watcher() {}
            pub(crate) fn spawn_autostart_watcher() {}
        "#;

        let _body = watcher_declaration_body(source, "spawn_autostart_watcher");
    }

    #[test]
    fn watcher_declaration_scan_returns_only_the_balanced_body() {
        let source = r#"
            pub(crate) fn spawn_origin_verification_watcher() {
                if shutdown_has_been_requested() {
                    inside_target();
                }
                let _note = "} pub(crate) fn spawn_origin_verification_watcher() { fake_string(); }";
                // }
                /* } */
            }

            pub(crate) fn later_function() {
                outside_target();
            }
        "#;

        let body = watcher_declaration_body(source, "spawn_origin_verification_watcher");

        assert!(body.contains("inside_target"));
        assert!(!body.contains("outside_target"));
    }

    #[test]
    fn watcher_declaration_scan_ignores_braces_in_character_literals() {
        let source = r#"
            const OPEN: char = '{';
            const CLOSE: char = '}';
            pub(crate) fn spawn_origin_verification_watcher() {
                shutdown_has_been_requested();
            }
        "#;

        let body = watcher_declaration_body(source, "spawn_origin_verification_watcher");
        assert!(contains_code(body, "shutdown_has_been_requested"));
    }

    #[test]
    fn watcher_guard_marker_in_comments_and_strings_is_not_code() {
        let source = r#"
            // shutdown_has_been_requested()
            let note = "shutdown_has_been_requested()";
        "#;
        assert!(!contains_code(source, "shutdown_has_been_requested"));
    }

    /// A reading that proved the origin reaches this console, taken at
    /// `checked_at`.
    fn verification_at(origin: &str, checked_at: u64) -> crate::remote_access::OriginVerification {
        crate::remote_access::OriginVerification {
            origin: origin.to_string(),
            checked_at,
            stale_after: ORIGIN_VERIFY_STALE_AFTER,
            outcome: crate::remote_access::OriginProbeOutcome::ReachesThisConsole,
            binding: crate::remote_access::OriginBinding::AppSupplied,
            agent: None,
        }
    }

    /// The exact incident: `spawn_remote_access_config_watcher` must not
    /// restart the stack just because `spawn_origin_verification_watcher`
    /// recorded a fresh reachability observation. Reproduces the actual
    /// live bug -- two configs identical except for `origin_verified`'s
    /// `checked_at` timestamp, which advances every ~60s in production --
    /// and confirms this fails against the derived whole-struct `==` (the
    /// bug that shipped) while passing through `restart_relevant_view`
    /// (the fix). Confirmed to fail if `restart_relevant_view` is reverted
    /// to `config.clone()` (i.e. stops stripping `origin_verified`).
    #[test]
    fn an_origin_verification_write_does_not_look_like_a_restart_worthy_change() {
        let base = crate::remote_access::off_remote_access_config();
        let earlier = RemoteAccessConfig {
            origin_verified: Some(verification_at("https://example.ngrok-free.app", 1_000)),
            ..base.clone()
        };
        let later = RemoteAccessConfig {
            // One ORIGIN_VERIFY_INTERVAL tick later.
            origin_verified: Some(verification_at("https://example.ngrok-free.app", 1_060)),
            ..base
        };

        assert_ne!(
            earlier, later,
            "the two configs must actually differ (by checked_at only), or this test is not \
             exercising the bug"
        );
        assert_eq!(
            restart_relevant_view(&earlier),
            restart_relevant_view(&later),
            "an origin-verification timestamp advancing must not look like a restart-worthy \
             change -- this is the exact mechanism that kept restarting the stack every ~60s \
             and left remote access off on a real machine"
        );
    }

    /// N restarts cannot chain: simulates one real, owner-initiated change
    /// followed by several consecutive origin-verification writes (the way
    /// `spawn_origin_verification_watcher` writes one every
    /// `ORIGIN_VERIFY_INTERVAL` in production) and asserts none of the
    /// follow-up writes register as restart-worthy against the baseline
    /// set by the one real change. The prior test proves a single pair of
    /// configs compares equal; this proves the loop actually settles
    /// instead of merely not firing once.
    #[test]
    fn repeated_origin_verification_writes_after_a_real_change_never_chain_into_more_restarts() {
        let mut last_applied = crate::remote_access::off_remote_access_config();
        let mut current = last_applied.clone();
        current.posture = crate::remote_access::RemoteAccessPosture::PublicUrl;
        current.provider = Some("cloudflare_tunnel".to_string());
        current.fields.reference_origin = Some("https://vault.example.com".to_string());

        assert_ne!(
            restart_relevant_view(&current),
            restart_relevant_view(&last_applied),
            "the one real, owner-initiated change must still be seen as restart-worthy"
        );
        last_applied = current.clone();

        for tick in 0..5u64 {
            let mut observed = last_applied.clone();
            observed.origin_verified = Some(verification_at(
                "https://vault.example.com",
                1_000 + tick * 60,
            ));
            assert_eq!(
                restart_relevant_view(&observed),
                restart_relevant_view(&last_applied),
                "tick {tick}: an origin-verification write alone must never be read as a \
                 config change worth restarting for, no matter how many ticks accumulate"
            );
        }
    }

    /// A record in the shape the console reads: `kind`-tagged outcome and
    /// binding, snake_case agent health, and the staleness window. Pinned
    /// because the console parses this JSON by hand
    /// (`parseOriginVerification` in the console's `remote-access.ts`).
    #[test]
    fn an_origin_verification_serializes_in_the_shape_the_console_reads() {
        let verification = crate::remote_access::OriginVerification {
            origin: "https://vault.example.com".to_string(),
            checked_at: 1_000,
            stale_after: ORIGIN_VERIFY_STALE_AFTER,
            outcome: crate::remote_access::OriginProbeOutcome::ReachesSomethingElse { status: 404 },
            binding: crate::remote_access::OriginBinding::OwnerMaintained {
                where_to_set: "the dashboard".to_string(),
                action_url: Some("https://dash.example.com/tunnels".to_string()),
            },
            agent: Some(crate::remote_access::TunnelAgentHealth::Running),
        };
        assert_eq!(
            serde_json::to_value(&verification).expect("serialize"),
            serde_json::json!({
                "origin": "https://vault.example.com",
                "checked_at": 1_000,
                "stale_after": 150,
                "outcome": { "kind": "reaches_something_else", "status": 404 },
                "binding": {
                    "kind": "owner_maintained",
                    "where_to_set": "the dashboard",
                    "action_url": "https://dash.example.com/tunnels",
                },
                "agent": "running",
            })
        );
    }

    /// A binding stored before `action_url` existed reads as "no link", so
    /// the observation already on disk keeps its guidance.
    #[test]
    fn an_owner_maintained_binding_without_an_action_url_still_parses() {
        let binding: crate::remote_access::OriginBinding = serde_json::from_value(
            serde_json::json!({ "kind": "owner_maintained", "where_to_set": "the dashboard" }),
        )
        .expect("a binding from the previous build must parse");
        assert_eq!(
            binding,
            crate::remote_access::OriginBinding::OwnerMaintained {
                where_to_set: "the dashboard".to_string(),
                action_url: None,
            }
        );
    }

    /// A record written by an older build must not stop the config from
    /// loading. The pre-change shape (`reachable: bool`, no `outcome`) is on
    /// disk on every machine that ran the previous build; failing to parse
    /// it would hide the owner's real settings behind an observation that
    /// is re-taken within a minute anyway.
    #[test]
    fn an_origin_verification_in_an_older_shape_is_discarded_not_fatal() {
        let stored = serde_json::json!({
            "posture": "public_url",
            "provider": "cloudflare_tunnel",
            "fields": {
                "PDPP_REFERENCE_ORIGIN": "https://vault.example.com",
                "PDPP_TRUSTED_HOSTS": "vault.example.com",
                "PDPP_TRUSTED_PROXIES": "",
                "PDPP_BIND_HOST": "127.0.0.1",
            },
            "cloudflare_tunnel": { "hostname": "vault.example.com" },
            "origin_verified": {
                "origin": "https://vault.example.com",
                "checked_at": 1_000,
                "reachable": true,
            },
        });
        let config: RemoteAccessConfig =
            serde_json::from_value(stored).expect("an old observation must not fail the load");
        assert_eq!(config.origin_verified, None);
        assert_eq!(
            config.fields.reference_origin.as_deref(),
            Some("https://vault.example.com")
        );
    }

    /// RFC 4231, test case 2. The console computes the same function with
    /// Node's `createHmac`; if this is wrong, no console can ever prove
    /// itself and every origin reads as misrouted.
    #[test]
    fn hmac_sha256_matches_the_rfc_4231_test_vector() {
        assert_eq!(
            hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // RFC 4231 test case 6: a key longer than the block size is hashed
        // first.
        assert_eq!(
            hmac_sha256_hex(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// The same triple is pinned in the console route's test
    /// (`apps/console/src/app/api/origin-proof/route.test.ts`), so the two
    /// implementations cannot drift apart without one suite failing.
    #[test]
    fn the_console_and_the_supervisor_agree_on_the_proof() {
        assert_eq!(
            hmac_sha256_hex(b"this-process-key", b"00112233445566778899aabbccddeeff"),
            "63cdbd95f7ede15df13f1fc676b443da4e43951477d5fa2da44bfd9f3949fe55"
        );
    }

    /// A fake console: answers one request to the origin-proof route with
    /// the HMAC of the request's challenge under `key`, like
    /// `apps/console/src/app/api/origin-proof/route.ts` does.
    fn serve_origin_proof_once(key: &'static str) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buffer = [0_u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let _ = sender.send(buffer[..read].to_vec());
                let challenge = request
                    .split_whitespace()
                    .nth(1)
                    .and_then(|target| target.split("challenge=").nth(1))
                    .unwrap_or_default()
                    .to_string();
                let proof = hmac_sha256_hex(key.as_bytes(), challenge.as_bytes());
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{proof}",
                        proof.len()
                    )
                    .as_bytes(),
                );
            }
        });
        (format!("http://127.0.0.1:{port}"), receiver)
    }

    #[test]
    fn the_origin_reaches_this_console_only_when_it_answers_with_this_key() {
        let (origin, request_received) = serve_origin_proof_once("this-process-key");
        assert_eq!(
            probe_public_origin(&origin, "this-process-key"),
            crate::remote_access::OriginProbeOutcome::ReachesThisConsole
        );
        let request = request_received
            .recv_timeout(Duration::from_secs(1))
            .expect("the probe request must have been sent");
        let request = String::from_utf8_lossy(&request).to_lowercase();
        assert!(
            request.starts_with("get /api/origin-proof?challenge="),
            "the probe must ask the console's own proof route; request was:\n{request}"
        );
        // Confirmed live, 2026-09-20: ngrok's free plan shows a one-time
        // browser interstitial to browser-looking requests, which would
        // stand between this probe and the console's answer.
        assert!(
            request.contains("ngrok-skip-browser-warning"),
            "expected the probe to send ngrok-skip-browser-warning; request was:\n{request}"
        );
    }

    /// Another DataConnect console (a second install, or this app's console
    /// from a different process) answers the route, but with a different
    /// key. It is not THIS console.
    #[test]
    fn a_different_consoles_answer_is_not_proof() {
        let (origin, _) = serve_origin_proof_once("another-process-key");
        assert_eq!(
            probe_public_origin(&origin, "this-process-key"),
            crate::remote_access::OriginProbeOutcome::ReachesSomethingElse { status: 200 }
        );
    }

    /// The 2026-09-22 incident: a dashboard-managed Cloudflare route still
    /// pointing at a port from before a rebuild, where some other service
    /// now answers with a JSON 404. The old check counted this as reachable
    /// because it carried no ngrok error header.
    #[test]
    fn a_stale_route_answering_with_another_services_404_is_reported_as_misrouted() {
        let origin = respond_once_with(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 21\r\n\r\n{\"error\":\"not_found\"}",
        );
        assert_eq!(
            probe_public_origin(origin.trim_end_matches('/'), "this-process-key"),
            crate::remote_access::OriginProbeOutcome::ReachesSomethingElse { status: 404 }
        );
    }

    /// Something that answers every path with 200 (the RI's JSON index, a
    /// parked-domain page, a provider interstitial) is still not proof.
    #[test]
    fn an_ordinary_200_page_is_not_proof() {
        let origin = respond_once_with("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        assert_eq!(
            probe_public_origin(&origin, "this-process-key"),
            crate::remote_access::OriginProbeOutcome::ReachesSomethingElse { status: 200 }
        );
    }

    #[test]
    fn a_redirect_is_reported_not_followed() {
        let origin = respond_once_with(
            "HTTP/1.1 302 Found\r\nLocation: https://login.example.com/\r\nContent-Length: 0\r\n\r\n",
        );
        assert_eq!(
            probe_public_origin(&origin, "this-process-key"),
            crate::remote_access::OriginProbeOutcome::ReachesSomethingElse { status: 302 }
        );
    }

    #[test]
    fn an_origin_nothing_answers_is_unreachable_with_a_reason() {
        let outcome = probe_public_origin("http://127.0.0.1:1", "this-process-key");
        let crate::remote_access::OriginProbeOutcome::Unreachable { reason } = outcome else {
            panic!("expected Unreachable, got {outcome:?}");
        };
        assert!(!reason.trim().is_empty());
    }

    #[test]
    fn the_console_receives_this_processs_origin_proof_key() {
        let spec = console_process_spec(
            Path::new("/tmp/pdpp-node"),
            Path::new("/tmp/console"),
            "http://127.0.0.1:1",
            "http://127.0.0.1:2",
            "owner-password",
            "reveal-proof",
            &crate::remote_access::off_remote_access_config(),
            crate::console_port::DEFAULT_CONSOLE_PORT,
        );
        let debug = format!("{:?}", spec.env);
        assert!(
            debug.contains(ORIGIN_PROOF_KEY_ENV),
            "the console must be started with {ORIGIN_PROOF_KEY_ENV}; env was {debug}"
        );
        assert!(
            debug.contains(OWNER_CREDENTIAL_REVEAL_PROOF_ENV),
            "the console must receive the dedicated owner reveal proof; env was {debug}"
        );
        assert_eq!(origin_proof_key().len(), 64);
        assert_eq!(
            origin_proof_key(),
            origin_proof_key(),
            "one key per process"
        );
    }

    #[test]
    fn the_console_receives_the_active_tunnel_provider_when_configured() {
        let mut remote_access = crate::remote_access::off_remote_access_config();
        remote_access.provider = Some(crate::remote_access_cloudflare::CLOUDFLARE_TUNNEL_PROVIDER_ID.to_string());
        let spec = console_process_spec(
            Path::new("/tmp/pdpp-node"),
            Path::new("/tmp/console"),
            "http://127.0.0.1:1",
            "http://127.0.0.1:2",
            "owner-password",
            "reveal-proof-test",
            &remote_access,
            crate::console_port::DEFAULT_CONSOLE_PORT,
        );
        assert_eq!(
            spec.env.vars.get(std::ffi::OsStr::new("PDPP_ACTIVE_TUNNEL_PROVIDER")),
            Some(&OsString::from(
                crate::remote_access_cloudflare::CLOUDFLARE_TUNNEL_PROVIDER_ID
            ))
        );
    }

    #[test]
    fn ri_environment_passes_secrets_only_to_the_ri_allowlist_without_debug_values() {
        let owner_password = "owner-password-test";
        let credential_key = "credential-key-test";
        let database_key = "database-key-test";
        let reveal_proof = "reveal-proof-test";
        let environment = ri_environment(
            Path::new("/tmp/unified"),
            owner_password,
            OwnerPasswordSource::DesktopGenerated,
            reveal_proof,
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
        assert!(!debug.contains(reveal_proof));
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
            "reveal-proof-test",
            &remote_access,
            4310,
        );
        assert_eq!(console_spec.requested_port, Some(4310));

        let unpinned_console_spec = console_process_spec(
            &node_program(),
            Path::new("/tmp/console-root"),
            "http://127.0.0.1:7662",
            "http://127.0.0.1:7663",
            "owner-password-test",
            "reveal-proof-test",
            &off_remote_access_config(),
            crate::console_port::DEFAULT_CONSOLE_PORT,
        );
        assert_eq!(unpinned_console_spec.requested_port, None);
    }

    #[test]
    fn the_console_is_told_the_port_the_owner_relies_on() {
        // Settings compares this with PORT to report a console that could
        // not keep its stable port; without it that case would be silent.
        let spec = console_process_spec(
            &node_program(),
            Path::new("/tmp/console-root"),
            "http://127.0.0.1:7662",
            "http://127.0.0.1:7663",
            "owner-password-test",
            "reveal-proof-test",
            &off_remote_access_config(),
            38739,
        );
        assert_eq!(
            spec.env
                .vars
                .get(std::ffi::OsStr::new(crate::console_port::STABLE_PORT_ENV)),
            Some(&OsString::from("38739")),
            "the console must receive its stable port"
        );
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

        set_cookies_then_navigate(
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

    /// Proves the actual mechanism the fix relies on: on a `current_thread`
    /// runtime (one worker thread, same shape of starvation risk the real
    /// watcher's task faces on a shared multi-threaded runtime), a blocking
    /// call made INLINE on an async task starves every other task on that
    /// runtime -- e.g. a concurrent `tokio::time::interval` -- for the full
    /// duration of the blocking call. The same blocking call wrapped in
    /// `tokio::task::spawn_blocking` (what `spawn_remote_access_config_watcher`
    /// now does) runs on Tokio's separate blocking-thread pool and does NOT
    /// starve the interval.
    ///
    /// Cannot force the real OS keychain call inside
    /// `load_or_create_credential_encryption_key` to be slow (no injection
    /// seam at that call site, and this environment's D-Bus secret-service
    /// call fails fast rather than hanging), so this stands a real
    /// `std::thread::sleep` in for "a blocking OS call in flight" -- the
    /// exact class of operation `apply_pending_ngrok_authtoken` and
    /// `apply_pending_cloudflare_tunnel_token` perform. This isolates the
    /// causal claim (spawn_blocking keeps the runtime responsive; inline
    /// does not) from the specific blocking call site.
    ///
    /// Does not call `apply_pending_ngrok_authtoken` /
    /// `apply_pending_cloudflare_tunnel_token` directly: both take
    /// `&AppHandle<Wry>` (the concrete default runtime), and
    /// `tauri::test::mock_app()` only ever produces `AppHandle<MockRuntime>`
    /// -- there is no seam to drive the real functions with a real
    /// `AppHandle<Wry>` outside a running desktop app. Generalizing them to
    /// `AppHandle<R: Runtime>` (as `teardown_stack` already is, for the same
    /// reason) would make that possible, but is out of scope for this
    /// minimal fix.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_blocking_keeps_the_runtime_responsive_while_inline_blocking_does_not() {
        const SIMULATED_KEYCHAIN_LATENCY: Duration = Duration::from_millis(200);
        const INTERVAL_TICK: Duration = Duration::from_millis(20);
        // A tick delayed by less than this is "the runtime stayed
        // responsive"; delayed by roughly SIMULATED_KEYCHAIN_LATENCY or more
        // is "the blocking call starved it". Comfortably between the two.
        const STARVATION_BOUND: Duration = Duration::from_millis(80);

        // Runs `work` concurrently (via `tokio::join!`, not sequential
        // `.await`s -- sequential awaits would measure `work`'s own duration
        // regardless of starvation, not whether the ticker made progress
        // WHILE `work` ran) with a periodic ticker on the same
        // current_thread runtime, and returns how long after start the
        // ticker's second tick landed. The first tick fires immediately on
        // creation and proves nothing; the second is the one starvation
        // would delay.
        async fn second_tick_delay_during<F, Fut>(work: F) -> Duration
        where
            F: FnOnce() -> Fut,
            Fut: std::future::Future<Output = ()>,
        {
            let started = Instant::now();
            let second_tick_at = Arc::new(Mutex::new(None));
            let recorder = Arc::clone(&second_tick_at);
            let ticker = async move {
                let mut interval = tokio::time::interval(INTERVAL_TICK);
                interval.tick().await; // first tick fires immediately
                interval.tick().await; // this is the one that can be starved
                *recorder.lock().expect("second tick lock") = Some(started.elapsed());
            };

            tokio::join!(ticker, work());

            let recorded = *second_tick_at.lock().expect("second tick lock");
            recorded.expect("ticker must have recorded its second tick")
        }

        // Old (buggy) shape: the blocking call runs inline on the async
        // task, occupying the runtime's only worker thread. The interval
        // ticker is a separate task on the SAME current_thread runtime
        // (joined concurrently, not sequenced after), so it cannot make
        // progress until the blocking call returns -- pushing its second
        // tick out to roughly SIMULATED_KEYCHAIN_LATENCY.
        let delay_while_inline = second_tick_delay_during(|| async {
            std::thread::sleep(SIMULATED_KEYCHAIN_LATENCY);
        })
        .await;
        assert!(
            delay_while_inline >= SIMULATED_KEYCHAIN_LATENCY,
            "an inline blocking call must starve every other task on a \
             current_thread runtime for its full duration -- this is the \
             defect this PR fixes, reproduced directly; second tick landed \
             at {delay_while_inline:?}, expected >= {SIMULATED_KEYCHAIN_LATENCY:?}"
        );

        // Fixed shape: the same blocking call wrapped in spawn_blocking.
        // Tokio's blocking-thread pool runs it off the runtime's worker
        // thread, so the interval ticker keeps ticking on schedule.
        let delay_while_spawn_blocking = second_tick_delay_during(|| async {
            tokio::task::spawn_blocking(|| {
                std::thread::sleep(SIMULATED_KEYCHAIN_LATENCY);
            })
            .await
            .expect("blocking task should not panic");
        })
        .await;
        assert!(
            delay_while_spawn_blocking < STARVATION_BOUND,
            "spawn_blocking must let the runtime keep serving other tasks \
             (e.g. the config-watcher's own poll loop, or any other timer \
             sharing the runtime) while the blocking call is in flight; \
             second tick landed at {delay_while_spawn_blocking:?}, expected \
             < {STARVATION_BOUND:?}"
        );
    }

    #[test]
    fn owner_session_cookie_is_http_only() {
        // Carries a real credential, so it must stay unreadable by page JS.
        let url: tauri::Url = "http://127.0.0.1:4310/".parse().expect("test url");
        let cookie = owner_session_cookie(&url, "session-value").expect("session cookie");
        assert_eq!(cookie.http_only(), Some(true));
    }

    #[test]
    fn owner_credential_reveal_cookie_is_host_only_and_http_only() {
        let url: tauri::Url = "http://127.0.0.1:4310/".parse().expect("test url");
        let cookie = owner_credential_reveal_cookie(&url, "reveal-proof").expect("reveal cookie");
        assert_eq!(cookie.name(), OWNER_CREDENTIAL_REVEAL_COOKIE);
        assert_eq!(cookie.value(), "reveal-proof");
        assert_eq!(cookie.domain(), None);
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
    }

    /// Source-level guard for the whole point of this fix: nothing in the
    /// console window's construction may gate `decide_console_navigation`
    /// behind a client-observable signal. Three prior fixes (#186, #200,
    /// #209) all failed by adding exactly that kind of check; this pins
    /// that the replacement handler is wired directly into the builder,
    /// unconditionally.
    #[test]
    fn console_window_wires_on_navigation_unconditionally() {
        let source = include_str!("unified.rs");
        let start = source
            .find("fn create_or_update_console_window(")
            .expect("create_or_update_console_window must exist");
        let body = &source[start..];
        assert!(
            body.contains(
                ".on_navigation(move |url| decide_console_navigation(url, &console_origin_for_navigation))"
            ),
            "create_or_update_console_window must attach on_navigation unconditionally on \
             the WebviewWindowBuilder -- no cookie, no runtime detection, nothing that can \
             fail closed the way #209's marker cookie did"
        );
    }

    #[test]
    fn is_console_origin_matches_scheme_host_and_port_only() {
        let console: tauri::Url = "http://127.0.0.1:4310/".parse().expect("console url");
        assert!(is_console_origin(
            &"http://127.0.0.1:4310/settings".parse().expect("same-origin url"),
            &console
        ));
        assert!(!is_console_origin(
            &"http://127.0.0.1:9999/".parse().expect("different port"),
            &console
        ));
        assert!(!is_console_origin(
            &"https://127.0.0.1:4310/".parse().expect("different scheme"),
            &console
        ));
        assert!(!is_console_origin(
            &"http://pdpp.dev:4310/".parse().expect("different host"),
            &console
        ));
    }

    /// A restart from a real, non-root Settings visit returns to that exact
    /// path -- the whole point of `console_url_preserving_path`.
    #[test]
    fn console_url_preserving_path_restores_a_real_path() {
        let new_origin: tauri::Url = "http://127.0.0.1:9999/".parse().expect("new origin");
        let result = console_url_preserving_path(&new_origin, Some("/settings"));
        assert_eq!(result.scheme(), "http");
        assert_eq!(result.host_str(), Some("127.0.0.1"));
        assert_eq!(result.port(), Some(9999));
        assert_eq!(result.path(), "/settings");
    }

    /// Query strings survive too, and are kept out of the path segment
    /// (`Url::set_path` would otherwise percent-encode a literal `?`).
    #[test]
    fn console_url_preserving_path_keeps_path_and_query_separate() {
        let new_origin: tauri::Url = "http://127.0.0.1:9999/".parse().expect("new origin");
        let result = console_url_preserving_path(&new_origin, Some("/sources?tab=all"));
        assert_eq!(result.path(), "/sources");
        assert_eq!(result.query(), Some("tab=all"));
    }

    /// No previous path (first launch, recovery import) leaves the origin
    /// exactly as given -- no `/` appended, no change at all.
    #[test]
    fn console_url_preserving_path_with_no_previous_path_is_the_origin_unchanged() {
        let new_origin: tauri::Url = "http://127.0.0.1:9999/".parse().expect("new origin");
        assert_eq!(console_url_preserving_path(&new_origin, None), new_origin);
    }

    /// The security property this function exists to guarantee: ONLY
    /// path+query may come from `previous_path`; the origin always comes
    /// from `console_origin` (the fresh port this process just bound), and
    /// a hostile `previous_path` can degrade the result to root but can
    /// NEVER change the scheme, host, or port. Same class of bug as the
    /// `is_local_url` CVE (GHSA-7gmj-67g7-phm9,
    /// `local/HOST-BRIDGE-DESIGN-0918.md`): a path is not allowed to become
    /// an origin.
    #[test]
    fn console_url_preserving_path_fails_closed_on_a_hostile_previous_path() {
        let new_origin: tauri::Url = "http://127.0.0.1:9999/".parse().expect("new origin");
        for hostile in [
            "//evil.example",
            "//evil.example/settings",
            "/x\\y",
            "\\\\evil.example",
            "https://evil.example/settings",
            "",
        ] {
            let result = console_url_preserving_path(&new_origin, Some(hostile));
            assert_eq!(
                result.scheme(),
                "http",
                "scheme must stay loopback http for hostile input {hostile:?}"
            );
            assert_eq!(
                result.host_str(),
                Some("127.0.0.1"),
                "host must stay loopback for hostile input {hostile:?}"
            );
            assert_eq!(
                result.port(),
                Some(9999),
                "port must stay the NEW console port for hostile input {hostile:?}"
            );
            assert_eq!(
                result.path(),
                "/",
                "a rejected path must fall back to root, not partially apply, for {hostile:?}"
            );
        }
    }

    /// A well-formed path is still rejected as hostile if it happens to
    /// embed a backslash anywhere (not just as a smuggled leading slash) --
    /// `ConsolePathAndQuery::parse` rejects the whole string, not just the
    /// prefix, per its own doc comment about parser-normalization tricks.
    #[test]
    fn console_path_and_query_rejects_any_embedded_backslash() {
        assert!(ConsolePathAndQuery::parse("/settings\\..\\etc").is_none());
    }

    /// The specific input `starts_with("//")` exists to catch: a
    /// protocol-relative path resolves against a DIFFERENT HOST when a
    /// browser/webview applies it to a base URL (`//evil.example/settings`
    /// against `http://127.0.0.1:9999/` resolves to
    /// `http://evil.example/settings`, not `http://127.0.0.1:9999//evil.example/settings`).
    /// Asserted directly on `parse` (not only end-to-end through
    /// `console_url_preserving_path`) so a future refactor that deletes the
    /// `starts_with("//")` clause fails a test that names exactly what it
    /// protects against, not just a generic "falls back to root" check that
    /// could pass for the wrong reason.
    #[test]
    fn console_path_and_query_rejects_protocol_relative_paths() {
        assert!(ConsolePathAndQuery::parse("//evil.example/settings").is_none());
        assert!(ConsolePathAndQuery::parse("//evil.example").is_none());
    }

    /// An absolute URL with no leading `/` at all (a scheme, then a host)
    /// is rejected by the SAME `!raw.starts_with('/')` clause that rejects
    /// a bare hostname -- `parse` never inspects the string for a scheme
    /// separately, so this and the plain-hostname case are one rule, not
    /// two independently-maintained ones.
    #[test]
    fn console_path_and_query_rejects_an_absolute_url() {
        assert!(ConsolePathAndQuery::parse("http://evil.example/settings").is_none());
    }

    #[test]
    fn console_path_and_query_accepts_a_normal_single_segment_path() {
        assert!(ConsolePathAndQuery::parse("/settings").is_some());
        assert!(ConsolePathAndQuery::parse("/sources/add?x=1").is_some());
        assert!(ConsolePathAndQuery::parse("/").is_some());
    }

    /// End-to-end: a hostile `previous_path` fed through the full
    /// `console_url_preserving_path` call (not just `ConsolePathAndQuery::parse`
    /// in isolation) must still produce a URL whose ORIGIN is the loopback
    /// console -- asserting the origin, not merely that `parse` returned
    /// `None`, is what would catch a regression where a future edit
    /// bypasses `parse` entirely (e.g. a caller that falls back to
    /// `format!("{console_origin}{previous_path}")` on some other branch).
    #[test]
    fn console_url_preserving_path_keeps_a_protocol_relative_previous_path_on_the_loopback_origin()
    {
        let console_origin: tauri::Url = "http://127.0.0.1:9999/".parse().expect("console url");
        let result =
            console_url_preserving_path(&console_origin, Some("//evil.example/settings"));
        assert_eq!(result.scheme(), "http");
        assert_eq!(result.host_str(), Some("127.0.0.1"));
        assert_eq!(result.port(), Some(9999));
        assert_ne!(result.host_str(), Some("evil.example"));
        assert_eq!(result.path(), "/");
    }

    /// `console_path_before_restart` needs a real `AppHandle` with a live
    /// webview window, which `tauri::test::mock_app()` cannot provide (same
    /// limitation `finish_bootstrap_tears_down_with_a_tunnel_preserving_reason`
    /// documents) -- so this proves the ordering property source-side: the
    /// window's URL must be read BEFORE `teardown` runs, because teardown
    /// destroys the window (and whatever page it was showing) that read
    /// would otherwise have nothing left to look at.
    #[test]
    fn restart_after_remote_access_config_reads_the_console_path_before_teardown() {
        let source = include_str!("unified.rs");
        let start = source
            .find("pub(crate) async fn restart_after_remote_access_config(")
            .expect("restart_after_remote_access_config must exist");
        let end = source[start..]
            .find("\nconst REMOTE_ACCESS_CONFIG_POLL_INTERVAL")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..end];
        let path_read_pos = body
            .find("console_path_before_restart(&app)")
            .expect("restart_after_remote_access_config must call console_path_before_restart");
        let teardown_pos = body
            .find("move || teardown(&app, StopReason::ConfigChange)")
            .expect("restart_after_remote_access_config must call teardown");
        assert!(
            path_read_pos < teardown_pos,
            "console_path_before_restart must run before teardown -- teardown destroys the \
             window whose URL it needs to read"
        );
    }

    #[test]
    fn decide_console_navigation_allows_the_consoles_own_origin() {
        let console: tauri::Url = "http://127.0.0.1:4310/".parse().expect("console url");
        for path in ["/", "/settings", "/connect"] {
            let url: tauri::Url = format!("http://127.0.0.1:4310{path}")
                .parse()
                .expect("console-origin url");
            assert!(
                decide_console_navigation(&url, &console),
                "navigation within the console's own origin ({path}) must be allowed, \
                 or the owner could never move around the console at all"
            );
        }
    }

    #[test]
    fn decide_console_navigation_denies_non_https_external_urls() {
        // Every scheme here is denied WITHOUT ever reaching
        // open::that_detached -- that call only happens for `https:`, gated
        // above this loop -- so none of these need the dry-run env var.
        // `https:` itself is covered separately, below, with the dry-run
        // gate set, so this process never shells out to the real OS opener
        // during a test run.
        let console: tauri::Url = "http://127.0.0.1:4310/".parse().expect("console url");
        for scheme_url in [
            "http://127.0.0.1:1/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            let url: tauri::Url = scheme_url.parse().expect("test url");
            assert!(
                !decide_console_navigation(&url, &console),
                "decide_console_navigation must always deny in-app navigation \
                 (return false) for external url {scheme_url:?}"
            );
        }
    }

    #[test]
    fn decide_console_navigation_denies_https_external_url_without_opening_a_real_browser() {
        // The only test in this file that exercises the https: branch of
        // decide_console_navigation, which is the one branch that can call
        // open::that_detached -- a real OS-level side effect this process
        // must never trigger during a test run (confirmed the hard way: an
        // earlier verification run DID pop a tab in a real desktop session
        // despite running under an isolated display, because xdg-open's
        // single-instance handoff ignores the calling process's DISPLAY).
        // Sets PDPP_OPEN_EXTERNAL_DRY_RUN=1 for the duration of this one
        // assertion and restores the prior value afterward. No other test in
        // this file reads that variable, so this is not a real race even
        // though env vars are process-global under parallel test execution.
        let previous = std::env::var(OPEN_EXTERNAL_DRY_RUN_ENV_VAR).ok();
        std::env::set_var(OPEN_EXTERNAL_DRY_RUN_ENV_VAR, "1");
        let console: tauri::Url = "http://127.0.0.1:4310/".parse().expect("console url");
        let url: tauri::Url = "https://pdpp.dev/".parse().expect("external url");
        let allowed = decide_console_navigation(&url, &console);
        match previous {
            Some(value) => std::env::set_var(OPEN_EXTERNAL_DRY_RUN_ENV_VAR, value),
            None => std::env::remove_var(OPEN_EXTERNAL_DRY_RUN_ENV_VAR),
        }
        assert!(
            !allowed,
            "decide_console_navigation must still deny in-app navigation for an \
             https: external url even in dry-run mode"
        );
    }
}
