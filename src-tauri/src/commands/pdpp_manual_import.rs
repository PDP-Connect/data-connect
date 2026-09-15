// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use super::connector_store::{get_active_connector_install, get_dataconnect_dir};
use super::pdpp_collection_state::DEFAULT_CONNECTION_ID;
use fs2::FileExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const DEFAULT_MANUAL_UPLOAD_MAX_BYTES: u64 = 24 * 1024 * 1024 * 1024;
const MAX_IMPORT_ENTRIES: usize = 100_000;
const MAX_IMPORT_DEPTH: usize = 32;
const STAGED_IMPORT_TTL: Duration = Duration::from_secs(60 * 60);
static IMPORT_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug)]
struct CopyLimits {
    max_total_bytes: u64,
    max_file_bytes: u64,
    max_entries: usize,
    max_depth: usize,
}

impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            max_total_bytes: DEFAULT_MANUAL_UPLOAD_MAX_BYTES,
            max_file_bytes: DEFAULT_MANUAL_UPLOAD_MAX_BYTES,
            max_entries: MAX_IMPORT_ENTRIES,
            max_depth: MAX_IMPORT_DEPTH,
        }
    }
}

#[tauri::command]
pub async fn prepare_installed_pdpp_import(
    app: AppHandle,
    connector_id: String,
    connection_id: Option<String>,
    directory: bool,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let install = get_active_connector_install(&connector_id)
            .ok_or("No active connector install for import")?;
        let root = canonical_import_root()?;
        reap_abandoned_imports_at(&root, SystemTime::now())?;
        let limits = copy_limits_for_install(&install)?;
        let connection_id = connection_id.as_deref().unwrap_or(DEFAULT_CONNECTION_ID);
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
        let scope = import_scope(&root, &connector_id, connection_id);
        copy_import_with_limits(&source, &root, &scope, limits)
            .map(|path| Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Import preparation task failed: {e}"))?
}

fn canonical_import_root() -> Result<PathBuf, String> {
    let data_root =
        get_dataconnect_dir().ok_or("Could not determine DataConnect import directory")?;
    fs::create_dir_all(&data_root)
        .map_err(|e| format!("Could not create DataConnect directory: {e}"))?;
    let data_root = fs::canonicalize(&data_root)
        .map_err(|e| format!("Could not resolve DataConnect directory: {e}"))?;
    let root = data_root.join("pdpp-imports");
    ensure_real_directory_chain(&data_root, &root)?;
    let root = fs::canonicalize(&root)
        .map_err(|e| format!("Could not resolve DataConnect import directory: {e}"))?;
    if root.parent().is_none() || !root.starts_with(&data_root) || root == data_root {
        return Err("DataConnect import directory escapes the application data directory".into());
    }
    Ok(root)
}

fn copy_limits_for_install(
    install: &super::connector_store::ActiveConnectorInstall,
) -> Result<CopyLimits, String> {
    let root = fs::canonicalize(&install.root_path)
        .map_err(|e| format!("Could not resolve PDPP install root for copy limits: {e}"))?;
    let relative = install
        .manifest_path
        .as_deref()
        .ok_or("PDPP active install is missing manifestPath")?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("PDPP manifest path is not a safe relative path".into());
    }
    let manifest = fs::canonicalize(root.join(relative))
        .map_err(|e| format!("Could not resolve PDPP connector manifest copy limits: {e}"))?;
    if !manifest.is_file() || !manifest.starts_with(&root) {
        return Err("PDPP connector manifest copy limits escape the install root".into());
    }
    copy_limits_from_manifest(&manifest)
}

