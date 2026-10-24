// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use super::{oci, oci_catalog};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tempfile::tempdir_in;

use super::connector_store::{
    activate_bundled_connector_install, get_active_connector_install, get_connectors_store_dir,
    replace_active_connector_install, ActiveConnectorInstall,
};
use super::pdpp_installed_connector::{
    host_can_run, host_unavailable_reason, validate_verified_manifest,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OciArtifact {
    pub registry: String,
    pub repository: String,
    pub digest: String,
    pub config_digest: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum PdppArtifactKind {
    #[serde(rename = "pdpp-collection-profile")]
    CollectionProfile,
}

/// One Collection Profile pinned in the bundled `connectors/lock.json`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LockedConnector {
    pub connector_id: String,
    pub company: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub manifest_sha256: String,
    pub connector_key: Option<String>,
    pub oci: OciArtifact,
    pub artifact_kind: PdppArtifactKind,
    pub manifest_path: String,
    pub entrypoint_path: String,
    pub entrypoint_sha256: String,
    pub provenance_path: String,
    pub provenance_sha256: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectorUpdateInfo {
    pub tier: String,
    #[serde(rename = "requiredBindings")]
    pub required_bindings: Vec<String>,
    #[serde(rename = "setupModality")]
    pub setup_modality: Option<String>,
    pub runnable: bool,
    #[serde(rename = "unavailableReason")]
    pub unavailable_reason: Option<String>,
    pub id: String,
    pub name: String,
    pub description: String,
    pub company: String,
    #[serde(rename = "currentVersion")]
    pub current_version: Option<String>,
    #[serde(rename = "latestVersion")]
    pub latest_version: String,
    #[serde(rename = "hasUpdate")]
    pub has_update: bool,
    #[serde(rename = "isNew")]
    pub is_new: bool,
}

#[derive(Debug, Clone)]
struct CatalogInstallMetadata {
    tier: String,
    required_bindings: Vec<String>,
    setup_modality: Option<String>,
}

impl CatalogInstallMetadata {
    fn from_catalog(entry: &oci_catalog::CatalogConnector) -> Self {
        Self {
            tier: entry.tier.clone(),
            required_bindings: entry.required_bindings(),
            setup_modality: entry.setup_modality().map(str::to_owned),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BundledConnectorLock {
    #[serde(rename = "lockVersion", deserialize_with = "supported_lock_version")]
    _lock_version: String,
    #[serde(deserialize_with = "pinned_oci_entries")]
    connectors: Vec<LockedConnector>,
}

/// Reads the pinned OCI entries of a lock. The checked-in lock still names
/// the retired script connectors, which carry neither `artifactKind` nor `oci`;
/// they are inert here and skipped. Any entry that declares an `artifactKind`
/// must be a complete pinned OCI entry, so a damaged entry still fails.
fn pinned_oci_entries<'de, D>(deserializer: D) -> Result<Vec<LockedConnector>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<serde_json::Value>::deserialize(deserializer)?;
    entries
        .into_iter()
        .filter(|entry| entry.get("artifactKind").is_some() || entry.get("oci").is_some())
        .map(|entry| serde_json::from_value(entry).map_err(serde::de::Error::custom))
        .collect()
}

fn supported_lock_version<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = String::deserialize(deserializer)?;
    let supported = version.split_once('.').is_some_and(|(major, minor)| {
        matches!(major, "1" | "2")
            && !minor.is_empty()
            && minor.bytes().all(|digit| digit.is_ascii_digit())
    });
    if !supported {
        return Err(serde::de::Error::custom(format!(
            "Unsupported connector lockVersion: {}",
            version
        )));
    }
    Ok(version)
}

fn read_bundled_lock(bundled_connectors_dir: &Path) -> Result<BundledConnectorLock, String> {
    let bytes = fs::read(bundled_connectors_dir.join("lock.json"))
        .map_err(|e| format!("Failed to read bundled connector lock: {e}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("Failed to parse bundled connector lock: {e}"))
}

fn locked_oci_reference(profile: &LockedConnector) -> Result<oci::OciReference, String> {
    let artifact = &profile.oci;
    if artifact.registry != "ghcr.io" {
        return Err("Untrusted OCI lock registry".into());
    }
    if artifact.repository.strip_prefix("pdp-connect/connector/")
        != profile.connector_key.as_deref()
    {
        return Err("OCI lock repository does not match connectorKey".into());
    }
    let reference = oci::OciReference {
        repository: artifact.repository.clone(),
        digest: artifact.digest.clone(),
        version: profile.version.clone(),
        config_digest: Some(artifact.config_digest.clone()),
    };
    oci::validate_reference(&reference)?;
    Ok(reference)
}

fn catalog_install_id<'a>(
    entry: &'a oci_catalog::CatalogConnector,
    lock: &'a BundledConnectorLock,
) -> &'a str {
    lock.connectors
        .iter()
        .find(|profile| profile.connector_key.as_deref() == Some(entry.connector_key.as_str()))
        .map(|profile| profile.connector_id.as_str())
        .unwrap_or(&entry.connector_id)
}

fn catalog_entry_for_download<'a>(
    id: &str,
    lock: &BundledConnectorLock,
    catalog: &'a oci_catalog::Catalog,
) -> Result<&'a oci_catalog::CatalogConnector, String> {
    catalog
        .connectors
        .iter()
        .find(|entry| catalog_install_id(entry, lock) == id)
        .ok_or_else(|| {
            format!(
                "Connector {id} is not available in the signed catalog; refusing bundled fallback"
            )
        })
}

fn bundled_pdpp_connector_installs(
    bundled_connectors_dir: &Path,
) -> Result<Vec<ActiveConnectorInstall>, String> {
    let lock = read_bundled_lock(bundled_connectors_dir)?;

    lock.connectors
        .iter()
        .map(|connector| {
            let connector_id = safe_store_segment(&connector.connector_id, "PDPP connector id")?;
            let install_root = bundled_connectors_dir
                .join("collection-profiles")
                .join(connector_id);
            active_pdpp_install_at(connector, &install_root)
        })
        .collect()
}

pub(crate) fn activate_bundled_pdpp_connectors(app: &AppHandle) -> Result<(), String> {
    let installs = bundled_pdpp_connector_installs(&get_bundled_connectors_dir(&app))?;
    log::info!("Activating {} bundled OCI connector(s)", installs.len());
    for install in installs {
        let existing_root_path =
            get_active_connector_install(&install.connector_id).map(|existing| existing.root_path);
        let replaced = activate_bundled_connector_install(install.clone())?;
        log::info!(
            "{}",
            bundled_activation_log_message(
                &install.connector_id,
                &install.version,
                replaced,
                existing_root_path.as_deref(),
            )
        );
    }
    Ok(())
}

fn bundled_activation_log_message(
    connector_id: &str,
    version: &str,
    replaced: bool,
    existing_root_path: Option<&str>,
) -> String {
    if replaced {
        format!("Activating bundled OCI connector {connector_id}@{version}")
    } else {
        format!(
            "Bundled OCI connector {connector_id}: kept existing install at {}",
            existing_root_path.unwrap_or("<unknown>")
        )
    }
}

fn get_bundled_connectors_dir(app: &AppHandle) -> PathBuf {
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev_path = PathBuf::from(&manifest_dir)
            .parent()
            .map(|p| p.join("connectors"))
            .unwrap_or_default();
        if dev_path.exists() {
            return dev_path;
        }
    }

    let cwd_path = std::env::current_dir()
        .unwrap_or_default()
        .join("connectors");
    if cwd_path.exists() {
        return cwd_path;
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(project_root) = exe_path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let dev_path = project_root.join("connectors");
            if dev_path.exists() {
                return dev_path;
            }
        }
    }

    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let up_path = resource_dir.join("_up_").join("connectors");
    if up_path.exists() {
        return up_path;
    }

    resource_dir.join("connectors")
}

