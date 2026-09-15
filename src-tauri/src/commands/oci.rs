// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// OCI transport for collection-profile connector artifacts.  The lock pins a
// manifest digest, so this module never resolves a tag while installing.

use futures_util::StreamExt;
use oci_client::Reference as OciClientReference;
use reqwest::{header, redirect::Policy, Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use super::oci_verify::CosignSignature;
pub(crate) use super::oci_verify::{
    COSIGN_BUNDLE_ANNOTATION, COSIGN_CERTIFICATE_ANNOTATION, COSIGN_SIGNATURE_ANNOTATION,
    COSIGN_SIGNATURE_MEDIA_TYPE, DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
    DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
};

pub(crate) const OCI_REGISTRY: &str = "ghcr.io";
pub(crate) const OCI_MANIFEST_MEDIA_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";
pub(crate) const OCI_CONFIG_MEDIA_TYPE: &str = "application/vnd.pdpp.connector.config.v1+json";
pub(crate) const OCI_PROFILE_MEDIA_TYPE: &str = "application/vnd.pdpp.connector.profile.v1+json";
pub(crate) const OCI_CODE_MEDIA_TYPE: &str = "application/vnd.pdpp.connector.code.v1.tar+gzip";
pub(crate) const OCI_ASSETS_MEDIA_TYPE: &str = "application/vnd.pdpp.connector.assets.v1.tar+gzip";
pub(crate) const OCI_LICENSES_MEDIA_TYPE: &str =
    "application/vnd.pdpp.connector.licenses.v1.tar+gzip";
pub(crate) const OCI_PROVENANCE_MEDIA_TYPE: &str =
    "application/vnd.pdpp.connector.provenance.v1+json";
pub(crate) const OCI_CATALOG_MEDIA_TYPE: &str = "application/vnd.pdpp.connector-catalog.v1+json";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_ARCHIVE_MEMBER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct OciReference {
    pub repository: String,
    pub digest: String,
    pub version: String,
    pub config_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Lookup {
    Present { digest: String },
    Absent,
    Unknown(String),
}

#[derive(Clone, Debug)]
pub(crate) struct VerifiedArtifact {
    pub config: Value,
    pub profile: Vec<u8>,
    pub provenance: Vec<u8>,
    /// Relative paths in the pre-existing installed collection-profile layout.
    pub files: Vec<(PathBuf, Vec<u8>)>,
    pub manifest_digest: String,
    pub config_digest: String,
}

#[derive(Debug, Deserialize)]
struct Descriptor {
    #[serde(rename = "mediaType")]
    media_type: String,
    digest: String,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(rename = "mediaType")]
    media_type: Option<String>,
    #[serde(rename = "artifactType")]
    artifact_type: Option<String>,
    config: Descriptor,
    layers: Vec<Descriptor>,
}

#[derive(Debug, Deserialize)]
struct SignatureManifest {
    layers: Vec<SignatureLayer>,
}

#[derive(Debug, Deserialize)]
struct SignatureLayer {
    #[serde(rename = "mediaType")]
    media_type: String,
    digest: String,
    size: Option<u64>,
    annotations: Option<HashMap<String, String>>,
}

pub(crate) struct RegistryClient {
    base: Url,
    http: Client,
}

impl RegistryClient {
    pub(crate) fn ghcr() -> Result<Self, String> {
        Self::new("https://ghcr.io/")
    }

    pub(crate) fn new(base: &str) -> Result<Self, String> {
        let base = Url::parse(base).map_err(|e| format!("Invalid OCI registry URL: {e}"))?;
        if base.scheme() != "https" || base.host_str() != Some(OCI_REGISTRY) {
            return Err("Refusing an OCI registry other than https://ghcr.io".to_string());
        }
        Self::new_unchecked(base)
    }

    #[cfg(test)]
    fn fixture(base: &str) -> Result<Self, String> {
        let base = Url::parse(base).map_err(|e| format!("Invalid fixture registry URL: {e}"))?;
        Self::new_unchecked(base)
    }

    fn new_unchecked(base: Url) -> Result<Self, String> {
        let http = Client::builder()
            .redirect(Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build OCI HTTP client: {e}"))?;
        Ok(Self { base, http })
    }

    pub(crate) async fn lookup_tag(&self, repository: &str, version: &str) -> Lookup {
        match self.fetch_manifest(repository, version).await {
            Ok((digest, _)) => Lookup::Present { digest },
            Err(error) if error.starts_with("OCI_ABSENT:") => Lookup::Absent,
            Err(error) => Lookup::Unknown(error),
        }
    }

    pub(crate) async fn fetch_manifest_by_digest(
        &self,
        repository: &str,
        digest: &str,
    ) -> Result<Vec<u8>, String> {
        let (returned, bytes) = self.fetch_manifest(repository, digest).await?;
        if returned != digest {
            return Err(format!(
                "OCI_TAMPERED: manifest request for {digest} returned {returned}"
            ));
        }
        Ok(bytes)
    }

    async fn fetch_manifest(
        &self,
        repository: &str,
        reference: &str,
    ) -> Result<(String, Vec<u8>), String> {
        validate_repository(repository)?;
        let response = self
            .authorized_get(
                &format!("v2/{repository}/manifests/{reference}"),
                OCI_MANIFEST_MEDIA_TYPE,
            )
            .await?;
        let status = response.status();
        let header_digest = response
            .headers()
            .get("docker-content-digest")
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|_| "OCI_UNKNOWN: malformed Docker-Content-Digest")
            })
            .transpose()?;
        let bytes = read_limited(response, MAX_MANIFEST_BYTES).await?;
        if status == StatusCode::NOT_FOUND {
            return if distribution_absence(&bytes) {
                Err("OCI_ABSENT: manifest is not published".to_string())
            } else {
                Err("OCI_UNKNOWN: manifest endpoint returned an unreadable 404".to_string())
            };
        }
        if status != StatusCode::OK {
            return Err(format!(
                "OCI_UNKNOWN: manifest endpoint returned HTTP {status}"
            ));
        }
        let computed = sha256_digest(&bytes);
        match header_digest {
            Some(value) if value == computed => Ok((value, bytes)),
            Some(value) if valid_digest(&value) => Err(format!(
                "OCI_UNKNOWN: Docker-Content-Digest {value} disagrees with {computed}"
            )),
            Some(_) => Err("OCI_UNKNOWN: malformed Docker-Content-Digest".to_string()),
            None => Ok((computed, bytes)),
        }
    }

    async fn fetch_blob(
        &self,
        repository: &str,
        descriptor: &Descriptor,
    ) -> Result<Vec<u8>, String> {
        let max_bytes = if descriptor.media_type == COSIGN_SIGNATURE_MEDIA_TYPE {
            MAX_MANIFEST_BYTES
        } else {
            MAX_BLOB_BYTES
        };
        if !valid_digest(&descriptor.digest) {
            return Err("OCI_TAMPERED: invalid blob descriptor digest".to_string());
        }
        if descriptor.size.is_some_and(|size| size > max_bytes as u64) {
            return Err("OCI_TAMPERED: blob descriptor exceeds byte limit".to_string());
        }
        let response = self
            .authorized_blob_get(
                &format!("v2/{repository}/blobs/{}", descriptor.digest),
                "application/octet-stream",
            )
            .await?;
        if response.status() != StatusCode::OK {
            return Err(format!(
                "OCI_UNKNOWN: blob endpoint returned HTTP {}",
                response.status()
            ));
        }
        let bytes = read_limited(response, max_bytes).await?;
        if descriptor
            .size
            .is_some_and(|size| size != bytes.len() as u64)
        {
            return Err("OCI_TAMPERED: blob size does not match descriptor".to_string());
        }
        let actual = sha256_digest(&bytes);
        if actual != descriptor.digest {
            return Err(format!(
                "OCI_TAMPERED: blob digest mismatch: expected {}, got {actual}",
                descriptor.digest
            ));
        }
        Ok(bytes)
    }

    async fn authorized_get(&self, path: &str, accept: &str) -> Result<reqwest::Response, String> {
        let url = self
            .base
            .join(path)
            .map_err(|e| format!("Invalid OCI endpoint: {e}"))?;
        let response = self
            .http
            .get(url.clone())
            .header(header::ACCEPT, accept)
            .send()
            .await
            .map_err(|e| format!("OCI_UNKNOWN: request failed: {e}"))?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let challenge = response
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .ok_or("OCI_UNKNOWN: registry denied pull without a bearer challenge")?;
        let token = self.fetch_token(challenge).await?;
        self.http
            .get(url)
            .header(header::ACCEPT, accept)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("OCI_UNKNOWN: authorized request failed: {e}"))
    }

    async fn authorized_blob_get(
        &self,
        path: &str,
        accept: &str,
    ) -> Result<reqwest::Response, String> {
        let url = self
            .base
            .join(path)
            .map_err(|e| format!("Invalid OCI endpoint: {e}"))?;
        let mut response = self
            .http
            .get(url.clone())
            .header(header::ACCEPT, accept)
            .send()
            .await
            .map_err(|e| format!("OCI_UNKNOWN: request failed: {e}"))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let header = response
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .ok_or("OCI_UNKNOWN: registry denied pull without a bearer challenge")?;
            let token = self.fetch_token(header).await?;
            response = self
                .http
                .get(url.clone())
                .header(header::ACCEPT, accept)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("OCI_UNKNOWN: authorized blob request failed: {e}"))?;
        }
        let mut redirect_url = url;
        for _ in 0..5 {
            if !response.status().is_redirection() {
                return Ok(response);
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("OCI_UNKNOWN: blob redirect lacks location")?;
            redirect_url = redirect_url
                .join(location)
                .map_err(|_| "OCI_UNKNOWN: blob redirect URL is invalid")?;
            if redirect_url.scheme() != "https"
                || !redirect_url.username().is_empty()
                || redirect_url.password().is_some()
            {
                return Err("OCI_UNKNOWN: blob redirect is not HTTPS".to_string());
            }
            // Credentials are deliberately not forwarded to a CDN redirect.
            response = self
                .http
                .get(redirect_url.clone())
                .header(header::ACCEPT, accept)
                .send()
                .await
                .map_err(|e| format!("OCI_UNKNOWN: redirected blob request failed: {e}"))?;
        }
        Err("OCI_UNKNOWN: blob endpoint redirected too many times".to_string())
    }

    async fn fetch_token(&self, challenge: &str) -> Result<String, String> {
        let parameters =
            bearer_parameters(challenge).ok_or("OCI_UNKNOWN: malformed bearer challenge")?;
        let realm = parameters
            .get("realm")
            .ok_or("OCI_UNKNOWN: bearer challenge lacks realm")?;
        let mut url = Url::parse(realm).map_err(|_| "OCI_UNKNOWN: bearer realm is not a URL")?;
        {
            let mut query = url.query_pairs_mut();
            for key in ["service", "scope"] {
                if let Some(value) = parameters.get(key) {
                    query.append_pair(key, value);
                }
            }
        }
        self.check_token_realm(&url)?;
        for _ in 0..=3 {
            let response = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|e| format!("OCI_UNKNOWN: token exchange failed: {e}"))?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("OCI_UNKNOWN: token redirect lacks location")?;
                url = url
                    .join(location)
                    .map_err(|_| "OCI_UNKNOWN: token redirect URL is invalid")?;
                self.check_token_realm(&url)?;
                continue;
            }
            if response.status() != StatusCode::OK {
                return Err(format!(
                    "OCI_UNKNOWN: token endpoint returned HTTP {}",
                    response.status()
                ));
            }
            let token_bytes = read_limited(response, MAX_MANIFEST_BYTES).await?;
            let value: Value = serde_json::from_slice(&token_bytes)
                .map_err(|_| "OCI_UNKNOWN: token endpoint returned invalid JSON")?;
            return value
                .get("token")
                .or_else(|| value.get("access_token"))
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or("OCI_UNKNOWN: token endpoint returned no token".to_string());
        }
        Err("OCI_UNKNOWN: token endpoint redirected too many times".to_string())
    }

    fn check_token_realm(&self, url: &Url) -> Result<(), String> {
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("OCI_UNKNOWN: token realm escaped registry origin".to_string());
        }
        if self.base.host_str() == Some(OCI_REGISTRY) {
            if url.scheme() != "https"
                || url.host_str() != Some(OCI_REGISTRY)
                || url.path() != "/token"
            {
                return Err("OCI_UNKNOWN: token realm is not https://ghcr.io/token".to_string());
            }
        } else if url.origin() != self.base.origin() {
            return Err("OCI_UNKNOWN: fixture token redirect escaped registry origin".to_string());
        }
        Ok(())
    }
}

