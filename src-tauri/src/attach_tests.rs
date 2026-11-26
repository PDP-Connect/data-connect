// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn input(origin: &str, code: Option<&str>) -> AttachInput {
    AttachInput {
        origin: origin.to_string(),
        code: code.map(ToOwned::to_owned),
        key: None,
    }
}

const VECTOR_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

/// The string the desktop signs over and verifies against is the origin of
/// the typed address in `url.origin` form, the form the server signs. Each
/// expected value below was produced with Node's `new URL(typed).origin`
/// (scheme defaulted as the desktop does for a bare host).
#[test]
fn typed_variants_reach_the_canonical_origin_the_server_signs() {
    for (typed, canonical) in [
        ("HOST.example:443", "https://host.example"),
        ("https://HOST.example:443/", "https://host.example"),
        ("https://host.example:443", "https://host.example"),
        ("https://host.example/", "https://host.example"),
        ("HTTPS://Host.Example", "https://host.example"),
        ("host.example", "https://host.example"),
        (
            "https://host.example:8443/settings?x=1",
            "https://host.example:8443",
        ),
        ("http://localhost:3000/", "http://localhost:3000"),
        ("http://LOCALHOST:80/x", "http://localhost"),
        ("localhost:3000", "http://localhost:3000"),
        ("http://[::1]:3000", "http://[::1]:3000"),
        ("http://127.0.0.1:4310", "http://127.0.0.1:4310"),
        ("https://bücher.example/", "https://xn--bcher-kva.example"),
    ] {
        assert_eq!(
            parse_attach_input(typed).map(|parsed| parsed.origin),
            Ok(canonical.to_string()),
            "{typed}"
        );
    }
}

#[test]
fn parses_pairing_links_addresses_and_fragments() {
    let link = format!("https://dc.example.com/settings#code=abcd-efgh-jkmn&key={VECTOR_KEY}");
    assert_eq!(
        parse_attach_input(&link),
        Ok(AttachInput {
            origin: "https://dc.example.com".to_string(),
            code: Some("ABCDEFGHJKMN".to_string()),
            key: Some(VECTOR_KEY.to_string()),
        })
    );
    // Path and query are ignored; only the fragment's code and key count.
    assert_eq!(
        parse_attach_input(&format!(
            "  http://localhost:3000/other/path?code=ZZZZ-ZZZZ-ZZZZ&key=x#key={VECTOR_KEY}  "
        )),
        Ok(AttachInput {
            origin: "http://localhost:3000".to_string(),
            code: None,
            key: Some(VECTOR_KEY.to_string()),
        })
    );
    // A bare host with a fragment keeps the scheme rules.
    assert_eq!(
        parse_attach_input("localhost:3000/settings#code=ABCDEFGHJKMN"),
        Ok(input("http://localhost:3000", Some("ABCDEFGHJKMN")))
    );
    assert_eq!(
        parse_attach_input("dc.example.com/settings#code=ABCDEFGHJKMN"),
        Ok(input("https://dc.example.com", Some("ABCDEFGHJKMN")))
    );
    // Unknown fragment names are ignored.
    assert_eq!(
        parse_attach_input("https://dc.example.com/#tab=2"),
        Ok(input("https://dc.example.com", None))
    );
}

#[test]
fn a_bad_code_or_key_in_a_link_is_refused() {
    assert!(parse_attach_input("https://dc.example.com/settings#code=nope").is_err());
    assert!(parse_attach_input("https://dc.example.com/settings#key=AAAA").is_err());
    assert!(parse_attach_input(&format!(
        "https://dc.example.com/settings#key={VECTOR_KEY}="
    ))
    .is_err());
}

#[test]
fn the_vana_scheme_is_not_an_attach_address() {
    for raw in [
        "vana://attach?server=https%3A%2F%2Fdc.example.com&code=ABCDEFGHJKMN",
        "VANA://attach",
        "vana:attach",
        "vana://connect?sessionId=x&secret=y",
    ] {
        assert!(parse_attach_input(raw).is_err(), "{raw}");
    }
}

