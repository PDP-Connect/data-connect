// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
mod commands;
#[cfg(desktop)]
mod atomic_write;
#[cfg(desktop)]
mod console_port;
#[cfg(desktop)]
mod main_thread_watchdog;
#[cfg(desktop)]
mod owner_credential;
mod processors;
#[cfg(desktop)]
mod recovery_code;
#[cfg(desktop)]
mod remote_access;
#[cfg(desktop)]
mod remote_access_cloudflare;
#[cfg(desktop)]
mod remote_access_ngrok;
#[cfg(desktop)]
mod remote_access_providers;
#[cfg(desktop)]
mod run_lease;
#[cfg(all(desktop, feature = "stall-repro"))]
pub mod stall_repro;
#[cfg(all(desktop, feature = "stall-repro"))]
pub mod winclose_repro;
#[cfg(all(desktop, feature = "stall-repro"))]
pub mod pdeathsig_port_repro;
#[cfg(desktop)]
mod sealed_credential;
#[cfg(desktop)]
mod unified;
#[cfg(target_os = "linux")]
pub mod wayland_titlebar;

pub use commands::browser_surface_host_env_pairs;
#[cfg(all(desktop, feature = "stall-repro"))]
pub use commands::test_support;

use commands::{
    add_developer_connector_source, check_browser_available, check_connected_platforms,
    check_connector_updates, cleanup_browser_surface_host, cleanup_installed_pdpp_connector_runs,
    cleanup_personal_server, cleanup_playwright_processes, cleanup_reference_server,
    clear_browser_session, clear_personal_server_data, close_reference_server_view,
    debug_connector_paths, delete_exported_run, download_browser, download_chromium_rust,
    download_connector, get_app_config, get_installed_connectors, get_log_path,
    get_personal_server_data_path, get_personal_server_status, get_platforms,
    get_reference_server_status, get_registry_url, get_run_files, get_user_data_path,
    handle_download, hide_reference_server_view, is_installed_pdpp_browser_setup_complete,
    list_browser_sessions, list_developer_connector_sources, load_latest_source_export_full,
    load_latest_source_export_preview, load_run_export_data, load_runs,
    load_source_export_full_from_path, load_source_export_preview_from_path,
    login_reference_server, mark_export_synced, open_folder, open_personal_server_scope_folder,
    open_platform_export_folder, open_reference_server_view, prepare_installed_pdpp_import,
    reference_server_has_connection,
    reload_developer_connector_source, remove_developer_connector_source,
    reset_installed_pdpp_browser_profile, resize_reference_server_view,
    select_developer_connector_source, set_app_config, start_connector_run,
    start_installed_pdpp_connector_run, start_personal_server, start_reference_server,
    stop_connector_run, stop_installed_pdpp_connector_run, stop_personal_server,
    stop_reference_server, submit_installed_pdpp_interaction_response, test_nodejs,
    write_export_data, BrowserSurfaceHost,
};
#[cfg(desktop)]
use commands::{get_autostart_enabled, set_autostart_enabled};
#[cfg(desktop)]
use commands::export_database_encryption_recovery_code;
#[cfg(desktop)]
use unified::import_database_encryption_recovery_code;
use tauri::{ipc::Invoke, Listener, Manager, Runtime};

/// Label of the legacy desktop app's window, declared in tauri.conf.json.
const LEGACY_MAIN_WINDOW_LABEL: &str = "main";

/// Build the legacy `main` window from its tauri.conf.json declaration.
fn create_legacy_main_window<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == LEGACY_MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| std::io::Error::other("tauri.conf.json declares no legacy `main` window"))?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
    Ok(())
}

/// Size at which the app log rotates. The plugin default (40 KB) held only
/// minutes of sidecar output.
const LOG_MAX_FILE_BYTES: u128 = 10 * 1024 * 1024;
/// Rotated files kept next to the active one, so the log directory holds at
/// most (1 + 4) x 10 MiB = 50 MiB. Syncthing ships the same 10 MiB file size
/// with 3 old files; VS Code keeps its last 10 sessions.
const LOG_ROTATED_FILES_KEPT: usize = 4;

