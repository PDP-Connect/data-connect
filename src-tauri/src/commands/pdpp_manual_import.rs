// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use super::connector_store::{get_active_connector_install, get_dataconnect_dir};
use super::pdpp_collection_state::DEFAULT_CONNECTION_ID;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn prepare_installed_pdpp_import(
    app: AppHandle,
    connector_id: String,
    connection_id: Option<String>,
    directory: bool,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        get_active_connector_install(&connector_id)
            .ok_or("No active connector install for import")?;
        let picker = app.dialog().file().set_title("Choose your exported data");
        let selected = if directory {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        };
        let Some(selected) = selected else {
            return Ok(None);
        };
        let source = selected.into_path().map_err(|e| e.to_string())?;
        let scope = import_scope(
            &import_root()?,
            &connector_id,
            connection_id.as_deref().unwrap_or(DEFAULT_CONNECTION_ID),
        );
        copy_import(&source, &scope).map(|path| Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Import preparation task failed: {e}"))?
}

fn import_root() -> Result<PathBuf, String> {
    Ok(get_dataconnect_dir()
        .ok_or("Could not determine DataConnect import directory")?
        .join("pdpp-imports"))
}

fn import_scope(root: &Path, connector_id: &str, connection_id: &str) -> PathBuf {
    root.join(hex::encode(Sha256::digest(connector_id.as_bytes())))
        .join(hex::encode(Sha256::digest(connection_id.as_bytes())))
}

#[cfg(test)]
pub(crate) fn create_import_directory_for_test(
    connector_id: &str,
    connection_id: &str,
) -> ImportedDirectory {
    let scope = import_scope(&import_root().unwrap(), connector_id, connection_id);
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("export.xml"), "<HealthData/>").unwrap();
    ImportedDirectory(copy_import(source.path(), &scope).unwrap())
}

pub(crate) fn validate_import_directory(
    connector_id: &str,
    connection_id: &str,
    supplied: &str,
) -> Result<PathBuf, String> {
    validate_import_at(
        &import_scope(&import_root()?, connector_id, connection_id),
        Path::new(supplied),
    )
}

/// Owns only the staged copy while a run is active, including failed runs.
pub(crate) struct ImportedDirectory(PathBuf);

impl ImportedDirectory {
    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn claim(
        connector_id: &str,
        connection_id: &str,
        supplied: &str,
    ) -> Result<Self, String> {
        validate_import_directory(connector_id, connection_id, supplied).map(Self)
    }
}

impl Drop for ImportedDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            log::warn!("Could not remove completed import copy: {error}");
        }
    }
}

fn validate_import_at(scope: &Path, supplied: &Path) -> Result<PathBuf, String> {
    let directory =
        fs::canonicalize(supplied).map_err(|e| format!("Import is unavailable: {e}"))?;
    let scope = fs::canonicalize(scope).map_err(|e| format!("Import scope is unavailable: {e}"))?;
    if !directory.is_dir() || directory.parent() != Some(scope.as_path()) {
        return Err("Import directory does not belong to this connection".into());
    }
    Ok(directory)
}

fn copy_import(source: &Path, scope: &Path) -> Result<PathBuf, String> {
    let copy = || -> Result<PathBuf, Box<dyn std::error::Error>> {
        fs::create_dir_all(scope)?;
        let staged = tempfile::Builder::new()
            .prefix("import-")
            .tempdir_in(scope)?;
        let source = fs::canonicalize(source)?;
        let destination = fs::canonicalize(staged.path())?;
        if destination.starts_with(&source) {
            return Err("Choose an export outside DataConnect's import storage".into());
        }
        // Copy folder contents at the import root: connectors look for their
        // expected export filenames there, not beneath another folder name.
        for entry in walkdir::WalkDir::new(&source).follow_links(false) {
            let entry = entry?;
            let kind = entry.file_type();
            if !kind.is_dir() && !kind.is_file() {
                return Err(
                    "Exports must contain regular files and folders, without symbolic links".into(),
                );
            }
            let relative = if source.is_file() {
                Path::new(source.file_name().ok_or("Export filename is missing")?)
            } else {
                entry.path().strip_prefix(&source)?
            };
            let target = staged.path().join(relative);
            if kind.is_dir() {
                fs::create_dir_all(target)?;
            } else {
                fs::copy(entry.path(), target)?;
            }
        }
        Ok(staged.keep())
    };
    copy().map_err(|e| format!("Could not copy exported data: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_file_and_folder_contents_into_isolated_connection_imports() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("export");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("export.xml"), "<HealthData/>").unwrap();
        fs::write(source.join("nested/record.json"), "{}").unwrap();
        let scope = import_scope(temp.path(), "apple-health-pdpp", "owner-a");
        let folder = copy_import(&source, &scope).unwrap();
        let file = copy_import(&source.join("export.xml"), &scope).unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("nested/record.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(file.join("export.xml")).unwrap(),
            "<HealthData/>"
        );
        assert_ne!(file, folder);
        assert_eq!(validate_import_at(&scope, &file).unwrap(), file);
        let other_scope = import_scope(temp.path(), "apple-health-pdpp", "owner-b");
        fs::create_dir_all(&other_scope).unwrap();
        assert!(validate_import_at(&other_scope, &file).is_err());
        assert!(validate_import_at(&scope, &source).is_err());
        assert!(validate_import_at(&scope, &folder.join("nested")).is_err());
        drop(ImportedDirectory(
            validate_import_at(&scope, &file).unwrap(),
        ));
        assert!(!file.exists());
        assert!(source.join("export.xml").exists());
        assert!(folder.exists());
    }

    #[test]
    fn rejects_copying_import_storage_into_itself() {
        let temp = tempfile::tempdir().unwrap();
        let scope = temp.path().join("imports");
        assert!(copy_import(temp.path(), &scope).is_err());
        assert_eq!(fs::read_dir(scope).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nested_symlinks_and_removes_incomplete_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("export");
        fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(temp.path(), source.join("escape")).unwrap();
        let scope = temp.path().join("imports");
        assert!(copy_import(&source, &scope).is_err());
        assert_eq!(fs::read_dir(scope).unwrap().count(), 0);
    }
}
