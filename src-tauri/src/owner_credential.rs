// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Durable owner credential storage for the unified desktop path.
//!
//! The OS keychain is the primary store. The app-data file is used only when
//! the keychain backend is unavailable at runtime, such as headless Linux.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const OWNER_CREDENTIAL_FILE: &str = "owner-credential";
pub(crate) const OWNER_PASSWORD_OWNER_SET_MARKER_FILE: &str = "owner-password-owner-set.json";
const OWNER_PASSWORD_WINDOW_REQUEST_FILE: &str = "owner-password-window-request.json";
const OWNER_PASSWORD_WINDOW_REQUEST_PREFIX: &str = "owner-password-window-request-";
const OWNER_PASSWORD_RECOVERY_WINDOW_REQUEST_FILE: &str =
    "owner-password-recovery-window-request.json";
const OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE: &str = "owner-password-stack-restart-request.json";
const OWNER_OS_REAUTH_REQUEST_FILE: &str = "owner-os-reauth-request.json";
const OWNER_OS_REAUTH_REQUEST_PREFIX: &str = "owner-os-reauth-request-";
const OWNER_OS_REAUTH_RESULT_PREFIX: &str = "owner-os-reauth-result-";
const CREDENTIAL_ENCRYPTION_KEY_FILE: &str = "credential-encryption-key";
const DATABASE_ENCRYPTION_KEY_FILE: &str = "database-encryption-key";
const GENERATED_SECRET_BYTES: usize = 32;
const OWNER_PASSWORD_MIN_LENGTH: usize = 15;
const OWNER_PASSWORD_WINDOW_LABEL: &str = "owner-password";
const OWNER_PASSWORD_WINDOW_WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(500);
const OWNER_OS_REAUTH_GRANT_TTL: Duration = Duration::from_secs(120);
const KEYRING_SERVICE: &str = "com.vana.dataconnect";
const OWNER_KEYRING_USERNAME: &str = "owner";
const PROVIDER_CREDENTIAL_USERNAME_PREFIX: &str = "remote-access-provider:";
const CREDENTIAL_ENCRYPTION_KEYRING_USERNAME: &str = "credential-encryption-key";
const DATABASE_ENCRYPTION_KEYRING_USERNAME: &str = "database-encryption-key";

trait CredentialStore {
    fn load(&mut self) -> Result<Option<String>, String>;
    fn save(&mut self, credential: &str) -> Result<(), String>;
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OwnerPasswordRequestState {
    request_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed_request_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    not_before_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deadline_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_for_request_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_consumed_request_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    purpose: Option<String>,
}

#[derive(Debug, Clone)]
struct OwnerReauthGrant {
    expires_unix_ms: u64,
    purpose: String,
    reauth_request_id: u64,
    window_request_id: Option<u64>,
}

static OWNER_REAUTH_GRANTS: OnceLock<Mutex<HashMap<String, OwnerReauthGrant>>> = OnceLock::new();

fn owner_reauth_grants() -> &'static Mutex<HashMap<String, OwnerReauthGrant>> {
    OWNER_REAUTH_GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct SystemKeyring {
    username: String,
}

impl SystemKeyring {
    fn new(username: impl Into<String>) -> Self {
        Self {
            username: username.into(),
        }
    }

    fn owner() -> Self {
        Self::new(OWNER_KEYRING_USERNAME)
    }

    fn provider_credential_reference(provider_id: &str) -> Result<Self, String> {
        let provider_id = validated_provider_id(provider_id)?;
        Ok(Self::new(format!(
            "{PROVIDER_CREDENTIAL_USERNAME_PREFIX}{provider_id}"
        )))
    }
}

impl CredentialStore for SystemKeyring {
    fn load(&mut self) -> Result<Option<String>, String> {
        log::info!("OS keychain load: entry username={}", self.username);
        let started = Instant::now();
        let result = (|| {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &self.username)
                .map_err(|error| format!("could not initialize OS keychain: {error}"))?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("could not read OS keychain: {error}")),
            }
        })();
        log::info!(
            "OS keychain load: exit username={} duration_ms={} ok={}",
            self.username,
            started.elapsed().as_millis(),
            result.is_ok()
        );
        result
    }

    fn save(&mut self, credential: &str) -> Result<(), String> {
        log::info!("OS keychain save: entry username={}", self.username);
        let started = Instant::now();
        let result = (|| {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &self.username)
                .map_err(|error| format!("could not initialize OS keychain: {error}"))?;
            entry
                .set_password(credential)
                .map_err(|error| format!("could not write OS keychain: {error}"))
        })();
        log::info!(
            "OS keychain save: exit username={} duration_ms={} ok={}",
            self.username,
            started.elapsed().as_millis(),
            result.is_ok()
        );
        result
    }
}

/// Resolve the app-data path used for the generated owner password.
pub(crate) fn owner_credential_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(OWNER_CREDENTIAL_FILE))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// Resolve the app-data path used for the generated desktop SQLite key.
pub(crate) fn database_encryption_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(DATABASE_ENCRYPTION_KEY_FILE))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// Resolve the app-data path used for the generated credential encryption key.
pub(crate) fn credential_encryption_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(CREDENTIAL_ENCRYPTION_KEY_FILE))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// Prefer an explicit development credential when one is supplied. The
/// `PDPP_OWNER_PASSWORD` fallback matches the RI's existing attach contract;
/// `DATACONNECT_OWNER_PASSWORD` makes the desktop-specific override explicit.
pub(crate) fn configured_owner_password() -> Option<String> {
    ["DATACONNECT_OWNER_PASSWORD", "PDPP_OWNER_PASSWORD"]
        .into_iter()
        .find_map(|name| {
            let value = std::env::var(name).ok()?;
            (!value.trim().is_empty()).then_some(value)
        })
}

/// Load the one credential for this app-data path, or create it once.
pub(crate) fn load_or_create_owner_credential(path: &Path) -> Result<String, String> {
    let mut store = SystemKeyring::owner();
    load_or_create_owner_credential_with_store(path, &mut store)
}

/// Distinguishes "the key is missing while an encrypted vault exists" (the
/// one failure the startup recovery flow in `unified.rs` needs to react to
/// with a recovery window) from every other way loading the key can fail
/// (keychain I/O errors, a corrupt app-data file, etc., which stay generic
/// errors). A typed signal here is deliberately narrower than rewriting every
/// `Result<_, String>` in this file: this is the one call site
/// (`load_bootstrap_secrets` in `unified.rs`) that needs to branch on the
/// distinction, so the blast radius of this type is exactly two functions.
#[derive(Debug)]
pub(crate) enum DatabaseKeyError {
    /// An encrypted SQLite vault exists on disk but no key was found in
    /// either the OS keychain or the app-data fallback file.
    Missing(String),
    Other(String),
}

impl DatabaseKeyError {
    /// Collapse to a plain message for callers that don't need the
    /// distinction (e.g. anywhere still matching the old `Result<_, String>`
    /// shape, or logging).
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::Missing(message) | Self::Other(message) => message,
        }
    }
}

impl std::fmt::Display for DatabaseKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(message) | Self::Other(message) => f.write_str(message),
        }
    }
}