#[test]
fn reduces_addresses_to_an_origin() {
    for (raw, origin) in [
        (
            "https://dc.example.com/settings?tab=1#x",
            "https://dc.example.com",
        ),
        ("https://dc.example.com:443/", "https://dc.example.com"),
        ("http://10.0.0.20:3000/", "http://10.0.0.20:3000"),
        ("HTTPS://DC.Example.COM", "https://dc.example.com"),
        ("dc.example.com", "https://dc.example.com"),
        ("nas:8080", "https://nas:8080"),
        ("localhost:3000", "http://localhost:3000"),
        ("127.0.0.1:4310/console", "http://127.0.0.1:4310"),
        ("[::1]:3000", "http://[::1]:3000"),
    ] {
        assert_eq!(parse_attach_input(raw), Ok(input(origin, None)), "{raw}");
    }
}

#[test]
fn rejects_unusable_addresses() {
    for raw in [
        "",
        "   ",
        "ftp://dc.example.com",
        "file:///etc/passwd",
        "https://user:pw@dc.example.com",
        "https://user@dc.example.com",
        "https://",
        "javascript:alert(1)",
    ] {
        assert!(parse_attach_input(raw).is_err(), "{raw:?} must be rejected");
    }
}

#[test]
fn normalizes_pairing_codes() {
    assert_eq!(
        normalize_pairing_code(" abcd-efgh-jkmn "),
        Ok("ABCDEFGHJKMN".to_string())
    );
    assert_eq!(
        normalize_pairing_code("ABCD EFGH JKMN"),
        Ok("ABCDEFGHJKMN".to_string())
    );
    assert_eq!(
        normalize_pairing_code("2345-6789-WXYZ"),
        Ok("23456789WXYZ".to_string())
    );
    for bad in [
        "",
        "ABCD-EFGH-JKM",
        "ABCD-EFGH-JKMNP",
        "ABCD-EFGH-JKMI",
        "ABCD-EFGH-JKMO",
        "ABCD-EFGH-JKM0",
        "ABCD-EFGH-JKM1",
        "ABCD-EFGH-JKMU",
        "ABCD-EFGH-JKML",
        "ABCD_EFGH_JKMN",
    ] {
        assert!(normalize_pairing_code(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn https_is_required_unless_loopback_or_trusted() {
    use HttpsPolicy::{Allowed, Refuse, Warn};
    for (origin, trust, expected) in [
        ("https://dc.example.com", false, Allowed),
        ("https://dc.example.com", true, Allowed),
        ("http://localhost:3000", false, Allowed),
        ("http://127.0.0.1:3000", false, Allowed),
        ("http://127.8.9.10:3000", false, Allowed),
        ("http://[::1]:3000", false, Allowed),
        ("http://nas:3000", false, Refuse),
        ("http://10.0.0.20:3000", false, Refuse),
        ("http://nas:3000", true, Warn),
        ("http://dc.example.com", true, Warn),
        ("ftp://dc.example.com", true, Refuse),
        ("not a url", true, Refuse),
    ] {
        assert_eq!(
            https_policy(origin, trust),
            expected,
            "{origin} trust={trust}"
        );
    }
}

fn attachment(origin: &str) -> Attachment {
    Attachment {
        origin: origin.to_string(),
        label: "DataConnect desktop (test)".to_string(),
        paired_at: "2026-11-17T00:00:00+00:00".to_string(),
        server_key: None,
    }
}

#[test]
fn attachment_round_trips_without_secrets() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(load_attachment(dir.path()), Ok(None));
    let saved = attachment("https://dc.example.com");
    save_attachment(dir.path(), &saved).expect("save");
    assert_eq!(load_attachment(dir.path()), Ok(Some(saved)));

    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(ATTACH_FILE)).expect("read"))
            .expect("json");
    let mut keys: Vec<_> = raw.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["label", "origin", "paired_at"]);

    remove_attachment(dir.path()).expect("remove");
    assert_eq!(load_attachment(dir.path()), Ok(None));
    remove_attachment(dir.path()).expect("removing twice is fine");
}