fn copy_limits_from_manifest(manifest: &Path) -> Result<CopyLimits, String> {
    let contents = fs::read_to_string(manifest)
        .map_err(|e| format!("Could not read PDPP connector manifest copy limits: {e}"))?;
    let manifest: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Could not parse PDPP connector manifest copy limits: {e}"))?;
    let validation = manifest
        .pointer("/setup/manual_or_upload/validation")
        .and_then(Value::as_object);
    let declared = validation.and_then(|value| {
        value
            .get("max_file_bytes")
            .or_else(|| value.get("maxFileBytes"))
    });
    let maximum = match declared {
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or("PDPP connector manifest max_file_bytes must be a positive integer")?,
        None => DEFAULT_MANUAL_UPLOAD_MAX_BYTES,
    }
    .min(DEFAULT_MANUAL_UPLOAD_MAX_BYTES);
    Ok(CopyLimits {
        max_total_bytes: maximum,
        max_file_bytes: maximum,
        ..CopyLimits::default()
    })
}

fn import_scope(root: &Path, connector_id: &str, connection_id: &str) -> PathBuf {
    root.join(hex::encode(Sha256::digest(connector_id.as_bytes())))
        .join(hex::encode(Sha256::digest(connection_id.as_bytes())))
}

#[cfg(test)]
pub(crate) fn create_import_directory_for_test(
    connector_id: &str,
    connection_id: &str,
) -> PreparedImportForTest {
    let root = canonical_import_root().unwrap();
    let scope = import_scope(&root, connector_id, connection_id);
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("export.xml"), "<HealthData/>").unwrap();
    PreparedImportForTest(
        copy_import_with_limits(source.path(), &root, &scope, CopyLimits::default()).unwrap(),
    )
}

#[cfg(test)]
pub(crate) struct PreparedImportForTest(PathBuf);

#[cfg(test)]
impl PreparedImportForTest {
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for PreparedImportForTest {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn validate_import_directory(
    connector_id: &str,
    connection_id: &str,
    supplied: &str,
) -> Result<PathBuf, String> {
    let root = canonical_import_root()?;
    validate_import_at(
        &root,
        &import_scope(&root, connector_id, connection_id),
        Path::new(supplied),
    )
}

/// Owns only the staged copy while a run is active, including failed runs.
pub(crate) struct ImportedDirectory {
    path: PathBuf,
    claim: Option<ClaimedImport>,
}

struct ClaimedImport {
    marker: File,
    marker_path: PathBuf,
}

impl ImportedDirectory {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn claim(
        connector_id: &str,
        connection_id: &str,
        supplied: &str,
    ) -> Result<Self, String> {
        let root = canonical_import_root()?;
        let expected_scope = import_scope(&root, connector_id, connection_id);
        let directory = validate_import_at(&root, &expected_scope, Path::new(supplied))?;
        let claim = claim_import_at(&root, &directory)?;
        Ok(Self {
            path: directory,
            claim: Some(claim),
        })
    }
}

impl Drop for ImportedDirectory {
    fn drop(&mut self) {
        let removal = fs::remove_dir_all(&self.path);
        match self.claim.take() {
            Some(claim) => finish_import_cleanup(&self.path, claim, removal),
            None => {
                if let Err(error) = removal {
                    log::warn!("Could not remove completed import copy: {error}");
                }
            }
        }
    }
}

fn validate_import_at(root: &Path, scope: &Path, supplied: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("Import root is unavailable: {e}"))?;
    ensure_scope(&root, scope)?;
    let scope = fs::canonicalize(scope).map_err(|e| format!("Import scope is unavailable: {e}"))?;
    let directory =
        fs::canonicalize(supplied).map_err(|e| format!("Import is unavailable: {e}"))?;
    let name_is_staged = directory
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("import-"));
    let supplied_kind = fs::symlink_metadata(supplied)
        .map_err(|e| format!("Import is unavailable: {e}"))?
        .file_type();
    if supplied_kind.is_symlink()
        || !directory.is_dir()
        || !directory.starts_with(&root)
        || directory.parent() != Some(scope.as_path())
        || !name_is_staged
    {
        return Err("Import directory does not belong to this connection".into());
    }
    Ok(directory)
}

fn ensure_scope(root: &Path, scope: &Path) -> Result<(), String> {
    let relative = scope
        .strip_prefix(root)
        .map_err(|_| "Import scope escapes the import root")?;
    if relative.components().count() != 2 {
        return Err("Import scope must identify one connector and connection".into());
    }
    ensure_real_directory_chain(root, scope)
}