/// The app log: the Tauri app plus every sidecar's stdout/stderr, which the
/// process supervisor forwards line by line. The plugin's default rotation
/// (`KeepOne`) deletes the full file, which destroyed the evidence of a failed
/// run minutes after it happened; `KeepSome` renames it to a dated file instead.
fn desktop_log_builder() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .max_file_size(LOG_MAX_FILE_BYTES)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(
            LOG_ROTATED_FILES_KEPT,
        ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls cannot pick a process-level CryptoProvider when both `ring` and
    // `aws-lc-rs` are present in the tree (they both are, transitively), and
    // it panics on first TLS use instead of failing gracefully. ngrok opens a
    // TLS session, so without this the tunnel start thread panics and the
    // whole managed stack fails to come up.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        log::debug!("A rustls CryptoProvider was already installed");
    }

    // Load .env file into process environment so VITE_* vars are available
    // to std::env::var() calls (e.g. VITE_ACCOUNT_URL, VITE_CHAIN_ID).
    let _ = dotenvy::dotenv();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is intercepted.
            // The deep-link URL is forwarded automatically via the `deep-link`
            // cargo feature — no manual arg parsing needed.
            #[cfg(desktop)]
            let window = if unified::is_enabled() {
                app.get_webview_window(unified::CONSOLE_WINDOW_LABEL)
            } else {
                app.get_webview_window("main")
            };
            #[cfg(not(desktop))]
            let window = app.get_webview_window("main");
            if let Some(window) = window {
                let _ = window.set_focus();
            } else {
                #[cfg(desktop)]
                if unified::is_enabled() {
                    unified::focus_or_bootstrap(app.clone());
                }
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Restore only size/position. VISIBLE would fight the console
                // window's .visible(false) -> set-cookie -> navigate -> show()
                // choreography (avoids a flash of unauthenticated content).
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                // Versioned filename: a state file saved before the console
                // window's 1280x800 default existed pins a stale small size
                // forever (the plugin re-saves whatever it restores, so a bad
                // size never self-heals). Bumping the filename once discards
                // any pre-v2 state so the builder's own default takes effect
                // again; state saved under this name is trusted from here on.
                .with_filename(".window-state-v2.json")
                .build(),
        );

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    #[cfg(target_os = "linux")]
    let builder = builder.plugin(wayland_titlebar::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            // Enable logging in both debug and release builds, writing to both stdout and a file
            // Default targets are already [Stdout, LogDir] — do NOT add
            // .target() calls or each log line gets written twice.
            app.handle().plugin(desktop_log_builder().build())?;

            let version = app.config().version.clone().unwrap_or_default();
            log::info!("DataConnect v{} starting", version);

            #[cfg(desktop)]
            if main_thread_watchdog::is_enabled() {
                main_thread_watchdog::spawn(app.handle().clone());
            }

            #[cfg(desktop)]
            if unified::is_enabled() {
                let app_data_dir = app.path().app_data_dir()?;
                let resource_dir = app.path().resource_dir().ok();
                let host = BrowserSurfaceHost::start(app_data_dir, resource_dir)
                    .map_err(std::io::Error::other)?;
                log::info!(
                    "Started unified browser surface host at {}",
                    host.endpoint()
                );
                app.manage(host);
                unified::setup(app)?;
            }

            // Runtime composition is decided here, once. The legacy `main`
            // window is `"create": false` in tauri.conf.json because a
            // window Tauri builds from config loads the legacy app and mounts
            // its hooks before this hook runs; hiding it afterwards leaves
            // that runtime live. It is built only when legacy mode is chosen.
            #[cfg(desktop)]
            let legacy = !unified::is_enabled();
            #[cfg(not(desktop))]
            let legacy = true;
            if legacy {
                create_legacy_main_window(app)?;
            }

            // Listen for close window events from connectors
            let app_handle = app.handle().clone();
            app.listen("connector-close-window", move |event| {
                let payload_str = event.payload();
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str) {
                    if let Some(run_id) = payload.get("runId").and_then(|v| v.as_str()) {
                        let window_label = format!("connector-{}", run_id);
                        if let Some(window) = app_handle.get_webview_window(&window_label) {
                            log::info!("Closing connector window: {}", window_label);
                            let _ = window.close();
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(app_invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                #[cfg(desktop)]
                if unified::is_enabled() {
                    match code {
                        // The last window closed. Unified mode stays resident
                        // in the tray; only an explicit exit (tray Quit) stops
                        // it. The legacy `main` window used to provide this
                        // by never closing while hidden.
                        None => api.prevent_exit(),
                        Some(code) => {
                            if unified::request_shutdown(app, code) {
                                api.prevent_exit();
                            }
                        }
                    }
                }
            }
            tauri::RunEvent::Exit => {
                #[cfg(desktop)]
                if unified::is_enabled() {
                    unified::assert_stack_released_at_exit(app);
                }
                cleanup_browser_surface_host(app);
                cleanup_personal_server();
                cleanup_reference_server();
                cleanup_installed_pdpp_connector_runs();
                cleanup_playwright_processes();
            }
            _ => {}
        });
}

/// The app's one invoke handler. Commands in `RUNTIME_GENERIC_COMMANDS` go
/// to `runtime_generic_invoke_handler`, which a test can build under
/// `tauri::test::mock_builder()`; every other command goes to the list below,
/// whose commands take the concrete Wry `AppHandle`.
pub(crate) fn app_invoke_handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    route_invoke(
        runtime_generic_invoke_handler(),
        tauri::generate_handler![
        get_platforms,
        add_developer_connector_source,
        list_developer_connector_sources,
        reload_developer_connector_source,
        remove_developer_connector_source,
        select_developer_connector_source,
        start_connector_run,
        start_installed_pdpp_connector_run,
        prepare_installed_pdpp_import,
        stop_installed_pdpp_connector_run,
        reset_installed_pdpp_browser_profile,
        commands::pdpp_collection_state::clear_pdpp_collection_state,
        commands::pdpp_collection_state::clear_pdpp_collection_connection_state,
        commands::pdpp_connections::ensure_pdpp_connection,
        commands::pdpp_connections::create_pdpp_connection,
        commands::pdpp_connections::set_pdpp_connection_label,
        commands::pdpp_connections::remove_pdpp_connection,
        is_installed_pdpp_browser_setup_complete,
        submit_installed_pdpp_interaction_response,
        stop_connector_run,
        check_connected_platforms,
        check_browser_available,
        download_browser,
        download_chromium_rust,
        test_nodejs,
        debug_connector_paths,
        get_user_data_path,
        handle_download,
        open_folder,
        get_run_files,
        write_export_data,
        open_platform_export_folder,
        open_personal_server_scope_folder,
        load_runs,
        load_run_export_data,
        load_latest_source_export_preview,
        load_latest_source_export_full,
        load_source_export_preview_from_path,
        load_source_export_full_from_path,
        delete_exported_run,
        check_connector_updates,
        download_connector,
        get_registry_url,
        get_installed_connectors,
        get_app_config,
        set_app_config,
        get_log_path,
        start_personal_server,
        stop_personal_server,
        clear_personal_server_data,
        get_personal_server_data_path,
        get_personal_server_status,
        list_browser_sessions,
        clear_browser_session,
        mark_export_synced,
        start_reference_server,
        stop_reference_server,
        get_reference_server_status,
        login_reference_server,
        reference_server_has_connection,
        open_reference_server_view,
        resize_reference_server_view,
        hide_reference_server_view,
        close_reference_server_view,
        #[cfg(desktop)]
        get_autostart_enabled,
        #[cfg(desktop)]
        set_autostart_enabled,
        #[cfg(desktop)]
        export_database_encryption_recovery_code,
        #[cfg(desktop)]
        import_database_encryption_recovery_code,
        ],
    )
}

/// Commands served by `runtime_generic_invoke_handler`. The native
/// owner-password window (`public/owner-password.html`) calls
/// `set_desktop_owner_password`; v0.7.59 registered no handler for it, so
/// saving a password there failed with "command not found".
#[cfg(desktop)]
const RUNTIME_GENERIC_COMMANDS: &[&str] = &["set_desktop_owner_password"];
#[cfg(not(desktop))]
const RUNTIME_GENERIC_COMMANDS: &[&str] = &[];

pub(crate) fn runtime_generic_invoke_handler<R: Runtime>(
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        #[cfg(desktop)]
        owner_credential::set_desktop_owner_password,
    ]
}

