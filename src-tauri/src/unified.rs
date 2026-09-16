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
use crate::commands::{attach_reference_server, login_reference_server_with_password};
use crate::owner_credential::{
    configured_owner_password, load_or_create_owner_credential, owner_credential_path,
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

pub(crate) const CONSOLE_WINDOW_LABEL: &str = "console";
const TRAY_ICON_ID: &str = "dataconnect-tray";
const DEFAULT_CONSOLE_URL: &str = "http://localhost:3001";
const CONSOLE_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const CONSOLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const UNIFIED_PROFILE_ENV: &str = "TAURI_PROFILE";
const DEFAULT_PROFILE: &str = "release";
const RI_LABEL: &str = "reference-implementation";
const CONSOLE_LABEL: &str = "console";
const RI_HEALTH_PATH: &str = "/.well-known/oauth-protected-resource";
const UNIFIED_DB_DIRECTORY: &str = "unified";
const UNIFIED_SHUTDOWN_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum UnifiedStatus {
    #[default]
    Starting,
    Ready,
    Restarting,
    Stopped,
    Error,
}

impl UnifiedStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "Status: Starting",
            Self::Ready => "Status: Ready",
            Self::Restarting => "Status: Restarting",
            Self::Stopped => "Status: Stopped",
            Self::Error => "Status: Error",
        }
    }
}

#[derive(Default)]
struct UnifiedRuntimeState {
    status: Mutex<UnifiedStatus>,
    console_origin: Mutex<Option<String>>,
    session_cookie: Mutex<Option<String>>,
    sidecars_ready: Mutex<BTreeSet<String>>,
    stack: Mutex<Option<UnifiedStack>>,
    shutdown: Mutex<ShutdownState>,
}

#[derive(Default)]
struct ShutdownState {
    requested: bool,
    complete: bool,
}

struct UnifiedStack {
    ri: SupervisorHandle,
    console: SupervisorHandle,
}

impl UnifiedStack {
    fn stop(&self) -> Result<(), String> {
        self.stop_until(std::time::Instant::now() + UNIFIED_SHUTDOWN_BUDGET)
    }