fn ensure_real_directory_chain(root: &Path, directory: &Path) -> Result<(), String> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "Import directory escapes its allowed root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err("Import directory contains an unsafe path component".into());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("Import directory path must contain only real directories".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Err(error) = fs::create_dir(&current) {
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(format!("Could not create import directory: {error}"));
                    }
                    let metadata = fs::symlink_metadata(&current)
                        .map_err(|e| format!("Could not inspect import directory: {e}"))?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(
                            "Import directory path must contain only real directories".into()
                        );
                    }
                }
            }
            Err(error) => return Err(format!("Could not inspect import directory: {error}")),
        }
    }
    let canonical = fs::canonicalize(directory)
        .map_err(|e| format!("Could not resolve import directory: {e}"))?;
    if canonical == root || !canonical.starts_with(root) {
        return Err("Import directory escapes its allowed root".into());
    }
    Ok(())
}

fn copy_import_with_limits(
    source: &Path,
    root: &Path,
    scope: &Path,
    limits: CopyLimits,
) -> Result<PathBuf, String> {
    let copy = || -> Result<PathBuf, Box<dyn std::error::Error>> {
        ensure_scope(root, scope)?;
        let staged = tempfile::Builder::new()
            .prefix("import-")
            .tempdir_in(scope)?;
        let copy_claim = lock_import_marker(staged.path(), true)?;
        let staged = StagedCopy {
            directory: Some(staged),
            claim: Some(copy_claim),
        };
        let source = fs::canonicalize(source)?;
        let destination = fs::canonicalize(staged.path())?;
        if destination.starts_with(&source) {
            return Err("Choose an export outside DataConnect's import storage".into());
        }
        // Copy folder contents at the import root: connectors look for their
        // expected export filenames there, not beneath another folder name.
        let mut entries = 0usize;
        let mut total_bytes = 0u64;
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
            if !(source.is_dir() && relative.as_os_str().is_empty()) {
                entries = entries
                    .checked_add(1)
                    .ok_or("Export entry count overflowed")?;
                if entries > limits.max_entries {
                    return Err(
                        format!("Export exceeds the {} entry limit", limits.max_entries).into(),
                    );
                }
                let depth = if source.is_file() { 1 } else { entry.depth() };
                if depth > limits.max_depth {
                    return Err(format!(
                        "Export exceeds the {} level depth limit",
                        limits.max_depth
                    )
                    .into());
                }
            }
            let target = staged.path().join(relative);
            if kind.is_dir() {
                fs::create_dir_all(target)?;
            } else {
                let file_bytes = entry.metadata()?.len();
                if file_bytes > limits.max_file_bytes {
                    return Err(format!(
                        "Export file exceeds the {} byte per-file byte limit",
                        limits.max_file_bytes
                    )
                    .into());
                }
                total_bytes = total_bytes
                    .checked_add(file_bytes)
                    .ok_or("Export total byte count overflowed")?;
                if total_bytes > limits.max_total_bytes {
                    return Err(format!(
                        "Export exceeds the {} total byte limit",
                        limits.max_total_bytes
                    )
                    .into());
                }
                let remaining_total = limits.max_total_bytes - (total_bytes - file_bytes);
                let allowed = limits.max_file_bytes.min(remaining_total);
                let mut input = File::open(entry.path())?;
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(target)?;
                let (copied, exceeded) = copy_at_most(&mut input, &mut output, allowed)?;
                if exceeded {
                    return Err(
                        "Export file grew beyond the byte limit while it was being copied".into(),
                    );
                }
                if copied != file_bytes {
                    return Err("Export file changed while it was being copied".into());
                }
            }
        }
        Ok(staged.keep())
    };
    copy().map_err(|e| format!("Could not copy exported data: {e}"))
}

struct StagedCopy {
    directory: Option<tempfile::TempDir>,
    claim: Option<ClaimedImport>,
}

impl StagedCopy {
    fn path(&self) -> &Path {
        self.directory.as_ref().expect("staging directory").path()
    }

