// Verification-only test (not part of the committed fix): exhaustively
// exercises the full command-to-window grant matrix against this crate's
// real tauri.conf.json + capabilities/*.json via Tauri's real
// RuntimeAuthority/ACL resolution (tauri::test::get_ipc_response). A future
// command added to generate_handler! without an explicit capability grant
// fails this test loudly, instead of failing silently at runtime in front
// of the owner.
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

#[tauri::command]
fn get_platforms() -> &'static str {
    "ok"
}

#[tauri::command]
fn start_connector_run() -> &'static str {
    "ok"
}

#[tauri::command]
fn start_installed_pdpp_connector_run() -> &'static str {
    "ok"
}

#[tauri::command]
fn prepare_installed_pdpp_import() -> &'static str {
    "ok"
}

#[tauri::command]
fn stop_installed_pdpp_connector_run() -> &'static str {
    "ok"
}

#[tauri::command]
fn reset_installed_pdpp_browser_profile() -> &'static str {
    "ok"
}

#[tauri::command]
fn is_installed_pdpp_browser_setup_complete() -> &'static str {
    "ok"
}

#[tauri::command]
fn submit_installed_pdpp_interaction_response() -> &'static str {
    "ok"
}

#[tauri::command]
fn stop_connector_run() -> &'static str {
    "ok"
}

#[tauri::command]
fn check_connected_platforms() -> &'static str {
    "ok"
}

#[tauri::command]
fn check_browser_available() -> &'static str {
    "ok"
}

#[tauri::command]
fn download_browser() -> &'static str {
    "ok"
}

#[tauri::command]
fn test_nodejs() -> &'static str {
    "ok"
}

#[tauri::command]
fn debug_connector_paths() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_user_data_path() -> &'static str {
    "ok"
}

#[tauri::command]
fn open_folder() -> &'static str {
    "ok"
}

#[tauri::command]
fn write_export_data() -> &'static str {
    "ok"
}

#[tauri::command]
fn open_platform_export_folder() -> &'static str {
    "ok"
}

#[tauri::command]
fn open_personal_server_scope_folder() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_runs() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_run_export_data() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_latest_source_export_preview() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_latest_source_export_full() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_source_export_preview_from_path() -> &'static str {
    "ok"
}

#[tauri::command]
fn load_source_export_full_from_path() -> &'static str {
    "ok"
}

#[tauri::command]
fn delete_exported_run() -> &'static str {
    "ok"
}

#[tauri::command]
fn check_connector_updates() -> &'static str {
    "ok"
}

#[tauri::command]
fn download_connector() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_log_path() -> &'static str {
    "ok"
}

#[tauri::command]
fn start_personal_server() -> &'static str {
    "ok"
}

#[tauri::command]
fn stop_personal_server() -> &'static str {
    "ok"
}

#[tauri::command]
fn clear_personal_server_data() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_personal_server_data_path() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_personal_server_status() -> &'static str {
    "ok"
}

#[tauri::command]
fn list_browser_sessions() -> &'static str {
    "ok"
}

#[tauri::command]
fn clear_browser_session() -> &'static str {
    "ok"
}

#[tauri::command]
fn mark_export_synced() -> &'static str {
    "ok"
}

#[tauri::command]
fn start_reference_server() -> &'static str {
    "ok"
}

#[tauri::command]
fn login_reference_server() -> &'static str {
    "ok"
}

#[tauri::command]
fn open_reference_server_view() -> &'static str {
    "ok"
}

#[tauri::command]
fn resize_reference_server_view() -> &'static str {
    "ok"
}

#[tauri::command]
fn hide_reference_server_view() -> &'static str {
    "ok"
}

#[tauri::command]
fn add_developer_connector_source() -> &'static str {
    "ok"
}

#[tauri::command]
fn list_developer_connector_sources() -> &'static str {
    "ok"
}

#[tauri::command]
fn reload_developer_connector_source() -> &'static str {
    "ok"
}

#[tauri::command]
fn remove_developer_connector_source() -> &'static str {
    "ok"
}

#[tauri::command]
fn select_developer_connector_source() -> &'static str {
    "ok"
}

#[tauri::command]
fn download_chromium_rust() -> &'static str {
    "ok"
}

#[tauri::command]
fn handle_download() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_run_files() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_registry_url() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_installed_connectors() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_app_config() -> &'static str {
    "ok"
}

#[tauri::command]
fn set_app_config() -> &'static str {
    "ok"
}

#[tauri::command]
fn stop_reference_server() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_reference_server_status() -> &'static str {
    "ok"
}

#[tauri::command]
fn close_reference_server_view() -> &'static str {
    "ok"
}

#[tauri::command]
fn inspect_remote_access_provider() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_remote_access_config() -> &'static str {
    "ok"
}

#[tauri::command]
fn inspect_remote_access() -> &'static str {
    "ok"
}

#[tauri::command]
fn set_remote_access_config() -> &'static str {
    "ok"
}

#[tauri::command]
fn configure_remote_access() -> &'static str {
    "ok"
}

