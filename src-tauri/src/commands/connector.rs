// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use super::connector_store::{get_legacy_user_connectors_dir, read_active_connector_manifest};
use super::pdpp_installed_connector::{
    pdpp_stream_to_dataconnect_scope, read_admitted_pdpp_asset_with_resource_dir,
};

// Chromium download constants
const CHROMIUM_REVISION: &str = "1200";
const CHROMIUM_CDN_MIRRORS: &[&str] = &[
    "https://cdn.playwright.dev",
    "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Platform {
    pub id: String,
    pub company: String,
    pub name: String,
    pub filename: String,
    pub description: String,
    #[serde(rename = "isUpdated")]
    pub is_updated: bool,
    #[serde(rename = "logoURL")]
    pub logo_url: String,
    #[serde(rename = "needsConnection")]
    pub needs_connection: bool,
    /// Runtime type. Installed PDPP connectors use "pdpp-network".
    pub runtime: Option<String>,
    /// Scopes this connector can export (just the scope strings, e.g. ["chatgpt.conversations", "chatgpt.memories"])
    pub scopes: Option<Vec<String>>,
    pub setup: Option<ActivePdppSetup>,
    #[serde(rename = "sourceKind", skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(rename = "sourceId", skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(rename = "activeSource", skip_serializing_if = "Option::is_none")]
    pub active_source: Option<bool>,
    /// For an installed PDPP connector: whether its manifest requires the
    /// browser binding, so the desktop keeps a saved browser session for it.
    #[serde(rename = "requiresBrowser", skip_serializing_if = "Option::is_none")]
    pub requires_browser: Option<bool>,
    #[serde(rename = "connectionId", skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(rename = "accountLabel", skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivePdppPlatformManifest {
    connector_id: String,
    connector_key: Option<String>,
    display_name: Option<String>,
    name: Option<String>,
    description: Option<String>,
    brand: Option<ActivePdppBrand>,
    setup: Option<ActivePdppSetup>,
    streams: Vec<ActivePdppStream>,
    #[serde(default)]
    runtime_requirements: Option<serde_json::Value>,
}

impl ActivePdppPlatformManifest {
    /// Mirrors `requires_browser` in pdpp_installed_connector.rs.
    fn requires_browser(&self) -> bool {
        self.runtime_requirements
            .as_ref()
            .and_then(|requirements| requirements.pointer("/bindings/browser/required"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}

#[derive(Debug, Deserialize)]
struct ActivePdppBrand {
    icon: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivePdppSetup {
    modality: String,
    #[serde(default, alias = "setup_description")]
    description: Option<String>,
    #[serde(
        default,
        rename = "credentialCapture",
        alias = "credential_capture",
        skip_serializing_if = "Option::is_none"
    )]
    credential_capture: Option<ActivePdppCredentialCapture>,
    #[serde(
        default,
        rename = "manualOrUpload",
        alias = "manual_or_upload",
        skip_serializing_if = "Option::is_none"
    )]
    manual_or_upload: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ActivePdppCredentialCapture {
    #[serde(default)]
    description: Option<String>,
    fields: Vec<ActivePdppCredentialField>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ActivePdppCredentialField {
    name: String,
    label: Option<String>,
    #[serde(default, rename = "description")]
    description: Option<String>,
    #[serde(default, rename = "helpText", alias = "help_text")]
    help_text: Option<String>,
    #[serde(default, rename = "helpUrl", alias = "help_url")]
    help_url: Option<String>,
    #[serde(rename = "type")]
    field_type: Option<String>,
    required: bool,
    secret: bool,
    autocomplete: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivePdppStream {
    name: String,
}

fn load_active_pdpp_platforms(app: &AppHandle) -> Vec<Platform> {
    let mut installs = read_active_connector_manifest()
        .map(|manifest| manifest.connectors.into_values().collect::<Vec<_>>())
        .unwrap_or_default();
    installs.extend(
        super::developer_connector_sources::list_sources()
            .unwrap_or_default()
            .into_iter()
            .map(|source| super::developer_connector_sources::as_active_install(&source)),
    );
    let resource_dir = app.path().resource_dir().ok();
    load_pdpp_platforms_with_resource_dir(installs, resource_dir.as_deref())
}

#[cfg(test)]
pub(super) fn load_pdpp_platforms(
    installs: impl IntoIterator<Item = super::connector_store::ActiveConnectorInstall>,
) -> Vec<Platform> {
    load_pdpp_platforms_with_resource_dir(installs, None)
}

pub(super) fn load_pdpp_platforms_with_resource_dir(
    installs: impl IntoIterator<Item = super::connector_store::ActiveConnectorInstall>,
    resource_dir: Option<&Path>,
) -> Vec<Platform> {
    let mut platforms = Vec::new();
    for install in installs {
        if install.artifact_kind.as_deref() != Some("pdpp-collection-profile") {
            continue;
        }
        let Ok(content) =
            super::pdpp_installed_connector::read_admitted_pdpp_manifest_with_resource_dir(
                &install,
                resource_dir,
            )
        else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<ActivePdppPlatformManifest>(&content) else {
            continue;
        };
        let requires_browser = manifest.requires_browser();

        let connector_key = manifest
            .connector_key
            .clone()
            .unwrap_or_else(|| install.connector_id.replace("-pdpp", ""));
        let filename = install.connector_id.clone();
        let company = if install.company.is_empty() {
            connector_key.clone()
        } else {
            install.company.clone()
        };
        let manual_upload = manifest
            .setup
            .as_ref()
            .is_some_and(|setup| setup.modality == "manual_or_upload");
        let scopes = pdpp_streams_to_dataconnect_scopes(
            &connector_key,
            &manifest.connector_id,
            &manifest.streams,
            manual_upload,
        );
        if scopes.is_empty() {
            continue;
        }

        let logo_url = manifest
            .brand
            .as_ref()
            .and_then(|brand| brand.icon.as_deref())
            .and_then(|icon_path| {
                let bytes = match read_admitted_pdpp_asset_with_resource_dir(
                    &install,
                    resource_dir,
                    icon_path,
                ) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        log::warn!(
                            "Could not load the {} PDPP brand icon: {}",
                            connector_key,
                            error
                        );
                        return None;
                    }
                };
                Some(image_data_url(icon_path, &bytes))
            })
            .unwrap_or_default();

        let source_id = install.connector_id.clone();
        let local_source = source_id.starts_with("local_");
        let active_source = local_source
            && super::developer_connector_sources::selected_source(&install.connector_id)
                .ok()
                .flatten()
                .is_some();
        platforms.push(Platform {
            id: source_id.clone(),
            company,
            name: manifest
                .display_name
                .or(manifest.name)
                .unwrap_or_else(|| connector_key.clone()),
            filename,
            description: manifest
                .description
                .unwrap_or_else(|| format!("{} PDPP connector", connector_key)),
            is_updated: false,
            logo_url,
            needs_connection: true,
            runtime: Some("pdpp-network".to_string()),
            scopes: Some(scopes),
            setup: manifest.setup,
            source_kind: local_source.then(|| "developer_local".to_string()),
            source_id: local_source.then_some(source_id),
            source_path: local_source.then(|| install.root_path.clone()),
            active_source: local_source.then_some(active_source),
            requires_browser: Some(requires_browser),
            connection_id: None,
            account_label: None,
        });
    }

    platforms
}

fn image_data_url(path: &str, bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let mime_type = match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))
}