#[test]
fn a_pinned_attachment_round_trips_and_an_old_file_still_loads() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pinned = Attachment {
        server_key: Some(VECTOR_KEY.to_string()),
        ..attachment("https://dc.example.com")
    };
    save_attachment(dir.path(), &pinned).expect("save");
    assert_eq!(load_attachment(dir.path()), Ok(Some(pinned.clone())));
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(ATTACH_FILE)).expect("read"))
            .expect("json");
    assert_eq!(raw["server_key"], serde_json::json!(VECTOR_KEY));
    assert_eq!(pinned.server_id().as_deref(), Some("MMG4-2KLG-YQZW-NEIS"));

    // A file written before pinning has no server_key: unpinned.
    std::fs::write(
        dir.path().join(ATTACH_FILE),
        r#"{"origin":"https://dc.example.com","label":"x","paired_at":"y"}"#,
    )
    .expect("write");
    let loaded = load_attachment(dir.path())
        .expect("loads")
        .expect("present");
    assert_eq!(loaded.server_key, None);
    assert_eq!(loaded.server_id(), None);

    // A key that is not 32 base64url bytes is refused, not trusted.
    std::fs::write(
        dir.path().join(ATTACH_FILE),
        r#"{"origin":"https://dc.example.com","label":"x","paired_at":"y","server_key":"AAAA"}"#,
    )
    .expect("write");
    assert!(load_attachment(dir.path()).is_err());
}

#[test]
fn the_keychain_service_follows_the_app_identifier() {
    assert_eq!(
        keyring_service_for("dev.dataconnect"),
        "dev.dataconnect.attach"
    );
    assert_eq!(
        keyring_service_for("dev.other.build"),
        "dev.other.build.attach"
    );
}

#[test]
fn an_attachment_with_a_bad_origin_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join(ATTACH_FILE),
        r#"{"origin":"https://dc.example.com/path","label":"x","paired_at":"y"}"#,
    )
    .expect("write");
    assert!(load_attachment(dir.path()).is_err());
    std::fs::write(dir.path().join(ATTACH_FILE), "{").expect("write");
    assert!(load_attachment(dir.path()).is_err());
}

#[test]
fn the_environment_override_wins_over_a_saved_attachment() {
    let saved = attachment("https://dc.example.com");
    assert_eq!(
        resolve_attach_target(true, Some(saved.clone())),
        AttachTarget::Environment
    );
    assert_eq!(resolve_attach_target(true, None), AttachTarget::Environment);
    assert_eq!(
        resolve_attach_target(false, Some(saved.clone())),
        AttachTarget::Saved(saved)
    );
    assert_eq!(resolve_attach_target(false, None), AttachTarget::Local);
}

#[test]
fn the_environment_override_needs_a_non_blank_variable() {
    assert!(!env_override_from(|_| None));
    assert!(!env_override_from(|_| Some("  ".to_string())));
    assert!(env_override_from(|name| {
        (name == "DATACONNECT_RI_URL").then(|| "http://127.0.0.1:3000".to_string())
    }));
    assert!(env_override_from(|name| {
        (name == "DATACONNECT_CONSOLE_URL").then(|| "http://127.0.0.1:3001".to_string())
    }));
    // Read only by the legacy reference-server commands; it never put
    // unified mode into attach mode, so it does not override a saved
    // attachment either.
    assert!(!env_override_from(|name| {
        (name == "PDPP_REFERENCE_SERVER_URL").then(|| "http://127.0.0.1:3000".to_string())
    }));
}

#[test]
fn the_attachment_names_its_host() {
    assert_eq!(
        attachment("https://dc.example.com").host(),
        "dc.example.com"
    );
    assert_eq!(attachment("http://localhost:3000").host(), "localhost:3000");
}

/// A keychain that is down: every call fails.
pub(crate) struct BrokenKeychain;

impl SessionStore for BrokenKeychain {
    fn load(&self, _: &str) -> Result<Option<String>, String> {
        Err("no secret service".to_string())
    }
    fn save(&self, _: &str, _: &str) -> Result<(), String> {
        Err("no secret service".to_string())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("no secret service".to_string())
    }
}

