// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::NamedTempFile;

static ACTIVE_CONNECTOR_MANIFEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConnectorManifest {
    pub version: String,
    pub updated_at: String,
    pub connectors: HashMap<String, ActiveConnectorInstall>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConnectorInstall {
    pub connector_id: String,
    pub company: String,
    pub version: String,
    pub root_path: String,
    pub metadata_relative_path: String,
    pub script_relative_path: String,
    #[serde(default)]
    pub artifact_kind: Option<String>,
    #[serde(default)]
    pub manifest_path: Option<String>,
    #[serde(default)]
    pub entrypoint_path: Option<String>,
    #[serde(default)]
    pub entrypoint_sha256: Option<String>,
    #[serde(default)]
    pub manifest_sha256: Option<String>,
    #[serde(default)]
    pub provenance_path: Option<String>,
    #[serde(default)]
    pub provenance_sha256: Option<String>,
}

pub fn get_dataconnect_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".dataconnect"))
}

pub fn get_legacy_user_connectors_dir() -> Option<PathBuf> {
    Some(get_dataconnect_dir()?.join("connectors"))
}

pub fn get_connectors_store_dir() -> Option<PathBuf> {
    Some(get_dataconnect_dir()?.join("connectors-store"))
}

pub fn get_active_manifest_path() -> Option<PathBuf> {
    Some(get_dataconnect_dir()?.join("connectors-active.json"))
}

pub fn read_active_connector_manifest() -> Option<ActiveConnectorManifest> {
    let manifest_path = get_active_manifest_path()?;
    read_active_connector_manifest_from(&manifest_path)
}

fn read_active_connector_manifest_from(
    manifest_path: &std::path::Path,
) -> Option<ActiveConnectorManifest> {
    if !manifest_path.exists() {
        return None;
    }

    let content = fs::read_to_string(manifest_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_active_connector_manifest_to(
    manifest_path: &std::path::Path,
    manifest: &ActiveConnectorManifest,
) -> Result<(), String> {
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create connector manifest directory: {}", e))?;
    }

    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize active connector manifest: {}", e))?;
    let parent = manifest_path
        .parent()
        .ok_or("Active connector manifest path has no parent directory")?;
    let mut temp_file = NamedTempFile::new_in(parent).map_err(|e| {
        format!(
            "Failed to create active connector manifest temp file: {}",
            e
        )
    })?;
    temp_file
        .write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write active connector manifest: {}", e))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync active connector manifest: {}", e))?;
    temp_file
        .persist(manifest_path)
        .map_err(|e| format!("Failed to activate connector manifest: {}", e))?;

    Ok(())
}

pub fn get_active_connector_install(connector_id: &str) -> Option<ActiveConnectorInstall> {
    let manifest = read_active_connector_manifest()?;
    manifest.connectors.get(connector_id).cloned()
}

fn update_active_connector_install(
    install: ActiveConnectorInstall,
    policy: ConnectorInstallUpdatePolicy,
) -> Result<bool, String> {
    let manifest_path =
        get_active_manifest_path().ok_or("Could not determine active manifest path")?;
    update_active_connector_install_at(&manifest_path, install, policy)
}

#[derive(Debug, Clone, Copy)]
enum ConnectorInstallUpdatePolicy {
    ReplaceExisting,
    RefreshBundledPathIfSameArtifact,
}

fn update_active_connector_install_at(
    manifest_path: &std::path::Path,
    install: ActiveConnectorInstall,
    policy: ConnectorInstallUpdatePolicy,
) -> Result<bool, String> {
    let _guard = ACTIVE_CONNECTOR_MANIFEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = manifest_path
        .parent()
        .ok_or("Active connector manifest path has no parent directory")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create connector manifest directory: {}", e))?;
    let lock_path = manifest_path.with_extension("json.lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open active connector manifest lock: {}", e))?;
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to lock active connector manifest: {}", e))?;
    let mut manifest =
        read_active_connector_manifest_from(manifest_path).unwrap_or(ActiveConnectorManifest {
            version: "1.0".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            connectors: HashMap::new(),
        });
    if let Some(existing) = manifest.connectors.get_mut(&install.connector_id) {
        match policy {
            ConnectorInstallUpdatePolicy::ReplaceExisting => {}
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact => {
                if !same_bundled_artifact(existing, &install) {
                    return Ok(false);
                }
                existing.root_path = install.root_path;
                existing.metadata_relative_path = install.metadata_relative_path;
                existing.script_relative_path = install.script_relative_path;
                existing.manifest_path = install.manifest_path;
                existing.entrypoint_path = install.entrypoint_path;
                existing.provenance_path = install.provenance_path;
                manifest.updated_at = chrono::Utc::now().to_rfc3339();
                write_active_connector_manifest_to(manifest_path, &manifest)?;
                return Ok(true);
            }
        }
    }
    manifest.updated_at = chrono::Utc::now().to_rfc3339();
    manifest
        .connectors
        .insert(install.connector_id.clone(), install);
    write_active_connector_manifest_to(manifest_path, &manifest)?;
    Ok(true)
}