/// Load the durable desktop database key, or create it only when the existing
/// database is not already encrypted. Replacing a missing key for an
/// encrypted database would permanently orphan the vault.
pub(crate) fn load_or_create_database_encryption_key(
    path: &Path,
    database_path: &Path,
) -> Result<String, DatabaseKeyError> {
    let mut store = SystemKeyring::new(DATABASE_ENCRYPTION_KEYRING_USERNAME);
    load_or_create_database_encryption_key_with_store(path, database_path, &mut store)
}

/// Replace the durable database encryption key in the OS keychain (with the
/// same 0600 app-data-file fallback every other credential in this module
/// uses), after a recovery code has been verified to actually open the vault.
/// Mirrors `save_owner_credential`'s shape exactly.
pub(crate) fn save_database_encryption_key(
    app: &AppHandle,
    credential: &str,
) -> Result<(), String> {
    let path = database_encryption_key_path(app)?;
    let mut store = SystemKeyring::new(DATABASE_ENCRYPTION_KEYRING_USERNAME);
    save_database_encryption_key_with_store(&path, &mut store, credential)
}

/// Replace the durable instance credential key after a v2 recovery kit has
/// been verified against the database key in the same kit.
pub(crate) fn save_credential_encryption_key(
    app: &AppHandle,
    credential: &str,
) -> Result<(), String> {
    let path = credential_encryption_key_path(app)?;
    let mut store = SystemKeyring::new(CREDENTIAL_ENCRYPTION_KEYRING_USERNAME);
    save_credential_encryption_key_with_store(&path, &mut store, credential)
}

pub(crate) fn generate_recovered_v1_credential_encryption_key() -> Result<String, String> {
    let mut bytes = [0u8; GENERATED_SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        format!("Failed to generate recovered credential encryption key: {error}")
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Load the durable instance credential key, or create it only when no sealed
/// connector credential would be orphaned by doing so.
pub(crate) fn load_or_create_credential_encryption_key(
    path: &Path,
    database_path: &Path,
) -> Result<String, String> {
    let mut store = SystemKeyring::new(CREDENTIAL_ENCRYPTION_KEYRING_USERNAME);
    load_or_create_secret_with_store(
        path,
        &mut store,
        "Credential encryption key",
        || database_contains_sealed_credentials(database_path),
        Some("Credential encryption key is missing while sealed connector credentials exist. Restore the key from the OS keychain or the credential-encryption-key app-data file; refusing to mint a replacement that would orphan those credentials."),
    )
}

/// Replace the owner password in the OS keychain, with the protected app-data
/// file as the same headless fallback used by initial credential creation.
pub(crate) fn save_owner_credential(app: &AppHandle, credential: &str) -> Result<(), String> {
    let path = owner_credential_path(app)?;
    let mut store = SystemKeyring::owner();
    save_owner_credential_with_store(&path, &mut store, credential)
}

pub(crate) fn owner_password_owner_set_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(OWNER_PASSWORD_OWNER_SET_MARKER_FILE)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

pub(crate) fn owner_password_owner_set_marker_exists(app: &AppHandle) -> Result<bool, String> {
    Ok(owner_password_owner_set_marker_path(app)?.exists())
}

pub(crate) fn mark_owner_password_owner_set(app: &AppHandle) -> Result<(), String> {
    let path = owner_password_owner_set_marker_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create owner password marker directory: {error}")
        })?;
    }
    let marker = serde_json::json!({
        "source": "desktop-owner-set",
        "version": 1,
    });
    crate::atomic_write::write_json_atomically(
        &path,
        &marker,
        "Failed to write owner password marker",
    )
}

fn owner_password_request_file_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(file_name)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

fn owner_password_window_request_path(app: &AppHandle) -> Result<PathBuf, String> {
    owner_password_request_file_path(app, OWNER_PASSWORD_WINDOW_REQUEST_FILE)
}

fn owner_password_recovery_window_request_path(app: &AppHandle) -> Result<PathBuf, String> {
    owner_password_request_file_path(app, OWNER_PASSWORD_RECOVERY_WINDOW_REQUEST_FILE)
}

fn owner_password_stack_restart_request_path(app: &AppHandle) -> Result<PathBuf, String> {
    owner_password_request_file_path(app, OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE)
}

fn owner_os_reauth_request_path(app: &AppHandle) -> Result<PathBuf, String> {
    owner_password_request_file_path(app, OWNER_OS_REAUTH_REQUEST_FILE)
}

fn owner_password_window_request_file_path(
    app: &AppHandle,
    request_id: u64,
) -> Result<PathBuf, String> {
    owner_password_request_file_path(
        app,
        &format!("{OWNER_PASSWORD_WINDOW_REQUEST_PREFIX}{request_id}.json"),
    )
}

fn owner_os_reauth_request_file_path(app: &AppHandle, request_id: u64) -> Result<PathBuf, String> {
    owner_password_request_file_path(
        app,
        &format!("{OWNER_OS_REAUTH_REQUEST_PREFIX}{request_id}.json"),
    )
}

fn owner_os_reauth_result_path(app: &AppHandle, request_id: u64) -> Result<PathBuf, String> {
    owner_password_request_file_path(
        app,
        &format!("{OWNER_OS_REAUTH_RESULT_PREFIX}{request_id}.json"),
    )
}

fn request_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(crate::unified::UNIFIED_DB_DIRECTORY))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

fn request_ids_with_prefix(app: &AppHandle, prefix: &str) -> Result<Vec<u64>, String> {
    let dir = request_directory(app)?;
    let mut ids = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(error) => return Err(format!("Failed to read owner request directory: {error}")),
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(raw) = name
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(".json"))
        else {
            continue;
        };
        if let Ok(id) = raw.parse::<u64>() {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

fn load_owner_password_request_state(
    path: &Path,
    label: &str,
) -> Result<OwnerPasswordRequestState, String> {
    if !path.exists() {
        return Ok(OwnerPasswordRequestState::default());
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))?;
    if content.trim().is_empty() {
        return Ok(OwnerPasswordRequestState::default());
    }
    serde_json::from_str(&content).map_err(|error| format!("Failed to parse {label}: {error}"))
}

fn save_owner_password_request_state(
    path: &Path,
    state: &OwnerPasswordRequestState,
    label: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {label} directory: {error}"))?;
    }
    crate::atomic_write::write_json_atomically(path, state, &format!("Failed to write {label}"))
}

fn unix_time_ms_now() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System time is before the Unix epoch: {error}"))?;
    Ok(duration.as_millis().try_into().unwrap_or(u64::MAX))
}

fn pending_owner_password_request_id(
    state: &OwnerPasswordRequestState,
    last_seen_request_id: u64,
    now_unix_ms: u64,
) -> Option<u64> {
    let completed_request_id = state.completed_request_id.unwrap_or(0);
    (state.request_id > completed_request_id
        && state.request_id != last_seen_request_id
        && state
            .not_before_unix_ms
            .map_or(true, |not_before| now_unix_ms >= not_before))
    .then_some(state.request_id)
}

fn incomplete_owner_password_request_id(state: &OwnerPasswordRequestState) -> Option<u64> {
    let completed_request_id = state.completed_request_id.unwrap_or(0);
    (state.request_id > completed_request_id).then_some(state.request_id)
}

