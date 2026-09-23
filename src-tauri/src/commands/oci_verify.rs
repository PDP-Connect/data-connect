// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Verification for cosign's OCI signature formats: the legacy simple-signing
//! `.sig` image, and the cosign v3-default Sigstore bundle.
//!
//! Cosign stores the legacy signed JSON payload in a layer at `<digest with
//! ':' replaced by '-'>.sig`.  The OCI client owns transport and descriptor
//! validation; this module turns those already-verified bytes and
//! annotations into a Sigstore bundle, then proves the signature, Fulcio
//! chain, pinned signer identity, and Rekor signed-entry timestamp.
//!
//! Cosign v3 makes the Sigstore protobuf bundle (media type
//! `application/vnd.dev.sigstore.bundle.v0.3+json`) the default signature
//! format instead.  That bundle is a DSSE envelope wrapping an in-toto
//! Statement whose `subject[].digest.sha256` names the signed artifact; the
//! `sigstore` crate verifies it natively (PAE signature, Fulcio chain, SCT,
//! Rekor tlog consistency) given the already-fetched, digest-checked bundle
//! bytes.

use std::{collections::BTreeMap, io::Cursor};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use sigstore::{
    bundle::{
        verify::{policy::Identity, Verifier},
        Bundle,
    },
    crypto::{CosignVerificationKey, Signature},
    trust::{sigstore::SigstoreTrustRoot, TrustRoot},
};

pub(crate) const COSIGN_SIGNATURE_MEDIA_TYPE: &str =
    "application/vnd.dev.cosign.simplesigning.v1+json";
pub(crate) const COSIGN_SIGNATURE_ANNOTATION: &str = "dev.cosignproject.cosign/signature";
pub(crate) const COSIGN_CERTIFICATE_ANNOTATION: &str = "dev.sigstore.cosign/certificate";
pub(crate) const COSIGN_BUNDLE_ANNOTATION: &str = "dev.sigstore.cosign/bundle";
pub(crate) const COSIGN_BUNDLE_V01_MEDIA_TYPE: &str =
    "application/vnd.dev.sigstore.bundle+json;version=0.1";

pub(crate) const DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER: &str =
    "https://token.actions.githubusercontent.com";
pub(crate) const DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY: &str =
    "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main";

/// The `artifactType`/media type cosign v3 gives its default Sigstore bundle,
/// both as a referrer descriptor's `artifactType` and as the bundle layer's
/// own `mediaType`.
pub(crate) const COSIGN_BUNDLE_V03_ARTIFACT_TYPE: &str =
    "application/vnd.dev.sigstore.bundle.v0.3+json";

