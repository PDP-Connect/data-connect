//! Durable desktop identity for each installed PDPP connector account.

use super::connector_store::get_dataconnect_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

static CONNECTIONS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PdppConnectionAccount {
    pub connection_id: String,
    #[serde(default)]
    pub account_label: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdppConnectionsFile {
    version: u8,
    connectors: std::collections::HashMap<String, Vec<PdppConnectionAccount>>,
}

fn connections_path() -> Result<PathBuf, String> {
    Ok(get_dataconnect_dir()
        .ok_or("Could not determine DataConnect directory for PDPP connections")?
        .join("pdpp-connections.json"))
}

fn read_connections(path: &Path) -> Result<PdppConnectionsFile, String> {
    if !path.exists() {
        return Ok(PdppConnectionsFile::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read PDPP connections: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse PDPP connections: {error}"))
}

fn write_connections(path: &Path, file: &PdppConnectionsFile) -> Result<(), String> {
    let parent = path.parent().ok_or("PDPP connections path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create PDPP connections directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create PDPP connections temp file: {error}"))?;
    serde_json::to_writer_pretty(&mut temporary, file)
        .map_err(|error| format!("Failed to serialize PDPP connections: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync PDPP connections: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to save PDPP connections: {error}"))?;
    Ok(())
}

fn next_account_label(accounts: &[PdppConnectionAccount]) -> String {
    let used_labels: std::collections::HashSet<String> = accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            account
                .account_label
                .clone()
                .unwrap_or_else(|| format!("Account {}", index + 1))
        })
        .collect();
    (1..)
        .map(|ordinal| format!("Account {ordinal}"))
        .find(|label| !used_labels.contains(label))
        .expect("account label sequence is unbounded")
}

pub(super) fn legacy_connection_id(connector_id: &str) -> String {
    if connector_id == "github-pdpp" {
        return "default".into();
    }
    let token = if connector_id.starts_with("https://") {
        let hash = connector_id
            .encode_utf16()
            .fold(2166136261_u32, |hash, unit| {
                (hash ^ u32::from(unit)).wrapping_mul(16777619)
            });
        format!("pdpp-{hash:08x}")
    } else {
        connector_id.to_owned()
    };
    format!("{token}-owner")
}

pub(super) fn has_legacy_data(app: &tauri::AppHandle, connector_id: &str, company: &str) -> bool {
    let legacy_id = legacy_connection_id(connector_id);
    let collection_has_legacy = get_dataconnect_dir()
        .map(|directory| directory.join("pdpp-collection-state.json"))
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|state| {
            state
                .get("connectors")?
                .get(connector_id)?
                .get(&legacy_id)
                .cloned()
        })
        .is_some();
    let profile_has_legacy =
        super::pdpp_browser::PdppBrowserLease::profile_exists(connector_id, &legacy_id)
            .unwrap_or(false);
    let export_has_legacy = app
        .path()
        .app_data_dir()
        .ok()
        .is_some_and(|directory| directory.join("exported_data").join(company).exists());
    collection_has_legacy || profile_has_legacy || export_has_legacy
}

pub(super) fn stored_connections(connector_id: &str) -> Result<Vec<PdppConnectionAccount>, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "PDPP connections lock is unavailable")?;
    Ok(read_connections(&connections_path()?)?
        .connectors
        .get(connector_id)
        .cloned()
        .unwrap_or_default())
}

/// Reuse the legacy owner id when old local state exists. New accounts receive
/// random ids once and retain them in the connection registry.
#[tauri::command]
pub fn ensure_pdpp_connection(
    app: tauri::AppHandle,
    connector_id: String,
    company: String,
) -> Result<PdppConnectionAccount, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "PDPP connections lock is unavailable")?;
    let path = connections_path()?;
    let mut file = read_connections(&path)?;
    let accounts = file.connectors.entry(connector_id.clone()).or_default();
    if let Some(account) = accounts.first() {
        return Ok(account.clone());
    }
    let is_legacy = has_legacy_data(&app, &connector_id, &company);
    let connection_id = if is_legacy {
        legacy_connection_id(&connector_id)
    } else {
        format!("connection-{}", Uuid::new_v4().as_simple())
    };
    let account = PdppConnectionAccount {
        connection_id,
        account_label: (!is_legacy).then(|| next_account_label(accounts)),
    };
    accounts.push(account.clone());
    file.version = 1;
    write_connections(&path, &file)?;
    Ok(account)
}

#[tauri::command]
pub fn create_pdpp_connection(connector_id: String) -> Result<PdppConnectionAccount, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "PDPP connections lock is unavailable")?;
    let path = connections_path()?;
    let mut file = read_connections(&path)?;
    let accounts = file.connectors.entry(connector_id.clone()).or_default();
    let account = PdppConnectionAccount {
        connection_id: format!("connection-{}", Uuid::new_v4().as_simple()),
        account_label: Some(next_account_label(accounts)),
    };
    accounts.push(account.clone());
    file.version = 1;
    write_connections(&path, &file)?;
    Ok(account)
}