pub(crate) async fn download_verified(
    reference: &OciReference,
) -> Result<VerifiedArtifact, String> {
    validate_reference(reference)?;
    let client = RegistryClient::ghcr()?;
    download_with_client(&client, reference).await
}

async fn download_with_client(
    client: &RegistryClient,
    reference: &OciReference,
) -> Result<VerifiedArtifact, String> {
    let manifest_bytes = client
        .fetch_manifest_by_digest(&reference.repository, &reference.digest)
        .await?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("OCI_TAMPERED: invalid artifact manifest: {e}"))?;
    if manifest.media_type.as_deref() != Some(OCI_MANIFEST_MEDIA_TYPE)
        || manifest.artifact_type.as_deref() != Some("application/vnd.pdpp.connector.v1+json")
    {
        return Err("OCI_TAMPERED: unsupported OCI artifact manifest".to_string());
    }
    if manifest.config.media_type != OCI_CONFIG_MEDIA_TYPE {
        return Err("OCI_TAMPERED: unsupported OCI config media type".to_string());
    }
    if let Some(expected) = &reference.config_digest {
        if expected != &manifest.config.digest {
            return Err("OCI_TAMPERED: config descriptor does not match lock".to_string());
        }
    }
    verify_signature(client, &reference.repository, &reference.digest).await?;
    let layers = index_layers(&manifest.layers)?;
    let config_bytes = client
        .fetch_blob(&reference.repository, &manifest.config)
        .await?;
    let profile = client
        .fetch_blob(
            &reference.repository,
            layers.get(OCI_PROFILE_MEDIA_TYPE).unwrap(),
        )
        .await?;
    let code = client
        .fetch_blob(
            &reference.repository,
            layers.get(OCI_CODE_MEDIA_TYPE).unwrap(),
        )
        .await?;
    let licenses = client
        .fetch_blob(
            &reference.repository,
            layers.get(OCI_LICENSES_MEDIA_TYPE).unwrap(),
        )
        .await?;
    let provenance = client
        .fetch_blob(
            &reference.repository,
            layers.get(OCI_PROVENANCE_MEDIA_TYPE).unwrap(),
        )
        .await?;
    let assets = match layers.get(OCI_ASSETS_MEDIA_TYPE) {
        Some(d) => Some(client.fetch_blob(&reference.repository, d).await?),
        None => None,
    };
    let config: Value =
        serde_json::from_slice(&config_bytes).map_err(|_| "OCI_TAMPERED: config is not JSON")?;
    let profile_json: Value =
        serde_json::from_slice(&profile).map_err(|_| "OCI_TAMPERED: profile is not JSON")?;
    cross_check(&config, &profile_json, &profile, reference)?;
    let entrypoint = config
        .get("entrypoint")
        .and_then(Value::as_str)
        .ok_or("OCI_TAMPERED: config lacks entrypoint")?;
    let entrypoint = Path::new(entrypoint)
        .strip_prefix("code")
        .map_err(|_| "OCI_TAMPERED: config entrypoint must be inside code/")?;
    let code_files = extract_tar(&code, "code")?;
    let entrypoint_bytes = code_files
        .iter()
        .find(|(path, _)| path == entrypoint)
        .map(|(_, bytes)| bytes.clone())
        .ok_or("OCI_TAMPERED: configured entrypoint is absent from code layer")?;
    let mut files = vec![
        (
            PathBuf::from("profile/collection-profile.json"),
            profile.clone(),
        ),
        (PathBuf::from("provenance.json"), provenance.clone()),
    ];
    files.extend(
        code_files
            .into_iter()
            .map(|(path, bytes)| (Path::new("dist").join(path), bytes)),
    );
    // `entrypoint_bytes` is deliberately retained for the caller's checksum
    // validation; it is also present above at its translated path.
    debug_assert!(files
        .iter()
        .any(|(path, bytes)| path == &Path::new("dist").join(entrypoint)
            && bytes == &entrypoint_bytes));
    files.extend(
        extract_tar(&licenses, "licenses")?
            .into_iter()
            .map(|(p, b)| (Path::new("licenses").join(p), b)),
    );
    if let Some(assets) = assets {
        files.extend(
            extract_tar(&assets, "assets")?
                .into_iter()
                .map(|(p, b)| (Path::new("assets").join(p), b)),
        );
    }
    Ok(VerifiedArtifact {
        config,
        profile,
        provenance,
        files,
        manifest_digest: reference.digest.clone(),
        config_digest: manifest.config.digest,
    })
}

