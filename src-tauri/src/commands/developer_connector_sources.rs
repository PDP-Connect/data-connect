// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Developer-local Collection Profile sources for the legacy desktop host.
//!
//! This file is intentionally not part of `connectors-active.json`. A local
//! source is unsigned; its hashes detect edits between reload and execution,
//! but do not make it a verified artifact.

use crate::commands::connector_store::{get_dataconnect_dir, ActiveConnectorInstall};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

const MANIFEST_PATH: &str = "profile/collection-profile.json";
const ENTRYPOINT_PATH: &str = "dist/collection-profile.mjs";
const PROVENANCE_PATH: &str = "provenance.json";
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperConnectorSource {
    pub connector_id: String,
    pub connector_key: String,
    pub display_name: String,
    pub entrypoint_path: String,
    pub entrypoint_sha256: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance_sha256: Option<String>,
    pub root_path: String,
    pub selected: bool,
    pub source_id: String,
    pub trust: String,
    pub updated_at: String,
    pub version: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeveloperConnectorSourceState {
    #[serde(default)]
    selected_by_connector_key: HashMap<String, Option<String>>,
    #[serde(default)]
    sources: HashMap<String, DeveloperConnectorSource>,
}

fn state_path() -> Result<PathBuf, String> {
    Ok(get_dataconnect_dir()
        .ok_or("Could not determine DataConnect data directory")?
        .join("connector-local-sources.json"))
}

fn read_state(path: &Path) -> Result<DeveloperConnectorSourceState, String> {
    if !path.exists() {
        return Ok(DeveloperConnectorSourceState::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read developer connector source state: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Developer connector source state is invalid: {error}"))
}

fn write_state(path: &Path, state: &DeveloperConnectorSourceState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Developer connector source state has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("Failed to create developer connector source directory: {error}")
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        format!("Failed to create developer connector source state temp file: {error}")
    })?;
    serde_json::to_writer_pretty(&mut temporary, state)
        .map_err(|error| format!("Failed to encode developer connector source state: {error}"))?;
    temporary
        .write_all(b"\n")
        .map_err(|error| format!("Failed to finish developer connector source state: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to publish developer connector source state: {error}"))?;
    Ok(())
}

fn canonical_root(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("Developer connector source path must be absolute".into());
    }
    let root = fs::canonicalize(candidate).map_err(|error| {
        format!("Developer connector source directory is not accessible: {error}")
    })?;
    if !root.is_dir() {
        return Err("Developer connector source path must be a directory".into());
    }
    Ok(root)
}

fn confined_file(root: &Path, relative: &str, label: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("{label} must stay within the local source root"));
    }
    let path = root.join(relative_path);
    let resolved =
        fs::canonicalize(&path).map_err(|error| format!("{label} is not accessible: {error}"))?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err(format!(
            "{label} must resolve to a file inside the local source root"
        ));
    }
    Ok(resolved)
}

fn file_hash(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read local connector file: {error}"))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn manifest_profile(root: &Path) -> Result<(String, String, String, String, Value), String> {
    let path = confined_file(root, MANIFEST_PATH, "Collection Profile manifest")?;
    if fs::metadata(&path)
        .map_err(|error| format!("Failed to stat Collection Profile manifest: {error}"))?
        .len()
        > MAX_PROFILE_BYTES
    {
        return Err("Collection Profile manifest exceeds the 1 MiB limit".into());
    }
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read Collection Profile manifest: {error}"))?,
    )
    .map_err(|error| format!("Collection Profile manifest is invalid: {error}"))?;
    let object = manifest
        .as_object()
        .ok_or("Collection Profile manifest must be an object")?;
    let connector_id = object
        .get("connector_id")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("https://"))
        .ok_or("Collection Profile manifest must declare an https connector_id")?;
    let connector_key = object
        .get("connector_key")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-' | b'.')
                })
        })
        .ok_or("Collection Profile manifest must declare a safe connector_key")?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Collection Profile manifest must declare a version")?;
    if !object.get("streams").is_some_and(Value::is_array)
        || object
            .get("streams")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        return Err("Collection Profile manifest must declare at least one stream".into());
    }
    if let Some(bindings) = object
        .get("runtime_requirements")
        .and_then(Value::as_object)
        .and_then(|requirements| requirements.get("bindings"))
        .and_then(Value::as_object)
    {
        for (binding, requirement) in bindings {
            if !matches!(binding.as_str(), "browser" | "filesystem" | "network") {
                return Err(format!(
                    "Collection Profile declares unsupported runtime binding: {binding}"
                ));
            }
            if !requirement.is_object() {
                return Err(format!(
                    "Collection Profile runtime binding {binding} must be an object"
                ));
            }
        }
    }
    Ok((
        connector_id.to_owned(),
        connector_key.to_owned(),
        object
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(connector_key)
            .to_owned(),
        version.to_owned(),
        manifest,
    ))
}

