// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Server identity for attach: the Server ID (key fingerprint) and the
//! signed proof the server gives for a fresh nonce.
//!
//! The server holds an Ed25519 key pair. The desktop pins the public key at
//! pairing and, before it sends the stored session on any later start,
//! asks the server to sign a fresh nonce. The signed text is
//! `dataconnect-instance-proof-v1\n<origin>\n<nonce exactly as sent>`, where
//! `<origin>` is the canonical origin (`url.origin` form) the desktop
//! connects to. Contract: the attach v2 contract shared with the server.

use crate::attach::{endpoint, http_client, is_gateway_failure, AttachError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

const PROOF_DOMAIN: &str = "dataconnect-instance-proof-v1";
const IDENTITY_PATH: &str = "/owner/desktop-pairings/identity";
const NONCE_BYTES: usize = 32;
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// What the owner compares: the key and its Server ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerIdentity {
    /// 32 raw bytes, base64url without padding.
    pub public_key: String,
    /// `XXXX-XXXX-XXXX-XXXX`.
    pub fingerprint: String,
}

/// RFC 4648 base32 without padding. Input length must be a multiple of 5.
fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5);
    for chunk in bytes.chunks_exact(5) {
        let bits = chunk
            .iter()
            .fold(0_u64, |acc, byte| (acc << 8) | u64::from(*byte));
        for group in (0..8).rev() {
            out.push(char::from(
                BASE32_ALPHABET[((bits >> (group * 5)) & 31) as usize],
            ));
        }
    }
    out
}

/// Decode a base64url (no padding) Ed25519 public key to its 32 raw bytes.
pub(crate) fn decode_public_key(encoded: &str) -> Result<[u8; 32], String> {
    URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| "The server key is not valid.".to_string())
}