fn complete_owner_password_request_at(
    path: &Path,
    label: &str,
    request_id: u64,
) -> Result<(), String> {
    if request_id == 0 {
        return Ok(());
    }
    let mut state = load_owner_password_request_state(path, label)?;
    let completed_request_id = state.completed_request_id.unwrap_or(0);
    if request_id <= completed_request_id {
        return Ok(());
    }
    state.completed_request_id = Some(request_id);
    save_owner_password_request_state(path, &state, label)
}

fn owner_os_reauth_result_exists(app: &AppHandle, request_id: u64) -> Result<bool, String> {
    Ok(owner_os_reauth_result_path(app, request_id)?.exists())
}

fn complete_owner_os_reauth_request_at(
    app: &AppHandle,
    request_id: u64,
    result: Result<&'static str, String>,
) -> Result<(), String> {
    if owner_os_reauth_result_exists(app, request_id)? {
        return Ok(());
    }
    let request_path = owner_os_reauth_request_file_path(app, request_id)?;
    let path = owner_os_reauth_result_path(app, request_id)?;
    let mut state = load_owner_password_request_state(&request_path, "owner OS re-auth request")?;
    if state.completed_request_id.unwrap_or(0) >= request_id {
        return Ok(());
    }
    state.request_id = request_id;
    state.completed_request_id = Some(request_id);
    match result {
        Ok(status) => {
            state.status = Some(status.to_string());
            state.error = None;
            if status == "authenticated" {
                let expires_unix_ms = unix_time_ms_now()?.saturating_add(
                    OWNER_OS_REAUTH_GRANT_TTL
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                );
                let grant_id = uuid::Uuid::new_v4().to_string();
                state.grant_id = Some(grant_id.clone());
                owner_reauth_grants()
                    .lock()
                    .map_err(|_| "Owner re-auth grant registry is unavailable.".to_string())?
                    .insert(
                        grant_id,
                        OwnerReauthGrant {
                            expires_unix_ms,
                            purpose: "change".to_string(),
                            reauth_request_id: request_id,
                            window_request_id: None,
                        },
                    );
            }
        }
        Err(error) => {
            let status = if error.contains("timed out") {
                "timed_out"
            } else if error.contains("OS re-auth failed") {
                "canceled"
            } else {
                "failed"
            };
            state.status = Some(status.to_string());
            state.error = Some(error);
        }
    }
    save_owner_password_request_state(&request_path, &state, "owner OS re-auth request")?;
    save_owner_password_request_state(&path, &state, "owner OS re-auth result")
}

fn current_owner_password_window_request_id(app: &AppHandle) -> Result<Option<u64>, String> {
    let recovery_path = owner_password_recovery_window_request_path(app)?;
    let recovery_state =
        load_owner_password_request_state(&recovery_path, "owner-password recovery request")?;
    if let Some(request_id) = incomplete_owner_password_request_id(&recovery_state) {
        return Ok(Some(request_id));
    }
    let path = owner_password_window_request_path(app)?;
    let state = load_owner_password_request_state(&path, "owner-password window request")?;
    Ok(incomplete_owner_password_request_id(&state))
}

fn current_owner_password_window_request_state(
    app: &AppHandle,
    request_id: u64,
) -> Result<OwnerPasswordRequestState, String> {
    let recovery_path = owner_password_recovery_window_request_path(app)?;
    let recovery_state =
        load_owner_password_request_state(&recovery_path, "owner-password recovery request")?;
    if recovery_state.request_id == request_id
        && recovery_state.completed_request_id.unwrap_or(0) < request_id
    {
        return Ok(recovery_state);
    }
    let path = owner_password_window_request_file_path(app, request_id)?;
    let state = load_owner_password_request_state(&path, "owner-password window request")?;
    if state.request_id == request_id {
        return Ok(state);
    }
    let index_path = owner_password_window_request_path(app)?;
    load_owner_password_request_state(&index_path, "owner-password window request")
}

fn consume_owner_password_window_authority(
    app: &AppHandle,
    request_id: Option<u64>,
) -> Result<(), String> {
    let request_id = request_id
        .ok_or_else(|| "Open the password window from Settings before saving.".to_string())?;
    let recovery_path = owner_password_recovery_window_request_path(app)?;
    let recovery_state =
        load_owner_password_request_state(&recovery_path, "owner-password recovery request")?;
    let is_recovery_request = recovery_state.request_id == request_id
        && recovery_state.completed_request_id.unwrap_or(0) < request_id;
    let mut state = if is_recovery_request {
        recovery_state
    } else {
        current_owner_password_window_request_state(app, request_id)?
    };
    if state.request_id != request_id || state.completed_request_id.unwrap_or(0) >= request_id {
        return Err("This password window request is no longer active.".to_string());
    }
    match state.purpose.as_deref() {
        Some("initial_setup") => {
            if owner_password_owner_set_marker_exists(app)? {
                return Err("Use Settings to change the existing owner password.".to_string());
            }
        }
        Some("recovery") => {}
        Some("change") => {
            let grant_id = state.grant_id.clone().ok_or_else(|| {
                "Confirm in Settings before saving the owner password.".to_string()
            })?;
            let now = unix_time_ms_now()?;
            let grant = owner_reauth_grants()
                .lock()
                .map_err(|_| "Owner re-auth grant registry is unavailable.".to_string())?
                .remove(&grant_id);
            if grant.is_none_or(|grant| {
                grant.expires_unix_ms <= now
                    || grant.purpose != "change"
                    || grant.window_request_id != Some(request_id)
            }) || state.grant_consumed_request_id.is_some()
            {
                return Err("Confirm in Settings before saving the owner password.".to_string());
            }
            state.grant_consumed_request_id = Some(request_id);
        }
        _ => {
            return Err("This password window request is missing a supported purpose.".to_string())
        }
    }
    if is_recovery_request {
        save_owner_password_request_state(&recovery_path, &state, "owner-password recovery request")
    } else {
        let request_path = owner_password_window_request_file_path(app, request_id)?;
        save_owner_password_request_state(&request_path, &state, "owner-password window request")
    }
}

fn complete_owner_password_window_request(
    app: &AppHandle,
    request_id: Option<u64>,
) -> Result<(), String> {
    if let Some(request_id) = request_id {
        let recovery_path = owner_password_recovery_window_request_path(app)?;
        let recovery_state =
            load_owner_password_request_state(&recovery_path, "owner-password recovery request")?;
        if recovery_state.request_id == request_id {
            complete_owner_password_request_at(
                &recovery_path,
                "owner-password recovery request",
                request_id,
            )?;
            return Ok(());
        }
        let request_path = owner_password_window_request_file_path(app, request_id)?;
        complete_owner_password_request_at(
            &request_path,
            "owner-password window request",
            request_id,
        )?;
    }
    Ok(())
}

pub(crate) fn capture_pending_owner_password_stack_restart_request_id(
    app: &AppHandle,
) -> Result<Option<u64>, String> {
    let path = owner_password_stack_restart_request_path(app)?;
    let state = load_owner_password_request_state(&path, "owner-password stack-restart request")?;
    Ok(incomplete_owner_password_request_id(&state))
}