fn pdpp_streams_to_dataconnect_scopes(
    connector_key: &str,
    connector_identity: &str,
    streams: &[ActivePdppStream],
    include_generic_streams: bool,
) -> Vec<String> {
    let mut scopes = Vec::new();
    for stream in streams {
        let scope = if include_generic_streams {
            format!("pdpp.manual.{connector_key}.{}", stream.name)
        } else {
            pdpp_stream_to_dataconnect_scope(connector_key, connector_identity, &stream.name)
        };
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes
}

/// Load the installed PDPP connectors, expanded to one platform per connection.
#[tauri::command]
pub async fn get_platforms(app: AppHandle) -> Result<Vec<Platform>, String> {
    let mut platforms: Vec<Platform> = Vec::new();
    for platform in load_active_pdpp_platforms(&app) {
        if !platforms.iter().any(|existing| existing.id == platform.id) {
            platforms.push(platform);
        }
    }
    let mut expanded = Vec::new();
    for platform in platforms {
        let mut accounts = super::pdpp_connections::stored_connections(&platform.id)?;
        if accounts.is_empty()
            && super::pdpp_connections::has_legacy_data(&app, &platform.id, &platform.company)
        {
            accounts.push(super::pdpp_connections::ensure_pdpp_connection(
                app.clone(),
                platform.id.clone(),
                platform.company.clone(),
            )?);
        }
        if accounts.is_empty() {
            expanded.push(platform);
            continue;
        }
        for account in accounts {
            let mut account_platform = platform.clone();
            account_platform.connection_id = Some(account.connection_id);
            account_platform.account_label = account.account_label;
            expanded.push(account_platform);
        }
    }
    log::info!("Loaded {} total platforms", expanded.len());
    Ok(expanded)
}

/// Check if a platform is connected (has exported data)
#[tauri::command]
pub async fn check_connected_platforms(
    app: AppHandle,
    platform_ids: Vec<String>,
    connection_ids: Option<HashMap<String, Vec<String>>>,
) -> Result<HashMap<String, bool>, String> {
    let mut connected = HashMap::new();

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("exported_data");

    // Build a map from platform ID to company name so we can check both paths
    let all_platforms = get_platforms(app).await.unwrap_or_default();
    let id_to_company: HashMap<String, String> = all_platforms
        .into_iter()
        .map(|p| (p.id.clone(), p.company))
        .collect();

    for id in platform_ids {
        if let Some(accounts) = connection_ids
            .as_ref()
            .and_then(|connections| connections.get(&id))
        {
            for connection_id in accounts {
                let key = format!("{id}:{connection_id}");
                let legacy_connection = super::pdpp_connections::legacy_connection_id(&id);
                let has_legacy_export = connection_id == &legacy_connection
                    && id_to_company.get(&id).is_some_and(|company| {
                        let sanitized_company = super::file_ops::sanitize_path_component(company);
                        super::file_ops::legacy_export_exists(
                            &data_dir,
                            &sanitized_company,
                            &id,
                        )
                        .unwrap_or(false)
                    });
                connected.insert(
                    key,
                    has_legacy_export || exported_connection_exists(&data_dir, connection_id)?,
                );
            }
            continue;
        }
        // Check by platform ID directory or company name directory
        let exists = data_dir.join(&id).exists()
            || id_to_company
                .get(&id)
                .map(|company| data_dir.join(company).exists())
                .unwrap_or(false);
        connected.insert(id, exists);
    }

    Ok(connected)
}

fn exported_connection_exists(
    export_root: &std::path::Path,
    connection_id: &str,
) -> Result<bool, String> {
    if !export_root.exists() {
        return Ok(false);
    }
    let mut directories = vec![export_root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(&format!("--{connection_id}")))
                {
                    return Ok(true);
                }
                directories.push(path);
            }
        }
    }
    Ok(false)
}

/// Get the user connectors directory (~/.dataconnect/connectors/)
fn get_user_connectors_dir() -> Option<PathBuf> {
    let path = get_legacy_user_connectors_dir()?;
    if path.exists() {
        log::info!("Found user connectors at: {:?}", path);
        Some(path)
    } else {
        None
    }
}

