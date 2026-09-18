// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Durable owner credential storage for the unified desktop path.
//!
//! The OS keychain is the primary store. The app-data file is used only when
//! the keychain backend is unavailable at runtime, such as headless Linux.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Manager};

const OWNER_CREDENTIAL_FILE: &str = "owner-credential";
const CREDENTIAL_ENCRYPTION_KEY_FILE: &str = "credential-encryption-key";
const DATABASE_ENCRYPTION_KEY_FILE: &str = "database-encryption-key";
const GENERATED_SECRET_BYTES: usize = 32;
const KEYRING_SERVICE: &str = "com.vana.dataconnect";
const OWNER_KEYRING_USERNAME: &str = "owner";
const PROVIDER_CREDENTIAL_USERNAME_PREFIX: &str = "remote-access-provider:";
const CREDENTIAL_ENCRYPTION_KEYRING_USERNAME: &str = "credential-encryption-key";
const DATABASE_ENCRYPTION_KEYRING_USERNAME: &str = "database-encryption-key";

trait CredentialStore {
    fn load(&mut self) -> Result<Option<String>, String>;
    fn save(&mut self, credential: &str) -> Result<(), String>;
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

/// Load the durable desktop database key, or create it only when the existing
/// database is not already encrypted. Replacing a missing key for an
/// encrypted database would permanently orphan the vault.
pub(crate) fn load_or_create_database_encryption_key(
    path: &Path,
    database_path: &Path,
) -> Result<String, String> {
    let mut store = SystemKeyring::new(DATABASE_ENCRYPTION_KEYRING_USERNAME);
    load_or_create_database_encryption_key_with_store(path, database_path, &mut store)
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

fn load_or_create_database_encryption_key_with_store(
    path: &Path,
    database_path: &Path,
    store: &mut impl CredentialStore,
) -> Result<String, String> {
    load_or_create_secret_with_store(
        path,
        store,
        "Database encryption key",
        || database_is_encrypted(database_path),
        Some("Database encryption key is missing while an encrypted SQLite vault exists. Restore the key from the OS keychain or the database-encryption-key app-data file; refusing to mint a replacement that would orphan the vault."),
    )
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
        Some(error) => log::warn!(
            "{label} store: 0600 app-data fallback; OS keychain unavailable ({error})"
        ),
        None => {
            log::warn!("{label} store: 0600 app-data fallback; OS keychain write failed")
        }
    }
}

fn read_secret(path: &Path, label: &str) -> Result<String, String> {
    let credential = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {label}: {error}"))?;
    let credential = credential.trim().to_string();
    if credential.is_empty() {
        return Err(format!("{label} file is empty"));
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect {label}: {error}"))?;
    Ok(credential)
}

fn database_is_encrypted(path: &Path) -> Result<bool, String> {
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
            verify_owner_credential_with_store(&path, &mut store, &expected)
                .expect("verification")
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
            verify_owner_credential_with_store(&path, &mut store, &expected)
                .expect("verification")
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
        assert_eq!(fs::read_to_string(key_path).expect("database key file"), key);
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

        assert!(error.contains("Database encryption key is missing"));
        assert!(!key_path.exists());
    }
}
