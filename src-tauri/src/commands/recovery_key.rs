// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Export the desktop database encryption key as a printable recovery code,
//! and the file-backed bridge that makes this reachable from the console
//! window.
//!
//! The console window is `WebviewUrl::External` and never gets an
//! `invoke()` bridge (see `local/HOST-BRIDGE-DESIGN-0918.md`, and
//! `remote_access.rs`'s `owner-remote-access.ts` precedent), so this command
//! cannot be called directly from Settings. Unlike the `user_supplied_origin`
//! remote-access provider, though, there is no HTTP-native way to answer this
//! request either: the recovery code is derived from a value the reference
//! server has no way to read (the Rust process's OS-keychain-backed database
//! key).
//!
//! The reference server writes one private command file under
//! `recovery-export-commands/rky_*.json`. The watcher answers with one
//! private result file under `recovery-export-results/rky_*.json`, removes
//! the command, and lets the server consume and unlink the short-lived result.

use crate::owner_credential::{
    DatabaseKeyError, credential_encryption_key_path, database_encryption_key_path,
    database_is_encrypted, load_or_create_credential_encryption_key,
    load_or_create_database_encryption_key,
};
use crate::recovery_code;
use crate::unified::unified_database_path;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const LEGACY_RECOVERY_EXPORT_FILE: &str = "recovery-export.json";
const RECOVERY_EXPORT_COMMANDS_DIR: &str = "recovery-export-commands";
const RECOVERY_EXPORT_RESULTS_DIR: &str = "recovery-export-results";
const RECOVERY_EXPORT_RESULT_TTL: Duration = Duration::from_secs(120);
const WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RecoveryExportCommand {
    command_id: String,
    kind: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RecoveryExportResult {
    command_id: String,
    status: String,
    code: Option<String>,
    error: Option<String>,
    created_at: String,
    expires_at: String,
    consumed_at: Option<String>,
}

fn recovery_export_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(crate::unified::UNIFIED_DB_DIRECTORY))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

fn command_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_EXPORT_COMMANDS_DIR)
}

fn result_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_EXPORT_RESULTS_DIR)
}

fn legacy_recovery_export_path(root: &Path) -> PathBuf {
    root.join(LEGACY_RECOVERY_EXPORT_FILE)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn ttl_iso(ttl: Duration) -> String {
    (chrono::Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default()).to_rfc3339()
}

fn is_expired(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|expires_at| expires_at <= chrono::Utc::now())
        .unwrap_or(true)
}

fn load_recovery_export_command(path: &Path) -> Result<RecoveryExportCommand, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read recovery export command: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse recovery export command: {error}"))
}

/// Writes recovery export command/result files and locks them to 0600.
/// Result files transiently carry plaintext recovery material, so they need
/// the same file-mode protection every other secret in this codebase gets in
/// `owner_credential.rs`.
fn save_private_json<T: Serialize>(path: &Path, value: &T, context: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create recovery export directory: {error}"))?;
    }
    crate::atomic_write::write_json_atomically(path, value, context)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to protect recovery export file: {error}"))?;
    }
    Ok(())
}

fn list_command_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = command_dir(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| {
        format!(
            "Failed to read recovery export command directory {}: {error}",
            dir.display()
        )
    })? {
        let path = entry
            .map_err(|error| format!("Failed to read recovery export command entry: {error}"))?
            .path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if file_name.starts_with("rky_") && file_name.ends_with(".json") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn cleanup_expired_recovery_exports(root: &Path) {
    for dir in [command_dir(root), result_dir(root)] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten().take(100) {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                let _ = fs::remove_file(&path);
                continue;
            };
            let expires_at = serde_json::from_str::<serde_json::Value>(&content)
                .ok()
                .and_then(|value| {
                    value
                        .get("expiresAt")
                        .and_then(|expires_at| expires_at.as_str())
                        .map(str::to_owned)
                });
            if expires_at.as_deref().map(is_expired).unwrap_or(true) {
                if dir.ends_with(RECOVERY_EXPORT_RESULTS_DIR) {
                    if let Some(name) = path.file_name() {
                        let _ = fs::remove_file(command_dir(root).join(name));
                    }
                }
                let _ = fs::remove_file(&path);
            }
        }
    }
}

const NO_VAULT_MESSAGE: &str = "No encrypted vault exists yet. There is nothing to back up until DataConnect has started at least once.";