/// Get the bundled connectors directory path
fn get_connectors_dir(app: &AppHandle) -> PathBuf {
    // In development, look in the project root directory
    // The project root is 3 levels up from src-tauri/target/debug/

    // First, try the CARGO_MANIFEST_DIR (only available during cargo run)
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev_path = PathBuf::from(&manifest_dir)
            .parent()
            .map(|p| p.join("connectors"))
            .unwrap_or_default();
        if dev_path.exists() {
            log::info!("Found bundled connectors at: {:?}", dev_path);
            return dev_path;
        }
    }

    // Try relative to current directory (for when running from project root)
    let cwd_path = std::env::current_dir()
        .unwrap_or_default()
        .join("connectors");
    if cwd_path.exists() {
        log::info!("Found bundled connectors at: {:?}", cwd_path);
        return cwd_path;
    }

    // Try relative to executable location (development fallback)
    if let Ok(exe_path) = std::env::current_exe() {
        // In dev: exe is at src-tauri/target/debug/dataconnect
        // Project root is 4 levels up
        if let Some(project_root) = exe_path
            .parent() // target/debug
            .and_then(|p| p.parent()) // target
            .and_then(|p| p.parent()) // src-tauri
            .and_then(|p| p.parent())
        // project root
        {
            let dev_path = project_root.join("connectors");
            if dev_path.exists() {
                log::info!("Found bundled connectors at: {:?}", dev_path);
                return dev_path;
            }
        }
    }

    // Try resource path for bundled app (production)
    // Tauri converts "../connectors" to "_up_/connectors" in resources
    let resource_dir = app.path().resource_dir().unwrap_or_default();

    // Check for _up_/connectors first (from "../connectors" resource path)
    let up_path = resource_dir.join("_up_").join("connectors");
    if up_path.exists() {
        log::info!("Found bundled connectors at: {:?}", up_path);
        return up_path;
    }

    // Fallback to direct connectors path
    let resource_path = resource_dir.join("connectors");
    log::info!(
        "Using resource bundled connectors path: {:?}",
        resource_path
    );
    resource_path
}

/// Get the path to the bundled Playwright runner binary (production) or None (dev)
fn get_bundled_playwright_runner(app: &AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    // In production, the binary is in the resources directory
    let resource_dir = app.path().resource_dir().ok()?;

    #[cfg(target_os = "macos")]
    let binary_name = "playwright-runner";
    #[cfg(target_os = "windows")]
    let binary_name = "playwright-runner.exe";
    #[cfg(target_os = "linux")]
    let binary_name = "playwright-runner";

    log::info!("=== Looking for Playwright runner ===");
    log::info!("Resource directory: {:?}", resource_dir);
    log::info!("Binary name: {}", binary_name);

    // List contents of resource directory for debugging
    if let Ok(entries) = std::fs::read_dir(&resource_dir) {
        let contents: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        log::info!("Resource dir contents: {:?}", contents);
    }

    // Try playwright-runner/dist path (matches tauri.conf.json resources config)
    let dist_path = resource_dir.join("playwright-runner").join("dist");
    let dist_binary = dist_path.join(binary_name);
    let dist_browsers = dist_path.join("browsers");

    log::info!(
        "Checking path 1: {:?} (exists: {})",
        dist_binary,
        dist_binary.exists()
    );
    if dist_path.exists() {
        if let Ok(entries) = std::fs::read_dir(&dist_path) {
            let contents: Vec<_> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            log::info!("  dist path contents: {:?}", contents);
        }
    }

    if dist_binary.exists() {
        log::info!("Found bundled Playwright runner at {:?}", dist_binary);
        let browsers = if dist_browsers.exists() {
            Some(dist_browsers)
        } else {
            None
        };
        return Some((dist_binary, browsers));
    }

    // Try binaries/ path (alternative CI builds layout)
    let binary_path = resource_dir.join("binaries").join(binary_name);
    let browsers_path = resource_dir.join("binaries").join("browsers");

    log::info!(
        "Checking path 2: {:?} (exists: {})",
        binary_path,
        binary_path.exists()
    );

    if binary_path.exists() {
        log::info!("Found bundled Playwright runner at {:?}", binary_path);
        let browsers = if browsers_path.exists() {
            Some(browsers_path)
        } else {
            None
        };
        return Some((binary_path, browsers));
    }

    // Try _up_/playwright-runner/dist path (local builds with "../playwright-runner/dist" resource)
    let up_path = resource_dir
        .join("_up_")
        .join("playwright-runner")
        .join("dist");
    let up_binary = up_path.join(binary_name);
    let up_browsers = up_path.join("browsers");

    log::info!(
        "Checking path 3: {:?} (exists: {})",
        up_binary,
        up_binary.exists()
    );
    if up_path.exists() {
        if let Ok(entries) = std::fs::read_dir(&up_path) {
            let contents: Vec<_> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            log::info!("  _up_ path contents: {:?}", contents);
        }
    }

    if up_binary.exists() {
        log::info!("Found bundled Playwright runner at {:?}", up_binary);
        let browsers = if up_browsers.exists() {
            Some(up_browsers)
        } else {
            None
        };
        return Some((up_binary, browsers));
    }

    log::error!("=== Playwright runner NOT FOUND in any location ===");
    None
}

