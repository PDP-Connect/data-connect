// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Every command registered in `generate_handler!` (src/lib.rs) must be
// listed here. Declaring an AppManifest at all makes Tauri enforce ACL on
// every app command from every window (see RuntimeAuthority::resolve_access
// in the `tauri` crate: `has_app_acl_manifest` is a single app-wide flag).
// A command left out of this list has no `allow-$command` permission to
// grant in capabilities/*.json and becomes unreachable from every window,
// including "main" -- there is no such thing as "leave the old ones alone"
// once this list exists.
const APP_COMMANDS: &[&str] = &[
    "get_platforms",
    "add_developer_connector_source",
    "list_developer_connector_sources",
    "reload_developer_connector_source",
    "remove_developer_connector_source",
    "select_developer_connector_source",
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
    "download_chromium_rust",
    "test_nodejs",
    "debug_connector_paths",
    "get_user_data_path",
    "handle_download",
    "open_folder",
    "get_run_files",
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
    "get_registry_url",
    "get_installed_connectors",
    "get_app_config",
    "set_app_config",
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
    "stop_reference_server",
    "get_reference_server_status",
    "login_reference_server",
    "open_reference_server_view",
    "resize_reference_server_view",
    "hide_reference_server_view",
    "close_reference_server_view",
    "inspect_remote_access",
    "get_remote_access_config",
    "set_remote_access_config",
    "configure_remote_access",
    "inspect_remote_access_provider",
];

fn main() {
    stage_development_node_sidecar();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build tauri app manifest");
}

fn stage_development_node_sidecar() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let destination =
        std::path::PathBuf::from("binaries").join(format!("pdpp-node-{target}{extension}"));
    let license_destination = std::path::PathBuf::from("binaries/pdpp-node-LICENSE");
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let Some(license) = [
        node.parent().map(|path| path.join("LICENSE")),
        node.parent().map(|path| path.join("../LICENSE")),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate.is_file()) else {
        return;
    };
    std::fs::create_dir_all("binaries").expect("failed to create development sidecar directory");
    stage_development_file(&node, &destination, "Node.js sidecar");
    stage_development_file(&license, &license_destination, "Node.js license");
}

fn stage_development_file(source: &std::path::Path, destination: &std::path::Path, label: &str) {
    if destination.is_file() {
        return;
    }
    if std::fs::hard_link(source, destination).is_err() {
        std::fs::copy(source, destination)
            .unwrap_or_else(|error| panic!("failed to stage development {label}: {error}"));
    }
}