/// Send each invoke to `generic` if it names a `RUNTIME_GENERIC_COMMANDS`
/// command, otherwise to `rest`. A generated handler consumes the invoke, so
/// the choice is made by name before either one runs.
fn route_invoke<R: Runtime>(
    generic: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    rest: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if RUNTIME_GENERIC_COMMANDS.contains(&invoke.message.command()) {
            generic(invoke)
        } else {
            rest(invoke)
        }
    }
}

/// A mock app built from the real tauri.conf.json (so the real capability
/// files apply) and served by `route_invoke` with
/// `runtime_generic_invoke_handler`, whose app-data directory is
/// `data_root/app`. The path resolver joins the identifier onto the user
/// data directory, and joining an absolute path replaces the base, so a test
/// never resolves the installed app's real data directory.
#[cfg(all(test, desktop))]
pub(crate) fn mock_app_with_data_dir(
    data_root: &std::path::Path,
) -> tauri::App<tauri::test::MockRuntime> {
    let mut context: tauri::Context<tauri::test::MockRuntime> = tauri::generate_context!();
    context.config_mut().identifier = data_root.join("app").to_string_lossy().into_owned();
    let app = tauri::test::mock_builder()
        .invoke_handler(route_invoke(runtime_generic_invoke_handler(), |_| false))
        .build(context)
        .expect("build the mock app");
    app.manage(owner_credential::ConfiguredOwnerPasswordForTest(None));
    app
}