/// Debug connector paths - helps diagnose why connectors aren't found
#[tauri::command]
pub async fn debug_connector_paths(app: AppHandle) -> Result<serde_json::Value, String> {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let connectors_dir = get_connectors_dir(&app);
    let user_dir = get_user_connectors_dir();

    // Check various paths
    let mut paths_to_check = vec![
        ("resource_dir", resource_dir.clone()),
        ("resource_dir/connectors", resource_dir.join("connectors")),
        (
            "resource_dir/_up_/connectors",
            resource_dir.join("_up_").join("connectors"),
        ),
        ("connectors_dir (bundled)", connectors_dir.clone()),
    ];

    // Add user directory if available
    if let Some(ref user_path) = user_dir {
        paths_to_check.push(("user_connectors_dir", user_path.clone()));
    }

    let mut results = serde_json::Map::new();

    for (name, path) in paths_to_check {
        let exists = path.exists();
        let contents = if exists && path.is_dir() {
            std::fs::read_dir(&path)
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        results.insert(
            name.to_string(),
            serde_json::json!({
                "path": path.to_string_lossy(),
                "exists": exists,
                "contents": contents
            }),
        );
    }

    Ok(serde_json::Value::Object(results))
}

/// Test that Node.js runtime is working
#[tauri::command]
pub async fn test_nodejs(app: AppHandle) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    // Get the playwright runner binary
    let (binary_path, _) =
        get_bundled_playwright_runner(&app).ok_or("Playwright runner not found")?;

    let mut child = Command::new(&binary_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn playwright runner: {}", e))?;

    let mut stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    // Send test command
    writeln!(stdin, r#"{{"type":"test"}}"#)
        .map_err(|e| format!("Failed to send command: {}", e))?;

    // Read response
    let reader = BufReader::new(stdout);
    for line in reader.lines().flatten() {
        if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
            if msg.get("type").and_then(|v| v.as_str()) == Some("test-result") {
                let _ = child.kill();
                return Ok(msg.get("data").cloned().unwrap_or(serde_json::Value::Null));
            }
        }
    }

    Err("No response from Node.js runtime".to_string())
}

/// Browser session info returned to the frontend
#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserSessionInfo {
    #[serde(rename = "connectorId")]
    pub connector_id: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "lastModified")]
    pub last_modified: String,
}

/// Recursively compute directory size in bytes
fn dir_size(path: &std::path::Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// List all stored browser sessions (profiles)
#[tauri::command]
pub async fn list_browser_sessions() -> Result<Vec<BrowserSessionInfo>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())?;

    let profiles_dir = PathBuf::from(&home)
        .join(".dataconnect")
        .join("browser-profiles");

    if !profiles_dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();

    let entries = fs::read_dir(&profiles_dir)
        .map_err(|e| format!("Failed to read browser-profiles directory: {}", e))?;

    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }

        let connector_id = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let size_bytes = dir_size(&path);

        let last_modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                // Return as ISO-ish timestamp (milliseconds since epoch)
                let secs = duration.as_secs();
                // Format as ISO 8601 manually
                let dt = chrono::DateTime::from_timestamp(secs as i64, 0).unwrap_or_default();
                dt.to_rfc3339()
            })
            .unwrap_or_default();

        sessions.push(BrowserSessionInfo {
            connector_id,
            path: path.to_string_lossy().to_string(),
            size_bytes,
            last_modified,
        });
    }

    Ok(sessions)
}

/// Clear (delete) a stored browser session for a given connector
#[tauri::command]
pub async fn clear_browser_session(connector_id: String) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())?;

    let profiles_parent = PathBuf::from(&home)
        .join(".dataconnect")
        .join("browser-profiles");

    clear_browser_session_from_profiles(&profiles_parent, &connector_id)
}

fn clear_browser_session_from_profiles(
    profiles_parent: &Path,
    connector_id: &str,
) -> Result<(), String> {
    if connector_id.is_empty()
        || connector_id == "."
        || connector_id == ".."
        || !connector_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("Invalid connector ID".to_string());
    }

    if !profiles_parent.exists() {
        return Ok(());
    }

    let canonical_profiles_parent = fs::canonicalize(profiles_parent)
        .map_err(|e| format!("Failed to resolve browser-profiles directory: {e}"))?;
    let profile_dir = profiles_parent.join(connector_id);
    if !profile_dir.exists() {
        return Ok(());
    }
    let canonical_profile_dir = fs::canonicalize(&profile_dir)
        .map_err(|e| format!("Failed to resolve browser profile: {e}"))?;
    if canonical_profile_dir == canonical_profiles_parent
        || !canonical_profile_dir.starts_with(&canonical_profiles_parent)
    {
        return Err("Invalid connector ID".to_string());
    }

    fs::remove_dir_all(&canonical_profile_dir)
        .map_err(|e| format!("Failed to delete browser profile: {}", e))?;

    log::info!("Cleared browser session for connector: {}", connector_id);
    Ok(())
}

#[cfg(test)]
mod connection_export_tests {
    use super::exported_connection_exists;
    use std::fs;

    #[test]
    fn exported_data_presence_is_scoped_to_the_connection_id() {
        let root = tempfile::tempdir().unwrap();
        for (connection_id, run_id) in [("account-a", "run-a"), ("account-b", "run-b")] {
            let run_dir = root
                .path()
                .join("OpenAI/ChatGPT")
                .join(format!("{run_id}--{connection_id}"));
            fs::create_dir_all(&run_dir).unwrap();
            fs::write(
                run_dir.join("chatgpt-pdpp_1.json"),
                serde_json::json!({"connectionId": connection_id}).to_string(),
            )
            .unwrap();
        }

        assert!(exported_connection_exists(root.path(), "account-a").unwrap());
        assert!(exported_connection_exists(root.path(), "account-b").unwrap());
        assert!(!exported_connection_exists(root.path(), "account-c").unwrap());
    }
}