/// Fetch the floating discovery hint only after verifying the immutable digest
/// it currently resolves to. Every selected catalog item is verified again at
/// installation, so this catalog can never authorize an artifact on its own.
pub(crate) async fn download_verified_catalog() -> Result<Vec<u8>, String> {
    let repository = "pdp-connect/connector-catalog";
    let client = RegistryClient::ghcr()?;
    let digest = match client.lookup_tag(repository, "latest").await {
        Lookup::Present { digest } => digest,
        Lookup::Absent => return Err("OCI_ABSENT: connector catalog is not published".to_string()),
        Lookup::Unknown(error) => {
            return Err(format!("OCI_UNVERIFIABLE: catalog lookup failed: {error}"))
        }
    };
    let bytes = client.fetch_manifest_by_digest(repository, &digest).await?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("OCI_TAMPERED: invalid catalog manifest: {e}"))?;
    if manifest.layers.len() != 1 || manifest.layers[0].media_type != OCI_CATALOG_MEDIA_TYPE {
        return Err("OCI_TAMPERED: catalog must contain exactly one catalog layer".to_string());
    }
    verify_signature(&client, repository, &digest).await?;
    client.fetch_blob(repository, &manifest.layers[0]).await
}

async fn verify_signature(
    client: &RegistryClient,
    repository: &str,
    manifest_digest: &str,
) -> Result<(), String> {
    let tag = signature_tag(manifest_digest);
    let (_, bytes) = client
        .fetch_manifest(repository, &tag)
        .await
        .map_err(|error| format!("OCI_UNVERIFIABLE: cannot fetch cosign signature: {error}"))?;
    let manifest: SignatureManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "OCI_UNVERIFIABLE: invalid cosign signature manifest")?;
    if manifest.layers.len() > 32 {
        return Err("OCI_UNVERIFIABLE: too many cosign signature candidates".into());
    }
    let mut candidates = Vec::new();
    for layer in manifest
        .layers
        .into_iter()
        .filter(|layer| layer.media_type == COSIGN_SIGNATURE_MEDIA_TYPE)
    {
        let annotations = layer.annotations.unwrap_or_default();
        let (Some(signature), Some(certificate), Some(bundle)) = (
            annotations.get(COSIGN_SIGNATURE_ANNOTATION),
            annotations.get(COSIGN_CERTIFICATE_ANNOTATION),
            annotations.get(COSIGN_BUNDLE_ANNOTATION),
        ) else {
            continue;
        };
        let payload = client
            .fetch_blob(
                repository,
                &Descriptor {
                    media_type: COSIGN_SIGNATURE_MEDIA_TYPE.to_string(),
                    digest: layer.digest,
                    size: layer.size,
                },
            )
            .await;
        // Cosign appends signatures. One unreadable or obsolete candidate must not hide
        // another valid signature by the pinned workflow.
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                log::debug!("Refused cosign candidate: {error}");
                continue;
            }
        };
        candidates.push(CosignSignature {
            signature: signature.clone(),
            certificate: certificate.clone(),
            bundle: bundle.clone(),
            payload,
        });
    }
    if candidates.is_empty() {
        return Err("OCI_UNVERIFIABLE: cosign signature has no complete candidates".to_string());
    }
    super::oci_verify::verify_cosign_signature(&candidates, manifest_digest, repository).await
}

