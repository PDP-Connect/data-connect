// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::attach::tests::{
    closed_origin, identity_answer, key_text, response, serve_with, server_id, test_key,
};
use ed25519_dalek::Signer;

const VECTOR_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

fn sign(key: &ed25519_dalek::SigningKey, origin: &str, nonce: &str) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(proof_message(origin, nonce).as_bytes()).to_bytes())
}

#[test]
fn the_fingerprint_matches_the_contract_vector() {
    let raw: [u8; 32] = std::array::from_fn(|index| index as u8);
    assert_eq!(URL_SAFE_NO_PAD.encode(raw), VECTOR_KEY);
    assert_eq!(fingerprint(&raw), "MMG4-2KLG-YQZW-NEIS");
    assert_eq!(
        identity_of(VECTOR_KEY).expect("key").fingerprint,
        "MMG4-2KLG-YQZW-NEIS"
    );
}

#[test]
fn keys_must_be_32_unpadded_base64url_bytes() {
    assert!(decode_public_key(VECTOR_KEY).is_ok());
    for bad in [
        "",
        "AAAA",
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        "!!!",
    ] {
        assert!(decode_public_key(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn a_proof_verifies_only_for_its_key_origin_and_nonce() {
    let key = test_key(1);
    let public = key_text(&key);
    let origin = "https://dc.example.com";
    let nonce = "bm9uY2Utbm9uY2Utbm9uY2U";
    let good = sign(&key, origin, nonce);
    assert!(verify_proof(&public, origin, nonce, &good));
    // Wrong key.
    assert!(!verify_proof(&key_text(&test_key(2)), origin, nonce, &good));
    // Wrong origin, wrong nonce.
    assert!(!verify_proof(
        &public,
        "https://other.example.com",
        nonce,
        &good
    ));
    assert!(!verify_proof(&public, origin, "b3RoZXI", &good));
    // The domain separator is part of the signed text.
    let bare = URL_SAFE_NO_PAD.encode(key.sign(format!("{origin}\n{nonce}").as_bytes()).to_bytes());
    assert!(!verify_proof(&public, origin, nonce, &bare));
    // Malformed inputs are false, never a panic.
    for bad in ["", "AAAA", "!!!", &good[..good.len() - 2]] {
        assert!(!verify_proof(&public, origin, nonce, bad), "{bad:?}");
    }
    assert!(!verify_proof("AAAA", origin, nonce, &good));
}

#[test]
fn a_loopback_dial_accepts_the_other_loopback_names_and_nothing_else_does() {
    let key = test_key(3);
    let public = key_text(&key);
    let nonce = "bm9uY2Utbm9uY2Utbm9uY2U";
    for (dialed, signed, accepted) in [
        ("http://127.0.0.1:3000", "http://localhost:3000", true),
        ("http://localhost:3000", "http://127.0.0.1:3000", true),
        ("http://localhost:3000", "http://[::1]:3000", true),
        ("http://[::1]:3000", "http://localhost:3000", true),
        ("http://127.0.0.1:3000", "http://127.0.0.1:3000", true),
        // Same scheme and port are required.
        ("http://127.0.0.1:3000", "http://localhost:3001", false),
        ("http://127.0.0.1:3000", "https://localhost:3000", false),
        ("http://127.0.0.1:3000", "http://localhost", false),
        // Other hosts: the exact canonical origin only.
        ("https://example.com", "http://localhost", false),
        ("https://example.com", "https://localhost", false),
        ("http://10.0.0.20:3000", "http://localhost:3000", false),
        ("http://127.8.9.10:3000", "http://localhost:3000", false),
        ("https://example.com", "https://example.com", true),
    ] {
        let signature = sign(&key, signed, nonce);
        assert_eq!(
            verify_proof_for_dialed(&public, dialed, nonce, &signature),
            accepted,
            "dialed {dialed}, signed {signed}"
        );
    }
}

#[tokio::test]
async fn probing_returns_the_proven_identity_and_sends_no_secret() {
    let key = test_key(4);
    let signer = key.clone();
    let (origin, server) = serve_with(1, move |origin, request| {
        identity_answer(&signer, origin, request)
    });
    let identity = probe_identity(&origin).await.expect("proven");
    assert_eq!(identity.public_key, key_text(&key));
    assert_eq!(identity.fingerprint, server_id(&key));
    let requests = server.join().expect("server");
    assert!(requests[0].starts_with("post /owner/desktop-pairings/identity "));
    assert!(!requests[0].contains("cookie"));
    assert!(!requests[0].contains("authorization"));
    // A fresh nonce: 43 base64url characters for 32 bytes.
    assert!(requests[0].contains(r#"{"nonce":""#), "{}", requests[0]);
}

#[tokio::test]
async fn every_probe_uses_a_new_nonce() {
    let key = test_key(4);
    let (origin, server) = serve_with(2, move |origin, request| {
        identity_answer(&key, origin, request)
    });
    probe_identity(&origin).await.expect("first");
    probe_identity(&origin).await.expect("second");
    let requests = server.join().expect("server");
    let nonce = |request: &str| {
        request
            .split(r#""nonce":""#)
            .nth(1)
            .map(|rest| rest[..43].to_string())
    };
    assert_ne!(nonce(&requests[0]), nonce(&requests[1]));
}

#[tokio::test]
async fn an_older_server_answers_404_and_cannot_prove_identity() {
    let (origin, server) = serve_with(1, |_, _| response("404 Not Found", "", ""));
    assert_eq!(
        probe_identity(&origin).await,
        Err(AttachError::IdentityUnsupported)
    );
    server.join().expect("server");
}

#[tokio::test]
async fn bad_proofs_are_refused_at_first_contact() {
    let key = test_key(5);
    type Handler = Box<dyn Fn(&str, &crate::attach::tests::Request) -> String + Send>;
    let mut cases: Vec<(&str, Handler)> = Vec::new();
    let signer = key.clone();
    cases.push((
        "signed for another origin",
        Box::new(move |_, request| identity_answer(&signer, "https://elsewhere.example", request)),
    ));
    let signer = key.clone();
    cases.push((
        "a different key than the one named",
        Box::new(move |origin, request| {
            let answer = identity_answer(&signer, origin, request);
            answer.replace(&key_text(&signer), &key_text(&test_key(6)))
        }),
    ));
    cases.push((
        "garbage body",
        Box::new(|_, _| response("200 OK", "Content-Type: application/json\r\n", "not json")),
    ));
    cases.push((
        "missing signature",
        Box::new(|_, _| response("200 OK", "Content-Type: application/json\r\n", "{}")),
    ));
    for (name, handler) in cases {
        let (origin, server) = serve_with(1, handler);
        assert_eq!(
            probe_identity(&origin).await,
            Err(AttachError::IdentityProofInvalid),
            "{name}"
        );
        server.join().expect("server");
    }
}

#[tokio::test]
async fn an_unreachable_or_failing_server_is_not_an_identity_answer() {
    assert_eq!(
        probe_identity(&closed_origin()).await,
        Err(AttachError::Unreachable)
    );
    let (origin, server) = serve_with(1, |_, _| response("503 Service Unavailable", "", ""));
    assert_eq!(probe_identity(&origin).await, Err(AttachError::Unreachable));
    server.join().expect("server");
    let (origin, server) = serve_with(1, |_, _| response("500 Internal Server Error", "", ""));
    assert_eq!(
        probe_identity(&origin).await,
        Err(AttachError::Server { status: 500 })
    );
    server.join().expect("server");
}

#[tokio::test]
async fn a_pinned_check_passes_only_for_the_pinned_key() {
    let key = test_key(7);
    let signer = key.clone();
    let (origin, server) = serve_with(1, move |origin, request| {
        identity_answer(&signer, origin, request)
    });
    assert_eq!(
        verify_pinned(&origin, &key_text(&key)).await,
        PinnedCheck::Verified
    );
    server.join().expect("server");

    // Another server answers with a valid proof of its own key.
    let other = test_key(8);
    let signer = other.clone();
    let (origin, server) = serve_with(1, move |origin, request| {
        identity_answer(&signer, origin, request)
    });
    assert_eq!(
        verify_pinned(&origin, &key_text(&key)).await,
        PinnedCheck::Changed {
            answering: Some(server_id(&other))
        }
    );
    server.join().expect("server");
}

#[tokio::test]
async fn a_pinned_check_treats_a_missing_route_or_bad_proof_as_changed() {
    let key_text = key_text(&test_key(7));
    let (origin, server) = serve_with(1, |_, _| response("404 Not Found", "", ""));
    assert_eq!(
        verify_pinned(&origin, &key_text).await,
        PinnedCheck::Changed { answering: None }
    );
    server.join().expect("server");
    let (origin, server) = serve_with(1, |_, _| {
        response("200 OK", "Content-Type: application/json\r\n", "<html>")
    });
    assert_eq!(
        verify_pinned(&origin, &key_text).await,
        PinnedCheck::Changed { answering: None }
    );
    server.join().expect("server");
    assert_eq!(
        verify_pinned(&closed_origin(), &key_text).await,
        PinnedCheck::Unreachable(AttachError::Unreachable)
    );
}