/// Get the user data path
#[tauri::command]
pub fn get_user_data_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// Check if a browser is available for automation
#[tauri::command]
pub async fn check_browser_available(
    app: AppHandle,
    simulate_no_chrome: Option<bool>,
) -> Result<BrowserStatus, String> {
    let system_browser = if simulate_no_chrome.unwrap_or(false) {
        None
    } else {
        get_system_browser_path()
    };
    let downloaded = get_downloaded_chromium_path();
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|resource_dir| get_bundled_chromium_path(&resource_dir));

    let mut status = resolve_browser_status(system_browser, downloaded.clone(), bundled.clone());
    // A system browser comes from a distribution package, which ships the
    // AppArmor profile its sandbox needs. A downloaded or bundled Chromium may
    // be blocked, and `--version` does not exercise the sandbox, so start it.
    if let Some(browser) = match status.browser_type.as_str() {
        "downloaded" => downloaded,
        "bundled" => bundled,
        _ => None,
    } {
        let launch_error =
            tauri::async_runtime::spawn_blocking(move || cached_browser_launch_error(&browser))
                .await
                .map_err(|error| format!("Browser launch check failed: {error}"))?;
        status = apply_browser_launch_error(status, launch_error);
    }
    Ok(status)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserStatus {
    pub available: bool,
    pub browser_type: String,
    pub needs_download: bool,
    /// Machine-readable reason when a browser is present but cannot start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Mark the resolved browser unavailable when it cannot start its sandbox.
/// A download would not help, because a downloaded Chromium has no AppArmor
/// profile either.
fn apply_browser_launch_error(
    status: BrowserStatus,
    launch_error: Option<super::browser_surface_host::BrowserLaunchError>,
) -> BrowserStatus {
    match launch_error {
        Some(error) if error.is_sandbox_unavailable() => BrowserStatus {
            available: false,
            needs_download: false,
            reason: Some(error.code.to_string()),
            message: Some(error.message),
            ..status
        },
        _ => status,
    }
}

/// Launch results per browser binary, kept for the life of the process.
static BROWSER_LAUNCH_CHECKS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<PathBuf, Option<super::browser_surface_host::BrowserLaunchError>>>,
> = std::sync::OnceLock::new();

fn cached_browser_launch_error(
    browser: &Path,
) -> Option<super::browser_surface_host::BrowserLaunchError> {
    let cache = BROWSER_LAUNCH_CHECKS.get_or_init(Default::default);
    if let Some(result) = cache
        .lock()
        .ok()
        .and_then(|checks| checks.get(browser).cloned())
    {
        return result;
    }
    let result = probe_browser_launch(browser);
    if let Ok(mut checks) = cache.lock() {
        checks.insert(browser.to_path_buf(), result.clone());
    }
    result
}

/// Start the browser the way the host does, with a throwaway profile, then
/// stop it. Only Linux restricts the sandbox this way.
#[cfg(target_os = "linux")]
pub(crate) fn probe_browser_launch(
    browser: &Path,
) -> Option<super::browser_surface_host::BrowserLaunchError> {
    let profile = match tempfile::Builder::new()
        .prefix("dataconnect-browser-check-")
        .tempdir()
    {
        Ok(profile) => profile,
        Err(error) => {
            log::warn!("Skipping browser launch check: {error}");
            return None;
        }
    };
    match super::browser_surface_host::launch_browser(browser, profile.path(), true) {
        Ok((mut child, _)) => {
            let _ = super::pdpp_browser::terminate_browser(&mut child);
            None
        }
        Err(error) => {
            log::warn!(
                "Browser launch check failed ({}): {}",
                error.code,
                error.message
            );
            Some(error)
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn probe_browser_launch(
    _browser: &Path,
) -> Option<super::browser_surface_host::BrowserLaunchError> {
    None
}

fn resolve_browser_status(
    system_browser: Option<PathBuf>,
    downloaded_browser: Option<PathBuf>,
    bundled_browser: Option<PathBuf>,
) -> BrowserStatus {
    let browser_type = if system_browser.is_some() {
        Some("system")
    } else if downloaded_browser.is_some() {
        Some("downloaded")
    } else if bundled_browser.is_some() {
        Some("bundled")
    } else {
        None
    };

    BrowserStatus {
        available: browser_type.is_some(),
        browser_type: browser_type.unwrap_or("none").to_string(),
        needs_download: browser_type.is_none(),
        reason: None,
        message: None,
    }
}

/// Get system browser path (Chrome/Edge)
pub(crate) fn get_system_browser_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let paths = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
        for p in paths {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let paths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
        for p in paths {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let paths = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ];
        for p in paths {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Download Chromium browser (uses Rust-based download in production)
#[tauri::command]
pub async fn download_browser(app: AppHandle) -> Result<(), String> {
    // Use the Rust-based download which works in production without npx
    download_chromium_rust(app).await?;
    Ok(())
}

/// Get downloaded Chromium path from ~/.dataconnect/browsers
pub(crate) fn get_downloaded_chromium_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;

    get_downloaded_chromium_path_in_home(Path::new(&home), current_browser_platform())
}

fn get_downloaded_chromium_path_in_home(home: &Path, platform: &str) -> Option<PathBuf> {
    let browsers_dir = home.join(".dataconnect").join("browsers");
    find_chromium_executable(&browsers_dir, platform)
}

fn get_bundled_chromium_path(resource_dir: &Path) -> Option<PathBuf> {
    get_bundled_chromium_path_for_platform(resource_dir, current_browser_platform())
}

pub(crate) fn get_bundled_chromium_path_for_platform(
    resource_dir: &Path,
    platform: &str,
) -> Option<PathBuf> {
    let browser_roots = [
        resource_dir
            .join("playwright-runner")
            .join("dist")
            .join("browsers"),
        resource_dir.join("binaries").join("browsers"),
        resource_dir
            .join("_up_")
            .join("playwright-runner")
            .join("dist")
            .join("browsers"),
    ];

    browser_roots
        .iter()
        .find_map(|root| find_chromium_executable(root, platform))
}

fn current_browser_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
    #[allow(unreachable_code)]
    "unsupported"
}

fn find_chromium_executable(browsers_dir: &Path, platform: &str) -> Option<PathBuf> {
    if !browsers_dir.exists() {
        return None;
    }

    let entries = std::fs::read_dir(&browsers_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("chromium-") && !name.contains("headless") {
            let chromium_dir = entry.path();
            let relative_paths: &[&str] = match platform {
                "macos" => &[
                    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
                    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
                ],
                "windows" => &["chrome-win/chrome.exe", "chrome-win64/chrome.exe"],
                "linux" => &["chrome-linux/chrome", "chrome-linux64/chrome"],
                _ => &[],
            };
            for relative_path in relative_paths {
                let executable = chromium_dir.join(relative_path);
                if executable.exists() {
                    return Some(executable);
                }
            }
        }
    }

    None
}

/// Shared executable discovery only. PDPP browser leases intentionally do not
/// reuse the legacy runner's page API or persistent connector profiles.
pub(crate) fn resolve_automation_browser_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resolve_automation_browser_path_from(
        get_system_browser_path(),
        get_downloaded_chromium_path(),
        resource_dir.and_then(get_bundled_chromium_path),
    )
}

fn resolve_automation_browser_path_from(
    system: Option<PathBuf>,
    downloaded: Option<PathBuf>,
    bundled: Option<PathBuf>,
) -> Option<PathBuf> {
    system.or(downloaded).or(bundled)
}

/// Get the Chromium download URL for the current platform
fn get_chromium_download_info() -> Option<(&'static str, &'static str)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some((
            "chromium-mac-arm64.zip",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ))
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some((
            "chromium-mac.zip",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ))
    }
    #[cfg(target_os = "windows")]
    {
        Some(("chromium-win64.zip", "chrome-win64/chrome.exe"))
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some(("chromium-linux.zip", "chrome-linux64/chrome"))
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Some(("chromium-linux-arm64.zip", "chrome-linux/chrome"))
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        target_os = "windows",
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        None
    }
}

/// Download Chromium browser using Rust (production-ready)
#[tauri::command]
pub async fn download_chromium_rust(app: AppHandle) -> Result<String, String> {
    use futures_util::StreamExt;

    log::info!("Starting Rust-based Chromium download");

    // Get platform-specific download info
    let (zip_filename, exe_path) =
        get_chromium_download_info().ok_or("Unsupported platform for Chromium download")?;

    // Create browsers directory
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory")?;

    let browsers_dir = PathBuf::from(&home).join(".dataconnect").join("browsers");
    std::fs::create_dir_all(&browsers_dir)
        .map_err(|e| format!("Failed to create browsers directory: {}", e))?;

    let chromium_dir = browsers_dir.join(format!("chromium-{}", CHROMIUM_REVISION));
    let final_exe_path = chromium_dir.join(exe_path);

    // Check if already downloaded
    if final_exe_path.exists() {
        log::info!("Chromium already downloaded at {:?}", final_exe_path);
        return Ok(final_exe_path.to_string_lossy().to_string());
    }

    // Build download URL - try mirrors in order
    let mut download_url = String::new();
    let client = reqwest::Client::new();

    for mirror in CHROMIUM_CDN_MIRRORS {
        let url = format!(
            "{}/builds/chromium/{}/{}",
            mirror, CHROMIUM_REVISION, zip_filename
        );
        log::info!("Trying mirror: {}", url);

        match client.head(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                download_url = url;
                break;
            }
            Ok(resp) => {
                log::warn!("Mirror {} returned status: {}", mirror, resp.status());
            }
            Err(e) => {
                log::warn!("Mirror {} failed: {}", mirror, e);
            }
        }
    }

    if download_url.is_empty() {
        return Err("All Chromium download mirrors failed".to_string());
    }

    log::info!("Downloading from: {}", download_url);

    // Emit starting progress
    let _ = app.emit(
        "browser-download-progress",
        serde_json::json!({
            "status": "downloading",
            "message": "Downloading Chromium browser...",
            "progress": 0
        }),
    );

    // Download with progress
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let total_size = response.content_length().unwrap_or(0);
    log::info!("Download size: {} bytes", total_size);

    let zip_path = browsers_dir.join(format!("chromium-{}.zip", CHROMIUM_REVISION));
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_progress = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;

        downloaded += chunk.len() as u64;

        // Emit progress every 1MB
        if total_size > 0 && downloaded - last_progress > 1_000_000 {
            last_progress = downloaded;
            let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = app.emit(
                "browser-download-progress",
                serde_json::json!({
                    "status": "downloading",
                    "message": format!("Downloading Chromium... {}%", progress),
                    "progress": progress,
                    "downloaded": downloaded,
                    "total": total_size
                }),
            );
        }
    }

    drop(file);
    log::info!("Download complete, extracting...");

    // Emit extracting progress
    let _ = app.emit(
        "browser-download-progress",
        serde_json::json!({
            "status": "extracting",
            "message": "Extracting Chromium...",
            "progress": 100
        }),
    );

    // Extract zip
    let zip_file =
        std::fs::File::open(&zip_path).map_err(|e| format!("Failed to open zip file: {}", e))?;

    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    // Create extraction directory
    std::fs::create_dir_all(&chromium_dir)
        .map_err(|e| format!("Failed to create chromium directory: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let outpath = chromium_dir.join(
            file.mangled_name()
                .map_err(|e| format!("Failed to read zip entry name: {}", e))?,
        );

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {}", e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to extract file: {}", e))?;

            // Set executable permission on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode)).ok();
                }
            }
        }
    }

    // Clean up zip file
    std::fs::remove_file(&zip_path).ok();

    // Verify executable exists
    if !final_exe_path.exists() {
        return Err(format!(
            "Chromium executable not found after extraction at {:?}",
            final_exe_path
        ));
    }

    // Set executable permission on the Chrome binary (macOS/Linux)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&final_exe_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set executable permission: {}", e))?;
    }

    log::info!("Chromium extraction complete: {:?}", final_exe_path);

    // Emit complete
    let _ = app.emit(
        "browser-download-progress",
        serde_json::json!({
            "status": "complete",
            "message": "Browser download complete",
            "path": final_exe_path.to_string_lossy()
        }),
    );

    Ok(final_exe_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        clear_browser_session_from_profiles, get_bundled_chromium_path_for_platform,
        get_downloaded_chromium_path_in_home, pdpp_streams_to_dataconnect_scopes,
        resolve_automation_browser_path_from, resolve_browser_status, ActivePdppPlatformManifest,
        ActivePdppStream,
    };
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    fn create_file(root: &Path, relative_path: &str) -> PathBuf {
        let path = root.join(relative_path);
        std::fs::create_dir_all(path.parent().expect("file parent")).expect("create parent");
        std::fs::write(&path, "fixture").expect("write fixture");
        path
    }

    #[test]
    fn clear_browser_session_rejects_paths_outside_profiles() {
        let temp = tempdir().expect("temporary directory");
        let profiles = temp.path().join(".dataconnect/browser-profiles");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&profiles).expect("create profiles root");
        let outside_file = create_file(&outside, "keep.txt");

        for connector_id in ["..", "nested/connector", outside.to_str().unwrap()] {
            assert!(clear_browser_session_from_profiles(&profiles, connector_id).is_err());
            assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "fixture");
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, profiles.join("outside-link"))
                .expect("create profile symlink");
            assert!(clear_browser_session_from_profiles(&profiles, "outside-link").is_err());
            assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "fixture");
        }
    }

    #[test]
    fn active_pdpp_setup_decodes_snake_case_and_serializes_frontend_shape() {
        for (fixture, field) in [
            (
                include_str!("../../tests/fixtures/apple-health.collection-profile.json"),
                "manualOrUpload",
            ),
            (
                include_str!("../../tests/fixtures/chatgpt-pdpp-browser.collection-profile.json"),
                "credentialCapture",
            ),
        ] {
            let manifest: ActivePdppPlatformManifest = serde_json::from_str(fixture).unwrap();
            let setup = serde_json::to_value(manifest.setup.unwrap()).unwrap();
            assert!(setup.get(field).is_some());
            if field == "credentialCapture" {
                assert!(setup[field]["fields"]
                    .as_array()
                    .is_some_and(|fields| !fields.is_empty()));
            }
            assert!(setup.get("credential_capture").is_none());
            assert!(setup.get("manual_or_upload").is_none());
        }
    }

    #[test]
    fn active_pdpp_setup_preserves_credential_guidance_for_frontend() {
        let manifest = json!({
            "connector_id": "https://registry.pdpp.dev/connectors/example",
            "setup": {
                "modality": "static_secret",
                "description": "Connect this source with its API credential.",
                "credential_capture": {
                    "description": "Create the credential before you start.",
                    "fields": [{
                        "name": "secret",
                        "label": "API key",
                        "description": "Use the key for this account.",
                        "help_text": "Create a key in the provider settings.",
                        "help_url": "https://example.com/settings",
                        "required": true,
                        "secret": true
                    }]
                }
            },
            "streams": [{ "name": "records" }]
        });

        let parsed: ActivePdppPlatformManifest = serde_json::from_value(manifest).unwrap();
        let setup = serde_json::to_value(parsed.setup.unwrap()).unwrap();
        expect_json_string(
            &setup["description"],
            "Connect this source with its API credential.",
        );
        expect_json_string(
            &setup["credentialCapture"]["description"],
            "Create the credential before you start.",
        );
        expect_json_string(
            &setup["credentialCapture"]["fields"][0]["helpText"],
            "Create a key in the provider settings.",
        );
        expect_json_string(
            &setup["credentialCapture"]["fields"][0]["helpUrl"],
            "https://example.com/settings",
        );
        expect_json_string(
            &setup["credentialCapture"]["fields"][0]["description"],
            "Use the key for this account.",
        );
    }

    fn expect_json_string(value: &serde_json::Value, expected: &str) {
        assert_eq!(value.as_str(), Some(expected));
    }

    #[test]
    fn manual_scope_discovery_never_reaches_curated_projection_arms() {
        for (key, stream) in [("github", "repositories"), ("chatgpt", "conversations")] {
            let streams = vec![ActivePdppStream {
                name: stream.into(),
            }];
            assert_eq!(
                pdpp_streams_to_dataconnect_scopes(
                    key,
                    &format!("https://registry.pdpp.org/connectors/{key}"),
                    &streams,
                    true,
                ),
                vec![format!("pdpp.manual.{key}.{stream}")]
            );
        }
    }

    #[test]
    fn pdpp_streams_map_to_legacy_and_generic_scope_ids() {
        for (fixture, expected) in [
            (include_str!("../../tests/fixtures/github.collection-profile.origin-main.json"),
             "github.profile pdpp.github.user_stats github.repositories github.starred pdpp.github.issues pdpp.github.pull_requests pdpp.github.gists"),
            (include_str!("../../tests/fixtures/chatgpt-pdpp-browser.collection-profile.json"),
             "chatgpt.conversations chatgpt.messages chatgpt.memories chatgpt.custom_gpts chatgpt.custom_instructions chatgpt.shared_conversations"),
            (include_str!("../../tests/fixtures/ynab.collection-profile.origin-main.json"),
             "pdpp.ynab.budgets pdpp.ynab.accounts pdpp.ynab.account_stats pdpp.ynab.category_groups pdpp.ynab.categories pdpp.ynab.payees pdpp.ynab.payee_locations pdpp.ynab.transactions pdpp.ynab.scheduled_transactions pdpp.ynab.months pdpp.ynab.month_categories"),
        ] {
            let manifest: super::ActivePdppPlatformManifest = serde_json::from_str(fixture).unwrap();
            assert_eq!(
                super::pdpp_streams_to_dataconnect_scopes(
                    manifest.connector_key.as_deref().unwrap(),
                    &manifest.connector_id,
                    &manifest.streams,
                    false,
                ),
                expected.split_whitespace().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn fresh_install_preflight_recognizes_browser_in_resource_directory() {
        let temp = tempdir().expect("tempdir");
        let executable = create_file(
            temp.path(),
            "playwright-runner/dist/browsers/chromium-1200/chrome-linux64/chrome",
        );

        let bundled = get_bundled_chromium_path_for_platform(temp.path(), "linux");
        let status = resolve_browser_status(None, None, bundled.clone());

        assert_eq!(bundled, Some(executable));
        assert!(status.available);
        assert_eq!(status.browser_type, "bundled");
        assert!(!status.needs_download);
    }

    #[cfg(target_os = "linux")]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        crate::test_executable::write(&path, body);
        path
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn browser_preflight_reports_sandbox_blocked_bundled_browser_unavailable() {
        let temp = tempdir().expect("tempdir");
        // Truncated before Chromium's own workaround advice.
        let blocked = write_script(
            temp.path(),
            "chrome",
            "#!/bin/sh\necho '[1:1:0928/165834.918776:FATAL:zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+' >&2\nexit 133\n",
        );

        let status = super::apply_browser_launch_error(
            resolve_browser_status(None, None, Some(blocked.clone())),
            super::cached_browser_launch_error(&blocked),
        );

        assert!(!status.available);
        assert!(!status.needs_download);
        assert_eq!(status.browser_type, "bundled");
        assert_eq!(
            status.reason.as_deref(),
            Some("browser_sandbox_unavailable")
        );
        assert!(status
            .message
            .as_deref()
            .is_some_and(|message| message.contains(".deb package")));

        // The result is cached per binary: a later fix to the file is not
        // re-probed during this session.
        std::fs::write(&blocked, "#!/bin/sh\nexit 1\n").expect("rewrite script");
        assert!(super::cached_browser_launch_error(&blocked)
            .is_some_and(|error| error.is_sandbox_unavailable()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn browser_preflight_keeps_a_startable_bundled_browser_available() {
        let temp = tempdir().expect("tempdir");
        let working = write_script(
            temp.path(),
            "chrome",
            "#!/bin/sh\nprintf '%s\\n' '{\"cdp_url\":\"http://127.0.0.1:9222\"}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
        );

        let status = super::apply_browser_launch_error(
            resolve_browser_status(None, None, Some(working.clone())),
            super::probe_browser_launch(&working),
        );

        assert!(status.available);
        assert_eq!(status.browser_type, "bundled");
        assert_eq!(status.reason, None);
    }

    /// Live counterpart of the preflight tests; see the host's
    /// `live_browser_launch_is_ready_or_reports_sandbox_unavailable`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a real Chromium in DATACONNECT_LIVE_BROWSER"]
    fn live_browser_preflight_probe() {
        let browser = PathBuf::from(
            std::env::var("DATACONNECT_LIVE_BROWSER").expect("DATACONNECT_LIVE_BROWSER"),
        );
        let status = super::apply_browser_launch_error(
            resolve_browser_status(None, None, Some(browser.clone())),
            super::probe_browser_launch(&browser),
        );
        eprintln!("live preflight status: {status:?}");
        assert!(
            status.available || status.reason.as_deref() == Some("browser_sandbox_unavailable")
        );
    }

    #[test]
    fn browser_preflight_preserves_system_then_user_download_priority() {
        let system = PathBuf::from("system-browser");
        let downloaded = PathBuf::from("downloaded-browser");
        let bundled = PathBuf::from("bundled-browser");

        let system_status = resolve_browser_status(
            Some(system),
            Some(downloaded.clone()),
            Some(bundled.clone()),
        );
        let downloaded_status = resolve_browser_status(None, Some(downloaded), Some(bundled));

        assert_eq!(system_status.browser_type, "system");
        assert_eq!(downloaded_status.browser_type, "downloaded");
    }

    #[test]
    fn downloaded_browser_lookup_supports_intel_mac_layout() {
        let temp = tempdir().expect("tempdir");
        let executable = create_file(
            temp.path(),
            ".dataconnect/browsers/chromium-1200/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        );

        assert_eq!(
            get_downloaded_chromium_path_in_home(temp.path(), "macos"),
            Some(executable)
        );
    }

    #[test]
    fn bundled_browser_lookup_supports_intel_mac_layout() {
        let temp = tempdir().expect("tempdir");
        let executable = create_file(
            temp.path(),
            "playwright-runner/dist/browsers/chromium-1200/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        );

        assert_eq!(
            get_bundled_chromium_path_for_platform(temp.path(), "macos"),
            Some(executable)
        );
    }

    #[test]
    fn bundled_browser_lookup_supports_release_platform_layouts() {
        for (platform, relative_path) in [
            ("linux", "playwright-runner/dist/browsers/chromium-1200/chrome-linux64/chrome"),
            ("windows", "playwright-runner/dist/browsers/chromium-1200/chrome-win64/chrome.exe"),
            ("macos", "playwright-runner/dist/browsers/chromium-1200/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            ("macos", "playwright-runner/dist/browsers/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        ] {
            let temp = tempdir().expect("tempdir");
            let executable = create_file(temp.path(), relative_path);

            assert_eq!(
                get_bundled_chromium_path_for_platform(temp.path(), platform),
                Some(executable)
            );
        }
    }

    #[test]
    fn pdpp_browser_discovery_uses_bundled_chromium_on_fresh_install() {
        let bundled = PathBuf::from("bundled-browser");

        assert_eq!(
            resolve_automation_browser_path_from(None, None, Some(bundled.clone())),
            Some(bundled)
        );
    }
}