pub(crate) fn request_owner_password_window_for_recovery(app: &AppHandle) -> Result<(), String> {
    let path = owner_password_recovery_window_request_path(app)?;
    let previous = load_owner_password_request_state(&path, "owner-password recovery request")?;
    let next_request_id = unix_time_ms_now()?
        .max(previous.request_id)
        .max(previous.completed_request_id.unwrap_or(0))
        .saturating_add(1);
    let state = OwnerPasswordRequestState {
        request_id: next_request_id,
        purpose: Some("recovery".to_string()),
        ..OwnerPasswordRequestState::default()
    };
    save_owner_password_request_state(&path, &state, "owner-password recovery request")
}

pub(crate) fn complete_owner_password_stack_restart_request(
    app: &AppHandle,
    request_id: Option<u64>,
) -> Result<(), String> {
    if let Some(request_id) = request_id {
        let path = owner_password_stack_restart_request_path(app)?;
        complete_owner_password_request_at(
            &path,
            "owner-password stack-restart request",
            request_id,
        )?;
    }
    Ok(())
}

fn queue_delayed_owner_password_stack_restart_request(app: &AppHandle) -> Result<(), String> {
    let path = owner_password_stack_restart_request_path(app)?;
    let mut state =
        load_owner_password_request_state(&path, "owner-password stack-restart request")?;
    let next_request_id = state
        .request_id
        .max(state.completed_request_id.unwrap_or(0))
        .saturating_add(1)
        .max(1);
    state.request_id = next_request_id;
    state.not_before_unix_ms = Some(unix_time_ms_now()?.saturating_add(180_000));
    save_owner_password_request_state(&path, &state, "owner-password stack-restart request")
}

pub(crate) fn spawn_owner_password_window_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(OWNER_PASSWORD_WINDOW_WATCHER_POLL_INTERVAL).await;
            let now_unix_ms = match unix_time_ms_now() {
                Ok(now) => now,
                Err(error) => {
                    log::warn!("Owner password window watcher could not read system time: {error}");
                    continue;
                }
            };
            let request_ids =
                match request_ids_with_prefix(&app, OWNER_PASSWORD_WINDOW_REQUEST_PREFIX) {
                    Ok(ids) => ids,
                    Err(error) => {
                        log::warn!(
                            "Owner password window watcher could not list requests: {error}"
                        );
                        continue;
                    }
                };
            for request_id in request_ids {
                let path = match owner_password_window_request_file_path(&app, request_id) {
                    Ok(path) => path,
                    Err(error) => {
                        log::warn!(
                            "Owner password window watcher could not resolve request path: {error}"
                        );
                        continue;
                    }
                };
                let mut state =
                    match load_owner_password_request_state(&path, "owner-password window request")
                    {
                        Ok(state) => state,
                        Err(error) => {
                            log::warn!(
                            "Owner password window watcher could not read request file: {error}"
                        );
                            continue;
                        }
                    };
                if state.request_id != request_id
                    || state.completed_request_id.unwrap_or(0) >= request_id
                    || state.status.as_deref() == Some("opened")
                    || state
                        .not_before_unix_ms
                        .map_or(false, |not_before| now_unix_ms < not_before)
                {
                    continue;
                }
                if state.purpose.as_deref() == Some("change") {
                    let Some(grant_id) = state.grant_id.clone() else {
                        log::warn!("Owner password change request missing re-auth grant id");
                        state.completed_request_id = Some(request_id);
                        let _ = save_owner_password_request_state(
                            &path,
                            &state,
                            "owner-password window request",
                        );
                        continue;
                    };
                    let result = owner_reauth_grants()
                        .lock()
                        .map_err(|_| "Owner re-auth grant registry is unavailable.".to_string())
                        .and_then(|mut grants| {
                            let grant = grants
                                .get_mut(&grant_id)
                                .ok_or_else(|| "Owner password window request has no live re-auth grant.".to_string())?;
                            if grant.expires_unix_ms <= now_unix_ms
                                || grant.purpose != "change"
                                || state.grant_for_request_id != Some(grant.reauth_request_id)
                            {
                                return Err("Owner password window request re-auth grant is invalid or expired.".to_string());
                            }
                            grant.window_request_id = Some(request_id);
                            Ok(())
                        });
                    if let Err(error) = result {
                        log::warn!("{error}");
                        state.completed_request_id = Some(request_id);
                        let _ = save_owner_password_request_state(
                            &path,
                            &state,
                            "owner-password window request",
                        );
                        continue;
                    }
                } else if state.purpose.as_deref() == Some("initial_setup") {
                    match owner_password_owner_set_marker_exists(&app) {
                        Ok(false) => {}
                        Ok(true) => {
                            log::warn!("Owner password initial setup request refused: marker already exists");
                            state.completed_request_id = Some(request_id);
                            let _ = save_owner_password_request_state(
                                &path,
                                &state,
                                "owner-password window request",
                            );
                            continue;
                        }
                        Err(error) => {
                            log::warn!(
                                "Owner password window watcher could not read marker: {error}"
                            );
                            continue;
                        }
                    }
                } else {
                    log::warn!("Owner password window request missing supported purpose");
                    state.completed_request_id = Some(request_id);
                    let _ = save_owner_password_request_state(
                        &path,
                        &state,
                        "owner-password window request",
                    );
                    continue;
                }
                state.status = Some("opened".to_string());
                let _ = save_owner_password_request_state(
                    &path,
                    &state,
                    "owner-password window request",
                );
                open_owner_password_window(&app);
            }
            let recovery_path = match owner_password_recovery_window_request_path(&app) {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "Owner password watcher could not resolve recovery request path: {error}"
                    );
                    continue;
                }
            };
            let mut recovery_state = match load_owner_password_request_state(
                &recovery_path,
                "owner-password recovery request",
            ) {
                Ok(state) => state,
                Err(error) => {
                    log::warn!("Owner password watcher could not read recovery request: {error}");
                    continue;
                }
            };
            let request_id = recovery_state.request_id;
            if recovery_state.purpose.as_deref() == Some("recovery")
                && recovery_state.completed_request_id.unwrap_or(0) < request_id
                && recovery_state.status.as_deref() != Some("opened")
            {
                recovery_state.status = Some("opened".to_string());
                let _ = save_owner_password_request_state(
                    &recovery_path,
                    &recovery_state,
                    "owner-password recovery request",
                );
                open_owner_password_window(&app);
            }
        }
    });
}

