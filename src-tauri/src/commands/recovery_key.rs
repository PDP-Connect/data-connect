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
//! key). This module's watcher mirrors the ACTUAL existing precedent for that
//! situation in this codebase -- `remote_access.rs`'s
//! `remote_access_config_path`/`spawn_remote_access_config_watcher` pair,
//! where Rust and the reference server agree on one shared JSON file under
//! `PDPP_DATA_DIR` and Rust polls it -- rather than a request/ack protocol,
//! which does not exist anywhere in this codebase today (despite an earlier
//! description of this task assuming an autostart-watcher precedent for it;
//! no such watcher exists in this repo -- see the recovery-key PR notes).
//!
//! `recovery-export.json` shape:
//! `{ "requestId": u64, "appliedRequestId": u64 | null, "code": string | null, "error": string | null }`
//! RS bumps `requestId` to ask for a fresh export. The watcher notices
//! `requestId != appliedRequestId`, computes the code (or an error), and
//! writes `appliedRequestId = requestId` plus either `code` or `error`. RS
//! polls until `appliedRequestId == requestId`, reads the result, and -- this
//! is the one place this file differs from the remote-access precedent, and
//! it is a real disclosure -- immediately writes `code: null` back so the
//! plaintext recovery code does not linger on disk after the round trip.

use crate::owner_credential::{
    database_encryption_key_path, database_is_encrypted, load_or_create_database_encryption_key,
    DatabaseKeyError,
};
use crate::recovery_code;
use crate::unified::unified_database_path;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const RECOVERY_EXPORT_FILE: &str = "recovery-export.json";
const WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RecoveryExportState {
    request_id: u64,
    applied_request_id: Option<u64>,
    code: Option<String>,
    error: Option<String>,
}

fn recovery_export_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(crate::unified::UNIFIED_DB_DIRECTORY).join(RECOVERY_EXPORT_FILE))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

fn load_recovery_export_state(path: &Path) -> Result<RecoveryExportState, String> {
    if !path.exists() {
        return Ok(RecoveryExportState::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read recovery export state: {error}"))?;
    if content.trim().is_empty() {
        return Ok(RecoveryExportState::default());
    }
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse recovery export state: {error}"))
}

/// Writes `recovery-export.json` and locks it to 0600 immediately after the
/// write. Unlike `remote-access.json` (config only), this file transiently
/// carries the plaintext database encryption key in its `code` field, so it
/// needs the same file-mode protection every other secret in this codebase
/// gets in `owner_credential.rs` -- world-readable default permissions would
/// let any local user read the key for as long as it sits on disk.
fn save_recovery_export_state(path: &Path, state: &RecoveryExportState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create recovery export directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize recovery export state: {error}"))?;
    fs::write(path, content)
        .map_err(|error| format!("Failed to write recovery export state: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to protect recovery export state: {error}"))?;
    }
    Ok(())
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
    export_recovery_code_at(&key_path, &database_path)
}

/// Tauri command for the recovery window / any future in-process caller.
/// Not reachable from the console window (see module docs) -- Settings goes
/// through the `recovery-export.json` file protocol below instead.
#[tauri::command]
pub(crate) fn export_database_encryption_recovery_code(app: AppHandle) -> Result<String, String> {
    export_recovery_code(&app)
}

/// Spawn the poller that answers Settings' "Export recovery code" requests.
/// Mirrors `spawn_remote_access_config_watcher`'s shared-file-polling shape
/// (see module docs for why this differs from a request/ack scheme).
pub(crate) fn spawn_recovery_export_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_applied: Option<u64> = None;
        loop {
            tokio::time::sleep(WATCHER_POLL_INTERVAL).await;
            tick_recovery_export_watcher(&app, &mut last_applied);
        }
    });
}