fn index_layers(layers: &[Descriptor]) -> Result<HashMap<&str, &Descriptor>, String> {
    let known = [
        OCI_PROFILE_MEDIA_TYPE,
        OCI_CODE_MEDIA_TYPE,
        OCI_ASSETS_MEDIA_TYPE,
        OCI_LICENSES_MEDIA_TYPE,
        OCI_PROVENANCE_MEDIA_TYPE,
    ];
    let mut indexed = HashMap::new();
    for layer in layers {
        if !known.contains(&layer.media_type.as_str()) {
            return Err(format!(
                "OCI_TAMPERED: unknown layer media type {}",
                layer.media_type
            ));
        }
        if indexed.insert(layer.media_type.as_str(), layer).is_some() {
            return Err(format!(
                "OCI_TAMPERED: duplicate layer media type {}",
                layer.media_type
            ));
        }
    }
    for required in [
        OCI_PROFILE_MEDIA_TYPE,
        OCI_CODE_MEDIA_TYPE,
        OCI_LICENSES_MEDIA_TYPE,
        OCI_PROVENANCE_MEDIA_TYPE,
    ] {
        if !indexed.contains_key(required) {
            return Err(format!("OCI_TAMPERED: missing required {required} layer"));
        }
    }
    Ok(indexed)
}