pub(crate) fn spawn_owner_password_stack_restart_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_seen_request_id = 0_u64;
        loop {
            tokio::time::sleep(OWNER_PASSWORD_WINDOW_WATCHER_POLL_INTERVAL).await;
            if crate::unified::shutdown_has_been_requested(&app) {
                log::debug!("Owner password stack-restart watcher stopping: shutdown requested");
                return;
            }
            let path = match owner_password_stack_restart_request_path(&app) {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "Owner password stack-restart watcher could not resolve request path: {error}"
                    );
                    continue;
                }
            };
            let state = match load_owner_password_request_state(
                &path,
                "owner-password stack-restart request",
            ) {
                Ok(state) => state,
                Err(error) => {
                    log::warn!(
                        "Owner password stack-restart watcher could not read request file: {error}"
                    );
                    continue;
                }
            };
            let now_unix_ms = match unix_time_ms_now() {
                Ok(now) => now,
                Err(error) => {
                    log::warn!(
                        "Owner password stack-restart watcher could not read system time: {error}"
                    );
                    continue;
                }
            };
            let Some(request_id) =
                pending_owner_password_request_id(&state, last_seen_request_id, now_unix_ms)
            else {
                continue;
            };
            match crate::unified::restart_after_remote_access_config(app.clone()).await {
                Ok(()) => {
                    last_seen_request_id = request_id;
                    if let Err(error) = complete_owner_password_request_at(
                        &path,
                        "owner-password stack-restart request",
                        request_id,
                    ) {
                        log::warn!(
                            "Owner password stack-restart watcher could not record completion: {error}"
                        );
                    }
                }
                Err(error) => {
                    log::warn!("Owner password stack-restart request failed: {error}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

pub(crate) fn spawn_owner_os_reauth_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(OWNER_PASSWORD_WINDOW_WATCHER_POLL_INTERVAL).await;
            if crate::unified::shutdown_has_been_requested(&app) {
                log::debug!("Owner OS re-auth watcher stopping: shutdown requested");
                return;
            }
            let now_unix_ms = match unix_time_ms_now() {
                Ok(now) => now,
                Err(error) => {
                    log::warn!("Owner OS re-auth watcher could not read system time: {error}");
                    continue;
                }
            };
            let request_ids = match request_ids_with_prefix(&app, OWNER_OS_REAUTH_REQUEST_PREFIX) {
                Ok(ids) => ids,
                Err(error) => {
                    log::warn!("Owner OS re-auth watcher could not list requests: {error}");
                    continue;
                }
            };
            for request_id in request_ids {
                if owner_os_reauth_result_exists(&app, request_id).unwrap_or(false) {
                    continue;
                }
                let path = match owner_os_reauth_request_file_path(&app, request_id) {
                    Ok(path) => path,
                    Err(error) => {
                        log::warn!(
                            "Owner OS re-auth watcher could not resolve request path: {error}"
                        );
                        continue;
                    }
                };
                let state =
                    match load_owner_password_request_state(&path, "owner OS re-auth request") {
                        Ok(state) => state,
                        Err(error) => {
                            log::warn!(
                                "Owner OS re-auth watcher could not read request file: {error}"
                            );
                            continue;
                        }
                    };
                if state.request_id != request_id
                    || state.completed_request_id.unwrap_or(0) >= request_id
                {
                    continue;
                }
                let fresh_now_unix_ms = match unix_time_ms_now() {
                    Ok(now) => now,
                    Err(error) => {
                        log::warn!(
                            "Owner OS re-auth watcher could not refresh system time: {error}"
                        );
                        continue;
                    }
                };
                if state
                    .deadline_unix_ms
                    .is_some_and(|deadline| fresh_now_unix_ms >= deadline)
                {
                    if let Err(error) = complete_owner_os_reauth_request_at(
                        &app,
                        request_id,
                        Err("OS re-authentication timed out.".to_string()),
                    ) {
                        log::warn!("Owner OS re-auth watcher could not record timeout: {error}");
                    }
                    continue;
                }
                let deadline_unix_ms = state.deadline_unix_ms.unwrap_or(
                    fresh_now_unix_ms.saturating_add(
                        OWNER_OS_REAUTH_GRANT_TTL
                            .as_millis()
                            .try_into()
                            .unwrap_or(u64::MAX),
                    ),
                );
                let result = owner_os_reauthenticate(deadline_unix_ms).await;
                if let Err(error) = complete_owner_os_reauth_request_at(&app, request_id, result) {
                    log::warn!("Owner OS re-auth watcher could not record completion: {error}");
                }
            }
        }
    });
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn owner_os_reauthenticate(deadline_unix_ms: u64) -> Result<&'static str, String> {
    use robius_authentication::{
        AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText,
    };
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    let policy = PolicyBuilder::new()
        .biometrics(Some(BiometricStrength::Strong))
        .password(true)
        .build()
        .ok_or_else(|| "Could not build OS re-auth policy.".to_string())?;
    let text = Text {
        android: AndroidText {
            title: "DataConnect",
            subtitle: None,
            description: Some("Confirm before changing or revealing the owner password."),
        },
        apple: "change or reveal the DataConnect owner password",
        windows: WindowsText::new(
            "DataConnect",
            "Confirm before changing or revealing the owner password.",
        )
        .ok_or_else(|| "Could not build OS re-auth prompt text.".to_string())?,
    };
    let (tx, rx) = oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    Context::new(())
        .authenticate(text, &policy, {
            let tx = Arc::clone(&tx);
            move |result| {
                if let Ok(mut sender) = tx.lock() {
                    if let Some(tx) = sender.take() {
                        let _ = tx.send(result);
                    }
                }
            }
        })
        .map_err(|error| format!("Could not start OS re-auth prompt: {error:?}"))?;
    let now = unix_time_ms_now()?;
    let remaining = Duration::from_millis(deadline_unix_ms.saturating_sub(now));
    tokio::time::timeout(remaining, rx)
        .await
        .map_err(|_| "OS re-authentication timed out.".to_string())?
        .map_err(|_| "OS re-authentication result channel closed.".to_string())?
        .map_err(|error| format!("OS re-auth failed: {error:?}"))?;
    Ok("authenticated")
}

#[cfg(target_os = "linux")]
async fn owner_os_reauthenticate(_deadline_unix_ms: u64) -> Result<&'static str, String> {
    Ok("skipped_linux_polkit_unverified")
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn owner_os_reauthenticate(_deadline_unix_ms: u64) -> Result<&'static str, String> {
    Err("OS re-auth is unavailable on this platform.".to_string())
}

fn open_owner_password_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OWNER_PASSWORD_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        OWNER_PASSWORD_WINDOW_LABEL,
        WebviewUrl::App("owner-password.html".into()),
    )
    .title("DataConnect - Set owner password")
    .inner_size(520.0, 420.0)
    .min_inner_size(460.0, 360.0)
    .center()
    .resizable(true)
    .build();
    match result {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => log::error!("Failed to open the DataConnect owner-password window: {error}"),
    }
}