/// Path-level export logic, independent of `AppHandle` so it's directly
/// unit-testable against a temp directory: refuse when no encrypted vault
/// exists yet, otherwise load the current database encryption key and
/// re-encode it as a recovery code.
///
/// Never logs the key or the resulting code -- only booleans/lengths would
/// be safe to log, and even that isn't done here since neither the command
/// nor the watcher's own logging need it.
fn export_recovery_code_at(key_path: &Path, database_path: &Path) -> Result<String, String> {
    if !database_is_encrypted(database_path)? {
        return Err(NO_VAULT_MESSAGE.to_string());
    }

    let credential = load_or_create_database_encryption_key(key_path, database_path)
        .map_err(DatabaseKeyError::into_message)?;
    recovery_code::encode(&credential).map_err(|error| error.to_string())
}

fn export_recovery_kit_v2_at(
    database_key_path: &Path,
    credential_key_path: &Path,
    database_path: &Path,
) -> Result<String, String> {
    if !database_is_encrypted(database_path)? {
        return Err(NO_VAULT_MESSAGE.to_string());
    }

    let database_encryption_key =
        load_or_create_database_encryption_key(database_key_path, database_path)
            .map_err(DatabaseKeyError::into_message)?;
    let credential_encryption_key =
        load_or_create_credential_encryption_key(credential_key_path, database_path)?;
    let kit = recovery_code::RecoveryKitV2 {
        database_encryption_key: Some(database_encryption_key),
        credential_encryption_key,
    };
    recovery_code::encode_v2(&kit).map_err(|error| error.to_string())
}

fn export_recovery_code(app: &AppHandle) -> Result<String, String> {
    if crate::unified::attach_mode() {
        // Attach mode has no local database key at all -- a different
        // process/host owns the vault (see load_bootstrap_secrets, which
        // returns None for database_encryption_key here). There is nothing
        // this process could export even in principle.
        return Err(
            "DataConnect is attached to an external reference server in this mode; there is no local key to export.".to_string(),
        );
    }
    let database_path = unified_database_path(app)?;
    let key_path = database_encryption_key_path(app)?;
    let credential_key_path = credential_encryption_key_path(app)?;
    export_recovery_kit_v2_at(&key_path, &credential_key_path, &database_path)
}

/// Tauri command for the recovery window / any future in-process caller.
/// Not reachable from the console window (see module docs) -- Settings goes
/// through the recovery export command/result file protocol below instead.
#[tauri::command]
pub(crate) fn export_database_encryption_recovery_code(app: AppHandle) -> Result<String, String> {
    export_recovery_code(&app)
}

/// Spawn the poller that answers Settings' "Export recovery code" requests.
/// The reference server creates one command file per request; this watcher
/// answers each command with one expiring result file.
pub(crate) fn spawn_recovery_export_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCHER_POLL_INTERVAL).await;
            tick_recovery_export_watcher(&app);
        }
    });
}