fn get_installed_connector_version(connector_id: &str) -> Option<String> {
    get_active_connector_install(connector_id).map(|install| install.version)
}

fn parse_version(version: &str) -> Option<Version> {
    Version::parse(version).ok()
}

fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_version(current), parse_version(latest)) {
        (Some(current), Some(latest)) => latest > current,
        _ => false,
    }
}

fn calculate_checksum(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    format!("sha256:{}", hex::encode(result))
}

fn normalize_archive_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => {
                return Err(format!(
                    "Artifact entry escapes bundle root: {}",
                    path.display()
                ))
            }
        }
    }
    Ok(normalized)
}

fn normalize_nonempty_artifact_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let normalized = normalize_archive_path(Path::new(path))?;
    if normalized.as_os_str().is_empty() {
        return Err(format!("{} must name a file", label));
    }
    Ok(normalized)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
    }
    fs::write(path, bytes).map_err(|e| format!("Failed to write {:?}: {}", path, e))
}

#[tauri::command]
pub async fn check_connector_updates(app: AppHandle) -> Result<Vec<ConnectorUpdateInfo>, String> {
    let lock = read_bundled_lock(&get_bundled_connectors_dir(&app))?;
    let catalog = match oci_catalog::fetch_catalog().await {
        Ok(catalog) => Some(catalog),
        Err(error) => {
            log::warn!("OCI connector discovery unavailable: {error}");
            None
        }
    };
    let mut updates = Vec::new();
    if let Some(catalog) = &catalog {
        for connector in &catalog.connectors {
            let id = catalog_install_id(connector, &lock);
            let locked = lock
                .connectors
                .iter()
                .find(|entry| entry.connector_id == id);
            let company = locked
                .map(|entry| entry.company.clone())
                .unwrap_or_else(|| connector.connector_key.clone());
            let catalog_metadata = CatalogInstallMetadata::from_catalog(connector);
            let required_bindings = catalog_metadata.required_bindings.clone();
            let setup_modality = catalog_metadata.setup_modality.clone();
            let current_version = get_installed_connector_version(id);
            let has_update = current_version
                .as_ref()
                .is_some_and(|version| is_newer_version(version, &connector.latest.version));
            let is_new = current_version.is_none();
            let runnable = host_can_run(&required_bindings, setup_modality.as_deref());
            let unavailable_reason =
                host_unavailable_reason(&required_bindings, setup_modality.as_deref());
            if has_update || is_new || !runnable {
                updates.push(ConnectorUpdateInfo {
                    tier: catalog_metadata.tier,
                    required_bindings,
                    setup_modality,
                    runnable,
                    unavailable_reason,
                    id: id.to_string(),
                    name: connector.display_name.clone(),
                    description: locked
                        .map(|entry| entry.description.clone())
                        .unwrap_or_default(),
                    company,
                    current_version,
                    latest_version: connector.latest.version.clone(),
                    has_update,
                    is_new,
                });
            }
        }
    }
    log::info!("Found {} connector updates", updates.len());
    Ok(updates)
}