fn build_source(root: &Path, selected: bool) -> Result<DeveloperConnectorSource, String> {
    let (connector_id, connector_key, display_name, version, _manifest) = manifest_profile(root)?;
    let manifest = confined_file(root, MANIFEST_PATH, "Collection Profile manifest")?;
    let entrypoint = confined_file(root, ENTRYPOINT_PATH, "Collection Profile entrypoint")?;
    let provenance = match confined_file(root, PROVENANCE_PATH, "Collection Profile provenance") {
        Ok(path) => Some((PROVENANCE_PATH.to_owned(), file_hash(&path)?)),
        Err(_error) if !root.join(PROVENANCE_PATH).exists() => None,
        Err(error) => return Err(error),
    };
    let root_digest = hex::encode(Sha256::digest(root.to_string_lossy().as_bytes()));
    let source_id = format!("local_{}", &root_digest[..24]);
    Ok(DeveloperConnectorSource {
        connector_id,
        connector_key,
        display_name,
        entrypoint_path: ENTRYPOINT_PATH.to_owned(),
        entrypoint_sha256: file_hash(&entrypoint)?,
        manifest_path: MANIFEST_PATH.to_owned(),
        manifest_sha256: file_hash(&manifest)?,
        provenance_path: provenance.as_ref().map(|value| value.0.clone()),
        provenance_sha256: provenance.map(|value| value.1),
        root_path: root.to_string_lossy().into_owned(),
        selected,
        source_id,
        trust: "developer-local-unsigned".into(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        version,
    })
}

fn selected_source_id(state: &DeveloperConnectorSourceState, connector_id: &str) -> Option<String> {
    state
        .selected_by_connector_key
        .get(connector_id)
        .and_then(Clone::clone)
        .or_else(|| {
            state.sources.get(connector_id).and_then(|source| {
                (state
                    .selected_by_connector_key
                    .get(&source.connector_key)
                    .and_then(Clone::clone)
                    .as_deref()
                    == Some(source.source_id.as_str()))
                .then(|| source.source_id.clone())
            })
        })
        .or_else(|| {
            state.sources.values().find_map(|source| {
                (source.connector_id == connector_id
                    && state
                        .selected_by_connector_key
                        .get(&source.connector_key)
                        .and_then(Clone::clone)
                        .as_deref()
                        == Some(source.source_id.as_str()))
                .then(|| source.source_id.clone())
            })
        })
}

fn update_selected_flags(state: &mut DeveloperConnectorSourceState) {
    for source in state.sources.values_mut() {
        source.selected = state
            .selected_by_connector_key
            .get(&source.connector_key)
            .and_then(Clone::clone)
            .as_deref()
            == Some(source.source_id.as_str());
    }
}

pub fn list_sources() -> Result<Vec<DeveloperConnectorSource>, String> {
    let path = state_path()?;
    let mut state = read_state(&path)?;
    update_selected_flags(&mut state);
    let mut sources: Vec<_> = state.sources.into_values().collect();
    sources.sort_by(|left, right| {
        left.connector_key
            .cmp(&right.connector_key)
            .then(left.root_path.cmp(&right.root_path))
    });
    Ok(sources)
}

pub fn add_source(source_path: String) -> Result<DeveloperConnectorSource, String> {
    let path = state_path()?;
    let mut state = read_state(&path)?;
    let root = canonical_root(&source_path)?;
    let source_id = build_source(&root, false)?.source_id;
    let key = state
        .sources
        .get(&source_id)
        .map(|source| source.connector_key.clone());
    let selected = key
        .as_deref()
        .and_then(|key| {
            state
                .selected_by_connector_key
                .get(key)
                .and_then(Clone::clone)
        })
        .as_deref()
        == Some(source_id.as_str());
    let source = build_source(&root, selected)?;
    state.sources.insert(source_id, source.clone());
    update_selected_flags(&mut state);
    write_state(&path, &state)?;
    Ok(source)
}

pub fn reload_source(source_id: String) -> Result<DeveloperConnectorSource, String> {
    let path = state_path()?;
    let mut state = read_state(&path)?;
    let existing = state
        .sources
        .get(&source_id)
        .cloned()
        .ok_or("Developer connector source was not found")?;
    let selected = state
        .selected_by_connector_key
        .get(&existing.connector_key)
        .and_then(Clone::clone)
        .as_deref()
        == Some(source_id.as_str());
    let source = build_source(&canonical_root(&existing.root_path)?, selected)?;
    if source.connector_key != existing.connector_key {
        return Err("Reloaded Collection Profile changed connector identity".into());
    }
    state.sources.insert(source_id, source.clone());
    update_selected_flags(&mut state);
    write_state(&path, &state)?;
    Ok(source)
}

pub fn remove_source(source_id: String) -> Result<(), String> {
    let path = state_path()?;
    let mut state = read_state(&path)?;
    let source = state
        .sources
        .remove(&source_id)
        .ok_or("Developer connector source was not found")?;
    if state
        .selected_by_connector_key
        .get(&source.connector_key)
        .and_then(Clone::clone)
        .as_deref()
        == Some(source_id.as_str())
    {
        state
            .selected_by_connector_key
            .insert(source.connector_key, None);
    }
    write_state(&path, &state)
}

pub fn select_source(connector_key: String, source_id: Option<String>) -> Result<(), String> {
    let path = state_path()?;
    let mut state = read_state(&path)?;
    if let Some(source_id) = &source_id {
        let source = state
            .sources
            .get(source_id)
            .ok_or("Developer connector source was not found")?;
        if source.connector_key != connector_key {
            return Err("Developer connector source does not belong to this connector".into());
        }
    }
    state
        .selected_by_connector_key
        .insert(connector_key, source_id);
    update_selected_flags(&mut state);
    write_state(&path, &state)
}

pub fn selected_source(connector_id: &str) -> Result<Option<DeveloperConnectorSource>, String> {
    let path = state_path()?;
    let state = read_state(&path)?;
    let Some(source_id) = selected_source_id(&state, connector_id) else {
        return Ok(None);
    };
    Ok(state.sources.get(&source_id).cloned())
}

pub fn as_active_install(source: &DeveloperConnectorSource) -> ActiveConnectorInstall {
    ActiveConnectorInstall {
        connector_id: source.source_id.clone(),
        manifest_connector_id: Some(source.connector_id.clone()),
        company: source.display_name.clone(),
        version: source.version.clone(),
        root_path: source.root_path.clone(),
        metadata_relative_path: source.manifest_path.clone(),
        script_relative_path: source.entrypoint_path.clone(),
        artifact_kind: Some("pdpp-collection-profile".into()),
        artifact_digest: None,
        manifest_path: Some(source.manifest_path.clone()),
        entrypoint_path: Some(source.entrypoint_path.clone()),
        entrypoint_sha256: Some(source.entrypoint_sha256.clone()),
        manifest_sha256: Some(source.manifest_sha256.clone()),
        provenance_path: source.provenance_path.clone(),
        provenance_sha256: source.provenance_sha256.clone(),
    }
}

#[tauri::command]
pub async fn list_developer_connector_sources() -> Result<Vec<DeveloperConnectorSource>, String> {
    list_sources()
}

#[tauri::command]
pub async fn add_developer_connector_source(
    source_path: String,
) -> Result<DeveloperConnectorSource, String> {
    add_source(source_path)
}

#[tauri::command]
pub async fn reload_developer_connector_source(
    source_id: String,
) -> Result<DeveloperConnectorSource, String> {
    reload_source(source_id)
}

#[tauri::command]
pub async fn remove_developer_connector_source(source_id: String) -> Result<(), String> {
    remove_source(source_id)
}

#[tauri::command]
pub async fn select_developer_connector_source(
    connector_key: String,
    source_id: Option<String>,
) -> Result<(), String> {
    select_source(connector_key, source_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;
    use tempfile::tempdir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fixture(root: &Path, key: &str) {
        fs::create_dir_all(root.join("profile")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(
            root.join(MANIFEST_PATH),
            serde_json::json!({
                "connector_id": format!("https://registry.pdpp.dev/connectors/{key}"),
                "connector_key": key,
                "display_name": "Developer fixture",
                "version": "0.1.0",
                "runtime_requirements": { "bindings": { "network": { "required": true } } },
                "streams": [{ "name": "items" }]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.join(ENTRYPOINT_PATH), "export default {};\n").unwrap();
    }

    fn with_home<T>(home: &Path, action: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = env::var_os("HOME");
        env::set_var("HOME", home);
        let result = action();
        match previous {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        result
    }

    #[test]
    fn local_source_registers_alongside_registry_without_verified_manifest_write() {
        let home = tempdir().unwrap();
        let source_root = tempdir().unwrap();
        fixture(source_root.path(), "developer-fixture");
        with_home(home.path(), || {
            let source = add_source(source_root.path().to_string_lossy().into_owned()).unwrap();
            assert_eq!(source.trust, "developer-local-unsigned");
            assert!(!home
                .path()
                .join(".dataconnect/connectors-active.json")
                .exists());
            assert_eq!(list_sources().unwrap().len(), 1);
            let registry = ActiveConnectorInstall {
                connector_id: "registry-fixture".into(),
                manifest_connector_id: None,
                company: "Registry".into(),
                version: "1.0.0".into(),
                root_path: "/registry".into(),
                metadata_relative_path: MANIFEST_PATH.into(),
                script_relative_path: ENTRYPOINT_PATH.into(),
                artifact_kind: Some("pdpp-collection-profile".into()),
                artifact_digest: Some("sha256:registry".into()),
                manifest_path: Some(MANIFEST_PATH.into()),
                entrypoint_path: Some(ENTRYPOINT_PATH.into()),
                entrypoint_sha256: None,
                manifest_sha256: None,
                provenance_path: Some(PROVENANCE_PATH.into()),
                provenance_sha256: None,
            };
            assert_ne!(source.source_id, registry.connector_id);
            let local_install = as_active_install(&source);
            assert!(local_install.artifact_digest.is_none());
            assert_eq!(
                local_install.manifest_connector_id.as_deref(),
                Some(source.connector_id.as_str())
            );
            select_source(source.connector_key.clone(), Some(source.source_id.clone())).unwrap();
            assert_eq!(
                selected_source(&source.connector_id)
                    .unwrap()
                    .unwrap()
                    .source_id,
                source.source_id
            );
            remove_source(source.source_id).unwrap();
            assert!(selected_source(&source.connector_id).unwrap().is_none());
        });
    }

    #[test]
    fn local_source_rejects_unsupported_binding() {
        let home = tempdir().unwrap();
        let source_root = tempdir().unwrap();
        fixture(source_root.path(), "bad-binding");
        let manifest = fs::read_to_string(source_root.path().join(MANIFEST_PATH)).unwrap();
        let mut value: Value = serde_json::from_str(&manifest).unwrap();
        value["runtime_requirements"]["bindings"] =
            serde_json::json!({ "usb": { "required": true } });
        fs::write(source_root.path().join(MANIFEST_PATH), value.to_string()).unwrap();
        with_home(home.path(), || {
            assert!(
                add_source(source_root.path().to_string_lossy().into_owned())
                    .unwrap_err()
                    .contains("unsupported runtime binding")
            );
        });
    }
}