fn tick_recovery_export_watcher(app: &AppHandle) {
    let root = match recovery_export_root(app) {
        Ok(root) => root,
        Err(error) => {
            log::warn!("Recovery export watcher could not resolve its root path: {error}");
            return;
        }
    };

    let _ = fs::remove_file(legacy_recovery_export_path(&root));
    cleanup_expired_recovery_exports(&root);

    let paths = match list_command_paths(&root) {
        Ok(paths) => paths,
        Err(error) => {
            log::warn!("Recovery export watcher could not list command files: {error}");
            return;
        }
    };

    for path in paths {
        let command = match load_recovery_export_command(&path) {
            Ok(command) => command,
            Err(error) => {
                log::warn!("Recovery export watcher could not read command: {error}");
                let _ = fs::remove_file(&path);
                continue;
            }
        };
        let file_stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("");
        if command.command_id != file_stem
            || !command.command_id.starts_with("rky_")
            || command.kind != "export_database_encryption_recovery_code"
        {
            log::warn!(
                "Recovery export watcher ignored invalid command file {}",
                path.display()
            );
            let _ = fs::remove_file(&path);
            continue;
        }
        if is_expired(&command.expires_at) {
            let _ = fs::remove_file(&path);
            continue;
        }

        let started = Instant::now();
        let result = export_recovery_code(app);
        let ok = result.is_ok();
        log::info!(
            "Recovery export watcher: command_id={} duration_ms={} ok={ok}",
            command.command_id,
            started.elapsed().as_millis()
        );

        let result = match result {
            Ok(code) => RecoveryExportResult {
                command_id: command.command_id.clone(),
                status: "succeeded".to_string(),
                code: Some(code),
                error: None,
                created_at: now_iso(),
                expires_at: ttl_iso(RECOVERY_EXPORT_RESULT_TTL),
                consumed_at: None,
            },
            Err(error) => RecoveryExportResult {
                command_id: command.command_id.clone(),
                status: "failed".to_string(),
                code: None,
                error: Some(error),
                created_at: now_iso(),
                expires_at: ttl_iso(RECOVERY_EXPORT_RESULT_TTL),
                consumed_at: None,
            },
        };
        let result_path = result_dir(&root).join(format!("{}.json", command.command_id));
        if let Err(error) = save_private_json(
            &result_path,
            &result,
            "Failed to write recovery export result",
        ) {
            log::warn!("Recovery export watcher could not write result file: {error}");
            continue;
        }
        if let Err(error) = fs::remove_file(&path) {
            log::warn!("Recovery export watcher could not remove answered command: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn export_result_round_trips_through_private_json() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("rky_test.json");

        let result = RecoveryExportResult {
            command_id: "rky_test".to_string(),
            status: "succeeded".to_string(),
            code: Some("AB12-CD34".to_string()),
            error: None,
            created_at: now_iso(),
            expires_at: ttl_iso(RECOVERY_EXPORT_RESULT_TTL),
            consumed_at: None,
        };
        save_private_json(&path, &result, "save test result").expect("saved result");
        let loaded: RecoveryExportResult =
            serde_json::from_str(&fs::read_to_string(&path).expect("read result"))
                .expect("loaded result");
        assert_eq!(loaded, result);
    }

    #[cfg(unix)]
    #[test]
    fn saved_export_result_file_is_locked_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("rky_test.json");
        let result = RecoveryExportResult {
            command_id: "rky_test".to_string(),
            status: "succeeded".to_string(),
            code: Some("plaintext-key-must-not-be-world-readable".to_string()),
            error: None,
            created_at: now_iso(),
            expires_at: ttl_iso(RECOVERY_EXPORT_RESULT_TTL),
            consumed_at: None,
        };

        save_private_json(&path, &result, "save test result").expect("saved result");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "recovery export result must be 0600, got {mode:o}"
        );
    }

    #[test]
    fn expired_result_cleanup_removes_matching_command() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let command_path = command_dir(root).join("rky_test.json");
        let result_path = result_dir(root).join("rky_test.json");
        fs::create_dir_all(command_dir(root)).expect("command dir");
        fs::create_dir_all(result_dir(root)).expect("result dir");
        fs::write(
            &command_path,
            r#"{"commandId":"rky_test","kind":"export_database_encryption_recovery_code","createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("command");
        fs::write(
            &result_path,
            r#"{"commandId":"rky_test","status":"succeeded","code":"SECRET","error":null,"createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-01T00:00:00Z","consumedAt":null}"#,
        )
        .expect("result");

        cleanup_expired_recovery_exports(root);

        assert!(!command_path.exists());
        assert!(!result_path.exists());
    }

    #[test]
    fn export_is_refused_when_no_vault_exists_yet() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        // No database file at all: the "hasn't started yet" case.

        let error = export_recovery_code_at(&key_path, &database_path)
            .expect_err("export must be refused with no vault");
        assert_eq!(error, NO_VAULT_MESSAGE);
    }

    #[test]
    fn export_is_refused_for_an_unencrypted_database() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, b"SQLite format 3\0").expect("plaintext database marker");

        let error = export_recovery_code_at(&key_path, &database_path)
            .expect_err("export must be refused for a plaintext database");
        assert_eq!(error, NO_VAULT_MESSAGE);
    }

    #[test]
    fn export_succeeds_and_round_trips_when_a_vault_exists() {
        let directory = tempdir().expect("temp directory");
        let database_key_path = directory.path().join("database-encryption-key");
        let credential_key_path = directory.path().join("credential-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, [0u8; 16]).expect("encrypted database marker");

        // Whether this sandbox's OS keychain is reachable or not,
        // load_or_create_database_encryption_key_with_store (exercised via
        // export_recovery_code_at -> the AppHandle-free path) must durably
        // persist SOME key on first call and return the SAME key on a
        // second call -- that stability is what the recovery code actually
        // has to round-trip against, independent of which backend (keychain
        // vs 0600 file) this environment happens to route through.
        let first_code =
            export_recovery_kit_v2_at(&database_key_path, &credential_key_path, &database_path)
                .expect("export recovery kit");
        let second_code =
            export_recovery_kit_v2_at(&database_key_path, &credential_key_path, &database_path)
                .expect("export recovery kit again");
        assert_eq!(first_code, second_code);

        let decoded = recovery_code::decode_v2(&first_code).expect("recovery kit decodes");
        assert!(decoded.database_encryption_key.is_some());
        assert!(!decoded.credential_encryption_key.is_empty());
    }
}