#[test]
fn a_working_keychain_holds_the_session() {
    let keychain = MemorySessionStore::default();
    let memory = MemorySessionStore::default();
    let origin = "https://dc.example.com";
    assert_eq!(
        load_session(&keychain, &memory, origin),
        SessionLookup::Missing
    );
    assert_eq!(
        store_session(&keychain, &memory, origin, "sess-1"),
        Ok(StoredIn::Keychain)
    );
    assert_eq!(keychain.load(origin), Ok(Some("sess-1".to_string())));
    assert_eq!(memory.load(origin), Ok(None));
    assert_eq!(
        load_session(&keychain, &memory, origin),
        SessionLookup::Found("sess-1".to_string())
    );
    assert_eq!(
        load_session(&keychain, &memory, "https://other.example.com"),
        SessionLookup::Missing,
        "sessions are keyed by origin"
    );
    forget_session(&keychain, &memory, origin).expect("forget");
    assert_eq!(
        load_session(&keychain, &memory, origin),
        SessionLookup::Missing
    );
}

/// Every file under `root`, at any depth.
fn files_under(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files
}

#[test]
fn an_unavailable_keychain_degrades_to_memory_never_a_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_dir = dir.path().join("app");
    let memory = MemorySessionStore::default();
    let origin = "https://dc.example.com";
    let session = "sess-never-on-disk-7f3a";
    // The whole save a pairing does, with the keychain refusing.
    assert_eq!(
        crate::attach_window::save_pairing(
            &data_dir,
            &BrokenKeychain,
            &memory,
            origin,
            None,
            session,
            "2026-11-17T00:00:00Z".to_string(),
        ),
        Ok(StoredIn::MemoryOnly)
    );
    assert_eq!(
        load_session(&BrokenKeychain, &memory, origin),
        SessionLookup::Found(session.to_string())
    );
    let files = files_under(dir.path());
    assert!(
        files.contains(&attachment_path(&data_dir)),
        "the pairing itself is saved: {files:?}"
    );
    for file in files {
        let bytes = std::fs::read(&file).expect("read file");
        assert!(
            !String::from_utf8_lossy(&bytes).contains(session),
            "{} holds the session",
            file.display()
        );
    }
    assert!(forget_session(&BrokenKeychain, &memory, origin).is_err());
    assert_eq!(
        load_session(&BrokenKeychain, &memory, origin),
        SessionLookup::KeychainUnavailable,
        "the memory copy is gone even when the keychain delete fails"
    );
}

#[test]
fn the_real_keychain_store_is_never_used_under_test() {
    assert!(KeychainSessionStore.load("https://dc.example.com").is_err());
    assert!(KeychainSessionStore
        .save("https://dc.example.com", "s")
        .is_err());
}

#[test]
fn the_session_label_names_this_computer() {
    let label = desktop_session_label();
    assert!(label.starts_with("DataConnect desktop ("), "{label}");
    assert!(label.ends_with(')'), "{label}");
}

/// One request a fake server received.
pub(crate) struct Request {
    pub method: String,
    pub path: String,
    /// The raw request, original case.
    pub raw: String,
    pub body: String,
}

/// Serves `count` connections, answering each with `handler(origin, request)`.
/// Returns the raw requests (lowercased) once all were answered.
pub(crate) fn serve_with(
    count: usize,
    mut handler: impl FnMut(&str, &Request) -> String + Send + 'static,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let served_origin = origin.clone();
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let length = text[..head_end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + length || read == 0 {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let raw = String::from_utf8_lossy(&request).to_string();
            let mut first_line = raw.lines().next().unwrap_or_default().split_whitespace();
            let parsed = Request {
                method: first_line.next().unwrap_or_default().to_string(),
                path: first_line.next().unwrap_or_default().to_string(),
                body: raw
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_string())
                    .unwrap_or_default(),
                raw,
            };
            let answer = handler(&served_origin, &parsed);
            stream.write_all(answer.as_bytes()).expect("answer");
            requests.push(parsed.raw.to_ascii_lowercase());
        }
        requests
    });
    (origin, handle)
}