#[tauri::command]
pub(crate) async fn set_desktop_owner_password(
    app: AppHandle,
    password: String,
) -> Result<(), String> {
    let window_request_id = current_owner_password_window_request_id(&app)?;
    if configured_owner_password().is_some() {
        return Err(
            "This password is set by the environment. Change PDPP_OWNER_PASSWORD and restart DataConnect."
                .to_string(),
        );
    }
    if password.chars().count() < OWNER_PASSWORD_MIN_LENGTH {
        return Err(format!(
            "Owner passwords must be at least {OWNER_PASSWORD_MIN_LENGTH} characters long."
        ));
    }
    consume_owner_password_window_authority(&app, window_request_id)?;
    save_owner_credential(&app, &password)?;
    mark_owner_password_owner_set(&app)?;
    queue_delayed_owner_password_stack_restart_request(&app)?;
    complete_owner_password_window_request(&app, window_request_id)?;
    if let Some(window) = app.get_webview_window(OWNER_PASSWORD_WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

/// True once this device has an owner credential -- always true once the
/// unified stack has booted at least once, since boot mints one when absent
/// (`load_or_create_owner_credential`). Reading this must never itself create
/// a credential: a status check is not a boot path.
pub(crate) fn owner_credential_exists(app: &AppHandle) -> Result<bool, String> {
    let path = owner_credential_path(app)?;
    let mut store = SystemKeyring::owner();
    owner_credential_exists_with_store(&path, &mut store)
}

/// Constant-time check of a submitted password against the one owner
/// credential on this device (the same value `load_bootstrap_secrets` used to
/// start the managed stack). Never mints a credential as a side effect --
/// callers that need one to already exist should check
/// `owner_credential_exists` first.
pub(crate) fn verify_owner_credential(app: &AppHandle, submitted: &str) -> Result<bool, String> {
    let path = owner_credential_path(app)?;
    let mut store = SystemKeyring::owner();
    verify_owner_credential_with_store(&path, &mut store, submitted)
}

fn owner_credential_exists_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
) -> Result<bool, String> {
    if matches!(store.load(), Ok(Some(value)) if !value.trim().is_empty()) {
        return Ok(true);
    }
    Ok(path.exists())
}

fn verify_owner_credential_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
    submitted: &str,
) -> Result<bool, String> {
    let stored = match store.load() {
        Ok(Some(value)) if !value.trim().is_empty() => value,
        _ => read_secret(path, "Owner credential")?,
    };
    let expected = configured_owner_password().unwrap_or(stored);
    Ok(constant_time_eq(expected.as_bytes(), submitted.as_bytes()))
}

/// Compares two byte strings in time independent of where they first differ,
/// so a mismatched owner password cannot be timed to learn how many leading
/// characters were correct.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Load the opaque provider credential reference for a native remote-access provider.
pub(crate) fn load_provider_credential_reference(
    provider_id: &str,
) -> Result<Option<String>, String> {
    let mut store = SystemKeyring::provider_credential_reference(provider_id)?;
    load_provider_credential_reference_with_store(&mut store)
}

/// Store the opaque provider credential reference for a native remote-access provider.
pub(crate) fn store_provider_credential_reference(
    provider_id: &str,
    credential_reference: &str,
) -> Result<(), String> {
    let mut store = SystemKeyring::provider_credential_reference(provider_id)?;
    store_provider_credential_reference_with_store(&mut store, credential_reference)
}

fn load_provider_credential_reference_with_store(
    store: &mut impl CredentialStore,
) -> Result<Option<String>, String> {
    Ok(store
        .load()?
        .map(|reference| reference.trim().to_string())
        .filter(|reference| !reference.is_empty()))
}

fn store_provider_credential_reference_with_store(
    store: &mut impl CredentialStore,
    credential_reference: &str,
) -> Result<(), String> {
    let credential_reference = credential_reference.trim();
    if credential_reference.is_empty() {
        return Err("Provider credential reference cannot be empty".to_string());
    }
    store.save(credential_reference)
}

fn validated_provider_id(provider_id: &str) -> Result<&str, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider id cannot be empty".to_string());
    }
    if !provider_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "Provider id must contain only ASCII letters, digits, dots, dashes, or underscores"
                .to_string(),
        );
    }
    Ok(provider_id)
}

fn load_or_create_owner_credential_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
) -> Result<String, String> {
    load_or_create_secret_with_store(path, store, "Owner credential", || Ok(false), None)
}

const DATABASE_KEY_MISSING_MESSAGE: &str = "Database encryption key is missing while an encrypted SQLite vault exists. Restore the key from the OS keychain or the database-encryption-key app-data file; refusing to mint a replacement that would orphan the vault.";

fn load_or_create_database_encryption_key_with_store(
    path: &Path,
    database_path: &Path,
    store: &mut impl CredentialStore,
) -> Result<String, DatabaseKeyError> {
    load_or_create_secret_with_store(
        path,
        store,
        "Database encryption key",
        || database_is_encrypted(database_path),
        Some(DATABASE_KEY_MISSING_MESSAGE),
    )
    .map_err(|message| {
        if message == DATABASE_KEY_MISSING_MESSAGE {
            DatabaseKeyError::Missing(message)
        } else {
            DatabaseKeyError::Other(message)
        }
    })
}

fn save_database_encryption_key_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
    credential: &str,
) -> Result<(), String> {
    if credential.trim().is_empty() {
        return Err("Database encryption key cannot be empty".to_string());
    }

    if store.save(credential).is_ok() {
        if path.exists() {
            write_owner_credential_file(path, credential)?;
        }
        return Ok(());
    }

    write_owner_credential_file(path, credential)
}

fn save_credential_encryption_key_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
    credential: &str,
) -> Result<(), String> {
    if credential.trim().is_empty() {
        return Err("Credential encryption key cannot be empty".to_string());
    }

    if store.save(credential).is_ok() {
        if path.exists() {
            write_owner_credential_file(path, credential)?;
        }
        return Ok(());
    }

    write_owner_credential_file(path, credential)
}

fn load_or_create_secret_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
    label: &str,
    missing_secret_check: impl FnOnce() -> Result<bool, String>,
    missing_secret_message: Option<&str>,
) -> Result<String, String> {
    log::info!("{label}: load_or_create entry");
    let started = Instant::now();
    let result = load_or_create_secret_with_store_inner(
        path,
        store,
        label,
        missing_secret_check,
        missing_secret_message,
    );
    log::info!(
        "{label}: load_or_create exit duration_ms={} ok={}",
        started.elapsed().as_millis(),
        result.is_ok()
    );
    result
}

fn load_or_create_secret_with_store_inner(
    path: &Path,
    store: &mut impl CredentialStore,
    label: &str,
    missing_secret_check: impl FnOnce() -> Result<bool, String>,
    missing_secret_message: Option<&str>,
) -> Result<String, String> {
    let keyring_error = match store.load() {
        Ok(Some(credential)) if !credential.trim().is_empty() => {
            log::info!("{label} store: OS keychain");
            return Ok(credential);
        }
        Ok(Some(_)) => Some("OS keychain returned an empty credential".to_string()),
        Ok(None) => None,
        Err(error) => Some(error),
    };

    if path.exists() {
        let credential = read_secret(path, label)?;
        if keyring_error.is_none() && store.save(&credential).is_ok() {
            log::info!("{label} store: OS keychain");
            return Ok(credential);
        }
        log_fallback_store(label, keyring_error.as_deref());
        return Ok(credential);
    }

    if missing_secret_check()? {
        if let Some(message) = missing_secret_message {
            return Err(message.to_string());
        }
    }

    let mut bytes = [0u8; GENERATED_SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| format!("Failed to generate {label}: {error}"))?;
    let credential = URL_SAFE_NO_PAD.encode(bytes);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {label} directory: {error}"))?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    if keyring_error.is_none() && store.save(&credential).is_ok() {
        log::info!("{label} store: OS keychain");
        return Ok(credential);
    }

    log_fallback_store(label, keyring_error.as_deref());
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(credential.as_bytes())
                .map_err(|error| format!("Failed to write {label}: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Failed to persist {label}: {error}"))?;
            #[cfg(unix)]
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Failed to protect {label}: {error}"))?;
            Ok(credential)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_secret(path, label),
        Err(error) => Err(format!("Failed to create {label}: {error}")),
    }
}

