// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Durable owner credential storage for the unified desktop path.
//!
//! The OS keychain is the primary store. The app-data file is used only when
//! the keychain backend is unavailable at runtime, such as headless Linux.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const OWNER_CREDENTIAL_FILE: &str = "owner-credential";
const OWNER_CREDENTIAL_BYTES: usize = 32;
const KEYRING_SERVICE: &str = "com.vana.dataconnect";
const KEYRING_USERNAME: &str = "owner";

trait CredentialStore {
    fn load(&mut self) -> Result<Option<String>, String>;
    fn save(&mut self, credential: &str) -> Result<(), String>;
}

struct SystemKeyring;

impl CredentialStore for SystemKeyring {
    fn load(&mut self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME)
            .map_err(|error| format!("could not initialize OS keychain: {error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("could not read OS keychain: {error}")),
        }
    }

    fn save(&mut self, credential: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME)
            .map_err(|error| format!("could not initialize OS keychain: {error}"))?;
        entry
            .set_password(credential)
            .map_err(|error| format!("could not write OS keychain: {error}"))
    }
}

/// Resolve the app-data path used for the generated owner password.
pub(crate) fn owner_credential_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(OWNER_CREDENTIAL_FILE))
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
    let mut store = SystemKeyring;
    load_or_create_owner_credential_with_store(path, &mut store)
}

fn load_or_create_owner_credential_with_store(
    path: &Path,
    store: &mut impl CredentialStore,
) -> Result<String, String> {
    let keyring_error = match store.load() {
        Ok(Some(credential)) if !credential.trim().is_empty() => {
            log::info!("Owner credential store: OS keychain");
            return Ok(credential);
        }
        Ok(Some(_)) => Some("OS keychain returned an empty credential".to_string()),
        Ok(None) => None,
        Err(error) => Some(error),
    };

    if path.exists() {
        let credential = read_owner_credential(path)?;
        if keyring_error.is_none() && store.save(&credential).is_ok() {
            log::info!("Owner credential store: OS keychain");
            return Ok(credential);
        }
        log_fallback_store(keyring_error.as_deref());
        return Ok(credential);
    }

    let mut bytes = [0u8; OWNER_CREDENTIAL_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Failed to generate owner credential: {error}"))?;
    let credential = URL_SAFE_NO_PAD.encode(bytes);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create owner credential directory: {error}"))?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    if keyring_error.is_none() && store.save(&credential).is_ok() {
        log::info!("Owner credential store: OS keychain");
        return Ok(credential);
    }

    log_fallback_store(keyring_error.as_deref());
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(credential.as_bytes())
                .map_err(|error| format!("Failed to write owner credential: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Failed to persist owner credential: {error}"))?;
            #[cfg(unix)]
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Failed to protect owner credential: {error}"))?;
            Ok(credential)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_owner_credential(path)
        }
        Err(error) => Err(format!("Failed to create owner credential: {error}")),
    }
}

fn log_fallback_store(keyring_error: Option<&str>) {
    match keyring_error {
        Some(error) => log::warn!(
            "Owner credential store: 0600 app-data fallback; OS keychain unavailable ({error})"
        ),
        None => {
            log::warn!("Owner credential store: 0600 app-data fallback; OS keychain write failed")
        }
    }
}

fn read_owner_credential(path: &Path) -> Result<String, String> {
    let credential = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read owner credential: {error}"))?;
    let credential = credential.trim().to_string();
    if credential.is_empty() {
        return Err("Owner credential file is empty".to_string());
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect owner credential: {error}"))?;
    Ok(credential)
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
}