fn tick_recovery_export_watcher(app: &AppHandle, last_applied: &mut Option<u64>) {
    let path = match recovery_export_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Recovery export watcher could not resolve its state path: {error}");
            return;
        }
    };
    let state = match load_recovery_export_state(&path) {
        Ok(state) => state,
        Err(error) => {
            log::warn!("Recovery export watcher could not read its state file: {error}");
            return;
        }
    };
    if Some(state.request_id) == *last_applied {
        return;
    }

    let started = Instant::now();
    let result = export_recovery_code(app);
    let ok = result.is_ok();
    log::info!(
        "Recovery export watcher: request_id={} duration_ms={} ok={ok}",
        state.request_id,
        started.elapsed().as_millis()
    );

    let next_state = match result {
        Ok(code) => RecoveryExportState {
            request_id: state.request_id,
            applied_request_id: Some(state.request_id),
            code: Some(code),
            error: None,
        },
        Err(error) => RecoveryExportState {
            request_id: state.request_id,
            applied_request_id: Some(state.request_id),
            code: None,
            error: Some(error),
        },
    };
    if let Err(error) = save_recovery_export_state(&path, &next_state) {
        log::warn!("Recovery export watcher could not write its state file: {error}");
        return;
    }
    *last_applied = Some(state.request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn export_state_round_trips_through_json() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(RECOVERY_EXPORT_FILE);

        let state = RecoveryExportState {
            request_id: 3,
            applied_request_id: Some(3),
            code: Some("AB12-CD34".to_string()),
            error: None,
        };
        save_recovery_export_state(&path, &state).expect("saved state");
        let loaded = load_recovery_export_state(&path).expect("loaded state");
        assert_eq!(loaded, state);
    }

    #[cfg(unix)]
    #[test]
    fn saved_export_state_file_is_locked_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(RECOVERY_EXPORT_FILE);
        let state = RecoveryExportState {
            request_id: 1,
            applied_request_id: Some(1),
            code: Some("plaintext-key-must-not-be-world-readable".to_string()),
            error: None,
        };

        save_recovery_export_state(&path, &state).expect("saved state");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "recovery-export.json must be 0600, got {mode:o}");
    }

    #[test]
    fn missing_export_state_file_defaults_to_zero_request_id() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(RECOVERY_EXPORT_FILE);

        let loaded = load_recovery_export_state(&path).expect("default state");
        assert_eq!(loaded, RecoveryExportState::default());
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
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, [0u8; 16]).expect("encrypted database marker");

        // Whether this sandbox's OS keychain is reachable or not,
        // load_or_create_database_encryption_key_with_store (exercised via
        // export_recovery_code_at -> the AppHandle-free path) must durably
        // persist SOME key on first call and return the SAME key on a
        // second call -- that stability is what the recovery code actually
        // has to round-trip against, independent of which backend (keychain
        // vs 0600 file) this environment happens to route through.
        let first_code = export_recovery_code_at(&key_path, &database_path).expect("export code");
        let second_code =
            export_recovery_code_at(&key_path, &database_path).expect("export code again");
        assert_eq!(first_code, second_code);

        let decoded = recovery_code::decode(&first_code).expect("recovery code decodes");
        assert!(!decoded.is_empty());
    }

    #[test]
    fn rs_style_cleanup_clears_the_code_field_after_reading_it() {
        // Simulates the RS-side half of the round trip: after RS observes
        // appliedRequestId == requestId and reads the code, it must write
        // the code field back to null so the plaintext code does not linger
        // on disk. This test proves the file shape supports that write
        // (RS itself is exercised by reference-implementation's own tests).
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(RECOVERY_EXPORT_FILE);

        let answered = RecoveryExportState {
            request_id: 1,
            applied_request_id: Some(1),
            code: Some("SECRET-CODE".to_string()),
            error: None,
        };
        save_recovery_export_state(&path, &answered).expect("saved answered state");

        let mut read_back = load_recovery_export_state(&path).expect("loaded state");
        assert_eq!(read_back.code.as_deref(), Some("SECRET-CODE"));
        read_back.code = None;
        save_recovery_export_state(&path, &read_back).expect("cleared state");

        let cleared = load_recovery_export_state(&path).expect("loaded cleared state");
        assert_eq!(cleared.code, None);
        assert_eq!(cleared.applied_request_id, Some(1));
    }
}