/// First 10 bytes of SHA-256(raw key) as base32, grouped `XXXX-XXXX-XXXX-XXXX`.
pub(crate) fn fingerprint(raw_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(raw_key);
    let text = base32(&digest[..10]);
    text.as_bytes()
        .chunks(4)
        .map(|group| std::str::from_utf8(group).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

pub(crate) fn identity_of(public_key: &str) -> Result<ServerIdentity, String> {
    let raw = decode_public_key(public_key)?;
    Ok(ServerIdentity {
        public_key: URL_SAFE_NO_PAD.encode(raw),
        fingerprint: fingerprint(&raw),
    })
}

/// The exact text the server signs.
pub(crate) fn proof_message(origin: &str, nonce: &str) -> String {
    format!("{PROOF_DOMAIN}\n{origin}\n{nonce}")
}

/// Whether `signature` (base64url) is the key's signature over the proof
/// text for this origin and nonce. Any malformed input is `false`.
pub(crate) fn verify_proof(public_key: &str, origin: &str, nonce: &str, signature: &str) -> bool {
    let Ok(raw) = decode_public_key(public_key) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&raw) else {
        return false;
    };
    let Some(signature) = URL_SAFE_NO_PAD
        .decode(signature.trim())
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
    else {
        return false;
    };
    key.verify_strict(proof_message(origin, nonce).as_bytes(), &signature)
        .is_ok()
}

const LOOPBACK_NAMES: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The origins a proof for `dialed` may be signed over. A server in a local
/// Docker setup signs its configured name (`http://localhost:P`) even when
/// the desktop dialed `http://127.0.0.1:P`, so a loopback address also
/// accepts the other two loopback names with the same scheme and port. Any
/// other host: the exact canonical origin only.
pub(crate) fn acceptable_proof_origins(dialed: &str) -> Vec<String> {
    let mut origins = vec![dialed.to_string()];
    let Ok(url) = url::Url::parse(dialed) else {
        return origins;
    };
    // `host_str` keeps the brackets of an IPv6 literal.
    let host = url.host_str().unwrap_or_default().to_string();
    if !LOOPBACK_NAMES.contains(&host.as_str()) {
        return origins;
    }
    for name in LOOPBACK_NAMES.into_iter().filter(|name| *name != host) {
        let mut other = url.clone();
        if other.set_host(Some(name)).is_ok() {
            origins.push(other.origin().ascii_serialization());
        }
    }
    origins
}

/// `verify_proof` for the origin the desktop dialed, with the loopback rule.
pub(crate) fn verify_proof_for_dialed(
    public_key: &str,
    dialed: &str,
    nonce: &str,
    signature: &str,
) -> bool {
    acceptable_proof_origins(dialed)
        .iter()
        .any(|origin| verify_proof(public_key, origin, nonce, signature))
}

fn fresh_nonce() -> Result<String, AttachError> {
    let mut bytes = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| AttachError::Unreachable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

enum Proof {
    /// The server signed our nonce with the key it named.
    Proven(ServerIdentity),
    /// 404: a server that predates identity proofs, or a route that is gone.
    NotSupported,
    /// A 200 whose body or signature does not check out.
    Unverifiable,
    Unreachable(AttachError),
}

/// Ask for a proof over a fresh nonce. No secret is sent.
async fn request_proof(origin: &str) -> Proof {
    let nonce = match fresh_nonce() {
        Ok(nonce) => nonce,
        Err(error) => return Proof::Unreachable(error),
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return Proof::Unreachable(error),
    };
    let response = client
        .post(endpoint(origin, IDENTITY_PATH))
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({ "nonce": nonce }))
        .send()
        .await;
    let Ok(response) = response else {
        return Proof::Unreachable(AttachError::Unreachable);
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Proof::NotSupported;
    }
    if is_gateway_failure(status) {
        return Proof::Unreachable(AttachError::Unreachable);
    }
    if status != reqwest::StatusCode::OK {
        return Proof::Unreachable(AttachError::Server {
            status: status.as_u16(),
        });
    }
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return Proof::Unverifiable;
    };
    let field = |name: &str| body.get(name).and_then(serde_json::Value::as_str);
    let (Some(public_key), Some(signature)) = (field("public_key"), field("signature")) else {
        return Proof::Unverifiable;
    };
    if !verify_proof_for_dialed(public_key, origin, &nonce, signature) {
        return Proof::Unverifiable;
    }
    match identity_of(public_key) {
        Ok(identity) => Proof::Proven(identity),
        Err(_) => Proof::Unverifiable,
    }
}

/// First contact: the server's proven identity, or why there is none.
pub(crate) async fn probe_identity(origin: &str) -> Result<ServerIdentity, AttachError> {
    match request_proof(origin).await {
        Proof::Proven(identity) => Ok(identity),
        Proof::NotSupported => Err(AttachError::IdentityUnsupported),
        Proof::Unverifiable => Err(AttachError::IdentityProofInvalid),
        Proof::Unreachable(error) => Err(error),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PinnedCheck {
    Verified,
    /// The server did not answer; the pairing stays.
    Unreachable(AttachError),
    /// Not the pinned server. `answering` is the Server ID of what answered
    /// when it proved a key of its own; nothing else is shown from it.
    Changed {
        answering: Option<String>,
    },
}

/// Later starts: a fresh proof must come from the pinned key.
pub(crate) async fn verify_pinned(origin: &str, pinned_key: &str) -> PinnedCheck {
    match request_proof(origin).await {
        Proof::Proven(identity) if identity.public_key == pinned_key => PinnedCheck::Verified,
        Proof::Proven(identity) => PinnedCheck::Changed {
            answering: Some(identity.fingerprint),
        },
        Proof::NotSupported | Proof::Unverifiable => PinnedCheck::Changed { answering: None },
        Proof::Unreachable(error) => PinnedCheck::Unreachable(error),
    }
}

#[cfg(test)]
#[path = "attach_identity_tests.rs"]
pub(crate) mod tests;