    fn keep(mut self) -> PathBuf {
        let directory = self.directory.take().expect("staging directory").keep();
        if let Some(claim) = self.claim.take() {
            let _ = claim.marker.set_modified(SystemTime::now());
            let _ = FileExt::unlock(&claim.marker);
            drop(claim);
        }
        directory
    }
}

impl Drop for StagedCopy {
    fn drop(&mut self) {
        let Some(directory) = self.directory.take() else {
            if let Some(claim) = self.claim.take() {
                remove_claim_marker(claim);
            }
            return;
        };
        let path = directory.path().to_path_buf();
        let removal = directory.close();
        match self.claim.take() {
            Some(claim) => finish_import_cleanup(&path, claim, removal),
            None => {
                let _ = removal;
            }
        }
    }
}

fn copy_at_most(
    input: &mut impl Read,
    output: &mut impl Write,
    maximum: u64,
) -> io::Result<(u64, bool)> {
    let copied = io::copy(&mut input.take(maximum), output)?;
    let mut extra = [0u8; 1];
    Ok((copied, input.read(&mut extra)? != 0))
}

fn claim_marker_path(directory: &Path) -> Result<PathBuf, String> {
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Import directory name is invalid")?;
    Ok(directory
        .parent()
        .ok_or("Import directory has no scope")?
        .join(format!(".claim-{name}")))
}

fn claim_import_at(root: &Path, directory: &Path) -> Result<ClaimedImport, String> {
    let _guard = IMPORT_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let scope = directory.parent().ok_or("Import directory has no scope")?;
    let directory = validate_import_at(root, scope, directory)?;
    lock_import_marker(&directory, false)
}

fn lock_import_marker(directory: &Path, create: bool) -> Result<ClaimedImport, String> {
    let marker_path = claim_marker_path(directory)?;
    match fs::symlink_metadata(&marker_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Import claim marker must be a regular file".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not inspect import claim: {error}")),
    }
    let mut options = OpenOptions::new();
    options.create(create).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let marker = options.open(&marker_path).map_err(|e| {
        if !create && e.kind() == io::ErrorKind::NotFound {
            "Import directory was not prepared by DataConnect".to_string()
        } else {
            format!("Could not create import claim: {e}")
        }
    })?;
    marker
        .try_lock_exclusive()
        .map_err(|_| "Import directory is already claimed by another run".to_string())?;
    Ok(ClaimedImport {
        marker,
        marker_path,
    })
}

fn remove_claim_marker(claim: ClaimedImport) {
    let marker_path = claim.marker_path.clone();
    release_claim_marker(claim);
    if let Err(error) = fs::remove_file(marker_path) {
        if error.kind() != io::ErrorKind::NotFound {
            log::warn!("Could not remove import claim: {error}");
        }
    }
}

fn release_claim_marker(claim: ClaimedImport) {
    let _ = FileExt::unlock(&claim.marker);
    drop(claim);
}

fn finish_import_cleanup(path: &Path, claim: ClaimedImport, removal: io::Result<()>) {
    match removal {
        Ok(()) => remove_claim_marker(claim),
        Err(error) if error.kind() == io::ErrorKind::NotFound => remove_claim_marker(claim),
        Err(error) => {
            log::warn!("Could not remove import copy {}: {error}", path.display());
            release_claim_marker(claim);
        }
    }
}