/// Serves one canned response per connection and returns the raw requests
/// (lowercased) once every response was sent.
pub(crate) fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let count = responses.len();
    let mut responses = responses.into_iter();
    serve_with(count, move |_, _| responses.next().expect("a response"))
}

/// A server's Ed25519 key, from a one-byte seed.
pub(crate) fn test_key(seed: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
}

pub(crate) fn key_text(key: &ed25519_dalek::SigningKey) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
}

pub(crate) fn server_id(key: &ed25519_dalek::SigningKey) -> String {
    crate::attach_identity::fingerprint(&key.verifying_key().to_bytes())
}

/// The identity answer a server gives for the nonce in `request`, signing
/// the proof text for `signed_origin`.
pub(crate) fn identity_answer(
    key: &ed25519_dalek::SigningKey,
    signed_origin: &str,
    request: &Request,
) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::Signer;
    let body: serde_json::Value = serde_json::from_str(&request.body).expect("nonce body");
    let nonce = body["nonce"].as_str().expect("nonce");
    let signature =
        key.sign(crate::attach_identity::proof_message(signed_origin, nonce).as_bytes());
    response(
        "200 OK",
        "Content-Type: application/json\r\nCache-Control: no-store\r\n",
        &serde_json::json!({
            "public_key": key_text(key),
            "fingerprint": server_id(key),
            "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        })
        .to_string(),
    )
}

/// A server that knows its key (`None`: an older server, 404 on the
/// identity route). Answers the routes attach uses; the redeem answer names
/// the key.
pub(crate) fn pdpp_route(
    origin: &str,
    request: &Request,
    key: Option<&ed25519_dalek::SigningKey>,
) -> String {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/.well-known/oauth-protected-resource") => pdpp_metadata(),
        ("POST", "/owner/desktop-pairings/identity") => match key {
            Some(key) => identity_answer(key, origin, request),
            None => response("404 Not Found", "", ""),
        },
        ("POST", "/owner/desktop-pairings/redeem") => response(
            "200 OK",
            "Content-Type: application/json\r\n",
            &serde_json::json!({
                "object": "desktop_pairing_session",
                "session": "sess-paired",
                "expires_at": "2026-12-17T00:00:00.000Z",
                "server_public_key": key.map(key_text),
            })
            .to_string(),
        ),
        ("GET", "/owner/session") => response("204 No Content", "", ""),
        ("POST", "/owner/logout") => response("204 No Content", "", ""),
        other => panic!("unexpected request {other:?}"),
    }
}

pub(crate) fn response(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

pub(crate) fn pdpp_metadata() -> String {
    response(
        "200 OK",
        "Content-Type: application/json\r\n",
        r#"{"resource":"https://dc.example.com","authorization_servers":["https://dc.example.com"]}"#,
    )
}

pub(crate) fn closed_origin() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    drop(listener);
    origin
}

#[tokio::test]
async fn identifies_a_pdpp_server_by_its_protected_resource_metadata() {
    let (origin, server) = serve(vec![pdpp_metadata()]);
    assert_eq!(verify_pdpp_server(&origin).await, Ok(()));
    let requests = server.join().expect("server");
    assert!(requests[0].starts_with("get /.well-known/oauth-protected-resource "));

    let (origin, server) = serve(vec![response(
        "200 OK",
        "Content-Type: text/html\r\n",
        "<html>router login</html>",
    )]);
    assert_eq!(
        verify_pdpp_server(&origin).await,
        Err(AttachError::NotPdppServer)
    );
    server.join().expect("server");

    let (origin, server) = serve(vec![response("404 Not Found", "", "")]);
    assert_eq!(
        verify_pdpp_server(&origin).await,
        Err(AttachError::NotPdppServer)
    );
    server.join().expect("server");

    let (origin, server) = serve(vec![response("502 Bad Gateway", "", "")]);
    assert_eq!(
        verify_pdpp_server(&origin).await,
        Err(AttachError::Unreachable)
    );
    server.join().expect("server");

    assert_eq!(
        verify_pdpp_server(&closed_origin()).await,
        Err(AttachError::Unreachable)
    );
}