/// Send one IPC call from `webview`, as its page's `invoke()` would.
#[cfg(all(test, desktop))]
pub(crate) fn invoke_from(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("app URL"),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri builds every config window marked `create` before the setup
    /// hook runs, so the legacy frontend would load and mount its hooks even
    /// in unified mode. Built from the real tauri.conf.json context, the app
    /// must start with no window at all; the setup hook alone chooses.
    #[test]
    fn startup_builds_no_window_before_composition_is_chosen() {
        let mut app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build the app from tauri.conf.json");
        // Tauri builds config windows when the event loop first runs, not
        // in `build`. One iteration runs that step.
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        assert!(
            app.webview_windows().is_empty(),
            "config created windows before setup: {:?}",
            app.webview_windows().keys().collect::<Vec<_>>()
        );
    }

    /// The native password window saves through `set_desktop_owner_password`.
    /// Sent through the real routing to the real handler, from a webview
    /// labelled like that window and under the real capability files, the
    /// call must reach the command: with no pending window request it fails
    /// on the command's own authority check, not with "command not found".
    #[test]
    fn the_password_window_command_is_registered() {
        let data_root = tempfile::tempdir().expect("tempdir");
        let app = mock_app_with_data_dir(data_root.path());
        let window = tauri::WebviewWindowBuilder::new(&app, "owner-password", Default::default())
            .build()
            .expect("build the owner-password window");
        let response = invoke_from(&window, "set_desktop_owner_password", serde_json::json!({
            "password": "a-long-enough-owner-password",
        }));
        assert_eq!(
            response.expect_err("no window request is pending"),
            serde_json::json!("Open the password window from Settings before saving.")
        );
    }

    /// The IPC ACL lets every local-origin webview call app commands, so the
    /// legacy `main` window and the recovery window reach this command too.
    /// Only the password window may pass to the command's authority check.
    #[test]
    fn only_the_password_window_may_save_a_password() {
        let data_root = tempfile::tempdir().expect("tempdir");
        let app = mock_app_with_data_dir(data_root.path());
        for label in ["main", "recovery"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .expect("build a local webview");
            let response = invoke_from(&window, "set_desktop_owner_password", serde_json::json!({
                "password": "a-long-enough-owner-password",
            }));
            assert_eq!(
                response.expect_err("refused by label"),
                serde_json::json!(
                    "Only the DataConnect password window can save the owner password."
                ),
                "{label}"
            );
        }
        let window = tauri::WebviewWindowBuilder::new(&app, "owner-password", Default::default())
            .build()
            .expect("build the owner-password window");
        let response = invoke_from(&window, "set_desktop_owner_password", serde_json::json!({
            "password": "a-long-enough-owner-password",
        }));
        assert_eq!(
            response.expect_err("reaches the authority check"),
            serde_json::json!("Open the password window from Settings before saving.")
        );
    }

    /// Writes info lines of about 1 KiB until the active log file shrinks,
    /// which means the plugin rotated it.
    fn fill_until_rotation(logger: &dyn log::Log, active: &std::path::Path) {
        let padding = "x".repeat(1024);
        let mut last_len = 0;
        loop {
            for _ in 0..256 {
                logger.log(
                    &log::Record::builder()
                        .level(log::Level::Info)
                        .args(format_args!("[reference] stdout: {padding}"))
                        .build(),
                );
            }
            let len = std::fs::metadata(active).map(|m| m.len()).unwrap_or(0);
            if len < last_len {
                return;
            }
            last_len = len;
        }
    }

    fn log_dir_contents(dir: &std::path::Path) -> Vec<(String, u64, String)> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .expect("read the log dir")
            .map(|entry| {
                let path = entry.expect("dir entry").path();
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                let len = std::fs::metadata(&path).expect("metadata").len();
                let text = std::fs::read_to_string(&path).expect("read log file");
                (name, len, text)
            })
            .collect();
        files.sort();
        files
    }

    /// A failed run must still be in the log after the next rotation, and
    /// the log directory must stay within a fixed disk budget however long
    /// the app runs. This drives the real plugin logger with the production
    /// limits. Rotated files are named to the second, so the test waits a
    /// second between rotations, as any real 10 MiB of logging does.
    #[test]
    fn desktop_log_keeps_rotated_history_within_a_disk_budget() {
        let dir = tempfile::tempdir().expect("tempdir");
        let active = dir.path().join("DataConnect.log");
        let app = tauri::test::mock_app();
        let (_plugin, _level, logger) = desktop_log_builder()
            .clear_targets()
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Folder {
                    path: dir.path().to_path_buf(),
                    file_name: Some("DataConnect".into()),
                },
            ))
            .split(app.handle())
            .expect("build the file logger");

        logger.log(
            &log::Record::builder()
                .level(log::Level::Error)
                .args(format_args!("run r-1 failed: marker-7f3a"))
                .build(),
        );
        fill_until_rotation(logger.as_ref(), &active);
        assert!(
            log_dir_contents(dir.path())
                .iter()
                .any(|(_, _, text)| text.contains("marker-7f3a")),
            "the failed run's line was deleted by the first rotation"
        );

        for _ in 0..LOG_ROTATED_FILES_KEPT + 1 {
            std::thread::sleep(std::time::Duration::from_millis(1100));
            fill_until_rotation(logger.as_ref(), &active);
        }
        let files = log_dir_contents(dir.path());
        let names: Vec<_> = files.iter().map(|(name, _, _)| name.as_str()).collect();
        assert_eq!(
            files.len(),
            LOG_ROTATED_FILES_KEPT + 1,
            "expected the active file plus {LOG_ROTATED_FILES_KEPT} rotated files: {names:?}"
        );
        assert!(
            names
                .iter()
                .all(|name| name.starts_with("DataConnect") && name.ends_with(".log")),
            "{names:?}"
        );
        let total: u64 = files.iter().map(|(_, len, _)| len).sum();
        assert!(
            total <= (LOG_ROTATED_FILES_KEPT as u64 + 1) * LOG_MAX_FILE_BYTES as u64,
            "log dir holds {total} bytes"
        );
        assert!(
            !files
                .iter()
                .any(|(_, _, text)| text.contains("marker-7f3a")),
            "the oldest rotated file must be deleted once the budget is full"
        );
    }

    #[test]
    fn legacy_mode_still_builds_the_declared_main_window() {
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build the app from tauri.conf.json");
        create_legacy_main_window(&app).expect("build the legacy window");
        assert!(app.get_webview_window(LEGACY_MAIN_WINDOW_LABEL).is_some());
    }
}