fn reap_abandoned_imports_at(root: &Path, now: SystemTime) -> Result<(), String> {
    let _guard = IMPORT_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = fs::canonicalize(root)
        .map_err(|e| format!("Could not resolve import root for cleanup: {e}"))?;
    for connector in real_child_directories(&root)? {
        for scope in real_child_directories(&connector)? {
            for candidate in real_child_directories(&scope)? {
                let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if !name.starts_with("import-") {
                    continue;
                }
                let marker_path = claim_marker_path(&candidate)?;
                let marker_exists = match fs::symlink_metadata(&marker_path) {
                    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                        continue;
                    }
                    Ok(_) => true,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                    Err(error) => {
                        return Err(format!("Could not inspect staged import claim: {error}"))
                    }
                };
                if !marker_exists {
                    continue;
                }
                let modified = fs::metadata(&marker_path)
                    .and_then(|metadata| metadata.modified())
                    .map_err(|e| format!("Could not inspect staged import age: {e}"))?;
                if now.duration_since(modified).unwrap_or_default() < STAGED_IMPORT_TTL {
                    continue;
                }
                let Ok(claim) = lock_import_marker(&candidate, false) else {
                    continue;
                };
                let refreshed = fs::metadata(&marker_path)
                    .and_then(|metadata| metadata.modified())
                    .map_err(|e| format!("Could not recheck staged import age: {e}"))?;
                if now.duration_since(refreshed).unwrap_or_default() < STAGED_IMPORT_TTL {
                    continue;
                }
                if validate_import_at(&root, &scope, &candidate).is_err() {
                    continue;
                }
                fs::remove_dir_all(&candidate)
                    .map_err(|e| format!("Could not remove abandoned import: {e}"))?;
                remove_claim_marker(claim);
            }
        }
    }
    Ok(())
}