fn save_owner_credential_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
    credential: &str,
) -> Result<(), String> {
    if credential.trim().is_empty() {
        return Err("Owner credential cannot be empty".to_string());
    }

    if store.save(credential).is_ok() {
        // Keep an existing fallback synchronized so a later keychain outage
        // cannot silently revert to an old owner password.
        if path.exists() {
            write_owner_credential_file(path, credential)?;
        }
        return Ok(());
    }

    write_owner_credential_file(path, credential)
}

fn write_owner_credential_file(path: &Path, credential: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create owner credential directory: {error}"))?;
    }
    fs::write(path, credential)
        .map_err(|error| format!("Failed to write owner credential: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect owner credential: {error}"))?;
    Ok(())
}

fn log_fallback_store(label: &str, keyring_error: Option<&str>) {
    match keyring_error {
        Some(error) => {
            log::warn!("{label} store: 0600 app-data fallback; OS keychain unavailable ({error})")
        }
        None => {
            log::warn!("{label} store: 0600 app-data fallback; OS keychain write failed")
        }
    }
}

fn read_secret(path: &Path, label: &str) -> Result<String, String> {
    let credential =
        fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))?;
    if credential.trim().is_empty() {
        return Err(format!("{label} file is empty"));
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect {label}: {error}"))?;
    Ok(credential)
}

pub(crate) fn database_is_encrypted(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if fs::metadata(path)
        .map_err(|error| format!("Could not inspect the database file: {error}"))?
        .len()
        == 0
    {
        return Ok(false);
    }

    let mut file = fs::File::open(path)
        .map_err(|error| format!("Could not inspect the database header: {error}"))?;
    let mut header = [0u8; 16];
    let bytes_read = file
        .read(&mut header)
        .map_err(|error| format!("Could not inspect the database header: {error}"))?;
    Ok(bytes_read != header.len() || &header != b"SQLite format 3\0")
}