    fn stop_until(&self, deadline: std::time::Instant) -> Result<(), String> {
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
    let status_item = MenuItem::with_id(manager, "status", status.label(), false, None::<&str>)?;
    let open_console = MenuItem::with_id(
        manager,
        "open-console",
        "Open DataConnect",
        true,
        None::<&str>,
    )?;
    let open_browser = MenuItem::with_id(
        manager,
        "open-browser",
        "Open in browser",
        true,
        None::<&str>,
    )?;
    let show_logs = MenuItem::with_id(manager, "show-logs", "Show logs", true, None::<&str>)?;
    let quit = MenuItem::with_id(manager, "quit", "Quit", true, None::<&str>)?;
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

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = bootstrap_and_open_console(app_handle.clone()).await {
            log::error!("Unified DataConnect startup failed: {error}");
            set_status(&app_handle, UnifiedStatus::Error);
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
        if let Err(error) = bootstrap_and_open_console(app.clone()).await {
            log::error!("Failed to open DataConnect console: {error}");
            set_status(&app, UnifiedStatus::Error);
        }
    });
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match tray_action_for_menu_id(event.id().as_ref()) {
        TrayAction::OpenConsole => focus_or_bootstrap(app.clone()),
        TrayAction::OpenBrowser => match configured_console_url() {
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

fn attach_mode() -> bool {
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
        env.extend(pairs.into_iter().map(|(name, value)| {
            (OsString::from(name), OsString::from(value))
        }));
    }
}

fn ri_process_spec(
    app: &AppHandle,
    node_binary: &Path,
    root: &Path,
    data_dir: &Path,
    owner_password: &str,
) -> ProcessSpec {
    let mut env = env_map(vec![
        (OsString::from("AS_PORT"), OsString::from("{port}")),
        (OsString::from("RS_PORT"), OsString::from("{port+1}")),
        (
            OsString::from("PDPP_DB_PATH"),
            data_dir.join("pdpp.sqlite").into_os_string(),
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
    }
}

fn console_process_spec(
    node_binary: &Path,
    root: &Path,
    ri_origin: &str,
    rs_origin: &str,
    owner_password: &str,
) -> ProcessSpec {
    let env = env_map(vec![
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
    ProcessSpec {
        label: CONSOLE_LABEL.to_string(),
        program: node_binary.to_path_buf(),
        args: vec![root.join("launch.mjs").into_os_string()],
        cwd: Some(root.to_path_buf()),
        env: EnvironmentSpec::cleared(env),
        readiness: Readiness::HttpGet {
            url_from_port: "http://127.0.0.1:{port}/".to_string(),
            deadline: CONSOLE_WAIT_TIMEOUT,
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
    ri_origin: String,
    console_url: String,
}

fn start_managed_stack(app: &AppHandle, owner_password: &str) -> Result<ManagedStackStart, String> {
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
    let ri = Supervisor::new(
        ri_process_spec(app, &node_binary, &ri_root, &data_dir, owner_password),
        sink.clone(),
    )
    .start()
    .map_err(|error| format!("Failed to start staged RI: {error}"))?;
    let ri_origin = format!("http://127.0.0.1:{}", ri.port());
    let rs_origin = format!("http://127.0.0.1:{}", ri.port().saturating_add(1));
    let console = Supervisor::new(
        console_process_spec(
            &node_binary,
            &console_root,
            &ri_origin,
            &rs_origin,
            owner_password,
        ),
        sink,
    )
    .start()
    .map_err(|error| format!("Failed to start staged console: {error}"))?;
    let console_url = format!("http://127.0.0.1:{}", console.port());
    Ok(ManagedStackStart {
        stack: UnifiedStack { ri, console },
        ri_origin,
        console_url,
    })
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

fn stop_stack(app: &AppHandle) -> Result<(), String> {
    let stack = take_stack(app)?;
    stack.map_or(Ok(()), |stack| stack.stop())
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

        let result = stack.map_or(Ok(()), |stack| stack.stop_until(deadline));
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

    log::info!("Unified shutdown requested; stopping managed sidecars asynchronously");
    let initial_stack = take_stack(app).ok().flatten();
    if initial_stack.is_none() && !startup_is_in_progress(app) {
        log::info!("No managed unified sidecars are running; allowing app exit");
        mark_shutdown_complete(app);
        return false;
    }

    begin_background_shutdown(app, initial_stack, exit_code);
    true
}

pub(crate) fn cleanup(app: &AppHandle) {
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

fn cleanup_managed_stack_on_error(app: &AppHandle, managed: bool) {
    if managed {
        if let Err(error) = stop_stack(app) {
            log::error!("Failed to clean up unified sidecars after startup error: {error}");
        }
    }
}

async fn bootstrap_and_open_console(app: AppHandle) -> Result<(), String> {
    set_status(&app, UnifiedStatus::Starting);

    let credential_path = owner_credential_path(&app)?;
    let stored_credential = load_or_create_owner_credential(&credential_path)?;
    let password = configured_owner_password().unwrap_or(stored_credential);

    let (ri_origin, console_url, managed) = if attach_mode() {
        let reference_status = attach_reference_server(app.clone()).await?;
        let ri_origin = reference_status
            .origin
            .ok_or_else(|| "Reference server reported ready without an origin".to_string())?;
        (ri_origin, configured_console_url()?, false)
    } else {
        let password_for_sidecar = password.clone();
        let app_for_sidecars = app.clone();
        let result = tokio::task::spawn_blocking(move || {
            start_managed_stack(&app_for_sidecars, &password_for_sidecar)
        })
        .await
        .map_err(|error| format!("Unified sidecar startup task failed: {error}"))??;
        let ri_origin = result.ri_origin.clone();
        let console_url = result.console_url.clone();
        store_stack(&app, result.stack)?;
        (ri_origin, console_url, true)
    };

    let login = match login_reference_server_with_password(ri_origin, &password).await {
        Ok(login) => login,
        Err(error) => {
            cleanup_managed_stack_on_error(&app, managed);
            return Err(error);
        }
    };

    if let Err(error) = wait_for_console(&console_url).await {
        cleanup_managed_stack_on_error(&app, managed);
        return Err(error);
    }
    let console_origin = console_url
        .parse()
        .map_err(|error| format!("Invalid console URL: {error}"));
    let console_origin = match console_origin {
        Ok(origin) => origin,
        Err(error) => {
            cleanup_managed_stack_on_error(&app, managed);
            return Err(error);
        }
    };
    let cookie = match owner_session_cookie(&console_origin, &login.session_cookie) {
        Ok(cookie) => cookie,
        Err(error) => {
            cleanup_managed_stack_on_error(&app, managed);
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
            .session_cookie
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? =
            Some(login.session_cookie);
        Ok(())
    })();
    if let Err(error) = state_update {
        cleanup_managed_stack_on_error(&app, managed);
        return Err(error);
    }

    if let Err(error) = create_or_update_console_window(&app, console_origin, cookie) {
        cleanup_managed_stack_on_error(&app, managed);
        return Err(error);
    }
    set_status(&app, UnifiedStatus::Ready);
    Ok(())
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
        window
            .show()
            .map_err(|error| format!("Failed to show console: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Failed to focus console: {error}"))?;
        return Ok(());
    }

    let blank_url: tauri::Url = "about:blank"
        .parse()
        .map_err(|error| format!("Failed to create blank console URL: {error}"))?;
    let window =
        WebviewWindowBuilder::new(app, CONSOLE_WINDOW_LABEL, WebviewUrl::External(blank_url))
            .title("DataConnect")
            .visible(false)
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
            api.prevent_close();
            let _ = window_for_close.hide();
        }
    });
    window
        .show()
        .map_err(|error| format!("Failed to show console: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus console: {error}"))?;
    Ok(())
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
        (UnifiedStack { ri, console }, ri_port, console_port)
    }

    #[test]
    fn unified_stack_requires_exact_one_flag() {
        assert!(enabled_for_value(Some("1")));
        assert!(!enabled_for_value(Some("0")));
        assert!(!enabled_for_value(Some("true")));
        assert!(!enabled_for_value(None));
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

    #[tokio::test(flavor = "current_thread")]
    async fn fake_sidecars_start_before_owner_login_is_attempted() {
        let directory = tempdir().expect("fake stack temp directory");
        let login_log = directory.path().join("login.log");
        let ri_script = fake_ri_script(&login_log, None, None, None);
        let console_script = fake_console_script();
        let events = RecordingSink::default();
        let (stack, ri_port, console_port) = fake_stack(
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
        let (stack, _, _) = fake_stack(
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

    #[test]
    fn fake_ri_crash_restarts_within_the_bounded_policy() {
        let directory = tempdir().expect("fake stack temp directory");
        let login_log = directory.path().join("login.log");
        let crash_marker = directory.path().join("crash.marker");
        let ri_script = fake_ri_script(&login_log, Some(&crash_marker), None, None);
        let console_script = fake_console_script();
        let events = RecordingSink::default();
        let observed = Arc::clone(&events.0);
        let (stack, _, _) = fake_stack(
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
