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
use tauri::{Listener, Manager};

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
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

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
        .invoke_handler(tauri::generate_handler![
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
        ])
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

    #[test]
    fn legacy_mode_still_builds_the_declared_main_window() {
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("build the app from tauri.conf.json");
        create_legacy_main_window(&app).expect("build the legacy window");
        assert!(app.get_webview_window(LEGACY_MAIN_WINDOW_LABEL).is_some());
    }
}