#[tauri::command]
pub fn set_pdpp_connection_label(
    connector_id: String,
    connection_id: String,
    account_label: String,
) -> Result<(), String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "PDPP connections lock is unavailable")?;
    let path = connections_path()?;
    let mut file = read_connections(&path)?;
    let account = file
        .connectors
        .get_mut(&connector_id)
        .and_then(|accounts| {
            accounts
                .iter_mut()
                .find(|account| account.connection_id == connection_id)
        })
        .ok_or("PDPP connection was not found")?;
    let label = account_label.trim();
    if !label.is_empty() {
        account.account_label = Some(label.chars().take(120).collect());
        file.version = 1;
        write_connections(&path, &file)?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_pdpp_connection(connector_id: String, connection_id: String) -> Result<(), String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "PDPP connections lock is unavailable")?;
    let path = connections_path()?;
    let mut file = read_connections(&path)?;
    if let Some(accounts) = file.connectors.get_mut(&connector_id) {
        accounts.retain(|account| account.connection_id != connection_id);
        if accounts.is_empty() {
            file.connectors.remove(&connector_id);
        }
        file.version = 1;
        write_connections(&path, &file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn legacy_owner_id_matches_the_pre_multi_account_id() {
        assert_eq!(legacy_connection_id("chatgpt-pdpp"), "chatgpt-pdpp-owner");
        assert_eq!(
            legacy_connection_id("https://example.test/connector"),
            "pdpp-d8654f42-owner"
        );
        assert_eq!(
            legacy_connection_id("https://example.test/é"),
            "pdpp-7ab12d62-owner"
        );
        assert_eq!(
            legacy_connection_id("http://example.test/connector"),
            "http://example.test/connector-owner"
        );
    }

    #[test]
    fn connection_registry_keeps_distinct_accounts_and_labels() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("connections.json");
        let mut file = PdppConnectionsFile::default();
        file.connectors.insert(
            "chatgpt-pdpp".into(),
            vec![
                PdppConnectionAccount {
                    connection_id: "chatgpt-pdpp-one".into(),
                    account_label: Some("one@example.test".into()),
                },
                PdppConnectionAccount {
                    connection_id: "chatgpt-pdpp-two".into(),
                    account_label: None,
                },
            ],
        );
        write_connections(&path, &file).unwrap();
        let loaded = read_connections(&path).unwrap();
        assert_eq!(loaded.connectors["chatgpt-pdpp"].len(), 2);
        assert_eq!(
            loaded.connectors["chatgpt-pdpp"][0]
                .account_label
                .as_deref(),
            Some("one@example.test")
        );
    }

    #[test]
    fn account_labels_do_not_repeat_after_an_account_is_removed() {
        let accounts = vec![PdppConnectionAccount {
            connection_id: "second".into(),
            account_label: Some("Account 2".into()),
        }];
        assert_eq!(next_account_label(&accounts), "Account 1");
    }

    #[test]
    fn a_new_account_gets_account_two_when_adding_to_an_unlabeled_legacy_account() {
        let accounts = vec![PdppConnectionAccount {
            connection_id: "legacy-owner".into(),
            account_label: None,
        }];
        assert_eq!(next_account_label(&accounts), "Account 2");
    }

    #[test]
    fn legacy_migration_keeps_the_existing_profile_and_collection_state_attached() {
        let directory = tempdir().unwrap();
        let old_connection_id = legacy_connection_id("chatgpt-pdpp");
        let profile = super::super::pdpp_browser::PdppBrowserLease::profile_path_at(
            directory.path(),
            "chatgpt-pdpp",
            &old_connection_id,
        );
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("Cookies"), "existing-session").unwrap();
        assert!(
            super::super::pdpp_browser::PdppBrowserLease::profile_exists_at(
                directory.path(),
                "chatgpt-pdpp",
                &old_connection_id,
            )
        );
        assert_eq!(
            fs::read_to_string(profile.join("Cookies")).unwrap(),
            "existing-session"
        );

        let collection_state = directory.path().join("pdpp-collection-state.json");
        fs::write(
            &collection_state,
            r#"{"version":1,"connectors":{"chatgpt-pdpp":{"chatgpt-pdpp-owner":{"checkpoints":{"conversations":"cursor-7"},"snapshotByStream":{},"rawRecordsByStream":{}}}}}"#,
        ).unwrap();
        let state = super::super::pdpp_collection_state::load_connection_state_at(
            &collection_state,
            "chatgpt-pdpp",
            &old_connection_id,
        )
        .unwrap();
        assert_eq!(
            state.checkpoints.get("conversations"),
            Some(&serde_json::json!("cursor-7"))
        );
    }
}