fn database_contains_sealed_credentials(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if database_is_encrypted(path)? {
        // rusqlite cannot inspect a ciphered database. Treat an existing
        // encrypted vault as containing protected credentials until its
        // durable credential key is restored.
        return Ok(true);
    }

    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| {
        format!(
            "Could not inspect the unified database before creating the credential encryption key: {error}"
        )
    })?;
    let table_exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connector_instance_credentials')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect credential storage metadata: {error}"))?;
    if !table_exists {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM connector_instance_credentials LIMIT 1)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect sealed credential records: {error}"))
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[derive(Default)]
    struct MockKeyring {
        value: Option<String>,
        available: bool,
    }

    impl CredentialStore for MockKeyring {
        fn load(&mut self) -> Result<Option<String>, String> {
            if self.available {
                Ok(self.value.clone())
            } else {
                Err("mock keyring unavailable".to_string())
            }
        }

        fn save(&mut self, credential: &str) -> Result<(), String> {
            if !self.available {
                return Err("mock keyring unavailable".to_string());
            }
            self.value = Some(credential.to_string());
            Ok(())
        }
    }

    #[test]
    fn read_secret_preserves_non_whitespace_fallback_bytes() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let expected = "  owner password with surrounding whitespace  \n";
        fs::write(&path, expected).expect("fallback credential file");

        let credential = read_secret(&path, "Owner credential").expect("credential");

        assert_eq!(credential, expected);
    }

    #[test]
    fn read_secret_rejects_all_whitespace_fallback_file() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        fs::write(&path, "  \n\t  ").expect("fallback credential file");

        let error = read_secret(&path, "Owner credential").expect_err("empty credential");

        assert!(error.contains("Owner credential file is empty"));
    }

    #[test]
    fn completed_owner_password_request_does_not_replay() {
        let state = OwnerPasswordRequestState {
            request_id: 42,
            completed_request_id: Some(42),
            not_before_unix_ms: None,
            ..Default::default()
        };

        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), None);
    }

    #[test]
    fn incomplete_owner_password_request_replays_after_restart() {
        let state = OwnerPasswordRequestState {
            request_id: 42,
            completed_request_id: None,
            not_before_unix_ms: None,
            ..Default::default()
        };

        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), Some(42));
        assert_eq!(pending_owner_password_request_id(&state, 42, 1000), None);
    }

    #[test]
    fn completing_owner_password_request_persists_current_request_id() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-password-window-request.json");
        fs::write(&path, r#"{"requestId":7}"#).expect("request file");

        complete_owner_password_request_at(&path, "owner-password window request", 7)
            .expect("completed request");
        let state = load_owner_password_request_state(&path, "owner-password window request")
            .expect("request state");

        assert_eq!(state.request_id, 7);
        assert_eq!(state.completed_request_id, Some(7));
        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), None);
    }

    #[test]
    fn newer_owner_password_request_runs_after_completed_request() {
        let state = OwnerPasswordRequestState {
            request_id: 8,
            completed_request_id: Some(7),
            not_before_unix_ms: None,
            ..Default::default()
        };

        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), Some(8));
    }

    #[test]
    fn older_owner_password_request_does_not_run_after_completed_request() {
        let state = OwnerPasswordRequestState {
            request_id: 6,
            completed_request_id: Some(7),
            not_before_unix_ms: None,
            ..Default::default()
        };

        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), None);
    }

    #[test]
    fn owner_password_request_waits_until_not_before_time() {
        let state = OwnerPasswordRequestState {
            request_id: 9,
            completed_request_id: None,
            not_before_unix_ms: Some(2_000),
            ..Default::default()
        };

        assert_eq!(pending_owner_password_request_id(&state, 0, 1_999), None);
        assert_eq!(pending_owner_password_request_id(&state, 0, 2_000), Some(9));
    }

    #[test]
    fn delayed_restart_request_is_newer_than_completed_request() {
        let directory = tempdir().expect("temp directory");
        let path = directory
            .path()
            .join("owner-password-stack-restart-request.json");
        let state = OwnerPasswordRequestState {
            request_id: 2,
            completed_request_id: Some(5),
            not_before_unix_ms: None,
            ..Default::default()
        };
        save_owner_password_request_state(&path, &state, "owner-password stack-restart request")
            .expect("seed request");

        let mut state =
            load_owner_password_request_state(&path, "owner-password stack-restart request")
                .expect("request state");
        let next_request_id = state
            .request_id
            .max(state.completed_request_id.unwrap_or(0))
            .saturating_add(1)
            .max(1);
        state.request_id = next_request_id;
        state.not_before_unix_ms = Some(180_000);
        save_owner_password_request_state(&path, &state, "owner-password stack-restart request")
            .expect("delayed request");
        let state =
            load_owner_password_request_state(&path, "owner-password stack-restart request")
                .expect("request state");

        assert_eq!(state.request_id, 6);
        assert_eq!(
            pending_owner_password_request_id(&state, 0, 180_000),
            Some(6)
        );
    }

    #[test]
    fn exact_completion_does_not_complete_newer_request() {
        let directory = tempdir().expect("temp directory");
        let path = directory
            .path()
            .join("owner-password-stack-restart-request.json");
        fs::write(&path, r#"{"requestId":8}"#).expect("request file");

        complete_owner_password_request_at(&path, "owner-password stack-restart request", 7)
            .expect("completed request");
        let state =
            load_owner_password_request_state(&path, "owner-password stack-restart request")
                .expect("request state");

        assert_eq!(state.request_id, 8);
        assert_eq!(state.completed_request_id, Some(7));
        assert_eq!(pending_owner_password_request_id(&state, 0, 1000), Some(8));
    }

    #[test]
    fn owner_password_stack_restart_watcher_stops_during_shutdown() {
        let source = include_str!("owner_credential.rs");
        let start = source
            .find("pub(crate) fn spawn_owner_password_stack_restart_watcher")
            .expect("owner-password stack restart watcher must exist");
        let end = source[start..]
            .find("fn open_owner_password_window")
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let body = &source[start..end];

        assert!(
            body.contains("shutdown_has_been_requested(&app)"),
            "owner-password stack restart watcher must stop once shutdown is requested"
        );
    }

    #[test]
    fn creates_credential_once_and_reuses_it() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");

        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };
        let first = load_or_create_owner_credential_with_store(&path, &mut store)
            .expect("first credential");
        let second = load_or_create_owner_credential_with_store(&path, &mut store)
            .expect("reused credential");

        assert_eq!(first, second);
        assert_eq!(store.value.as_deref(), Some(first.as_str()));
        assert!(!first.is_empty());
    }

    #[test]
    fn falls_back_to_a_0600_file_when_keyring_is_unavailable() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let mut store = MockKeyring::default();

        let credential = load_or_create_owner_credential_with_store(&path, &mut store)
            .expect("fallback credential");

        assert_eq!(
            fs::read_to_string(&path).expect("fallback file"),
            credential
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path)
                .expect("credential metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn saves_owner_password_to_the_keyring() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };

        save_owner_credential_with_store(&path, &mut store, "chosen-owner-password")
            .expect("saved owner password");

        assert_eq!(store.value.as_deref(), Some("chosen-owner-password"));
        assert!(!path.exists());
    }

    #[test]
    fn reports_no_credential_before_one_is_created() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let mut store = MockKeyring::default();

        let exists =
            owner_credential_exists_with_store(&path, &mut store).expect("existence check");

        assert!(!exists);
        assert!(!path.exists());
    }

    #[test]
    fn reports_a_credential_once_the_keyring_holds_one() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let mut store = MockKeyring {
            available: true,
            value: Some("owner-password".to_string()),
        };

        let exists =
            owner_credential_exists_with_store(&path, &mut store).expect("existence check");

        assert!(exists);
    }

    #[test]
    fn reports_a_credential_from_the_fallback_file_when_the_keyring_is_unavailable() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        fs::write(&path, "owner-password").expect("fallback credential file");
        let mut store = MockKeyring::default();

        let exists =
            owner_credential_exists_with_store(&path, &mut store).expect("existence check");

        assert!(exists);
    }

    /// `verify_owner_credential_with_store` intentionally defers to
    /// `configured_owner_password()` (a `DATACONNECT_OWNER_PASSWORD` /
    /// `PDPP_OWNER_PASSWORD` env override) when one is set, exactly like
    /// production boot does. These tests must verify against whatever that
    /// function actually resolves to right now rather than assuming the test
    /// environment has neither var set -- this repo's own dev environment
    /// commonly does.
    fn expected_owner_password_for_test(stored: &str) -> String {
        configured_owner_password().unwrap_or_else(|| stored.to_string())
    }

    #[test]
    fn verifies_a_matching_password_against_the_keyring() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        let mut store = MockKeyring {
            available: true,
            value: Some("owner-password".to_string()),
        };
        let expected = expected_owner_password_for_test("owner-password");

        assert!(
            verify_owner_credential_with_store(&path, &mut store, &expected).expect("verification")
        );
        assert!(
            !verify_owner_credential_with_store(&path, &mut store, "wrong-password")
                .expect("verification")
        );
    }

    #[test]
    fn verifies_a_matching_password_against_the_fallback_file() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("owner-credential");
        fs::write(&path, "owner-password").expect("fallback credential file");
        let mut store = MockKeyring::default();
        let expected = expected_owner_password_for_test("owner-password");

        assert!(
            verify_owner_credential_with_store(&path, &mut store, &expected).expect("verification")
        );
        assert!(
            !verify_owner_credential_with_store(&path, &mut store, "wrong-password")
                .expect("verification")
        );
    }

    #[test]
    fn constant_time_eq_rejects_different_lengths_and_accepts_equal_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abc", b"abd"));
    }

    #[test]
    fn stores_and_loads_provider_credential_reference() {
        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };

        store_provider_credential_reference_with_store(&mut store, "native-secret-slot")
            .expect("stored provider credential reference");

        assert_eq!(
            load_provider_credential_reference_with_store(&mut store)
                .expect("loaded provider credential reference")
                .as_deref(),
            Some("native-secret-slot")
        );
    }

    #[test]
    fn rejects_empty_provider_credential_reference() {
        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };

        assert!(store_provider_credential_reference_with_store(&mut store, "  ").is_err());
    }

    #[test]
    fn validates_provider_ids_used_for_keychain_usernames() {
        assert!(validated_provider_id("user-origin").is_ok());
        assert!(validated_provider_id("../user-origin").is_err());
        assert!(validated_provider_id(" ").is_err());
    }

    #[test]
    fn database_key_is_generated_for_a_plaintext_database() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, b"SQLite format 3\0").expect("plaintext database marker");
        let mut store = MockKeyring::default();

        let key = load_or_create_database_encryption_key_with_store(
            &key_path,
            &database_path,
            &mut store,
        )
        .expect("database key");

        assert_eq!(key.len(), 43);
        assert_eq!(store.value.as_deref(), None);
        assert_eq!(
            fs::read_to_string(key_path).expect("database key file"),
            key
        );
    }

    #[test]
    fn missing_database_key_fails_closed_for_an_encrypted_database() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, [0u8; 16]).expect("encrypted database marker");
        let mut store = MockKeyring::default();

        let error = load_or_create_database_encryption_key_with_store(
            &key_path,
            &database_path,
            &mut store,
        )
        .expect_err("missing key must not be replaced");

        assert!(matches!(error, DatabaseKeyError::Missing(_)));
        assert!(error
            .to_string()
            .contains("Database encryption key is missing"));
        assert!(!key_path.exists());
    }

    #[test]
    fn saves_and_reloads_database_encryption_key_via_the_store() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let database_path = directory.path().join("pdpp.sqlite");
        fs::write(&database_path, [0u8; 16]).expect("encrypted database marker");
        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };

        save_database_encryption_key_with_store(&key_path, &mut store, "recovered-key-value")
            .expect("saved database encryption key");

        let reloaded = load_or_create_database_encryption_key_with_store(
            &key_path,
            &database_path,
            &mut store,
        )
        .expect("reloaded database encryption key");

        assert_eq!(reloaded, "recovered-key-value");
    }

    #[test]
    fn rejects_saving_an_empty_database_encryption_key() {
        let directory = tempdir().expect("temp directory");
        let key_path = directory.path().join("database-encryption-key");
        let mut store = MockKeyring {
            available: true,
            ..Default::default()
        };

        assert!(save_database_encryption_key_with_store(&key_path, &mut store, "  ").is_err());
    }
}