fn real_child_directories(parent: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Could not resolve import cleanup directory: {e}"))?;
    let mut children = Vec::new();
    for entry in fs::read_dir(&parent)
        .map_err(|e| format!("Could not read import cleanup directory: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Could not read import cleanup entry: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Could not inspect import cleanup entry: {e}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let child = fs::canonicalize(entry.path())
            .map_err(|e| format!("Could not resolve import cleanup entry: {e}"))?;
        if child.parent() == Some(parent.as_path()) {
            children.push(child);
        }
    }
    Ok(children)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn tiny_limits() -> CopyLimits {
        CopyLimits {
            max_total_bytes: 8,
            max_file_bytes: 6,
            max_entries: 3,
            max_depth: 2,
        }
    }

    fn assert_failed_copy_is_removed(
        source: &Path,
        root: &Path,
        scope: &Path,
        limits: CopyLimits,
        expected: &str,
    ) {
        let error = copy_import_with_limits(source, root, scope, limits).unwrap_err();
        assert!(error.contains(expected), "unexpected error: {error}");
        assert_eq!(fs::read_dir(scope).unwrap().count(), 0);
    }

    #[test]
    fn copies_file_and_folder_contents_into_isolated_connection_imports() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("export");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("export.xml"), "<HealthData/>").unwrap();
        fs::write(source.join("nested/record.json"), "{}").unwrap();
        let scope = import_scope(temp.path(), "apple-health-pdpp", "owner-a");
        let folder =
            copy_import_with_limits(&source, temp.path(), &scope, CopyLimits::default()).unwrap();
        let file = copy_import_with_limits(
            &source.join("export.xml"),
            temp.path(),
            &scope,
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("nested/record.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(file.join("export.xml")).unwrap(),
            "<HealthData/>"
        );
        assert_ne!(file, folder);
        assert_eq!(
            validate_import_at(temp.path(), &scope, &file).unwrap(),
            file
        );
        let other_scope = import_scope(temp.path(), "apple-health-pdpp", "owner-b");
        ensure_scope(temp.path(), &other_scope).unwrap();
        assert!(validate_import_at(temp.path(), &other_scope, &file).is_err());
        assert!(validate_import_at(temp.path(), &scope, &source).is_err());
        assert!(validate_import_at(temp.path(), &scope, &folder.join("nested")).is_err());
        let path = validate_import_at(temp.path(), &scope, &file).unwrap();
        let claim = claim_import_at(temp.path(), &path).unwrap();
        drop(ImportedDirectory {
            path,
            claim: Some(claim),
        });
        assert!(!file.exists());
        assert!(source.join("export.xml").exists());
        assert!(folder.exists());
    }

    #[test]
    fn rejects_copying_import_storage_into_itself() {
        let temp = tempfile::tempdir().unwrap();
        let scope = import_scope(temp.path(), "connector", "connection");
        assert!(
            copy_import_with_limits(temp.path(), temp.path(), &scope, CopyLimits::default())
                .is_err()
        );
        assert_eq!(fs::read_dir(scope).unwrap().count(), 0);
    }

    #[test]
    fn enforces_per_file_and_total_byte_limits_and_removes_partial_copies() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("export");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("too-large"), b"1234567").unwrap();
        let scope = import_scope(temp.path(), "connector", "per-file");
        assert_failed_copy_is_removed(
            &source,
            temp.path(),
            &scope,
            tiny_limits(),
            "per-file byte limit",
        );

        fs::remove_file(source.join("too-large")).unwrap();
        fs::write(source.join("one"), b"12345").unwrap();
        fs::write(source.join("two"), b"6789").unwrap();
        let scope = import_scope(temp.path(), "connector", "total");
        assert_failed_copy_is_removed(
            &source,
            temp.path(),
            &scope,
            tiny_limits(),
            "total byte limit",
        );
    }

    #[test]
    fn enforces_entry_and_depth_limits_and_removes_partial_copies() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("entries");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("one"), []).unwrap();
        fs::write(source.join("two"), []).unwrap();
        fs::write(source.join("three"), []).unwrap();
        fs::write(source.join("four"), []).unwrap();
        let scope = import_scope(temp.path(), "connector", "entry-scope");
        assert_failed_copy_is_removed(&source, temp.path(), &scope, tiny_limits(), "entry limit");

        let source = temp.path().join("depth");
        fs::create_dir_all(source.join("one/two/three")).unwrap();
        fs::write(source.join("one/two/three/data"), []).unwrap();
        let scope = import_scope(temp.path(), "connector", "depth-scope");
        assert_failed_copy_is_removed(&source, temp.path(), &scope, tiny_limits(), "depth limit");
    }

    #[test]
    fn manifest_copy_limits_use_declared_max_file_bytes_or_reference_default() {
        let temp = tempfile::tempdir().unwrap();
        let declared = temp.path().join("declared.json");
        fs::write(
            &declared,
            r#"{"setup":{"manual_or_upload":{"validation":{"max_file_bytes":1234}}}}"#,
        )
        .unwrap();
        let camel = temp.path().join("camel.json");
        fs::write(
            &camel,
            r#"{"setup":{"manual_or_upload":{"validation":{"maxFileBytes":2345}}}}"#,
        )
        .unwrap();
        assert_eq!(
            copy_limits_from_manifest(&declared).unwrap().max_file_bytes,
            1234
        );
        assert_eq!(
            copy_limits_from_manifest(&declared)
                .unwrap()
                .max_total_bytes,
            1234
        );
        assert_eq!(
            copy_limits_from_manifest(&camel).unwrap().max_file_bytes,
            2345
        );
        assert!(copy_limits_from_manifest(&temp.path().join("missing.json"))
            .unwrap_err()
            .contains("Could not read PDPP connector manifest copy limits"));
        assert_eq!(
            CopyLimits::default().max_total_bytes,
            24 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn bounded_copy_never_writes_past_the_limit() {
        let mut input = io::Cursor::new(b"1234567");
        let mut output = Vec::new();

        let (copied, exceeded) = copy_at_most(&mut input, &mut output, 6).unwrap();

        assert_eq!(copied, 6);
        assert!(exceeded);
        assert_eq!(output, b"123456");
    }

    #[test]
    fn rejects_imports_deeper_than_the_default_limit() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("deep");
        let mut deepest = source.clone();
        for _ in 0..=MAX_IMPORT_DEPTH {
            deepest.push("nested");
        }
        fs::create_dir_all(&deepest).unwrap();
        fs::write(deepest.join("data"), []).unwrap();
        let scope = import_scope(temp.path(), "connector", "deep-default");

        assert_failed_copy_is_removed(
            &source,
            temp.path(),
            &scope,
            CopyLimits::default(),
            "depth limit",
        );
    }

    #[test]
    fn reaps_only_stale_unclaimed_imports_across_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let stale = root.join("connector-a/connection-a/import-stale");
        let stale_with_marker = root.join("connector-a/connection-a/import-stale-marked");
        let recent = root.join("connector-b/connection-b/import-recent");
        let claimed = root.join("connector-c/connection-c/import-claimed");
        let unprepared = root.join("connector-d/connection-d/import-unprepared");
        for directory in [&stale, &stale_with_marker, &recent, &claimed, &unprepared] {
            fs::create_dir_all(directory).unwrap();
        }
        let old = SystemTime::now() - STAGED_IMPORT_TTL - Duration::from_secs(1);
        fs::File::open(&stale).unwrap().set_modified(old).unwrap();
        fs::File::open(&stale_with_marker)
            .unwrap()
            .set_modified(old)
            .unwrap();
        fs::File::open(&claimed).unwrap().set_modified(old).unwrap();
        fs::File::open(&unprepared)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let stale_claim = lock_import_marker(&stale, true).unwrap();
        stale_claim.marker.set_modified(old).unwrap();
        drop(stale_claim);
        let stale_claim = lock_import_marker(&stale_with_marker, true).unwrap();
        stale_claim.marker.set_modified(old).unwrap();
        drop(stale_claim);
        let claim = lock_import_marker(&claimed, true).unwrap();
        claim.marker.set_modified(old).unwrap();

        reap_abandoned_imports_at(&root, SystemTime::now()).unwrap();

        assert!(!stale.exists());
        assert!(!stale_with_marker.exists());
        assert!(recent.exists());
        assert!(claimed.exists());
        assert!(unprepared.exists());
        drop(claim);
    }

    #[test]
    fn rejects_claiming_an_unprepared_import_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let directory = root.join("connector/connection/import-unprepared");
        fs::create_dir_all(&directory).unwrap();

        assert!(claim_import_at(&root, &directory).is_err());
        assert!(directory.exists());
    }

    #[test]
    fn retains_claim_marker_when_cleanup_fails_for_a_retry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let directory = root.join("connector/connection/import-retry");
        fs::create_dir_all(&directory).unwrap();
        let marker = claim_marker_path(&directory).unwrap();
        let claim = lock_import_marker(&directory, true).unwrap();

        finish_import_cleanup(
            &directory,
            claim,
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected cleanup failure",
            )),
        );

        assert!(directory.exists());
        assert!(marker.exists());

        let claim = lock_import_marker(&directory, false).unwrap();
        claim
            .marker
            .set_modified(SystemTime::now() - STAGED_IMPORT_TTL - Duration::from_secs(1))
            .unwrap();
        drop(claim);
        reap_abandoned_imports_at(&root, SystemTime::now()).unwrap();

        assert!(!directory.exists());
        assert!(!marker.exists());
    }

    #[test]
    fn rejects_a_second_claim_without_deleting_the_active_import() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let scope = root.join("connector/connection");
        let source = temp.path().join("source");
        fs::create_dir_all(&scope).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("export.xml"), "data").unwrap();
        let directory =
            copy_import_with_limits(&source, &root, &scope, CopyLimits::default()).unwrap();
        let claim = claim_import_at(&root, &directory).unwrap();

        assert!(claim_import_at(&root, &directory).is_err());
        assert!(directory.exists());

        drop(ImportedDirectory {
            path: directory.clone(),
            claim: Some(claim),
        });
        assert!(!directory.exists());
    }

    #[test]
    fn claim_marker_persists_across_lock_handoffs() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("import-active");
        fs::create_dir(&directory).unwrap();
        let marker = claim_marker_path(&directory).unwrap();
        let first = lock_import_marker(&directory, true).unwrap();

        assert!(marker.exists());
        assert!(lock_import_marker(&directory, true).is_err());
        drop(first);
        assert!(marker.exists());

        let second = lock_import_marker(&directory, true).unwrap();
        assert!(lock_import_marker(&directory, true).is_err());
        fs::remove_dir(&directory).unwrap();
        remove_claim_marker(second);
        assert!(!marker.exists());
    }

    #[test]
    fn recently_completed_long_copy_is_not_reaped() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let directory = root.join("connector/connection/import-long-copy");
        fs::create_dir_all(&directory).unwrap();
        let old = SystemTime::now() - STAGED_IMPORT_TTL - Duration::from_secs(1);
        fs::File::open(&directory)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let claim = lock_import_marker(&directory, true).unwrap();
        claim.marker.set_modified(SystemTime::now()).unwrap();
        drop(claim);

        reap_abandoned_imports_at(&root, SystemTime::now()).unwrap();

        assert!(directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn reaper_ignores_stale_import_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let scope = root.join("connector/connection");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&scope).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), "keep").unwrap();
        std::os::unix::fs::symlink(&outside, scope.join("import-escaped")).unwrap();

        reap_abandoned_imports_at(&root, SystemTime::now() + STAGED_IMPORT_TTL).unwrap();

        assert_eq!(
            fs::read_to_string(outside.join("sentinel")).unwrap(),
            "keep"
        );
        assert!(scope.join("import-escaped").is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_scope_symlinks_that_escape_the_canonical_import_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(outside.join("connection/import-escaped")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("connector")).unwrap();
        let scope = root.join("connector/connection");
        let supplied = scope.join("import-escaped");
        let sentinel = supplied.join("sentinel");
        fs::write(&sentinel, "keep").unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("export.xml"), "data").unwrap();

        assert!(validate_import_at(&root, &scope, &supplied).is_err());
        assert!(claim_import_at(&root, &supplied).is_err());
        assert!(copy_import_with_limits(&source, &root, &scope, CopyLimits::default()).is_err());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "keep");

        let root = temp.path().join("pdpp-imports-direct");
        let outside = temp.path().join("outside-direct");
        fs::create_dir_all(root.join("connector")).unwrap();
        fs::create_dir_all(outside.join("import-escaped")).unwrap();
        fs::write(outside.join("import-escaped/sentinel"), "keep").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("connector/connection")).unwrap();
        let scope = root.join("connector/connection");
        let supplied = scope.join("import-escaped");

        assert!(validate_import_at(&root, &scope, &supplied).is_err());
        assert!(claim_import_at(&root, &supplied).is_err());
        assert!(copy_import_with_limits(&source, &root, &scope, CopyLimits::default()).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("import-escaped/sentinel")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_import_root_outside_the_canonical_data_root() {
        let temp = tempfile::tempdir().unwrap();
        let data_root = temp.path().join("data");
        let outside = temp.path().join("outside");
        fs::create_dir(&data_root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), "keep").unwrap();
        std::os::unix::fs::symlink(&outside, data_root.join("pdpp-imports")).unwrap();

        assert!(ensure_real_directory_chain(&data_root, &data_root.join("pdpp-imports")).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("sentinel")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_claim_markers_without_touching_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("pdpp-imports");
        let directory = root.join("connector/connection/import-marker");
        let outside = temp.path().join("outside-marker");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&outside, "keep").unwrap();
        std::os::unix::fs::symlink(&outside, claim_marker_path(&directory).unwrap()).unwrap();

        assert!(claim_import_at(&root, &directory).is_err());
        reap_abandoned_imports_at(&root, SystemTime::now() + STAGED_IMPORT_TTL).unwrap();

        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
        assert!(directory.exists());
    }

    #[test]
    fn connector_and_connection_ids_cannot_add_path_components() {
        let temp = tempfile::tempdir().unwrap();
        let scope = import_scope(temp.path(), "../../connector", "../connection\\escape");
        assert_eq!(scope.parent().and_then(Path::parent), Some(temp.path()));
        assert!(scope.starts_with(temp.path()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nested_symlinks_and_removes_incomplete_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("export");
        fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(temp.path(), source.join("escape")).unwrap();
        let scope = import_scope(temp.path(), "connector", "connection");
        assert!(
            copy_import_with_limits(&source, temp.path(), &scope, CopyLimits::default()).is_err()
        );
        assert_eq!(fs::read_dir(scope).unwrap().count(), 0);
    }
}