fn cross_check(
    config: &Value,
    profile: &Value,
    profile_bytes: &[u8],
    reference: &OciReference,
) -> Result<(), String> {
    if config.get("profile_digest").and_then(Value::as_str)
        != Some(sha256_digest(profile_bytes).as_str())
    {
        return Err("OCI_TAMPERED: config profile_digest mismatch".to_string());
    }
    for field in [
        "connector_key",
        "connector_id",
        "protocol_version",
        "version",
    ] {
        if config.get(field).and_then(Value::as_str).is_none()
            || profile.get(field).and_then(Value::as_str).is_none()
            || config.get(field) != profile.get(field)
        {
            return Err(format!("OCI_TAMPERED: config/profile {field} mismatch"));
        }
    }
    if profile.get("version").and_then(Value::as_str) != Some(reference.version.as_str()) {
        return Err("OCI_TAMPERED: artifact version does not match lock".to_string());
    }
    let key = config
        .get("connector_key")
        .and_then(Value::as_str)
        .ok_or("OCI_TAMPERED: config lacks connector_key")?;
    if !valid_connector_key(key) || reference.repository.rsplit('/').next() != Some(key) {
        return Err("OCI_MISIDENTIFIED: repository does not match connector key".to_string());
    }
    Ok(())
}

fn extract_tar(bytes: &[u8], label: &str) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    // Bound the entire decompressed stream, including metadata, padding and trailing data.
    // Raw headers are needed because tar's normal iterator silently applies GNU/PAX overrides.
    let mut raw = Vec::new();
    flate2::read::MultiGzDecoder::new(Cursor::new(bytes))
        .take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("OCI_TAMPERED: unreadable {label} gzip: {e}"))?;
    if raw.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "OCI_TAMPERED: {label} exceeds decompressed byte limit"
        ));
    }
    parse_tar(&raw, label)
}

fn parse_tar(raw: &[u8], label: &str) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let malformed = || format!("OCI_TAMPERED: malformed {label} archive");
    let mut files = Vec::new();
    let mut names = HashSet::new();
    let mut offset = 0usize;
    let mut count = 0usize;
    let mut pending_pax: Option<(Option<PathBuf>, Option<u64>)> = None;
    while let Some(block) = raw.get(offset..offset + 512) {
        if block.iter().all(|byte| *byte == 0) {
            if pending_pax.is_some()
                || raw.len() - offset < 1024
                || raw[offset..].iter().any(|byte| *byte != 0)
            {
                return Err(malformed());
            }
            return Ok(files);
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(format!("OCI_TAMPERED: {label} exceeds entry limit"));
        }
        let header = tar::Header::from_byte_slice(block);
        let checksum = header.cksum().map_err(|_| malformed())?;
        let unsigned: u32 = block
            .iter()
            .enumerate()
            .map(|(i, byte)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    *byte as u32
                }
            })
            .sum();
        let signed: i32 = block
            .iter()
            .enumerate()
            .map(|(i, byte)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    *byte as i8 as i32
                }
            })
            .sum();
        if checksum != unsigned && checksum as i64 != signed as i64 {
            return Err(malformed());
        }
        let kind = block[156];
        if !matches!(kind, 0 | b'0' | b'5' | b'x') {
            return Err(format!("OCI_TAMPERED: {label} has unsupported entry type"));
        }
        let (pax_path, pax_size) = if kind == b'x' {
            if pending_pax.is_some() {
                return Err(malformed());
            }
            (None, None)
        } else {
            pending_pax.take().unwrap_or_default()
        };
        let size = match pax_size {
            Some(size) => size,
            None => header.size().map_err(|_| malformed())?,
        };
        if size > MAX_ARCHIVE_MEMBER_BYTES {
            return Err(format!("OCI_TAMPERED: {label} exceeds member byte limit"));
        }
        offset += 512;
        let end = offset.checked_add(size as usize).ok_or_else(malformed)?;
        let body = raw.get(offset..end).ok_or_else(malformed)?;
        offset = offset
            .checked_add((size as usize).div_ceil(512) * 512)
            .ok_or_else(malformed)?;
        if offset > raw.len() {
            return Err(malformed());
        }
        if kind == b'x' {
            pending_pax = Some(parse_pax(body)?);
            continue;
        }
        let path = match pax_path {
            Some(path) => path,
            None => safe_archive_path(&header.path().map_err(|_| malformed())?)?,
        };
        if kind == b'5' {
            if size != 0 {
                return Err("OCI_TAMPERED: directory has nonzero size".into());
            }
            continue;
        }
        if path.as_os_str().is_empty() || !names.insert(path.clone()) {
            return Err(malformed());
        }
        files.push((path, body.to_vec()));
    }
    Err(malformed())
}

fn parse_pax(body: &[u8]) -> Result<(Option<PathBuf>, Option<u64>), String> {
    let malformed = || "OCI_TAMPERED: malformed PAX record".to_string();
    let (mut path, mut size) = (None, None);
    let mut offset = 0;
    while offset < body.len() {
        let space = body[offset..]
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(malformed)?
            + offset;
        let length_text = std::str::from_utf8(&body[offset..space]).map_err(|_| malformed())?;
        if length_text.starts_with('0') || !length_text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(malformed());
        }
        let length: usize = length_text.parse().map_err(|_| malformed())?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= body.len() && *end > space + 2)
            .ok_or_else(malformed)?;
        if body[end - 1] != b'\n' {
            return Err(malformed());
        }
        let record = std::str::from_utf8(&body[space + 1..end - 1]).map_err(|_| malformed())?;
        let (key, value) = record.split_once('=').ok_or_else(malformed)?;
        if value.is_empty() {
            return Err(malformed());
        }
        match key {
            "path" => path = Some(safe_archive_path(Path::new(value))?),
            "size" => {
                if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(malformed());
                }
                size = Some(value.parse().map_err(|_| malformed())?);
            }
            _ => return Err(format!("OCI_TAMPERED: unsupported PAX override {key}")),
        }
        offset = end;
    }
    Ok((path, size))
}