/// One descriptor-validated simple-signing layer from the cosign `.sig` image.
///
/// `payload` must be the exact bytes fetched for that layer, after the OCI
/// client checked its descriptor digest and size.  Keeping that proof at the
/// transport boundary prevents an annotation from selecting unchecked bytes.
#[derive(Debug, Clone)]
pub(crate) struct CosignSignature {
    pub signature: String,
    pub certificate: String,
    pub bundle: String,
    pub payload: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RekorBundle {
    signed_entry_timestamp: String,
    payload: RekorPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekorPayload {
    body: String,
    integrated_time: i64,
    log_index: i64,
    #[serde(rename = "logID")]
    log_id: String,
}

/// Verifies one of the supplied cosign signatures against the production
/// Sigstore trust root.  A candidate must bind the requested manifest digest,
/// use the PDP-Connect workflow identity and GitHub Actions issuer, and carry
/// a Rekor inclusion promise signed by a trusted Rekor key.
pub(crate) async fn verify_cosign_signature(
    candidates: &[CosignSignature],
    expected_manifest_digest: &str,
    repository: &str,
) -> Result<(), String> {
    validate_reference(repository, expected_manifest_digest)?;
    if candidates.is_empty() {
        return Err(
            "OCI_UNVERIFIABLE: artifact has no usable cosign simple-signing layer".to_owned(),
        );
    }

    let trust_root = SigstoreTrustRoot::new(None).await.map_err(|error| {
        format!("OCI_UNVERIFIABLE: could not load the Sigstore trust root: {error}")
    })?;
    verify_cosign_signature_with_trust_root(
        candidates,
        expected_manifest_digest,
        repository,
        trust_root,
    )
    .await
}

async fn verify_cosign_signature_with_trust_root<R: TrustRoot>(
    candidates: &[CosignSignature],
    expected_manifest_digest: &str,
    repository: &str,
    trust_root: R,
) -> Result<(), String> {
    validate_reference(repository, expected_manifest_digest)?;
    let rekor_keys = trust_root
        .rekor_keys()
        .map_err(|error| format!("OCI_UNVERIFIABLE: could not load trusted Rekor keys: {error}"))?
        .into_iter()
        .map(|(key_id, key)| (key_id, key.to_vec()))
        .collect::<BTreeMap<_, _>>();
    let verifier = Verifier::new(Default::default(), trust_root).map_err(|error| {
        format!("OCI_UNVERIFIABLE: could not initialize Sigstore verification: {error}")
    })?;
    let policy = Identity::new(
        DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
        DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
    );

    let mut failures = Vec::new();
    for candidate in candidates {
        match verify_candidate(
            &verifier,
            &policy,
            &rekor_keys,
            candidate,
            expected_manifest_digest,
            repository,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(error),
        }
    }

    let error_class = if failures
        .iter()
        .any(|error| error.starts_with("OCI_MISIDENTIFIED:"))
    {
        "OCI_MISIDENTIFIED"
    } else {
        "OCI_UNVERIFIABLE"
    };
    Err(format!(
        "{error_class}: no cosign signature for {repository}@{expected_manifest_digest} verified: {}",
        failures.join("; ")
    ))
}

/// Verifies one of the supplied cosign v3 Sigstore bundles against the
/// production trust root.  A candidate must be a DSSE envelope whose in-toto
/// statement names `expected_manifest_bytes`' digest, use the PDP-Connect
/// workflow identity and GitHub Actions issuer, and carry Fulcio + Rekor
/// evidence the crate can check offline.
///
/// `candidates` are already-fetched, digest-verified bundle layer bytes, one
/// per referrer whose manifest named the artifact digest as its `subject`;
/// that check happens at the referrer-selection layer
/// (`fetch_candidate_bundle_manifest` in `oci.rs`), because for this format
/// the claim lives in the outer manifest, not the bundle payload. This
/// function additionally requires the DSSE in-toto statement's own subject
/// digest to match, so a bundle cannot be accepted on a manifest `subject`
/// claim it does not itself repeat.
///
/// `expected_manifest_bytes` are the exact, already digest-checked manifest
/// bytes the caller fetched by digest (`RegistryClient::fetch_manifest_by_digest`),
/// hashed here to produce the `input_digest` the DSSE path compares against
/// the statement's subject — the same relationship the legacy path has
/// between its `payload` bytes and `messageDigest`.
pub(crate) async fn verify_cosign_bundle_signature(
    candidates: &[Vec<u8>],
    expected_manifest_bytes: &[u8],
    repository: &str,
) -> Result<(), String> {
    let expected_manifest_digest = sha256_digest_string(expected_manifest_bytes);
    validate_reference(repository, &expected_manifest_digest)?;
    if candidates.is_empty() {
        return Err("OCI_UNVERIFIABLE: artifact has no usable cosign v3 bundle candidate".into());
    }

    let trust_root = SigstoreTrustRoot::new(None).await.map_err(|error| {
        format!("OCI_UNVERIFIABLE: could not load the Sigstore trust root: {error}")
    })?;
    verify_cosign_bundle_signature_with_trust_root(
        candidates,
        expected_manifest_bytes,
        repository,
        trust_root,
    )
    .await
}

fn sha256_digest_string(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

async fn verify_cosign_bundle_signature_with_trust_root<R: TrustRoot>(
    candidates: &[Vec<u8>],
    expected_manifest_bytes: &[u8],
    repository: &str,
    trust_root: R,
) -> Result<(), String> {
    let expected_manifest_digest = sha256_digest_string(expected_manifest_bytes);
    validate_reference(repository, &expected_manifest_digest)?;
    let verifier = Verifier::new(Default::default(), trust_root).map_err(|error| {
        format!("OCI_UNVERIFIABLE: could not initialize Sigstore verification: {error}")
    })?;
    let policy = Identity::new(
        DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
        DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
    );

    let mut failures = Vec::new();
    for candidate in candidates {
        match verify_bundle_candidate(&verifier, &policy, candidate, expected_manifest_bytes).await
        {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(error),
        }
    }

    let error_class = if failures
        .iter()
        .any(|error| error.starts_with("OCI_MISIDENTIFIED:"))
    {
        "OCI_MISIDENTIFIED"
    } else {
        "OCI_UNVERIFIABLE"
    };
    Err(format!(
        "{error_class}: no cosign v3 bundle for {repository}@{expected_manifest_digest} verified: {}",
        failures.join("; ")
    ))
}

/// Verify one candidate bundle's bytes as a Sigstore bundle.
///
/// `Verifier::verify_digest` takes a live `Sha256` hasher rather than raw
/// digest bytes; the crate finalizes it internally and, on the DSSE path,
/// compares the result against the in-toto statement's subject digest rather
/// than using it as a signed preimage (`verify_bundle_content`'s `Dsse` arm,
/// sigstore 0.14.0 `src/bundle/verify/verifier.rs`). Hashing the real
/// manifest bytes here — rather than trying to seed a hasher with a
/// precomputed digest, which the hash API does not allow — produces exactly
/// that comparison value.
async fn verify_bundle_candidate(
    verifier: &Verifier,
    policy: &Identity,
    bundle_bytes: &[u8],
    manifest_bytes: &[u8],
) -> Result<(), String> {
    let bundle: Bundle = serde_json::from_slice(bundle_bytes).map_err(|error| {
        format!("OCI_UNVERIFIABLE: cosign v3 bundle is not valid JSON: {error}")
    })?;

    // `sigstore` 0.14.0 pins `sha2 = "0.10"`, one major behind this crate's own
    // `sha2 = "0.11"`, so `Verifier::verify_digest` needs the 0.10 `Sha256`
    // type specifically (see the `sha2-for-sigstore` note in `Cargo.toml`).
    use sha2_for_sigstore::Digest as _;
    let mut hasher = sha2_for_sigstore::Sha256::new();
    hasher.update(manifest_bytes);

    // `offline = true`: verify the Rekor evidence embedded in the bundle
    // (inclusion proof + checkpoint, required for a v0.3 bundle) rather than
    // asking the network to fill in missing evidence, matching the legacy
    // path's offline posture.
    verifier
        .verify_digest(hasher, bundle, policy, true)
        .await
        .map_err(|error| {
            let error = error.to_string();
            let error_class = if error.contains("OIDCIssuer") || error.contains("SubjectAltName") {
                "OCI_MISIDENTIFIED"
            } else {
                "OCI_UNVERIFIABLE"
            };
            format!("{error_class}: Sigstore v3 bundle verification failed: {error}")
        })
}

async fn verify_candidate(
    verifier: &Verifier,
    policy: &Identity,
    rekor_keys: &BTreeMap<String, Vec<u8>>,
    candidate: &CosignSignature,
    expected_manifest_digest: &str,
    repository: &str,
) -> Result<(), String> {
    assert_payload_names_digest(&candidate.payload, expected_manifest_digest)?;
    let payload: serde_json::Value = serde_json::from_slice(&candidate.payload)
        .map_err(|e| format!("Invalid cosign payload: {e}"))?;
    if payload
        .pointer("/critical/identity/docker-reference")
        .and_then(serde_json::Value::as_str)
        != Some(format!("ghcr.io/{repository}").as_str())
    {
        return Err("OCI_MISIDENTIFIED: cosign signature names a different repository".into());
    }
    let rekor = parse_rekor_bundle(&candidate.bundle)?;
    let certificate_der = certificate_der(&candidate.certificate)?;
    let signature = decode_base64("cosign signature", &candidate.signature)?;
    verify_rekor_set(rekor_keys, &rekor)?;
    let bundle = assemble_bundle(&candidate.payload, &signature, &certificate_der, &rekor)?;

    // `offline = true` means Sigstore verifies the supplied Rekor evidence
    // rather than asking the network to fill in missing evidence.  The bundle
    // is v0.1 because a cosign `.sig` annotation carries a signed entry
    // timestamp (SET), not a Merkle inclusion proof.
    verifier
        .verify(Cursor::new(&candidate.payload), bundle, policy, true)
        .await
        .map_err(|error| {
            let error = error.to_string();
            let error_class = if error.contains("OIDCIssuer") || error.contains("SubjectAltName") {
                "OCI_MISIDENTIFIED"
            } else {
                "OCI_UNVERIFIABLE"
            };
            format!("{error_class}: Sigstore verification failed: {error}")
        })
}

fn assert_payload_names_digest(
    payload: &[u8],
    expected_manifest_digest: &str,
) -> Result<(), String> {
    let document: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|error| format!("cosign simple-signing payload is not JSON: {error}"))?;
    let actual = document
        .pointer("/critical/image/docker-manifest-digest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "cosign simple-signing payload names no manifest digest".to_owned())?;
    if actual != expected_manifest_digest {
        return Err(format!(
            "OCI_MISIDENTIFIED: cosign signature covers manifest {actual}, not {expected_manifest_digest}"
        ));
    }
    Ok(())
}

fn parse_rekor_bundle(raw: &str) -> Result<RekorBundle, String> {
    let parsed: RekorBundle = serde_json::from_str(raw)
        .map_err(|error| format!("cosign Rekor annotation is not valid JSON: {error}"))?;
    if parsed.signed_entry_timestamp.is_empty() || parsed.payload.body.is_empty() {
        return Err("cosign Rekor annotation has no signed inclusion promise".to_owned());
    }
    if parsed.payload.log_id.len() != 64
        || !parsed
            .payload
            .log_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("cosign Rekor annotation has an invalid log ID".to_owned());
    }
    Ok(parsed)
}

fn assemble_bundle(
    payload: &[u8],
    signature: &[u8],
    certificate_der: &[u8],
    rekor: &RekorBundle,
) -> Result<Bundle, String> {
    let body = decode_base64("Rekor canonicalized body", &rekor.payload.body)?;
    let log_id = hex::decode(&rekor.payload.log_id)
        .map_err(|error| format!("cosign Rekor annotation has an invalid log ID: {error}"))?;
    let set = decode_base64(
        "Rekor signed inclusion promise",
        &rekor.signed_entry_timestamp,
    )?;

    // The Sigstore bundle verifier checks certificate chaining, the certificate
    // identity and issuer, payload signature, body consistency, and validity at
    // Rekor's integrated time.  Its v0.1 path deliberately accepts the SET as
    // evidence but does not validate it, so `verify_rekor_set` closes that gap.
    let bundle_json = json!({
        "mediaType": COSIGN_BUNDLE_V01_MEDIA_TYPE,
        "verificationMaterial": {
            "x509CertificateChain": { "certificates": [{ "rawBytes": BASE64.encode(certificate_der) }] },
            "tlogEntries": [{
                "logIndex": rekor.payload.log_index.to_string(),
                "logId": { "keyId": BASE64.encode(&log_id) },
                "kindVersion": { "kind": rekor_kind(&body)?, "version": rekor_version(&body)? },
                "integratedTime": rekor.payload.integrated_time.to_string(),
                "inclusionPromise": { "signedEntryTimestamp": BASE64.encode(&set) },
                "canonicalizedBody": BASE64.encode(&body)
            }]
        },
        "messageSignature": {
            "messageDigest": { "algorithm": "SHA2_256", "digest": BASE64.encode(Sha256::digest(payload)) },
            "signature": BASE64.encode(signature)
        }
    });

    serde_json::from_value(bundle_json)
        .map_err(|error| format!("could not assemble the cosign Sigstore bundle: {error}"))
}

fn verify_rekor_set(
    trusted_keys: &BTreeMap<String, Vec<u8>>,
    rekor: &RekorBundle,
) -> Result<(), String> {
    let key = trusted_keys.get(&rekor.payload.log_id).ok_or_else(|| {
        format!(
            "Rekor log {} is not in the Sigstore trust root",
            rekor.payload.log_id
        )
    })?;
    let verification_key = CosignVerificationKey::try_from_der(key)
        .map_err(|error| format!("trusted Rekor key is unsupported: {error}"))?;
    let signed_payload = serde_json::to_vec(&json!({
        "body": rekor.payload.body,
        "integratedTime": rekor.payload.integrated_time,
        "logID": rekor.payload.log_id,
        "logIndex": rekor.payload.log_index,
    }))
    .map_err(|error| format!("could not canonicalize Rekor inclusion promise: {error}"))?;
    let set = decode_base64(
        "Rekor signed inclusion promise",
        &rekor.signed_entry_timestamp,
    )?;
    verification_key
        .verify_signature(Signature::Raw(&set), &signed_payload)
        .map_err(|error| format!("Rekor inclusion promise could not be verified: {error}"))
}

fn rekor_kind(body: &[u8]) -> Result<String, String> {
    rekor_body_field(body, "kind")
}

fn rekor_version(body: &[u8]) -> Result<String, String> {
    rekor_body_field(body, "apiVersion")
}

fn rekor_body_field(body: &[u8], field: &str) -> Result<String, String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get(field)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| format!("Rekor canonicalized body has no {field}"))
}