#[tokio::test]
async fn the_identity_check_does_not_follow_redirects() {
    let (origin, server) = serve(vec![response(
        "302 Found",
        "Location: https://elsewhere.example.com/.well-known/oauth-protected-resource\r\n",
        "",
    )]);
    assert_eq!(
        verify_pdpp_server(&origin).await,
        Err(AttachError::NotPdppServer)
    );
    assert_eq!(server.join().expect("server").len(), 1);
}

#[tokio::test]
async fn redeems_a_pairing_code_for_a_session() {
    let (origin, server) = serve(vec![response(
        "200 OK",
        "Content-Type: application/json\r\n",
        r#"{"object":"desktop_pairing_session","session":"sess-abc","expires_at":"2026-12-17T00:00:00.000Z","expires_in_seconds":2592000,"label":"DataConnect desktop (box)"}"#,
    )]);
    let redeemed = redeem_pairing(&origin, "ABCDEFGHJKMN", "DataConnect desktop (box)")
        .await
        .expect("redeem");
    assert_eq!(
        redeemed,
        RedeemedSession {
            session: "sess-abc".to_string(),
            expires_at: Some("2026-12-17T00:00:00.000Z".to_string()),
            server_public_key: None,
        }
    );
    let request = &server.join().expect("server")[0];
    assert!(request.starts_with("post /owner/desktop-pairings/redeem "));
    assert!(request.contains("content-type: application/json"));
    assert!(request.contains(r#""code":"abcdefghjkmn""#));
    assert!(request.contains(r#""label":"dataconnect desktop (box)""#));
}

#[tokio::test]
async fn names_each_redeem_failure() {
    let invalid = response(
        "401 Unauthorized",
        "Content-Type: application/json\r\n",
        r#"{"error":{"code":"invalid_pairing_code","message":"x"}}"#,
    );
    for (answer, expected) in [
        (invalid, AttachError::InvalidCode),
        (
            response("404 Not Found", "", ""),
            AttachError::PairingUnsupported,
        ),
        (
            response("405 Method Not Allowed", "", ""),
            AttachError::PairingUnsupported,
        ),
        (
            response("429 Too Many Requests", "Retry-After: 42\r\n", ""),
            AttachError::RateLimited {
                retry_after_seconds: Some(42),
            },
        ),
        (
            response("429 Too Many Requests", "", ""),
            AttachError::RateLimited {
                retry_after_seconds: None,
            },
        ),
        (
            response("500 Internal Server Error", "", ""),
            AttachError::Server { status: 500 },
        ),
        (
            response(
                "200 OK",
                "Content-Type: application/json\r\n",
                r#"{"object":"x"}"#,
            ),
            AttachError::Server { status: 200 },
        ),
    ] {
        let (origin, server) = serve(vec![answer]);
        assert_eq!(
            redeem_pairing(&origin, "ABCDEFGHJKMN", "label").await,
            Err(expected.clone()),
            "{expected:?}"
        );
        server.join().expect("server");
    }
    assert_eq!(
        redeem_pairing(&closed_origin(), "ABCDEFGHJKMN", "label").await,
        Err(AttachError::Unreachable)
    );
}

#[tokio::test]
async fn a_signed_in_session_is_valid() {
    let (origin, server) = serve(vec![pdpp_metadata(), response("204 No Content", "", "")]);
    assert_eq!(
        check_session(&origin, "sess-abc").await,
        SessionCheck::Valid
    );
    let requests = server.join().expect("server");
    assert!(requests[1].starts_with("get /owner/session "));
    assert!(requests[1].contains("\r\ncookie: pdpp_owner_session=sess-abc\r\n"));
    assert!(
        !requests[0].contains("cookie:"),
        "the identity check carries no credential"
    );
}

/// The server answers 401 to a JSON caller whose session ended. Only that
/// answer ends the pairing.
#[tokio::test]
async fn a_rejected_session_has_ended() {
    let (origin, server) = serve(vec![pdpp_metadata(), response("401 Unauthorized", "", "")]);
    assert_eq!(
        check_session(&origin, "sess-abc").await,
        SessionCheck::Expired
    );
    server.join().expect("server");
}

/// Any other refusal may come from a proxy or a fault, not from the end of
/// the session: keep the pairing and show the error.
#[tokio::test]
async fn other_refusals_keep_the_pairing() {
    for (answer, status) in [
        (response("403 Forbidden", "", ""), 403),
        (response("302 Found", "Location: /owner/login\r\n", ""), 302),
        (response("500 Internal Server Error", "", ""), 500),
        (response("418 I'm a teapot", "", ""), 418),
    ] {
        let (origin, server) = serve(vec![pdpp_metadata(), answer]);
        assert_eq!(
            check_session(&origin, "sess-abc").await,
            SessionCheck::Unreachable(AttachError::Server { status }),
            "HTTP {status}"
        );
        server.join().expect("server");
    }
}

#[tokio::test]
async fn a_server_that_is_down_or_not_pdpp_gets_no_session() {
    assert_eq!(
        check_session(&closed_origin(), "sess-abc").await,
        SessionCheck::Unreachable(AttachError::Unreachable)
    );
    let (origin, server) = serve(vec![response("200 OK", "", "<html>other machine</html>")]);
    assert_eq!(
        check_session(&origin, "sess-abc").await,
        SessionCheck::Unreachable(AttachError::NotPdppServer)
    );
    let requests = server.join().expect("server");
    assert_eq!(requests.len(), 1, "the session was never sent");
    assert!(!requests[0].contains("sess-abc"));

    let (origin, server) = serve(vec![
        pdpp_metadata(),
        response("500 Internal Server Error", "", ""),
    ]);
    assert_eq!(
        check_session(&origin, "sess-abc").await,
        SessionCheck::Unreachable(AttachError::Server { status: 500 })
    );
    server.join().expect("server");
}

#[tokio::test]
async fn revoking_signs_the_session_out_as_a_json_client() {
    let (origin, server) = serve(vec![pdpp_metadata(), response("204 No Content", "", "")]);
    assert!(revoke_session(&origin, None, "sess-abc").await);
    let requests = server.join().expect("server");
    assert!(requests[1].starts_with("post /owner/logout "));
    assert!(requests[1].contains("\r\ncookie: pdpp_owner_session=sess-abc\r\n"));
    assert!(requests[1].contains("content-type: application/json"));

    let (origin, server) = serve(vec![
        pdpp_metadata(),
        response("500 Internal Server Error", "", ""),
    ]);
    assert!(!revoke_session(&origin, None, "sess-abc").await);
    server.join().expect("server");
    assert!(!revoke_session(&closed_origin(), None, "sess-abc").await);
}

#[tokio::test]
async fn password_login_errors_follow_the_login_function() {
    let (origin, server) = serve(vec![response(
        "302 Found",
        "Location: /\r\nSet-Cookie: pdpp_owner_session=fresh; Path=/; HttpOnly\r\n",
        "",
    )]);
    assert_eq!(
        login_with_password(&origin, "pw").await,
        Ok("fresh".to_string())
    );
    let request = &server.join().expect("server")[0];
    assert!(request.starts_with("post /owner/login "));
    assert!(
        !request.contains("x-pdpp-owner-session-label"),
        "\"This computer\" would replace the remote's own desktop session"
    );

    for (answer, expected) in [
        (
            response("401 Unauthorized", "", ""),
            AttachError::WrongPassword,
        ),
        (
            response("429 Too Many Requests", "", ""),
            AttachError::RateLimited {
                retry_after_seconds: None,
            },
        ),
        (
            response("500 Internal Server Error", "", ""),
            AttachError::Server { status: 500 },
        ),
    ] {
        let (origin, server) = serve(vec![answer]);
        assert_eq!(login_with_password(&origin, "pw").await, Err(expected));
        server.join().expect("server");
    }
    assert_eq!(
        login_with_password(&closed_origin(), "pw").await,
        Err(AttachError::Unreachable)
    );
}

#[tokio::test]
async fn an_attached_launch_opens_the_console_with_a_valid_session() {
    let (origin, server) = serve(vec![pdpp_metadata(), response("204 No Content", "", "")]);
    assert_eq!(
        decide_attached_launch(&origin, None, SessionLookup::Found("sess-abc".to_string())).await,
        AttachedLaunch::OpenConsole {
            session: "sess-abc".to_string()
        }
    );
    server.join().expect("server");
}

#[tokio::test]
async fn an_attached_launch_with_an_ended_session_asks_to_pair_again() {
    let (origin, server) = serve(vec![pdpp_metadata(), response("401 Unauthorized", "", "")]);
    assert_eq!(
        decide_attached_launch(&origin, None, SessionLookup::Found("sess-abc".to_string())).await,
        AttachedLaunch::PairAgain {
            notice: PAIRING_ENDED_NOTICE.to_string()
        }
    );
    server.join().expect("server");
    assert_eq!(
        decide_attached_launch("https://dc.example.com", None, SessionLookup::Missing).await,
        AttachedLaunch::PairAgain {
            notice: PAIRING_ENDED_NOTICE.to_string()
        },
        "no request is made without a session"
    );
    assert!(matches!(
        decide_attached_launch(
            "https://dc.example.com",
            None,
            SessionLookup::KeychainUnavailable
        )
        .await,
        AttachedLaunch::PairAgain { .. }
    ));
}

#[tokio::test]
async fn an_unreachable_server_keeps_the_pairing_and_names_the_origin() {
    let origin = closed_origin();
    let AttachedLaunch::Unreachable { message } =
        decide_attached_launch(&origin, None, SessionLookup::Found("sess-abc".to_string())).await
    else {
        panic!("expected Unreachable");
    };
    assert!(message.contains(&origin), "{message}");
    assert!(message.contains("disconnect"), "{message}");
}

/// Drive every request that carries a secret against servers that echo the
/// secrets back, and check that no message shown to the owner repeats one.
#[tokio::test]
async fn error_messages_never_include_the_code_session_or_password() {
    const CODE: &str = "QRSTVWXYZ234";
    const SESSION: &str = "sess-secret-5d1c";
    const PASSWORD: &str = "pw-secret-8e2b";
    let echo = format!(r#"{{"error":"{CODE} {SESSION} {PASSWORD}"}}"#);
    let echo_header = format!("Content-Type: application/json\r\nX-Echo: {CODE} {SESSION}\r\n");
    let answers = [
        "200 OK",
        "302 Found",
        "400 Bad Request",
        "401 Unauthorized",
        "403 Forbidden",
        "404 Not Found",
        "429 Too Many Requests",
        "500 Internal Server Error",
        "502 Bad Gateway",
    ];
    let mut messages = Vec::new();
    for status in answers {
        let answer = || response(status, &echo_header, &echo);

        let (origin, server) = serve(vec![answer()]);
        if let Err(error) = redeem_pairing(&origin, CODE, "label").await {
            messages.push(error.message(&origin));
        }
        server.join().expect("server");

        let (origin, server) = serve(vec![answer()]);
        if let Err(error) = login_with_password(&origin, PASSWORD).await {
            messages.push(error.message(&origin));
        }
        server.join().expect("server");

        let (origin, server) = serve(vec![pdpp_metadata(), answer()]);
        if let SessionCheck::Unreachable(error) = check_session(&origin, SESSION).await {
            messages.push(error.message(&origin));
        }
        server.join().expect("server");
    }
    let origin = closed_origin();
    for error in [
        redeem_pairing(&origin, CODE, "label").await.err(),
        login_with_password(&origin, PASSWORD).await.err(),
    ]
    .into_iter()
    .flatten()
    {
        messages.push(error.message(&origin));
    }
    assert!(
        messages.len() >= answers.len() * 2,
        "too few failures to check: {messages:?}"
    );
    for message in &messages {
        assert!(!message.is_empty());
        for secret in [CODE, SESSION, PASSWORD] {
            assert!(!message.contains(secret), "{message}");
        }
    }
}
