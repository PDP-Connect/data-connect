// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Verification for cosign's legacy OCI simple-signing objects.
//!
//! Cosign stores the signed JSON payload in a layer at `<digest with ':' replaced
//! by '-'>.sig`.  The OCI client owns transport and descriptor validation; this
//! module turns those already-verified bytes and annotations into a Sigstore
//! bundle, then proves the signature, Fulcio chain, pinned signer identity, and
//! Rekor signed-entry timestamp.

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