#[tauri::command]
pub async fn download_connector(app: AppHandle, id: String) -> Result<(), String> {
    log::info!("=== Starting connector download: {} ===", id);
    let lock = read_bundled_lock(&get_bundled_connectors_dir(&app))?;
    let bundled = lock
        .connectors
        .iter()
        .find(|entry| entry.connector_id == id);
    let locked_profile = match bundled {
        Some(profile) => {
            locked_oci_reference(profile)?;
            Some(profile)
        }
        None => None,
    };
    // This command installs the latest advertised update. Never substitute the older
    // bundled lock if discovery fails between checking updates and downloading one.
    let catalog = oci_catalog::fetch_catalog().await?;
    let entry = catalog_entry_for_download(&id, &lock, &catalog)?;
    let matching_lock = locked_profile.filter(|profile| profile.oci.digest == entry.latest.digest);
    let reference = oci::OciReference {
        repository: format!("pdp-connect/connector/{}", entry.connector_key),
        digest: entry.latest.digest.clone(),
        version: entry.latest.version.clone(),
        config_digest: matching_lock.map(|profile| profile.oci.config_digest.clone()),
    };
    let catalog_metadata = CatalogInstallMetadata::from_catalog(entry);
    if let Some(reason) = host_unavailable_reason(
        &catalog_metadata.required_bindings,
        catalog_metadata.setup_modality.as_deref(),
    ) {
        return Err(reason);
    }
    let artifact = oci::download_verified(&reference).await?;
    if artifact.config["connector_id"].as_str() != Some(entry.connector_id.as_str()) {
        return Err("Catalog connector identity does not match OCI artifact".into());
    }
    let company = bundled
        .map(|entry| entry.company.as_str())
        .unwrap_or(&entry.connector_key);
    install_oci_artifact(
        &id,
        &entry.connector_id,
        company,
        &entry.display_name,
        &reference,
        artifact,
        matching_lock,
    )
    .await
}

async fn install_oci_artifact(
    id: &str,
    manifest_connector_id: &str,
    company: &str,
    name: &str,
    reference: &oci::OciReference,
    artifact: oci::VerifiedArtifact,
    locked: Option<&LockedConnector>,
) -> Result<(), String> {
    let (id, manifest_connector_id, company, name) = (
        id.to_owned(),
        manifest_connector_id.to_owned(),
        company.to_owned(),
        name.to_owned(),
    );
    let reference = reference.clone();
    let locked = locked.cloned();
    tokio::task::spawn_blocking(move || {
        let store_dir =
            get_connectors_store_dir().ok_or("Could not determine connectors store directory")?;
        let install = install_oci_artifact_into(
            &id,
            &manifest_connector_id,
            &company,
            &name,
            &reference,
            artifact,
            locked.as_ref(),
            &store_dir,
        )?;
        replace_active_connector_install(install)
    })
    .await
    .map_err(|e| format!("OCI install task failed: {e}"))?
}

fn install_oci_artifact_into(
    id: &str,
    manifest_connector_id: &str,
    company: &str,
    name: &str,
    reference: &oci::OciReference,
    artifact: oci::VerifiedArtifact,
    locked: Option<&LockedConnector>,
    store_dir: &Path,
) -> Result<ActiveConnectorInstall, String> {
    if artifact.manifest_digest != reference.digest {
        return Err("Verified OCI artifact does not match requested manifest".into());
    }
    if artifact.config["connector_id"].as_str() != Some(manifest_connector_id) {
        return Err("OCI artifact connector URI does not match verified manifest URI".into());
    }
    validate_verified_manifest(&reference.version, manifest_connector_id, &artifact.profile)?;
    // The registry key and desktop install id differ for bundled aliases such as github-pdpp.
    // Bind the repository key to the profile while keeping the caller's connector_id as the store key.
    let key = reference
        .repository
        .strip_prefix("pdp-connect/connector/")
        .ok_or("Untrusted OCI repository")?;
    if artifact.config["connector_key"].as_str() != Some(key) {
        return Err("OCI connector key mismatch".into());
    }
    if let Some(locked) = locked {
        if locked.connector_key.as_deref() != Some(key) {
            return Err("OCI repository does not match locked connectorKey".into());
        }
        verify_named_checksum(
            &artifact.profile,
            &locked.manifest_sha256,
            "locked OCI profile",
        )?;
        verify_named_checksum(
            &artifact.provenance,
            &locked.provenance_sha256,
            "locked OCI provenance",
        )?;
    }
    let entrypoint_path = normalize_nonempty_artifact_path(
        &artifact.entrypoint_path.to_string_lossy(),
        "OCI entrypoint path",
    )?;
    let entrypoint = artifact
        .files
        .iter()
        .find(|(path, _)| path == &entrypoint_path)
        .map(|(_, bytes)| bytes)
        .ok_or("OCI entrypoint missing from install files")?;
    if let Some(locked) = locked {
        verify_named_checksum(
            entrypoint,
            &locked.entrypoint_sha256,
            "locked OCI entrypoint",
        )?;
    }
    let connector = LockedConnector {
        connector_id: id.to_string(),
        company: company.to_string(),
        version: reference.version.clone(),
        name: name.to_string(),
        description: String::new(),
        manifest_sha256: calculate_checksum(&artifact.profile),
        connector_key: Some(key.to_string()),
        oci: OciArtifact {
            registry: "ghcr.io".into(),
            repository: reference.repository.clone(),
            digest: reference.digest.clone(),
            config_digest: artifact.config_digest,
        },
        artifact_kind: PdppArtifactKind::CollectionProfile,
        manifest_path: "profile/collection-profile.json".into(),
        entrypoint_path: entrypoint_path.to_string_lossy().into_owned(),
        entrypoint_sha256: calculate_checksum(entrypoint),
        provenance_path: "provenance.json".into(),
        provenance_sha256: calculate_checksum(&artifact.provenance),
    };
    let version = safe_store_segment(&connector.version, "OCI connector version")?;
    let connector_dir = store_dir.join(oci_store_segment(id)?);
    fs::create_dir_all(&connector_dir)
        .map_err(|e| format!("Create OCI connector directory: {e}"))?;
    let install_root = connector_dir.join(version);
    let parent = install_root.parent().ok_or("Missing OCI install parent")?;
    // Serialize promotion of the same version; never overwrite an existing tree on Unix rename.
    let lock_file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join(".install.lock"))
        .map_err(|e| format!("Open OCI install lock: {e}"))?;
    fs2::FileExt::lock_exclusive(&lock_file).map_err(|e| format!("Lock OCI install: {e}"))?;
    if !install_root.exists() {
        promote_staged_install(parent, &install_root, |staged| {
            for (path, bytes) in &artifact.files {
                let path =
                    normalize_nonempty_artifact_path(&path.to_string_lossy(), "OCI install path")?;
                write_bytes(&staged.join(path), bytes)?;
            }
            verify_oci_install_files(staged, &artifact.files)?;
            active_pdpp_install_at(&connector, staged)?;
            Ok(())
        })?;
    } else {
        verify_oci_install_files(&install_root, &artifact.files)?;
    }
    active_pdpp_install_at(&connector, &install_root)
}

