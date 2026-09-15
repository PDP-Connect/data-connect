// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! Signed discovery hints. Each selected connector is verified again by digest at install time.
use chrono::{DateTime, FixedOffset};
use fs2::FileExt;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct Catalog {
    pub catalog_version: String,
    pub generated_at: String,
    pub source_commit: String,
    pub connectors: Vec<CatalogConnector>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogConnector {
    pub connector_key: String,
    pub connector_id: String,
    pub display_name: String,
    pub latest: CatalogVersion,
    pub versions: Vec<CatalogVersion>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogVersion {
    pub version: String,
    pub digest: String,
}

pub(crate) async fn fetch_catalog() -> Result<Catalog, String> {
    let bytes = super::oci::download_verified_catalog().await?;
    let state_dir = super::connector_store::get_dataconnect_dir()
        .ok_or("Could not determine catalog state directory")?;
    // Blocking file locks and disk writes must not occupy an async runtime worker.
    tokio::task::spawn_blocking(move || accept_catalog(&bytes, &state_dir))
        .await
        .map_err(|e| format!("Catalog acceptance task failed: {e}"))?
}

fn timestamp(value: &str) -> Result<DateTime<FixedOffset>, String> {
    DateTime::parse_from_rfc3339(value).map_err(|e| format!("Invalid catalog generated_at: {e}"))
}

fn validate_catalog(bytes: &[u8]) -> Result<Catalog, String> {
    let catalog: Catalog =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid connector catalog: {e}"))?;
    if catalog.catalog_version != "1.0" || catalog.source_commit.is_empty() {
        return Err("Unsupported or incomplete connector catalog".into());
    }
    timestamp(&catalog.generated_at)?;
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for connector in &catalog.connectors {
        let key = &connector.connector_key;
        if key.is_empty()
            || !key.as_bytes()[0].is_ascii_lowercase() && !key.as_bytes()[0].is_ascii_digit()
            || !key
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !keys.insert(key)
            || !ids.insert(&connector.connector_id)
            || connector.connector_id.is_empty()
            || connector.display_name.is_empty()
        {
            return Err("Invalid or duplicate catalog connector identity".into());
        }
        let mut versions = HashSet::new();
        for version in connector.versions.iter().chain([&connector.latest]) {
            semver::Version::parse(&version.version)
                .map_err(|e| format!("Invalid catalog version: {e}"))?;
            let hex = version.digest.strip_prefix("sha256:").unwrap_or_default();
            if hex.len() != 64
                || !hex
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("Invalid catalog manifest digest".into());
            }
        }
        for version in &connector.versions {
            if !versions.insert(&version.version) {
                return Err("Duplicate catalog version".into());
            }
        }
        if !connector
            .versions
            .iter()
            .any(|v| v.version == connector.latest.version && v.digest == connector.latest.digest)
        {
            return Err("Catalog latest must be listed in versions".into());
        }
    }
    Ok(catalog)
}

// Called only after signature and layer verification. Persist under an OS lock so concurrent
// responses cannot race an older catalog past the rollback guard.
fn accept_catalog(bytes: &[u8], state_dir: &Path) -> Result<Catalog, String> {
    let catalog = validate_catalog(bytes)?;
    let generated_at = timestamp(&catalog.generated_at)?;
    fs::create_dir_all(state_dir).map_err(|e| format!("Create catalog state directory: {e}"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state_dir.join("connector-catalog.lock"))
        .map_err(|e| format!("Open catalog state lock: {e}"))?;
    lock.lock_exclusive()
        .map_err(|e| format!("Lock catalog state: {e}"))?;
    let state_path = state_dir.join("connector-catalog-generated-at");
    match fs::read_to_string(&state_path) {
        Ok(last) if generated_at < timestamp(last.trim())? => {
            return Err("Stale connector catalog refused".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Read catalog rollback state: {e}")),
    }
    let mut staged = tempfile::NamedTempFile::new_in(state_dir)
        .map_err(|e| format!("Stage catalog state: {e}"))?;
    staged
        .write_all(catalog.generated_at.as_bytes())
        .map_err(|e| format!("Write catalog state: {e}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|e| format!("Sync catalog state: {e}"))?;
    staged
        .persist(state_path)
        .map_err(|e| format!("Persist catalog state: {e}"))?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(date: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "catalog_version": "1.0", "generated_at": date, "source_commit": "test", "connectors": []
        })).unwrap()
    }

    #[test]
    fn b2_t7_stale_catalog_refused_and_high_water_mark_preserved() {
        let dir = tempfile::tempdir().unwrap();
        accept_catalog(&catalog("2026-09-15T12:00:00Z"), dir.path()).unwrap();
        // Compare instants, not lexical order: this is one hour older despite its later date.
        let error = accept_catalog(&catalog("2026-09-16T01:00:00+14:00"), dir.path()).unwrap_err();
        assert!(error.contains("Stale"));
        assert_eq!(
            fs::read_to_string(dir.path().join("connector-catalog-generated-at")).unwrap(),
            "2026-09-15T12:00:00Z"
        );
        accept_catalog(&catalog("2026-09-15T12:00:00Z"), dir.path()).unwrap();
        accept_catalog(&catalog("2026-09-15T13:00:00Z"), dir.path()).unwrap();
    }

    #[test]
    fn malformed_catalog_does_not_advance_rollback_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(accept_catalog(&catalog("not-a-date"), dir.path()).is_err());
        assert!(!dir.path().join("connector-catalog-generated-at").exists());
        fs::write(dir.path().join("connector-catalog-generated-at"), "corrupt").unwrap();
        assert!(accept_catalog(&catalog("2026-09-15T12:00:00Z"), dir.path()).is_err());
    }
}