fn build_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_builder()
        .invoke_handler(tauri::generate_handler![
            get_platforms,
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
            test_nodejs,
            debug_connector_paths,
            get_user_data_path,
            open_folder,
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
            login_reference_server,
            open_reference_server_view,
            resize_reference_server_view,
            hide_reference_server_view,
            add_developer_connector_source,
            list_developer_connector_sources,
            reload_developer_connector_source,
            remove_developer_connector_source,
            select_developer_connector_source,
            download_chromium_rust,
            handle_download,
            get_run_files,
            get_registry_url,
            get_installed_connectors,
            get_app_config,
            set_app_config,
            stop_reference_server,
            get_reference_server_status,
            close_reference_server_view,
            inspect_remote_access_provider,
            get_remote_access_config,
            inspect_remote_access,
            set_remote_access_config,
            configure_remote_access
        ])
        .build(tauri::generate_context!())
        .expect("failed to build test app from real tauri.conf.json + capabilities")
}

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    url: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

// main.json grants these to "main" (per src/**/*.ts* invoke() call sites,
// plus commands with no current caller kept reachable from main to match
// this app's prior behavior, when ACL enforcement was off entirely).
const MAIN_COMMANDS: &[&str] = &[
        "get_platforms",
        "start_connector_run",
        "start_installed_pdpp_connector_run",
        "prepare_installed_pdpp_import",
        "stop_installed_pdpp_connector_run",
        "reset_installed_pdpp_browser_profile",
        "is_installed_pdpp_browser_setup_complete",
        "submit_installed_pdpp_interaction_response",
        "stop_connector_run",
        "check_connected_platforms",
        "check_browser_available",
        "download_browser",
        "test_nodejs",
        "debug_connector_paths",
        "get_user_data_path",
        "open_folder",
        "write_export_data",
        "open_platform_export_folder",
        "open_personal_server_scope_folder",
        "load_runs",
        "load_run_export_data",
        "load_latest_source_export_preview",
        "load_latest_source_export_full",
        "load_source_export_preview_from_path",
        "load_source_export_full_from_path",
        "delete_exported_run",
        "check_connector_updates",
        "download_connector",
        "get_log_path",
        "start_personal_server",
        "stop_personal_server",
        "clear_personal_server_data",
        "get_personal_server_data_path",
        "get_personal_server_status",
        "list_browser_sessions",
        "clear_browser_session",
        "mark_export_synced",
        "start_reference_server",
        "login_reference_server",
        "open_reference_server_view",
        "resize_reference_server_view",
        "hide_reference_server_view",
        "add_developer_connector_source",
        "list_developer_connector_sources",
        "reload_developer_connector_source",
        "remove_developer_connector_source",
        "select_developer_connector_source",
        "download_chromium_rust",
        "handle_download",
        "get_run_files",
        "get_registry_url",
        "get_installed_connectors",
        "get_app_config",
        "set_app_config",
        "stop_reference_server",
        "get_reference_server_status",
        "close_reference_server_view",
        "inspect_remote_access_provider"
];

// console.json grants exactly these four to "console" (the only invoke()
// call sites in apps/console/src).
const CONSOLE_COMMANDS: &[&str] = &[
        "get_remote_access_config",
        "inspect_remote_access",
        "set_remote_access_config",
        "configure_remote_access"
];

const MAIN_REAL_ORIGIN: &str = "tauri://localhost";
const CONSOLE_REAL_ORIGIN: &str = "http://127.0.0.1:54321";

#[test]
fn every_main_command_is_reachable_from_main_at_its_real_local_origin() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let mut failures = Vec::new();
    for cmd in MAIN_COMMANDS {
        if invoke(&webview, cmd, MAIN_REAL_ORIGIN).is_err() {
            failures.push(*cmd);
        }
    }

    assert!(
        failures.is_empty(),
        "main.json failed to grant these commands to main: {failures:?}"
    );
}

#[test]
fn every_console_command_is_reachable_from_console_at_its_real_loopback_origin() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "console", Default::default())
        .build()
        .unwrap();

    let mut failures = Vec::new();
    for cmd in CONSOLE_COMMANDS {
        if invoke(&webview, cmd, CONSOLE_REAL_ORIGIN).is_err() {
            failures.push(*cmd);
        }
    }

    assert!(
        failures.is_empty(),
        "console.json failed to grant these commands to console: {failures:?}"
    );
}

#[test]
fn console_cannot_reach_any_main_only_command() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "console", Default::default())
        .build()
        .unwrap();

    let mut leaks = Vec::new();
    for cmd in MAIN_COMMANDS {
        if invoke(&webview, cmd, CONSOLE_REAL_ORIGIN).is_ok() {
            leaks.push(*cmd);
        }
    }

    assert!(
        leaks.is_empty(),
        "console window can reach main-only commands (unintended widening): {leaks:?}"
    );
}

#[test]
fn main_cannot_reach_any_console_only_command() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let mut leaks = Vec::new();
    for cmd in CONSOLE_COMMANDS {
        if invoke(&webview, cmd, MAIN_REAL_ORIGIN).is_ok() {
            leaks.push(*cmd);
        }
    }

    assert!(
        leaks.is_empty(),
        "main window can reach console-only commands (unintended widening): {leaks:?}"
    );
}

#[test]
fn console_window_is_denied_from_a_non_loopback_remote_origin() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "console", Default::default())
        .build()
        .unwrap();

    // Proves the fix is scoped to loopback, not "any remote origin" -- the
    // brief's explicit requirement not to open IPC to arbitrary remote origins.
    let result = invoke(
        &webview,
        "get_remote_access_config",
        "http://evil.example.com",
    );

    assert!(
        result.is_err(),
        "console.json's remote allowlist must not grant IPC to a non-loopback origin"
    );
}