fn certificate_der(certificate: &str) -> Result<Vec<u8>, String> {
    let encoded = certificate
        .replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "")
        .split_whitespace()
        .collect::<String>();
    if encoded.is_empty() {
        return Err("cosign signature has no Fulcio certificate".to_owned());
    }
    decode_base64("Fulcio certificate", &encoded)
}

fn decode_base64(label: &str, encoded: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(encoded)
        .map_err(|error| format!("{label} is not base64: {error}"))
}

fn validate_reference(repository: &str, digest: &str) -> Result<(), String> {
    let connector_key = repository.strip_prefix("pdp-connect/connector/");
    let trusted_connector = connector_key.is_some_and(|key| {
        !key.is_empty()
            && key
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    });
    if !(trusted_connector || repository == "pdp-connect/connector-catalog") {
        return Err(format!(
            "OCI repository is not trusted for PDP-Connect signing: {repository}"
        ));
    }
    let hex = digest.strip_prefix("sha256:").unwrap_or_default();
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("invalid OCI manifest digest: {digest}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sigstore::crypto::SigningScheme;

    fn ynab_fixture() -> CosignSignature {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../test-fixtures/ynab-cosign-signature.json"
        ))
        .expect("valid captured YNAB cosign fixture");
        CosignSignature {
            signature: fixture["signature"].as_str().expect("signature").to_owned(),
            certificate: fixture["certificate"]
                .as_str()
                .expect("certificate")
                .to_owned(),
            bundle: fixture["bundle"].as_str().expect("bundle").to_owned(),
            payload: BASE64
                .decode(fixture["payload"].as_str().expect("payload"))
                .expect("payload bytes"),
        }
    }

    fn captured_trust_root() -> SigstoreTrustRoot {
        SigstoreTrustRoot::from_trusted_root_json_unchecked(include_bytes!(
            "../../test-fixtures/sigstore-trusted-root.json"
        ))
        .expect("valid captured Sigstore trust root")
    }

    // ── cosign v3 Sigstore bundle: real Fulcio-signed fixture ──────────────
    //
    // `fulcio-real-bundle-v03.json` is a real, Fulcio-issued, Rekor-logged
    // cosign v0.3 DSSE bundle (borrowed from the `sigstore` crate's own test
    // suite; see test-fixtures/cosign-v3-bundle/README.md for full
    // provenance). `fulcio-real-manifest-v134.json` is the actual preimage it
    // signed, fetched live from ghcr.io. Together they let these tests drive
    // the real `Verifier::verify_digest` path end to end, not just structural
    // parsing.

    const KUBEWARDEN_IDENTITY: &str = "https://github.com/kubewarden/kubewarden-controller/.github/workflows/release.yml@refs/tags/v1.34.0";
    const KUBEWARDEN_ISSUER: &str = "https://token.actions.githubusercontent.com";

    fn kubewarden_bundle_bytes() -> &'static [u8] {
        include_bytes!("../../test-fixtures/cosign-v3-bundle/fulcio-real-bundle-v03.json")
    }

    fn kubewarden_manifest_bytes() -> &'static [u8] {
        include_bytes!("../../test-fixtures/cosign-v3-bundle/fulcio-real-manifest-v134.json")
    }

    fn kubewarden_policy() -> Identity {
        Identity::new(KUBEWARDEN_IDENTITY, KUBEWARDEN_ISSUER)
    }

    async fn verify_kubewarden_bundle(
        manifest_bytes: &[u8],
        policy: Identity,
    ) -> Result<(), String> {
        let verifier =
            Verifier::new(Default::default(), captured_trust_root()).expect("offline verifier");
        verify_bundle_candidate(
            &verifier,
            &policy,
            kubewarden_bundle_bytes(),
            manifest_bytes,
        )
        .await
    }

    #[tokio::test]
    async fn v3_t1_accepts_a_real_fulcio_signed_v03_bundle_offline() {
        let result =
            verify_kubewarden_bundle(kubewarden_manifest_bytes(), kubewarden_policy()).await;
        assert!(
            result.is_ok(),
            "real Fulcio-signed v0.3 DSSE bundle must verify: {result:?}"
        );
    }

    #[tokio::test]
    async fn v3_t2_refuses_a_payload_digest_mismatch() {
        // Real bundle, but the manifest bytes hashed here are not what the
        // DSSE statement's subject names — this must refuse, not downgrade.
        let error = verify_kubewarden_bundle(b"not the signed artifact", kubewarden_policy())
            .await
            .expect_err("mismatched artifact bytes must be refused");
        assert!(error.starts_with("OCI_UNVERIFIABLE:"), "{error}");
    }

    #[tokio::test]
    async fn v3_t3_refuses_a_wrong_identity() {
        let wrong_identity = Identity::new(
            "https://github.com/attacker/kubewarden-controller/.github/workflows/release.yml@refs/tags/v1.34.0",
            KUBEWARDEN_ISSUER,
        );
        let error = verify_kubewarden_bundle(kubewarden_manifest_bytes(), wrong_identity)
            .await
            .expect_err("wrong identity must be refused");
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
    }

    #[tokio::test]
    async fn v3_t4_refuses_a_wrong_issuer() {
        let wrong_issuer = Identity::new(KUBEWARDEN_IDENTITY, "https://issuer.example.invalid");
        let error = verify_kubewarden_bundle(kubewarden_manifest_bytes(), wrong_issuer)
            .await
            .expect_err("wrong issuer must be refused");
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
    }

    #[tokio::test]
    async fn v3_t5_pinned_policy_refuses_a_real_bundle_for_a_different_signer() {
        // The bundle's real identity is kubewarden's, not
        // DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY, so the PDP-Connect-pinned
        // policy this entry point uses must still refuse it — proving the
        // production policy is actually applied, not bypassed just because
        // the bundle is real and cryptographically valid.
        let error = verify_cosign_bundle_signature_with_trust_root(
            &[kubewarden_bundle_bytes().to_vec()],
            kubewarden_manifest_bytes(),
            "pdp-connect/connector/ynab",
            captured_trust_root(),
        )
        .await
        .expect_err("a real bundle for a different signer must be refused");
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
    }

    #[tokio::test]
    async fn v3_t6_no_candidates_is_unverifiable() {
        let error = verify_cosign_bundle_signature_with_trust_root(
            &[],
            kubewarden_manifest_bytes(),
            "pdp-connect/connector/ynab",
            captured_trust_root(),
        )
        .await
        .expect_err("no candidates must refuse");
        assert!(error.starts_with("OCI_UNVERIFIABLE:"), "{error}");
    }

    #[tokio::test]
    async fn v3_t7_key_based_bundle_is_unverifiable_not_a_downgrade() {
        // The captured cosign-v3-bundle fixture (real wire bytes from
        // data-connectors#148) is key-based (publicKey.hint), not a Fulcio
        // certificate. `sigstore` 0.14.0 cannot build a `CheckedBundle` from
        // `VerificationMaterial::PublicKey` at all
        // (`BundleErrorKind::VerificationMaterialContentUnsupported`), so this
        // must refuse as unverifiable — never silently accepted, and never a
        // panic. We do not have preimage bytes for this fixture's own subject
        // digest (see the fixture README), so this test only proves the
        // refusal path is reached, not a digest match on top of it.
        let key_based_bundle =
            include_bytes!("../../test-fixtures/cosign-v3-bundle/bundle-blob.json");
        let verifier =
            Verifier::new(Default::default(), captured_trust_root()).expect("offline verifier");
        let error = verify_bundle_candidate(
            &verifier,
            &kubewarden_policy(),
            key_based_bundle,
            b"placeholder artifact bytes",
        )
        .await
        .expect_err("key-based bundle must not verify");
        assert!(error.starts_with("OCI_UNVERIFIABLE:"), "{error}");
        assert!(
            error.contains("unsupported VerificationMaterial::Content"),
            "expected the crate's own unsupported-content-material refusal, got: {error}"
        );
    }

    async fn verify_fixture_with_policy(
        candidate: &CosignSignature,
        policy: Identity,
    ) -> Result<(), String> {
        let trust_root = captured_trust_root();
        let rekor_keys = trust_root
            .rekor_keys()
            .expect("trusted Rekor keys")
            .into_iter()
            .map(|(id, key)| (id, key.to_vec()))
            .collect::<BTreeMap<_, _>>();
        let verifier = Verifier::new(Default::default(), trust_root).expect("offline verifier");
        verify_candidate(
            &verifier,
            &policy,
            &rekor_keys,
            candidate,
            "sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad",
            "pdp-connect/connector/ynab",
        )
        .await
    }

    #[test]
    fn accepts_only_the_pinned_oci_repositories() {
        let digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(validate_reference("pdp-connect/connector/ynab", digest).is_ok());
        assert!(validate_reference("pdp-connect/connector-catalog", digest).is_ok());
        assert!(validate_reference("pdp-connect/connector/ynab/extra", digest).is_err());
        assert!(validate_reference("attacker/connector/ynab", digest).is_err());
    }

    #[test]
    fn different_manifest_digest_is_refused_before_signature_verification() {
        let expected = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let payload = serde_json::to_vec(&json!({
            "critical": {
                "image": {
                    "docker-manifest-digest":
                        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }
            }
        }))
        .unwrap();
        let error = assert_payload_names_digest(&payload, expected).unwrap_err();
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
        assert!(error.contains("covers manifest"));
    }

    #[test]
    fn b2_t1_accepts_a_real_rekor_signature_and_refuses_a_changed_entry() {
        // This signs and verifies the actual canonical SET bytes with the
        // Sigstore crate's ECDSA implementation.  It is deliberately not a
        // boolean mock of transparency-log verification.
        let signer = SigningScheme::ECDSA_P256_SHA256_ASN1
            .create_signer()
            .expect("test signer");
        let public_key = match signer.to_verification_key().expect("test verification key") {
            CosignVerificationKey::ECDSA_P256_SHA256_ASN1(key) => key,
            _ => panic!("P-256 signer returned an unexpected verification key"),
        };
        let key_id = hex::encode(Sha256::digest(&public_key));
        let mut keys = BTreeMap::new();
        keys.insert(key_id.clone(), public_key);
        let mut rekor = RekorBundle {
            signed_entry_timestamp: String::new(),
            payload: RekorPayload {
                body: BASE64.encode(br#"{\"apiVersion\":\"0.0.1\",\"kind\":\"hashedrekord\"}"#),
                integrated_time: 1_757_894_400,
                log_index: 1,
                log_id: key_id,
            },
        };
        let set_payload = serde_json::to_vec(&json!({
            "body": rekor.payload.body,
            "integratedTime": rekor.payload.integrated_time,
            "logID": rekor.payload.log_id,
            "logIndex": rekor.payload.log_index,
        }))
        .expect("canonical test SET payload");
        rekor.signed_entry_timestamp = BASE64.encode(signer.sign(&set_payload).expect("sign SET"));

        assert!(verify_rekor_set(&keys, &rekor).is_ok());
        rekor.payload.log_index += 1;
        assert!(verify_rekor_set(&keys, &rekor).is_err());
    }

    #[tokio::test]
    async fn b2_t1_verifies_captured_ynab_signature_offline_and_refuses_a_different_ref() {
        let digest = "sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad";
        let fixture = ynab_fixture();
        verify_cosign_signature_with_trust_root(
            &[fixture.clone()],
            digest,
            "pdp-connect/connector/ynab",
            captured_trust_root(),
        )
        .await
        .expect("captured pinned GitHub Actions signature must verify");

        let different_ref = Identity::new(
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY.replace("main", "main2"),
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
        );
        let error = verify_fixture_with_policy(&fixture, different_ref)
            .await
            .unwrap_err();
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
    }

    #[tokio::test]
    async fn refuses_a_valid_signature_replayed_from_another_repository() {
        let error = verify_cosign_signature_with_trust_root(
            &[ynab_fixture()],
            "sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad",
            "pdp-connect/connector/github",
            captured_trust_root(),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");
        assert!(error.contains("different repository"));
    }

    #[tokio::test]
    async fn accepts_one_trusted_signature_among_invalid_candidates() {
        let valid = ynab_fixture();
        let mut invalid = valid.clone();
        invalid.signature = "aW52YWxpZA==".into();
        verify_cosign_signature_with_trust_root(
            &[invalid, valid],
            "sha256:9da6a382500368ef28a8c9f59351d1f3ab6871297bf27418c7c63e8d9e241fad",
            "pdp-connect/connector/ynab",
            captured_trust_root(),
        )
        .await
        .expect("one pinned signature authorizes the artifact");
    }

    #[tokio::test]
    async fn b2_t6_catalog_refuses_a_signer_outside_the_shared_workflow_identity() {
        let fixture = ynab_fixture();
        let foreign_identity = Identity::new(
            "https://github.com/attacker/connector-catalog/.github/workflows/publish.yml@refs/heads/main",
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
        );
        let error = verify_fixture_with_policy(&fixture, foreign_identity)
            .await
            .unwrap_err();
        assert!(error.starts_with("OCI_MISIDENTIFIED:"), "{error}");

        let wrong_issuer = Identity::new(
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
            "https://issuer.example.invalid",
        );
        assert!(verify_fixture_with_policy(&fixture, wrong_issuer)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn refuses_missing_or_tampered_rekor_evidence() {
        let fixture = ynab_fixture();
        let policy = Identity::new(
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
        );
        let mut missing = fixture.clone();
        missing.bundle = "{}".to_owned();
        assert!(verify_fixture_with_policy(&missing, policy).await.is_err());

        let mut tampered = fixture;
        let mut bundle: serde_json::Value =
            serde_json::from_str(&tampered.bundle).expect("bundle JSON");
        bundle["Payload"]["logIndex"] = serde_json::json!(0);
        tampered.bundle = serde_json::to_string(&bundle).expect("bundle JSON");
        let policy = Identity::new(
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
            DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
        );
        assert!(verify_fixture_with_policy(&tampered, policy).await.is_err());
    }
}