fn verify_oci_install_files(
    install_root: &Path,
    files: &[(PathBuf, Vec<u8>)],
) -> Result<(), String> {
    let root_metadata = fs::symlink_metadata(install_root)
        .map_err(|e| format!("Read OCI install root metadata: {e}"))?;
    if !root_metadata.file_type().is_dir() {
        return Err("OCI install root is not a directory".into());
    }

    for (relative, expected) in files {
        let relative = normalize_nonempty_artifact_path(
            &relative.to_string_lossy(),
            "OCI installed file path",
        )?;
        let mut current = install_root.to_path_buf();
        let components = relative.components().collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            current.push(component.as_os_str());
            let metadata = fs::symlink_metadata(&current).map_err(|e| {
                format!(
                    "Read OCI installed file {} metadata: {e}",
                    relative.display()
                )
            })?;
            let is_last = index + 1 == components.len();
            if is_last {
                if !metadata.file_type().is_file() {
                    return Err(format!(
                        "OCI installed file {} is not a regular file",
                        relative.display()
                    ));
                }
                let actual = fs::read(&current)
                    .map_err(|e| format!("Read OCI installed file {}: {e}", relative.display()))?;
                if actual != *expected {
                    return Err(format!(
                        "OCI installed file {} does not match verified bytes",
                        relative.display()
                    ));
                }
            } else if !metadata.file_type().is_dir() {
                return Err(format!(
                    "OCI installed path component {} is not a directory",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

fn oci_store_segment(id: &str) -> Result<String, String> {
    if safe_store_segment(id, "OCI connector id").is_ok() && !id.contains('%') {
        return Ok(id.to_string());
    }
    // URI connector ids stay intact in connectors-active.json. Encode them only at the
    // filesystem boundary, preserving the directory names of existing bundled aliases.
    let uri = reqwest::Url::parse(id).map_err(|_| "Invalid OCI connector id")?;
    if uri.scheme() != "https"
        || uri.host_str().is_none()
        || !uri.username().is_empty()
        || uri.password().is_some()
    {
        return Err("Invalid OCI connector id".into());
    }
    let mut segment = String::new();
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            segment.push(byte as char);
        } else {
            segment.push_str(&format!("%{byte:02X}"));
        }
    }
    if segment.len() > 240 {
        return Err("OCI connector id exceeds filesystem limit".into());
    }
    Ok(segment)
}

fn safe_store_segment<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    if value.contains(['\\', '/', ':', '\0']) || matches!(value, "." | "..") {
        return Err(format!("{} must be a single safe path segment", label));
    }
    let mut components = Path::new(value).components();
    let segment = match (components.next(), components.next()) {
        (Some(Component::Normal(segment)), None) => segment,
        _ => return Err(format!("{} must be a single safe path segment", label)),
    };
    segment
        .to_str()
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| format!("{} must be valid UTF-8", label))
}

fn promote_staged_install(
    connector_store_dir: &Path,
    install_root: &Path,
    write_staged: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let temp_dir = tempdir_in(connector_store_dir)
        .map_err(|e| format!("Failed to create connector staging directory: {}", e))?;
    write_staged(temp_dir.path())?;
    fs::rename(temp_dir.path(), install_root).map_err(|e| {
        format!(
            "Failed to promote staged connector artifact into {:?}: {}",
            install_root, e
        )
    })
}

#[derive(Deserialize)]
struct PdppManifestIdentity {
    version: String,
    connector_id: String,
}

fn active_pdpp_install_at(
    connector: &LockedConnector,
    install_root: &Path,
) -> Result<ActiveConnectorInstall, String> {
    let common = connector;
    let manifest_relative =
        normalize_nonempty_artifact_path(&connector.manifest_path, "PDPP manifest path")?;
    let entrypoint_relative =
        normalize_nonempty_artifact_path(&connector.entrypoint_path, "PDPP entrypoint path")?;
    let provenance_relative =
        normalize_nonempty_artifact_path(&connector.provenance_path, "PDPP provenance path")?;

    verify_installed_file(
        &install_root.join(&manifest_relative),
        &common.manifest_sha256,
        "installed PDPP manifest",
    )?;
    verify_installed_file(
        &install_root.join(&entrypoint_relative),
        &connector.entrypoint_sha256,
        "installed PDPP entrypoint",
    )?;
    verify_installed_file(
        &install_root.join(&provenance_relative),
        &connector.provenance_sha256,
        "installed PDPP provenance",
    )?;

    let manifest_bytes = fs::read(install_root.join(&manifest_relative))
        .map_err(|e| format!("Failed to read installed PDPP manifest: {}", e))?;
    let manifest: PdppManifestIdentity = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Failed to parse installed PDPP manifest: {}", e))?;
    if manifest.version != common.version {
        return Err(format!(
            "Installed PDPP version mismatch. Expected {}, got {}",
            common.version, manifest.version
        ));
    }

    Ok(ActiveConnectorInstall {
        connector_id: common.connector_id.clone(),
        manifest_connector_id: Some(manifest.connector_id),
        company: common.company.clone(),
        version: common.version.clone(),
        root_path: install_root.to_string_lossy().into_owned(),
        metadata_relative_path: manifest_relative.to_string_lossy().into_owned(),
        script_relative_path: entrypoint_relative.to_string_lossy().into_owned(),
        artifact_kind: Some("pdpp-collection-profile".to_string()),
        artifact_digest: Some(connector.oci.digest.clone()),
        manifest_path: Some(manifest_relative.to_string_lossy().into_owned()),
        entrypoint_path: Some(entrypoint_relative.to_string_lossy().into_owned()),
        entrypoint_sha256: Some(connector.entrypoint_sha256.clone()),
        manifest_sha256: Some(common.manifest_sha256.clone()),
        provenance_path: Some(provenance_relative.to_string_lossy().into_owned()),
        provenance_sha256: Some(connector.provenance_sha256.clone()),
    })
}

fn verify_named_checksum(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    let actual = calculate_checksum(bytes);
    if actual != expected {
        return Err(format!(
            "{} checksum verification failed. Expected: {}, Got: {}",
            label, expected, actual
        ));
    }
    Ok(())
}

fn verify_installed_file(path: &Path, expected: &str, label: &str) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", label, e))?;
    verify_named_checksum(&bytes, expected, label)
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_activation_log_message, bundled_pdpp_connector_installs, calculate_checksum,
        BundledConnectorLock, LockedConnector,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn oci_fixture(version: &str) -> (super::oci::OciReference, super::oci::VerifiedArtifact) {
        oci_fixture_for(version, "https://registry.pdpp.dev/connectors/github")
    }

    fn catalog_metadata() -> super::CatalogInstallMetadata {
        super::CatalogInstallMetadata {
            tier: "supported".into(),
            required_bindings: vec!["network".into()],
            setup_modality: None,
        }
    }

    fn oci_fixture_for(
        version: &str,
        connector_id: &str,
    ) -> (super::oci::OciReference, super::oci::VerifiedArtifact) {
        let profile = serde_json::to_vec(&json!({
            "version": version,
            "connector_key": "github",
            "connector_id": connector_id,
            "runtime_requirements": { "bindings": { "network": { "required": true } } },
            "streams": [{ "name": "records" }],
        }))
        .unwrap();
        let provenance = b"{}".to_vec();
        (
            super::oci::OciReference {
                repository: "pdp-connect/connector/github".into(),
                digest: format!("sha256:{}", "a".repeat(64)),
                version: version.into(),
                config_digest: None,
            },
            super::oci::VerifiedArtifact {
                config: json!({"connector_key":"github", "connector_id":connector_id}),
                profile: profile.clone(),
                provenance: provenance.clone(),
                entrypoint_path: PathBuf::from("dist/collection-profile.mjs"),
                files: vec![
                    ("profile/collection-profile.json".into(), profile),
                    (
                        "dist/collection-profile.mjs".into(),
                        b"export default {};".to_vec(),
                    ),
                    ("provenance.json".into(), provenance),
                    ("licenses/LICENSE".into(), b"Apache-2.0".to_vec()),
                ],
                manifest_digest: format!("sha256:{}", "a".repeat(64)),
                config_digest: format!("sha256:{}", "b".repeat(64)),
            },
        )
    }

    #[tokio::test]
    #[ignore = "manual read-only GHCR smoke; requires network"]
    async fn live_ynab_oci_smoke() {
        let reference = super::oci::OciReference {
            repository: "pdp-connect/connector/ynab".into(),
            digest: "sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad"
                .into(),
            version: "0.3.0".into(),
            config_digest: None,
        };
        let artifact = super::oci::download_verified(&reference)
            .await
            .expect("verify published YNAB artifact");
        let root = tempdir().unwrap();
        let count = artifact.files.len();
        let install = super::install_oci_artifact_into(
            "ynab-pdpp",
            "https://registry.pdpp.dev/connectors/ynab",
            "ynab",
            "YNAB",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .unwrap();
        println!("Verified {}@{}; version {}; installed {} files under {}; manifest {}; entrypoint {}; provenance {}", reference.repository, reference.digest, install.version, count, root.path().display(), install.manifest_sha256.unwrap(), install.entrypoint_sha256.unwrap(), install.provenance_sha256.unwrap());
    }

    #[test]
    fn b2_t4_oci_install_is_atomic_and_preserves_existing_and_user_trees() {
        let root = tempdir().unwrap();
        let store = root.path().join("connectors-store");
        let user = root.path().join("connectors/github");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("github-pdpp.js"), b"user code").unwrap();
        let (reference, artifact) = oci_fixture("1.0.0");
        let install = super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact.clone(),
            None,
            &store,
        )
        .unwrap();
        assert_eq!(install.connector_id, "github-pdpp");
        assert_eq!(
            install.manifest_connector_id.as_deref(),
            Some("https://registry.pdpp.dev/connectors/github")
        );
        assert_eq!(
            PathBuf::from(&install.root_path),
            store.join("github-pdpp/1.0.0")
        );
        assert_eq!(
            std::fs::read(store.join("github-pdpp/1.0.0/licenses/LICENSE")).unwrap(),
            b"Apache-2.0"
        );
        let (next, mut broken) = oci_fixture("2.0.0");
        broken
            .files
            .retain(|(path, _)| path != std::path::Path::new("provenance.json"));
        assert!(super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &next,
            broken,
            None,
            &store,
        )
        .is_err());
        assert!(!store.join("github-pdpp/2.0.0").exists());
        assert_eq!(
            std::fs::read(store.join("github-pdpp/1.0.0/dist/collection-profile.mjs")).unwrap(),
            b"export default {};"
        );
        assert_eq!(
            std::fs::read(user.join("github-pdpp.js")).unwrap(),
            b"user code"
        );
        let entries = std::fs::read_dir(store.join("github-pdpp"))
            .unwrap()
            .count();
        assert_eq!(entries, 2, "only completed version and install lock remain");

        // Existing data is verified, never replaced, even when offered the same version again.
        let script_path = store.join("github-pdpp/1.0.0/dist/collection-profile.mjs");
        std::fs::write(&script_path, b"user modified store").unwrap();
        assert!(super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            &store,
        )
        .is_err());
        assert_eq!(std::fs::read(script_path).unwrap(), b"user modified store");
    }

    #[test]
    fn oci_install_rejects_artifact_with_a_different_connector_id() {
        let root = tempdir().unwrap();
        let (reference, mut artifact) = oci_fixture("1.0.0");
        artifact.config["connector_id"] = json!("another-connector");
        let profile = serde_json::to_vec(&json!({
            "version": "1.0.0",
            "connector_key": "github",
            "connector_id": "another-connector",
        }))
        .unwrap();
        artifact.profile = profile.clone();
        artifact.files[0].1 = profile;

        let error = super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .expect_err("artifact identity must match the verified manifest URI");
        assert!(error.contains("connector URI"));
    }

    #[test]
    fn oci_install_uses_the_declared_entrypoint_path() {
        let root = tempdir().unwrap();
        let (reference, mut artifact) = oci_fixture("1.0.0");
        artifact.entrypoint_path = PathBuf::from("dist/nested/runner.mjs");
        artifact.files[1].0 = artifact.entrypoint_path.clone();

        let install = super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .expect("declared entrypoint should be installed");
        assert_eq!(
            install.entrypoint_path.as_deref(),
            Some("dist/nested/runner.mjs")
        );
        assert!(PathBuf::from(&install.root_path)
            .join("dist/nested/runner.mjs")
            .is_file());
    }

    #[test]
    fn oci_reinstall_refuses_modified_auxiliary_files() {
        let root = tempdir().unwrap();
        let (reference, artifact) = oci_fixture("1.0.0");
        super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact.clone(),
            None,
            root.path(),
        )
        .expect("initial OCI install");

        let license = root.path().join("github-pdpp/1.0.0/licenses/LICENSE");
        std::fs::remove_file(&license).unwrap();
        let error = super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/github",
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .expect_err("reinstall must verify every OCI file");
        assert!(error.contains("licenses/LICENSE"));
        assert!(!license.exists());
    }

    #[test]
    fn oci_manifest_uri_stays_separate_from_activation_alias() {
        let root = tempdir().unwrap();
        let install_id = "github-pdpp";
        let manifest_id = "https://registry.pdpp.dev/connectors/github";
        let (reference, artifact) = oci_fixture_for("1.0.0", manifest_id);
        let install = super::install_oci_artifact_into(
            install_id,
            manifest_id,
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .unwrap();
        assert_eq!(install.connector_id, install_id);
        assert_eq!(install.manifest_connector_id.as_deref(), Some(manifest_id));
        assert_eq!(
            PathBuf::from(install.root_path)
                .strip_prefix(root.path())
                .unwrap()
                .components()
                .count(),
            2
        );
        for id in [
            "../escape",
            "a\\b",
            "C:drive",
            "https://user:secret@example.com/id",
        ] {
            assert!(super::oci_store_segment(id).is_err(), "{id}");
        }
    }

    #[test]
    fn unbundled_oci_uri_uses_a_safe_store_path() {
        let root = tempdir().unwrap();
        let manifest_id = "https://registry.pdpp.dev/connectors/unbundled";
        let (reference, artifact) = oci_fixture_for("1.0.0", manifest_id);
        let install = super::install_oci_artifact_into(
            manifest_id,
            manifest_id,
            "unbundled",
            "Unbundled",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .unwrap();
        assert_eq!(install.connector_id, manifest_id);
        assert!(PathBuf::from(&install.root_path).starts_with(root.path()));
        assert!(!install.root_path.contains(manifest_id));
    }

    #[test]
    fn oci_install_rejects_a_wrong_verified_manifest_uri() {
        let root = tempdir().unwrap();
        let (reference, artifact) = oci_fixture("1.0.0");
        let error = super::install_oci_artifact_into(
            "github-pdpp",
            "https://registry.pdpp.dev/connectors/other",
            "github",
            "GitHub",
            &reference,
            artifact,
            None,
            root.path(),
        )
        .expect_err("the catalog URI must match the verified artifact URI");
        assert!(error.contains("connector URI"));
    }

    #[test]
    fn catalog_metadata_drives_listing_admission_without_lock_fallbacks() {
        let manual: super::oci_catalog::CatalogConnector = serde_json::from_value(json!({
            "connector_key":"manual-source",
            "connector_id":"https://registry.pdpp.dev/connectors/manual-source",
            "display_name":"Manual source",
            "tier":"supported",
            "runtime_requirements":{"bindings":{"filesystem":{"required":true}}},
            "setup":{"modality":"manual_or_upload"},
            "latest":{"version":"1.0.0","digest":"sha256:test"},
            "versions":[{"version":"1.0.0","digest":"sha256:test"}]
        }))
        .unwrap();
        let metadata = super::CatalogInstallMetadata::from_catalog(&manual);
        assert_eq!(metadata.tier, "supported");
        assert_eq!(metadata.required_bindings, ["filesystem"]);
        assert_eq!(metadata.setup_modality.as_deref(), Some("manual_or_upload"));
        assert!(super::host_can_run(
            &metadata.required_bindings,
            metadata.setup_modality.as_deref()
        ));

        let desktop_only: super::oci_catalog::CatalogConnector = serde_json::from_value(json!({
            "connector_key":"desktop-source",
            "connector_id":"https://registry.pdpp.dev/connectors/desktop-source",
            "display_name":"Desktop source",
            "tier":"supported",
            "runtime_requirements":{"bindings":{"desktop_session":{"required":true}}},
            "setup":null,
            "latest":{"version":"1.0.0","digest":"sha256:test"},
            "versions":[{"version":"1.0.0","digest":"sha256:test"}]
        }))
        .unwrap();
        let metadata = super::CatalogInstallMetadata::from_catalog(&desktop_only);
        assert!(!super::host_can_run(
            &metadata.required_bindings,
            metadata.setup_modality.as_deref()
        ));
        assert_eq!(
            super::host_unavailable_reason(
                &metadata.required_bindings,
                metadata.setup_modality.as_deref()
            )
            .as_deref(),
            Some("Requires unavailable binding: desktop_session")
        );
    }

    #[test]
    fn bundled_activation_log_names_the_install_it_kept() {
        assert_eq!(
            bundled_activation_log_message(
                "github-pdpp",
                "0.5.0",
                false,
                Some("/home/test/.dataconnect/connectors-store/github-pdpp/0.5.0"),
            ),
            "Bundled OCI connector github-pdpp: kept existing install at /home/test/.dataconnect/connectors-store/github-pdpp/0.5.0"
        );
        assert_eq!(
            bundled_activation_log_message("github-pdpp", "0.5.0", true, None),
            "Activating bundled OCI connector github-pdpp@0.5.0"
        );
    }

    #[test]
    fn host_binding_predicate_table() {
        use super::host_can_run;
        for (bindings, setup, runnable) in [
            (vec!["network"], None, true),
            (vec!["network", "browser"], Some("static_secret"), true),
            (vec!["network", "filesystem"], None, true),
            (vec!["network", "desktop_session"], None, false),
            (vec!["network", "unknown"], None, false),
            (vec!["network"], Some("manual_or_upload"), false),
            (vec!["filesystem"], Some("manual_or_upload"), true),
            (vec!["network"], Some("unknown_setup"), false),
            (vec![], None, false),
        ] {
            let bindings: Vec<String> = bindings.into_iter().map(String::from).collect();
            assert_eq!(
                host_can_run(&bindings, setup),
                runnable,
                "{bindings:?}, {setup:?}"
            );
        }
    }

    #[test]
    fn b_t3_rust_refuses_unknown_lock_major() {
        for version in ["0.0", "3.0", "20.0", "future", "2", "2.", "2.bad", "2.0.1"] {
            let error = serde_json::from_value::<BundledConnectorLock>(json!({
                "lockVersion": version, "connectors": []
            }))
            .expect_err("unknown lock major must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("Unsupported connector lockVersion"),
                "{error}"
            );
        }
        for version in ["1.0", "2.0", "2.1"] {
            serde_json::from_value::<BundledConnectorLock>(json!({
                "lockVersion": version, "connectors": []
            }))
            .expect("supported lock major");
        }
    }

    #[test]
    fn bundled_lock_activates_only_hash_verified_pdpp_profiles() {
        let manifest = br#"{"version":"0.5.0","connector_id":"https://registry.pdpp.org/connectors/github","connector_key":"github"}"#;
        let entrypoint = b"export default {};\n";
        let provenance = br#"{"upstream":{"commit":"test"}}"#;
        let temp = tempdir().expect("bundled connector tempdir");
        let install_root = temp.path().join("collection-profiles/github-pdpp");
        std::fs::create_dir_all(install_root.join("profile")).expect("manifest directory");
        std::fs::create_dir_all(install_root.join("dist")).expect("entrypoint directory");
        std::fs::write(
            install_root.join("profile/collection-profile.json"),
            manifest,
        )
        .expect("manifest");
        std::fs::write(install_root.join("dist/collection-profile.mjs"), entrypoint)
            .expect("entrypoint");
        std::fs::write(install_root.join("provenance.json"), provenance).expect("provenance");
        std::fs::write(
            temp.path().join("lock.json"),
            serde_json::to_vec(&v2_lock(manifest, entrypoint, provenance)).expect("lock JSON"),
        )
        .expect("lock file");

        let installs = bundled_pdpp_connector_installs(temp.path()).expect("bundled installs");
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].connector_id, "github-pdpp");
        assert_eq!(PathBuf::from(&installs[0].root_path), install_root);
        assert!(!temp.path().join("collection-profiles/github").exists());
        assert_eq!(
            installs[0].entrypoint_sha256.as_deref(),
            Some(calculate_checksum(entrypoint).as_str())
        );
        assert_eq!(
            installs[0].manifest_connector_id.as_deref(),
            Some("https://registry.pdpp.org/connectors/github")
        );

        std::fs::write(
            install_root.join("dist/collection-profile.mjs"),
            b"tampered",
        )
        .expect("tampered entrypoint");
        let error = bundled_pdpp_connector_installs(temp.path())
            .expect_err("bundled profiles must match the pinned lock");
        assert!(error.contains("checksum verification failed"), "{error}");
    }

    #[test]
    fn checked_in_bundled_lock_resolves_all_oci_profiles() {
        let bundled_connectors = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("DataConnect repository root")
            .join("connectors");
        let installs = bundled_pdpp_connector_installs(&bundled_connectors)
            .expect("checked-in bundled profiles must match their lock hashes");
        let mut connector_ids = installs
            .iter()
            .map(|install| install.connector_id.as_str())
            .collect::<Vec<_>>();
        connector_ids.sort_unstable();
        assert_eq!(
            connector_ids,
            [
                "apple-health-pdpp",
                "chatgpt-pdpp",
                "github-pdpp",
                "ynab-pdpp"
            ]
        );
    }

    fn locked_profile(manifest: &[u8], entrypoint: &[u8], provenance: &[u8]) -> serde_json::Value {
        json!({
            "connectorId": "github-pdpp",
            "connectorKey": "github",
            "company": "github",
            "version": "0.5.0",
            "name": "GitHub (PDPP Collection Profile)",
            "description": "Collects GitHub data through PDPP.",
            "artifactKind": "pdpp-collection-profile",
            "manifestPath": "profile/collection-profile.json",
            "entrypointPath": "dist/collection-profile.mjs",
            "provenancePath": "provenance.json",
            "manifestSha256": calculate_checksum(manifest),
            "entrypointSha256": calculate_checksum(entrypoint),
            "provenanceSha256": calculate_checksum(provenance),
            "oci": {
                "registry": "ghcr.io",
                "repository": "pdp-connect/connector/github",
                "digest": format!("sha256:{}", "a".repeat(64)),
                "configDigest": format!("sha256:{}", "b".repeat(64))
            }
        })
    }

    fn v2_lock(manifest: &[u8], entrypoint: &[u8], provenance: &[u8]) -> serde_json::Value {
        json!({
            "lockVersion": "2.0",
            "connectors": [locked_profile(manifest, entrypoint, provenance)]
        })
    }

    #[test]
    fn rust_deserializes_v2_collection_profile_lock() {
        let lock: BundledConnectorLock =
            serde_json::from_value(v2_lock(b"m", b"e", b"p")).expect("v2 lock");
        let profile = &lock.connectors[0];
        assert_eq!(profile.connector_key.as_deref(), Some("github"));
        assert_eq!(profile.oci.registry, "ghcr.io");
        assert_eq!(profile.oci.repository, "pdp-connect/connector/github");
    }

    #[test]
    fn lock_skips_script_entries_and_rejects_unknown_artifact_kinds() {
        // A script.js/manifest.json entry has no artifactKind and no OCI
        // coordinates. It cannot be installed, so the lock ignores it.
        let mut lock = v2_lock(b"m", b"e", b"p");
        let pinned = lock["connectors"].as_array().unwrap().len();
        lock["connectors"].as_array_mut().unwrap().push(json!({
            "connectorId": "example-script",
            "company": "example",
            "version": "1.0.0",
            "name": "Example",
            "description": "Script entry",
            "sourceFiles": { "metadata": "example/example.json", "script": "example/example.js" },
            "manifestSha256": calculate_checksum(b"manifest"),
            "scriptSha256": calculate_checksum(b"script"),
            "artifactSha256": calculate_checksum(b"artifact"),
            "artifactUrl": "https://example.com/example-1.0.0.tgz"
        }));
        let parsed = serde_json::from_value::<BundledConnectorLock>(lock).unwrap();
        assert_eq!(parsed.connectors.len(), pinned);

        let mut lock = v2_lock(b"m", b"e", b"p");
        lock["connectors"][0]["artifactKind"] = json!("future-artifact-kind");
        assert!(serde_json::from_value::<BundledConnectorLock>(lock).is_err());

        let mut lock = v2_lock(b"m", b"e", b"p");
        lock["connectors"][0].as_object_mut().unwrap().remove("oci");
        assert!(serde_json::from_value::<BundledConnectorLock>(lock).is_err());
    }

    #[test]
    fn catalog_outage_never_falls_back_to_the_bundled_lock() {
        let lock: BundledConnectorLock = serde_json::from_value(v2_lock(b"m", b"e", b"p")).unwrap();
        let entry: super::oci_catalog::CatalogConnector = serde_json::from_value(json!({
            "connector_key":"github", "connector_id":"https://registry.pdpp.dev/connectors/github", "display_name":"GitHub",
            "tier":"supported",
            "runtime_requirements":{"bindings":{"network":{"required":true}}},
            "setup":null,
            "latest":{"version":"1.0.0","digest":"sha256:test"}, "versions":[]
        })).unwrap();
        assert_eq!(super::catalog_install_id(&entry, &lock), "github-pdpp");
        let empty: super::oci_catalog::Catalog = serde_json::from_value(json!({
            "catalog_version":"1.0", "generated_at":"2026-09-15T12:00:00Z", "source_commit":"test", "connectors":[]
        })).unwrap();
        assert!(
            super::catalog_entry_for_download("github-pdpp", &lock, &empty)
                .unwrap_err()
                .contains("refusing bundled fallback")
        );
    }

    #[test]
    fn oci_lock_coordinates_are_checked_before_network_access() {
        let mut profile: LockedConnector =
            serde_json::from_value(locked_profile(b"", b"", b"")).unwrap();
        assert!(super::locked_oci_reference(&profile).is_ok());
        profile.oci.registry = "attacker.example".into();
        assert!(super::locked_oci_reference(&profile)
            .unwrap_err()
            .contains("registry"));
        profile.oci.registry = "ghcr.io".into();
        profile.oci.repository = "pdp-connect/connector/ynab".into();
        assert!(super::locked_oci_reference(&profile)
            .unwrap_err()
            .contains("connectorKey"));
        profile.oci.repository = "pdp-connect/connector/github".into();
        profile.oci.config_digest = "not-a-digest".into();
        assert!(super::locked_oci_reference(&profile)
            .unwrap_err()
            .contains("config digest"));
    }
}