fn same_bundled_artifact(
    existing: &ActiveConnectorInstall,
    install: &ActiveConnectorInstall,
) -> bool {
    existing.connector_id == install.connector_id
        && existing.company == install.company
        && existing.version == install.version
        && existing.artifact_kind == install.artifact_kind
        && existing.manifest_path == install.manifest_path
        && existing.entrypoint_path == install.entrypoint_path
        && existing.provenance_path == install.provenance_path
        && required_equal(&existing.manifest_sha256, &install.manifest_sha256)
        && required_equal(&existing.entrypoint_sha256, &install.entrypoint_sha256)
        && required_equal(&existing.provenance_sha256, &install.provenance_sha256)
}

fn required_equal(existing: &Option<String>, install: &Option<String>) -> bool {
    matches!((existing, install), (Some(existing), Some(install)) if existing == install)
}

pub fn replace_active_connector_install(install: ActiveConnectorInstall) -> Result<(), String> {
    update_active_connector_install(install, ConnectorInstallUpdatePolicy::ReplaceExisting)
        .map(|_| ())
}

pub fn activate_bundled_connector_install(install: ActiveConnectorInstall) -> Result<bool, String> {
    update_active_connector_install(
        install,
        ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        read_active_connector_manifest_from, update_active_connector_install_at,
        ActiveConnectorInstall, ConnectorInstallUpdatePolicy,
    };
    use fs2::FileExt;
    use std::fs::OpenOptions;
    use std::process::Command;
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    fn install(version: &str, root_path: &str) -> ActiveConnectorInstall {
        ActiveConnectorInstall {
            connector_id: "github-pdpp".to_string(),
            company: "github".to_string(),
            version: version.to_string(),
            root_path: root_path.to_string(),
            metadata_relative_path: "profile/collection-profile.json".to_string(),
            script_relative_path: "dist/collection-profile.mjs".to_string(),
            artifact_kind: Some("pdpp-collection-profile".to_string()),
            manifest_path: Some("profile/collection-profile.json".to_string()),
            entrypoint_path: Some("dist/collection-profile.mjs".to_string()),
            entrypoint_sha256: Some("sha256:entrypoint".to_string()),
            manifest_sha256: Some("sha256:manifest".to_string()),
            provenance_path: Some("provenance.json".to_string()),
            provenance_sha256: Some("sha256:provenance".to_string()),
        }
    }

    fn selected(manifest_path: &std::path::Path) -> ActiveConnectorInstall {
        read_active_connector_manifest_from(manifest_path)
            .expect("active connector manifest")
            .connectors
            .get("github-pdpp")
            .expect("selection")
            .clone()
    }

    #[test]
    fn bundled_activation_cannot_replace_a_concurrent_user_selection() {
        let temp = tempdir().expect("manifest tempdir");

        for iteration in 0..32 {
            let manifest_path = temp.path().join(format!("active-{iteration}.json"));
            let barrier = Arc::new(Barrier::new(3));
            let bundled_path = manifest_path.clone();
            let bundled_barrier = Arc::clone(&barrier);
            let bundled = std::thread::spawn(move || {
                bundled_barrier.wait();
                update_active_connector_install_at(
                    &bundled_path,
                    install("0.1.0", "/bundled/github-pdpp"),
                    ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
                )
            });
            let user_path = manifest_path.clone();
            let user_barrier = Arc::clone(&barrier);
            let user = std::thread::spawn(move || {
                user_barrier.wait();
                update_active_connector_install_at(
                    &user_path,
                    install("9.9.9", "/user/github-pdpp"),
                    ConnectorInstallUpdatePolicy::ReplaceExisting,
                )
            });

            barrier.wait();
            bundled
                .join()
                .expect("bundled thread")
                .expect("bundled write");
            user.join().expect("user thread").expect("user write");

            let selected = selected(&manifest_path);
            assert_eq!(selected.version, "9.9.9");
            assert_eq!(selected.root_path, "/user/github-pdpp");
        }
    }

    #[test]
    fn bundled_activation_refreshes_path_for_same_exact_artifact() {
        let temp = tempdir().expect("manifest tempdir");
        let manifest_path = temp.path().join("connectors-active.json");
        let mut stale = install("0.1.0", "/tmp/.mount-old/github-pdpp");
        stale.metadata_relative_path = "old-profile/collection-profile.json".to_string();
        stale.script_relative_path = "old-dist/collection-profile.mjs".to_string();
        update_active_connector_install_at(
            &manifest_path,
            stale,
            ConnectorInstallUpdatePolicy::ReplaceExisting,
        )
        .expect("stale bundled install");

        let mut fresh = install("0.1.0", "/tmp/.mount-new/github-pdpp");
        fresh.metadata_relative_path = "profile/collection-profile.json".to_string();
        fresh.script_relative_path = "dist/collection-profile.mjs".to_string();
        assert!(update_active_connector_install_at(
            &manifest_path,
            fresh,
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
        )
        .expect("fresh bundled activation"));

        let selected = selected(&manifest_path);
        assert_eq!(selected.root_path, "/tmp/.mount-new/github-pdpp");
        assert_eq!(
            selected.metadata_relative_path,
            "profile/collection-profile.json"
        );
        assert_eq!(selected.script_relative_path, "dist/collection-profile.mjs");
        assert_eq!(selected.version, "0.1.0");
    }

    #[test]
    fn bundled_activation_preserves_distinct_user_install() {
        let temp = tempdir().expect("manifest tempdir");
        let manifest_path = temp.path().join("connectors-active.json");
        update_active_connector_install_at(
            &manifest_path,
            install("9.9.9", "/user/github-pdpp"),
            ConnectorInstallUpdatePolicy::ReplaceExisting,
        )
        .expect("user install");

        assert!(!update_active_connector_install_at(
            &manifest_path,
            install("0.1.0", "/bundled/github-pdpp"),
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
        )
        .expect("bundled activation"));

        let selected = selected(&manifest_path);
        assert_eq!(selected.version, "9.9.9");
        assert_eq!(selected.root_path, "/user/github-pdpp");
    }

    #[test]
    fn bundled_activation_preserves_same_version_with_changed_or_missing_hash() {
        let temp = tempdir().expect("manifest tempdir");
        let changed_hash_path = temp.path().join("changed-hash.json");
        update_active_connector_install_at(
            &changed_hash_path,
            install("0.1.0", "/user/github-pdpp"),
            ConnectorInstallUpdatePolicy::ReplaceExisting,
        )
        .expect("user install");

        let mut changed = install("0.1.0", "/bundled/github-pdpp");
        changed.manifest_sha256 = Some("sha256:changed".to_string());
        assert!(!update_active_connector_install_at(
            &changed_hash_path,
            changed,
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
        )
        .expect("changed hash bundled activation"));
        assert_eq!(selected(&changed_hash_path).root_path, "/user/github-pdpp");

        let missing_hash_path = temp.path().join("missing-hash.json");
        let mut missing = install("0.1.0", "/user/github-pdpp");
        missing.entrypoint_sha256 = None;
        update_active_connector_install_at(
            &missing_hash_path,
            missing,
            ConnectorInstallUpdatePolicy::ReplaceExisting,
        )
        .expect("user install without hash");

        assert!(!update_active_connector_install_at(
            &missing_hash_path,
            install("0.1.0", "/bundled/github-pdpp"),
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
        )
        .expect("missing hash bundled activation"));
        assert_eq!(selected(&missing_hash_path).root_path, "/user/github-pdpp");
    }

    #[test]
    fn cross_process_manifest_update_helper() {
        let Some(manifest_path) = std::env::var_os("DATACONNECT_TEST_MANIFEST_PATH") else {
            return;
        };
        let ready_path =
            std::env::var_os("DATACONNECT_TEST_READY_PATH").expect("cross-process ready path");
        std::fs::write(&ready_path, b"ready").expect("cross-process ready marker");
        update_active_connector_install_at(
            std::path::Path::new(&manifest_path),
            install("9.9.9", "/user/github-pdpp"),
            ConnectorInstallUpdatePolicy::ReplaceExisting,
        )
        .expect("cross-process user update");
    }

    #[test]
    fn manifest_updates_take_the_cross_process_file_lock() {
        let temp = tempdir().expect("manifest tempdir");
        let manifest_path = temp.path().join("connectors-active.json");
        update_active_connector_install_at(
            &manifest_path,
            install("0.1.0", "/bundled/github-pdpp"),
            ConnectorInstallUpdatePolicy::RefreshBundledPathIfSameArtifact,
        )
        .expect("bundled install");

        let lock_path = manifest_path.with_extension("json.lock");
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("active manifest lock");
        lock_file.lock_exclusive().expect("parent file lock");

        let ready_path = temp.path().join("child-ready");
        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "commands::connector_store::tests::cross_process_manifest_update_helper",
                "--nocapture",
            ])
            .env("DATACONNECT_TEST_MANIFEST_PATH", &manifest_path)
            .env("DATACONNECT_TEST_READY_PATH", &ready_path)
            .spawn()
            .expect("cross-process update child");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready_path.exists(), "child did not reach manifest update");
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            child.try_wait().expect("child status").is_none(),
            "child update bypassed the held cross-process lock"
        );

        FileExt::unlock(&lock_file).expect("release parent file lock");
        assert!(child.wait().expect("child completion").success());
        let manifest =
            read_active_connector_manifest_from(&manifest_path).expect("active connector manifest");
        let selected = manifest.connectors.get("github-pdpp").expect("selection");
        assert_eq!(selected.version, "9.9.9");
        assert_eq!(selected.root_path, "/user/github-pdpp");
    }
}