fn safe_archive_path(path: &Path) -> Result<PathBuf, String> {
    let raw = path
        .to_str()
        .ok_or("OCI_TAMPERED: archive path is not UTF-8")?;
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') || path.is_absolute() {
        return Err("OCI_TAMPERED: archive path is unsafe".to_string());
    }
    let mut output = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(segment) => output.push(segment),
            Component::CurDir => {}
            _ => return Err("OCI_TAMPERED: archive path is unsafe".to_string()),
        }
    }
    Ok(output)
}

pub(crate) fn validate_reference(reference: &OciReference) -> Result<(), String> {
    validate_repository(&reference.repository)?;
    let Some(key) = reference.repository.strip_prefix("pdp-connect/connector/") else {
        return Err(
            "OCI_INVALID_REFERENCE: repository is outside PDP-Connect connector namespace"
                .to_string(),
        );
    };
    if key.contains('/') {
        return Err("OCI_INVALID_REFERENCE: repository must contain one connector key".to_string());
    }
    if !valid_digest(&reference.digest) {
        return Err("OCI_INVALID_REFERENCE: lock requires a sha256 manifest digest".to_string());
    }
    if reference
        .config_digest
        .as_ref()
        .is_some_and(|digest| !valid_digest(digest))
    {
        return Err("OCI_INVALID_REFERENCE: invalid locked config digest".into());
    }
    let parsed: OciClientReference = format!(
        "{OCI_REGISTRY}/{}@{}",
        reference.repository, reference.digest
    )
    .parse()
    .map_err(|_| "OCI_INVALID_REFERENCE: OCI reference parser rejected lock coordinates")?;
    if parsed.registry() != OCI_REGISTRY || parsed.repository() != reference.repository {
        return Err(
            "OCI_INVALID_REFERENCE: OCI reference parser changed lock coordinates".to_string(),
        );
    }
    if !valid_connector_key(key) {
        return Err("OCI_INVALID_REFERENCE: repository has invalid connector key".to_string());
    }
    Ok(())
}
fn validate_repository(repository: &str) -> Result<(), String> {
    if repository.is_empty()
        || !repository.split('/').all(|part| {
            !part.is_empty()
                && part.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                })
        })
    {
        return Err("OCI_INVALID_REFERENCE: invalid repository".to_string());
    }
    Ok(())
}
fn valid_connector_key(key: &str) -> bool {
    !key.is_empty()
        && (key.as_bytes()[0].is_ascii_lowercase() || key.as_bytes()[0].is_ascii_digit())
        && key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn valid_digest(digest: &str) -> bool {
    digest.len() == 71
        && digest.starts_with("sha256:")
        && digest[7..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn signature_tag(digest: &str) -> String {
    format!("{}.sig", digest.replace(':', "-"))
}
fn distribution_absence(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|v| v.get("errors")?.as_array().cloned())
        .is_some_and(|errors| {
            !errors.is_empty()
                && errors.iter().all(|e| {
                    e.get("code").and_then(Value::as_str).is_some_and(|code| {
                        matches!(
                            code.to_uppercase().as_str(),
                            "MANIFEST_UNKNOWN" | "NAME_UNKNOWN"
                        )
                    })
                })
        })
}
fn bearer_parameters(challenge: &str) -> Option<HashMap<String, String>> {
    if !challenge.to_ascii_lowercase().starts_with("bearer ") {
        return None;
    }
    let mut parameters = HashMap::new();
    for pair in challenge[7..].split(',') {
        let (key, value) = pair.trim().split_once('=')?;
        parameters.insert(key.to_owned(), value.trim_matches('\"').to_owned());
    }
    parameters.contains_key("realm").then_some(parameters)
}

async fn read_limited(response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("OCI_UNKNOWN: response read failed: {e}"))?;
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err("OCI_UNKNOWN: response exceeds byte limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn fixture(status: u16, headers: &[(&str, String)], body: Vec<u8>) -> RegistryClient {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).await.unwrap();
            let reason = match status {
                200 => "OK",
                404 => "Not Found",
                500 => "Internal Server Error",
                _ => "Error",
            };
            let mut response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            for (key, value) in headers {
                response.push_str(&format!("{key}: {value}\r\n"));
            }
            response.push_str("\r\n");
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        RegistryClient::fixture(&format!("http://{address}/")).unwrap()
    }

    #[tokio::test]
    async fn b2_t2_lookup_classifies_present_absent_and_unknown() {
        let manifest = br#"{"schemaVersion":2}"#.to_vec();
        let digest = sha256_digest(&manifest);
        let present = fixture(200, &[("Docker-Content-Digest", digest.clone())], manifest).await;
        assert_eq!(
            present
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await,
            Lookup::Present { digest }
        );

        let absent = fixture(
            404,
            &[],
            br#"{"errors":[{"code":"MANIFEST_UNKNOWN"}]}"#.to_vec(),
        )
        .await;
        assert_eq!(
            absent
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await,
            Lookup::Absent
        );

        let unknown = fixture(404, &[], br#"{"errors":[{"code":"DENIED"}]}"#.to_vec()).await;
        assert!(matches!(
            unknown
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await,
            Lookup::Unknown(_)
        ));

        // Port of PR112 oci.test.mjs A-T2's complete response decision table.
        let cases = [
            (404, r#"{"errors":[{"code":"manifest_unknown"}]}"#, true),
            (404, r#"{"errors":[{"code":"NAME_UNKNOWN"}]}"#, true),
            (404, "", false),
            (404, r#"{"errors":[{"message":"not found"}]}"#, false),
            (
                404,
                r#"{"errors":[{"code":"MANIFEST_UNKNOWN"},{"code":"DENIED"}]}"#,
                false,
            ),
            (404, r#"{"errors":[{"code":"MANIFEST_UNKNOWN"},{}]}"#, false),
            (404, r#"{"errors":[]}"#, false),
            (401, "", false),
            (
                403,
                r#"{"errors":[{"code":"DENIED","message":"not found"}]}"#,
                false,
            ),
            (500, "", false),
            (404, "<html>gone</html>", false),
        ];
        for (status, body, absent) in cases {
            let client = fixture(status, &[], body.as_bytes().to_vec()).await;
            let outcome = client
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await;
            assert_eq!(
                matches!(outcome, Lookup::Absent),
                absent,
                "{status}: {body}"
            );
            assert!(matches!(outcome, Lookup::Absent | Lookup::Unknown(_)));
        }
        for digest in [
            "not-a-digest".to_string(),
            format!("sha256:{}", "a".repeat(64)),
        ] {
            let client = fixture(200, &[("Docker-Content-Digest", digest)], b"{}".to_vec()).await;
            assert!(matches!(
                client
                    .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                    .await,
                Lookup::Unknown(_)
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let disconnected = RegistryClient::fixture(&format!("http://{address}/")).unwrap();
        assert!(matches!(
            disconnected
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await,
            Lookup::Unknown(_)
        ));
    }

    #[tokio::test]
    async fn b2_t2_token_endpoint_absence_is_unknown_and_challenge_scope_is_preserved() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            first.read(&mut request).await.unwrap();
            let response = format!("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"http://{address}/token\",service=\"ghcr.io\",scope=\"repository:pdp-connect/connector/ynab:pull\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            first.write_all(response.as_bytes()).await.unwrap();
            let (mut token, _) = listener.accept().await.unwrap();
            let count = token.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("service=ghcr.io"));
            assert!(request.contains("scope=repository%3Apdp-connect%2Fconnector%2Fynab%3Apull"));
            let body = r#"{"errors":[{"code":"MANIFEST_UNKNOWN"}]}"#;
            let response = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            token.write_all(response.as_bytes()).await.unwrap();
        });
        let client = RegistryClient::fixture(&format!("http://{address}/")).unwrap();
        assert!(matches!(
            client
                .lookup_tag("pdp-connect/connector/ynab", "1.0.0")
                .await,
            Lookup::Unknown(_)
        ));
        server.await.unwrap();
    }

    #[test]
    fn token_realms_pin_scheme_host_port_and_refuse_credentials() {
        let client = RegistryClient::ghcr().unwrap();
        assert!(client
            .check_token_realm(&Url::parse("https://ghcr.io:443/token").unwrap())
            .is_ok());
        for url in [
            "https://ghcr.io:8443/token",
            "http://ghcr.io/token",
            "https://attacker.example/token",
            "https://user:pass@ghcr.io/token",
            "https://ghcr.io/token#fragment",
            "https://ghcr.io/other",
        ] {
            assert!(
                client.check_token_realm(&Url::parse(url).unwrap()).is_err(),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn b2_t3_refuses_blob_bytes_that_do_not_match_descriptor_digest() {
        let client = fixture(200, &[], b"tampered layer".to_vec()).await;
        let descriptor = Descriptor {
            media_type: OCI_CODE_MEDIA_TYPE.to_string(),
            digest: sha256_digest(b"expected layer"),
            size: None,
        };
        assert!(client
            .fetch_blob("pdp-connect/connector/ynab", &descriptor)
            .await
            .unwrap_err()
            .contains("OCI_TAMPERED"));
    }

    #[test]
    fn tar_refuses_unsafe_path() {
        assert!(safe_archive_path(Path::new("../escape")).is_err());
        assert!(safe_archive_path(Path::new("code\\escape")).is_err());
        assert!(safe_archive_path(Path::new("/absolute")).is_err());
    }

    fn raw_member(archive: &mut Vec<u8>, name: &str, kind: u8, header_size: u64, bytes: &[u8]) {
        let mut header = tar::Header::new_ustar();
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_entry_type(tar::EntryType::new(kind));
        header.set_size(header_size);
        header.set_mode(0o644);
        header.set_cksum();
        archive.extend_from_slice(header.as_bytes());
        archive.extend_from_slice(bytes);
        archive.resize(archive.len().div_ceil(512) * 512, 0);
    }

    fn gzip_archive(mut raw: Vec<u8>) -> Vec<u8> {
        use std::io::Write;
        raw.extend_from_slice(&[0; 1024]);
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&raw).unwrap();
        gzip.finish().unwrap()
    }

    fn pax(key: &str, value: &str) -> Vec<u8> {
        let record = format!(" {key}={value}\n");
        let mut size = record.len() + 1;
        while size.to_string().len() + record.len() != size {
            size = size.to_string().len() + record.len();
        }
        format!("{size}{record}").into_bytes()
    }

    #[test]
    fn oci_archive_applies_pax_path_and_size_overrides() {
        let mut raw = Vec::new();
        let metadata = [pax("path", "nested/file.mjs"), pax("size", "3")].concat();
        raw_member(
            &mut raw,
            "PaxHeader",
            b'x',
            metadata.len() as u64,
            &metadata,
        );
        raw_member(&mut raw, "original", b'0', 0, b"abc");
        let files = extract_tar(&gzip_archive(raw), "fixture").unwrap();
        assert_eq!(
            files,
            vec![(PathBuf::from("nested/file.mjs"), b"abc".to_vec())]
        );
    }

    #[test]
    fn oci_archive_refuses_link_types_and_path_overrides() {
        for kind in [b'1', b'2', b'3', b'4', b'6', b'L', b'K', b'g'] {
            let mut raw = Vec::new();
            raw_member(&mut raw, "entry", kind, 0, b"");
            assert!(
                extract_tar(&gzip_archive(raw), "fixture").is_err(),
                "type {kind}"
            );
        }
        for key in ["linkpath", "SCHILY.realsize", "GNU.sparse.map"] {
            let mut raw = Vec::new();
            let metadata = pax(key, "outside");
            raw_member(
                &mut raw,
                "PaxHeader",
                b'x',
                metadata.len() as u64,
                &metadata,
            );
            raw_member(&mut raw, "entry", b'0', 0, b"");
            assert!(
                extract_tar(&gzip_archive(raw), "fixture").is_err(),
                "key {key}"
            );
        }
        for path in ["../escape", "/absolute", "back\\slash"] {
            let mut raw = Vec::new();
            raw_member(&mut raw, path, b'5', 0, b"");
            assert!(
                extract_tar(&gzip_archive(raw), "fixture").is_err(),
                "directory {path}"
            );
        }
    }

    #[test]
    fn oci_archive_refuses_unconsumed_pax_metadata() {
        let mut raw = Vec::new();
        let metadata = pax("path", "orphan");
        raw_member(
            &mut raw,
            "PaxHeader",
            b'x',
            metadata.len() as u64,
            &metadata,
        );
        assert!(extract_tar(&gzip_archive(raw), "fixture").is_err());
    }

    #[test]
    fn oci_archive_bounds_entries_members_and_entire_decompressed_stream() {
        let mut too_many = Vec::new();
        for _ in 0..=MAX_ARCHIVE_ENTRIES {
            raw_member(&mut too_many, "./", b'5', 0, b"");
        }
        assert!(extract_tar(&gzip_archive(too_many), "fixture")
            .unwrap_err()
            .contains("entry limit"));
        let mut oversized = Vec::new();
        raw_member(
            &mut oversized,
            "file",
            b'0',
            MAX_ARCHIVE_MEMBER_BYTES + 1,
            b"",
        );
        assert!(extract_tar(&gzip_archive(oversized), "fixture")
            .unwrap_err()
            .contains("member byte limit"));
        let zeros = vec![0; MAX_ARCHIVE_BYTES as usize + 1];
        assert!(extract_tar(&gzip_archive(zeros), "fixture")
            .unwrap_err()
            .contains("decompressed byte limit"));
        let mut directory = Vec::new();
        raw_member(&mut directory, "directory", b'5', 1, b"x");
        assert!(extract_tar(&gzip_archive(directory), "fixture").is_err());
    }

    #[test]
    fn b2_t5_trust_constants_match_js_or_committed_reference() {
        let fallback: Value =
            serde_json::from_str(include_str!("../../test-fixtures/oci-trust-constants.json"))
                .unwrap();
        let expected = [
            ("identity", DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY),
            ("issuer", DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER),
            ("signatureMediaType", COSIGN_SIGNATURE_MEDIA_TYPE),
            ("signatureAnnotation", COSIGN_SIGNATURE_ANNOTATION),
            ("certificateAnnotation", COSIGN_CERTIFICATE_ANNOTATION),
            ("bundleAnnotation", COSIGN_BUNDLE_ANNOTATION),
            ("configMediaType", OCI_CONFIG_MEDIA_TYPE),
            ("profileMediaType", OCI_PROFILE_MEDIA_TYPE),
            ("codeMediaType", OCI_CODE_MEDIA_TYPE),
            ("assetsMediaType", OCI_ASSETS_MEDIA_TYPE),
            ("licensesMediaType", OCI_LICENSES_MEDIA_TYPE),
            ("provenanceMediaType", OCI_PROVENANCE_MEDIA_TYPE),
        ];
        for (name, actual) in expected {
            assert_eq!(
                fallback[name].as_str(),
                Some(actual),
                "fallback {name} drifted"
            );
        }
        assert_eq!(signature_tag("sha256:ab"), "sha256-ab.sig");
        assert_eq!(
            signature_tag("sha256:<hex>"),
            fallback["signatureTagTemplate"]
        );
        assert_eq!(
            OCI_CATALOG_MEDIA_TYPE,
            "application/vnd.pdpp.connector-catalog.v1+json"
        );

        let js_root = dirs::home_dir()
            .unwrap_or_default()
            .join("code/data-connectors/packages/connector-installer-core");
        let registry = js_root.join("oci-registry.mjs");
        let verifier = js_root.join("oci-verify.mjs");
        if registry.is_file() && verifier.is_file() {
            eprintln!("B2-T5 source: {}", js_root.display());
            let source = format!(
                "{}\n{}",
                std::fs::read_to_string(registry).unwrap(),
                std::fs::read_to_string(verifier).unwrap()
            );
            for (_, value) in expected {
                assert!(source.contains(value), "JS trust source is missing {value}");
            }
            assert!(source.contains("replace(\":\", \"-\")") && source.contains(".sig"));
        } else {
            eprintln!("B2-T5 source: committed reference {}", fallback["source"]);
        }
    }
}
