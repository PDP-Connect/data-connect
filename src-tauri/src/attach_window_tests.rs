// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::attach::tests::{
    closed_origin, key_text, pdpp_metadata, pdpp_route, response, serve, serve_with, server_id,
    test_key, BrokenKeychain,
};
use crate::attach::MemorySessionStore;
use crate::{invoke_from, invoke_from_url, mock_app_with_data_dir};
use serde_json::{json, Value};
use tauri::test::MockRuntime;

const COMMANDS: [&str; 6] = [
    "attach_window_view",
    "preview_attach_target",
    "inspect_server",
    "attach_with_pairing_code",
    "attach_with_owner_password",
    "detach_from_server",
];

fn app(data_root: &Path, environment_override: bool) -> tauri::App<MockRuntime> {
    let app = mock_app_with_data_dir(data_root);
    app.manage(AttachWindowState::default());
    app.manage(RelaunchRecorderForTest(Mutex::new(Vec::new())));
    app.manage(EnvironmentOverrideForTest(environment_override));
    app
}

fn window(app: &tauri::App<MockRuntime>, label: &str) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("build a local webview")
}

fn data_dir(data_root: &Path) -> PathBuf {
    data_root.join("app")
}

fn relaunches(app: &tauri::App<MockRuntime>) -> Vec<Option<String>> {
    app.state::<RelaunchRecorderForTest>()
        .0
        .lock()
        .unwrap()
        .clone()
}

fn body(response: tauri::ipc::InvokeResponseBody) -> Value {
    match response {
        tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json).expect("json"),
        tauri::ipc::InvokeResponseBody::Raw(_) => panic!("raw response"),
    }
}

fn saved(data_root: &Path, origin: &str) {
    saved_with_key(data_root, origin, None);
}

fn saved_with_key(data_root: &Path, origin: &str, server_key: Option<String>) {
    attach::save_attachment(
        &data_dir(data_root),
        &Attachment {
            origin: origin.to_string(),
            label: "DataConnect desktop (box)".to_string(),
            paired_at: "2026-11-17T00:00:00Z".to_string(),
            server_key,
        },
    )
    .expect("save attachment");
}

/// Every local-origin webview may call app commands, so each attach
/// command checks the window label itself.
#[test]
fn only_the_attach_window_may_use_the_attach_commands() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    for label in ["main", "console", "owner-password", "recovery"] {
        let other = window(&app, label);
        for command in COMMANDS {
            let response = invoke_from(
                &other,
                command,
                json!({
                    "input": "https://dc.example.com",
                    "code": "ABCD-EFGH-JKMN",
                    "password": "pw",
                    "trustPlainHttp": false,
                }),
            );
            assert_eq!(
                response.expect_err("refused by label"),
                json!("Only the DataConnect attach window can do this."),
                "{label} {command}"
            );
        }
    }
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

/// The label check is not the only gate: Tauri refuses an app command from a
/// page that is not the app's own, because no capability grants `remote`
/// access. Same window, same arguments; only the page URL changes.
#[test]
fn the_attach_window_is_refused_once_its_page_is_not_the_apps_own() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(12);
    let signer = key.clone();
    let (origin, server) = serve_with(3, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    // The view was created from the app's own page.
    invoke_from(&attach_window, "attach_window_view", json!({})).expect("view");

    // The window then navigated to another site.
    for command in COMMANDS {
        let refused = invoke_from_url(
            &attach_window,
            command,
            connect_args(&origin, &key),
            "https://other.example.test/attach.html",
        )
        .expect_err("refused: not the app's own page");
        assert!(
            refused.as_str().is_some_and(|text| text.contains("not allowed")),
            "{command}: {refused}"
        );
    }
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());

    // Back on the app's own page the same call reaches pairing, once. The
    // server saw nothing from the refused calls.
    invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        connect_args(&origin, &key),
    )
    .expect("connected");
    let requests = server.join().expect("server");
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.starts_with("post /owner/desktop-pairings/redeem "))
            .count(),
        1
    );
}

#[test]
fn the_window_view_reports_prefill_once_and_the_saved_attachment() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    {
        let state = app.state::<AttachWindowState>();
        *state.prefill.lock().unwrap() = AttachPrefill {
            input: Some("https://dc.example.com".to_string()),
            notice: Some(attach::PAIRING_ENDED_NOTICE.to_string()),
            identity_changed: Some(IdentityChanged {
                pinned_id: Some("AAAA-BBBB-CCCC-DDDD".to_string()),
                answering_id: None,
            }),
        };
    }
    saved(data_root.path(), "https://dc.example.com");
    let view = body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"));
    assert_eq!(view["environmentOverride"], json!(false));
    assert_eq!(view["environmentMessage"], Value::Null);
    assert_eq!(view["input"], json!("https://dc.example.com"));
    assert_eq!(view["notice"], json!(attach::PAIRING_ENDED_NOTICE));
    assert_eq!(
        view["identityChanged"],
        json!({"pinnedId": "AAAA-BBBB-CCCC-DDDD", "answeringId": null})
    );
    assert_eq!(
        view["attached"],
        json!({"origin": "https://dc.example.com", "host": "dc.example.com", "serverId": null})
    );
    let again = body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"));
    assert_eq!(again["notice"], Value::Null, "a reload must not refill");
    assert_eq!(again["identityChanged"], Value::Null);
}

#[test]
fn an_environment_override_disables_attaching() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), true);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let view = body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"));
    assert_eq!(view["environmentOverride"], json!(true));
    assert!(view["environmentMessage"]
        .as_str()
        .expect("message")
        .starts_with("Set by environment"));
    // No server listens here: a refusal must come before any request.
    let origin = closed_origin();
    // A saved attachment the environment overrides: Detach must keep it.
    saved(data_root.path(), &origin);
    for (command, args) in [
        (
            "attach_with_pairing_code",
            json!({"input": origin, "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
        ),
        (
            "attach_with_owner_password",
            json!({"input": origin, "password": "pw", "trustPlainHttp": false}),
        ),
        ("detach_from_server", json!({})),
    ] {
        let error = invoke_from(&attach_window, command, args).expect_err("refused");
        assert!(
            error
                .as_str()
                .expect("text")
                .starts_with("Set by environment"),
            "{command}: {error}"
        );
    }
    assert!(relaunches(&app).is_empty());
    assert!(attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn the_preview_names_the_target_and_the_plain_http_warning() {
    let https = preview("https://dc.example.com/settings", false);
    assert_eq!(https.origin.as_deref(), Some("https://dc.example.com"));
    assert_eq!(https.policy, Some(HttpsPolicy::Allowed));
    assert!(!https.plain_http);
    assert_eq!(https.warning, None);

    let link = preview(
        "https://dc.example.com/settings#code=ABCD-EFGH-JKMN&key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        false,
    );
    assert_eq!(link.origin.as_deref(), Some("https://dc.example.com"));
    assert_eq!(link.code.as_deref(), Some("ABCDEFGHJKMN"));

    let lan = preview("http://nas:4310", false);
    assert_eq!(lan.origin.as_deref(), Some("http://nas:4310"));
    assert_eq!(lan.policy, Some(HttpsPolicy::Refuse));
    assert!(lan.plain_http);
    assert_eq!(lan.warning.as_deref(), Some(attach::PLAIN_HTTP_WARNING));
    assert_eq!(
        preview("http://nas:4310", true).policy,
        Some(HttpsPolicy::Warn)
    );

    let loopback = preview("localhost:4310", false);
    assert_eq!(loopback.origin.as_deref(), Some("http://localhost:4310"));
    assert_eq!(loopback.policy, Some(HttpsPolicy::Allowed));
    assert!(!loopback.plain_http);

    assert!(preview("ftp://x", false).error.is_some());
    assert_eq!(
        preview("   ", false).error,
        None,
        "an empty field is not an error"
    );
}

#[test]
fn plain_http_to_another_machine_needs_the_trust_box_before_any_request() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    // nas.invalid never resolves; a request would fail as unreachable,
    // not with this message.
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        json!({"input": "http://nas.invalid:4310", "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
    )
    .expect_err("refused");
    assert!(
        error
            .as_str()
            .expect("text")
            .contains("I trust this network"),
        "{error}"
    );
}

fn connect_args(origin: &str, key: &ed25519_dalek::SigningKey) -> Value {
    json!({
        "input": origin,
        "code": "abcd-efgh-jkmn",
        "trustPlainHttp": false,
        "confirmedKey": key_text(key),
    })
}

fn session_sent(requests: &[String]) -> bool {
    requests
        .iter()
        .any(|request| request.contains("pdpp_owner_session="))
}

/// Contact order: the server is identified and proves its key, then the
/// code is redeemed. The key is pinned in attach.json; the session is not.
#[test]
fn pairing_pins_the_proven_key_and_restarts() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(11);
    let signer = key.clone();
    let (origin, server) = serve_with(3, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let outcome = body(
        invoke_from(
            &attach_window,
            "attach_with_pairing_code",
            connect_args(&origin, &key),
        )
        .expect("connected"),
    );
    let requests = server.join().expect("server");
    assert!(requests[0].starts_with("get /.well-known/oauth-protected-resource "));
    assert!(requests[1].starts_with("post /owner/desktop-pairings/identity "));
    assert!(requests[2].starts_with("post /owner/desktop-pairings/redeem "));
    assert!(
        requests[2].contains(r#""code":"abcdefghjkmn""#),
        "{}",
        requests[2]
    );
    assert_eq!(outcome["origin"], json!(origin));
    // Under test the keychain is refused, so the session is memory-only,
    // the owner is told, and the restart carries it.
    assert_eq!(outcome["notice"], json!(attach::MEMORY_ONLY_NOTICE));
    assert_eq!(relaunches(&app), vec![Some("sess-paired".to_string())]);
    let attachment = attach::load_attachment(&data_dir(data_root.path()))
        .expect("read")
        .expect("saved");
    assert_eq!(attachment.origin, origin);
    assert_eq!(attachment.server_key, Some(key_text(&key)));
    let file = std::fs::read_to_string(attach::attachment_path(&data_dir(data_root.path())))
        .expect("attach.json");
    assert!(
        !file.contains("sess-paired"),
        "the session must never reach attach.json"
    );
}

#[test]
fn inspecting_a_server_shows_its_id_and_sends_no_code() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(12);
    let signer = key.clone();
    let (origin, server) = serve_with(2, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let link = format!(
        "{origin}/settings#code=ABCD-EFGH-JKMN&key={}",
        key_text(&key)
    );
    let inspection = body(
        invoke_from(
            &attach_window,
            "inspect_server",
            json!({"input": link, "trustPlainHttp": false}),
        )
        .expect("inspected"),
    );
    let requests = server.join().expect("server");
    assert_eq!(requests.len(), 2, "no redeem request");
    assert!(requests
        .iter()
        .all(|request| !request.contains("abcdefghjkmn")));
    assert_eq!(inspection["origin"], json!(origin));
    assert_eq!(inspection["serverId"], json!(server_id(&key)));
    assert_eq!(inspection["serverKey"], json!(key_text(&key)));
    assert_eq!(inspection["matchesLink"], json!(true));
    assert_eq!(inspection["code"], json!("ABCDEFGHJKMN"));
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn an_address_without_a_link_shows_the_id_but_does_not_claim_a_match() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(12);
    let signer = key.clone();
    let (origin, server) = serve_with(2, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let inspection = body(
        invoke_from(
            &attach_window,
            "inspect_server",
            json!({"input": origin, "trustPlainHttp": false}),
        )
        .expect("inspected"),
    );
    server.join().expect("server");
    assert_eq!(inspection["matchesLink"], json!(false));
    assert_eq!(inspection["serverId"], json!(server_id(&key)));
    assert_eq!(inspection["code"], Value::Null);
}

/// A link names the server's key. A server with another key gets nothing:
/// not the code, not even a connect.
#[test]
fn a_link_key_that_differs_from_the_probed_key_sends_nothing() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let real = test_key(13);
    let linked = test_key(14);
    let signer = real.clone();
    let (origin, server) = serve_with(2, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let link = format!(
        "{origin}/settings#code=ABCD-EFGH-JKMN&key={}",
        key_text(&linked)
    );
    let error = invoke_from(
        &attach_window,
        "inspect_server",
        json!({"input": link, "trustPlainHttp": false}),
    )
    .expect_err("refused");
    assert_eq!(
        error,
        json!(AttachError::KeyDiffersFromLink.message(&origin))
    );
    let requests = server.join().expect("server");
    assert!(requests
        .iter()
        .all(|request| !request.contains("/redeem") && !request.contains("abcdefghjkmn")));
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn connecting_a_key_the_owner_did_not_confirm_sends_no_code() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(15);
    let signer = key.clone();
    let (origin, server) = serve_with(2, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        connect_args(&origin, &test_key(16)),
    )
    .expect_err("refused");
    let requests = server.join().expect("server");
    assert!(error
        .as_str()
        .expect("text")
        .contains("not the one you confirmed"));
    assert!(requests.iter().all(|request| !request.contains("/redeem")));
    assert!(relaunches(&app).is_empty());
}

/// The server redeems with another key than it proved: nothing is saved.
#[test]
fn a_redeem_that_names_another_key_saves_nothing() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(17);
    let signer = key.clone();
    let (origin, server) = serve_with(3, move |origin, request| {
        let answer = pdpp_route(origin, request, Some(&signer));
        if request.path.ends_with("/redeem") {
            answer.replace(&key_text(&signer), &key_text(&test_key(18)))
        } else {
            answer
        }
    });
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        connect_args(&origin, &key),
    )
    .expect_err("refused");
    server.join().expect("server");
    assert_eq!(
        error,
        json!(AttachError::KeyChangedWhileConnecting.message(&origin))
    );
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

/// An older server (404 on the identity route) connects only through the
/// owner password with the tick-box, and is stored unpinned.
#[test]
fn an_older_server_connects_only_by_password_with_the_tick_box_and_stays_unpinned() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);

    let (origin, server) = serve_with(2, |origin, request| pdpp_route(origin, request, None));
    let inspection = body(
        invoke_from(
            &attach_window,
            "inspect_server",
            json!({"input": origin, "trustPlainHttp": false}),
        )
        .expect("inspected"),
    );
    server.join().expect("server");
    assert_eq!(inspection["serverId"], Value::Null);
    assert_eq!(inspection["serverKey"], Value::Null);

    // A code is refused before it is sent.
    let (origin, server) = serve_with(2, |origin, request| pdpp_route(origin, request, None));
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        json!({"input": origin, "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
    )
    .expect_err("refused");
    let requests = server.join().expect("server");
    assert!(error
        .as_str()
        .expect("text")
        .contains("cannot prove its identity"));
    assert!(requests.iter().all(|request| !request.contains("/redeem")));

    // The password without the tick-box is refused before it is sent.
    let (origin, server) = serve_with(2, |origin, request| pdpp_route(origin, request, None));
    let error = invoke_from(
        &attach_window,
        "attach_with_owner_password",
        json!({"input": origin, "password": "pw", "trustPlainHttp": false, "acceptUnverified": false}),
    )
    .expect_err("refused");
    let requests = server.join().expect("server");
    assert!(error.as_str().expect("text").contains("Tick the box"));
    assert!(requests
        .iter()
        .all(|request| !request.contains("/owner/login")));
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());

    // With the tick-box the login runs and the attachment has no key.
    let (origin, server) = serve_with(3, |origin, request| {
        if request.path == "/owner/login" {
            response(
                "200 OK",
                "Set-Cookie: pdpp_owner_session=sess-pw; Path=/; HttpOnly\r\n",
                "{}",
            )
        } else {
            pdpp_route(origin, request, None)
        }
    });
    invoke_from(
        &attach_window,
        "attach_with_owner_password",
        json!({"input": origin, "password": "pw", "trustPlainHttp": false, "acceptUnverified": true}),
    )
    .expect("connected");
    server.join().expect("server");
    let attachment = attach::load_attachment(&data_dir(data_root.path()))
        .expect("read")
        .expect("saved");
    assert_eq!(attachment.origin, origin);
    assert_eq!(attachment.server_key, None);
    assert_eq!(relaunches(&app), vec![Some("sess-pw".to_string())]);
}

/// A server that answers the identity checks (protected-resource metadata,
/// then 404 on the identity route), then accepts the next request and never
/// answers it. It hangs up after `stall` or when the client does.
fn serve_then_stall(stall: std::time::Duration) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let handle = std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        for answer in [pdpp_metadata(), response("404 Not Found", "", "")] {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                let read = stream.read(&mut buffer).expect("read request");
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            // Request bodies are small; the JSON body arrives with the head.
            stream
                .write_all(answer.as_bytes())
                .expect("answer the check");
        }
        let (mut stalled, _) = listener.accept().expect("accept the login");
        stalled.set_read_timeout(Some(stall)).expect("read timeout");
        // Returns when the client hangs up or `stall` passes.
        while matches!(stalled.read(&mut buffer), Ok(read) if read > 0) {}
    });
    (origin, handle)
}

/// A password login that never gets an answer must end with an error and
/// free the window for the next attempt.
#[test]
fn a_stalled_password_login_times_out_and_frees_the_window() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let (origin, server) = serve_then_stall(std::time::Duration::from_secs(15));
    let started = std::time::Instant::now();
    let error = invoke_from(
        &attach_window,
        "attach_with_owner_password",
        json!({"input": origin, "password": "pw", "trustPlainHttp": false, "acceptUnverified": true}),
    )
    .expect_err("the login timed out");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "the login waited {:?}",
        started.elapsed()
    );
    assert_eq!(error, json!(AttachError::Unreachable.message(&origin)));
    assert!(
        !app.state::<AttachWindowState>().busy.load(Ordering::SeqCst),
        "the window is free again"
    );
    let next = invoke_from(
        &attach_window,
        "attach_with_owner_password",
        json!({"input": closed_origin(), "password": "pw", "trustPlainHttp": false, "acceptUnverified": true}),
    )
    .expect_err("nothing listens");
    assert!(
        !next.as_str().expect("text").contains("already connecting"),
        "{next}"
    );
    server.join().expect("server");
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn a_rejected_code_saves_nothing_and_does_not_restart() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let key = test_key(19);
    let signer = key.clone();
    let (origin, server) = serve_with(3, move |origin, request| {
        if request.path.ends_with("/redeem") {
            response(
                "401 Unauthorized",
                "Content-Type: application/json\r\n",
                r#"{"error":"invalid_pairing_code"}"#,
            )
        } else {
            pdpp_route(origin, request, Some(&signer))
        }
    });
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        connect_args(&origin, &key),
    )
    .expect_err("rejected");
    server.join().expect("server");
    assert_eq!(error, json!(AttachError::InvalidCode.message(&origin)));
    assert!(relaunches(&app).is_empty());
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn a_saved_pairing_keeps_the_session_out_of_attach_json_and_forgets_the_previous_one() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let data_dir = data_dir(data_root.path());
    let keychain = MemorySessionStore::default();
    let memory = MemorySessionStore::default();
    assert_eq!(
        save_pairing(
            &data_dir,
            &keychain,
            &memory,
            "https://a.example",
            None,
            "sess-a",
            "t1".into()
        ),
        Ok(StoredIn::Keychain)
    );
    assert_eq!(
        keychain.load("https://a.example"),
        Ok(Some("sess-a".to_string()))
    );
    assert_eq!(
        save_pairing(
            &data_dir,
            &keychain,
            &memory,
            "https://b.example",
            None,
            "sess-b",
            "t2".into()
        ),
        Ok(StoredIn::Keychain)
    );
    assert_eq!(
        keychain.load("https://a.example"),
        Ok(None),
        "switch forgets the old session"
    );
    assert_eq!(
        keychain.load("https://b.example"),
        Ok(Some("sess-b".to_string()))
    );
    let attachment = attach::load_attachment(&data_dir)
        .expect("read")
        .expect("saved");
    assert_eq!(attachment.origin, "https://b.example");
    assert_eq!(attachment.paired_at, "t2");

    assert_eq!(
        save_pairing(
            &data_dir,
            &BrokenKeychain,
            &memory,
            "https://c.example",
            None,
            "sess-c",
            "t3".into()
        ),
        Ok(StoredIn::MemoryOnly)
    );
    assert_eq!(
        memory.load("https://c.example"),
        Ok(Some("sess-c".to_string()))
    );
}

#[tokio::test]
async fn detach_revokes_then_deletes_everything_local() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let data_dir = data_dir(data_root.path());
    let keychain = MemorySessionStore::default();
    let memory = MemorySessionStore::default();
    let (origin, server) = serve(vec![pdpp_metadata(), response("204 No Content", "", "")]);
    save_pairing(
        &data_dir,
        &keychain,
        &memory,
        &origin,
        None,
        "sess-d",
        "t".into(),
    )
    .expect("save");
    let report = detach_saved_attachment(&data_dir, &keychain, &memory)
        .await
        .expect("detached");
    let requests = server.join().expect("server");
    assert!(requests[1].starts_with("post /owner/logout "));
    assert!(requests[1].contains("cookie: pdpp_owner_session=sess-d"));
    assert!(report.server_confirmed);
    assert_eq!(report.keychain_error, None);
    assert_eq!(keychain.load(&origin), Ok(None));
    assert!(attach::load_attachment(&data_dir).expect("read").is_none());
    assert!(report
        .notice()
        .contains("The server ended this computer's session."));
}

#[tokio::test]
async fn detach_finishes_locally_when_the_server_does_not_answer() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let data_dir = data_dir(data_root.path());
    let keychain = MemorySessionStore::default();
    let memory = MemorySessionStore::default();
    let origin = closed_origin();
    save_pairing(
        &data_dir,
        &keychain,
        &memory,
        &origin,
        None,
        "sess-e",
        "t".into(),
    )
    .expect("save");
    let report = detach_saved_attachment(&data_dir, &keychain, &memory)
        .await
        .expect("detached");
    assert!(!report.server_confirmed);
    assert_eq!(keychain.load(&origin), Ok(None));
    assert!(attach::load_attachment(&data_dir).expect("read").is_none());
    let notice = report.notice();
    assert!(notice.contains("did not confirm"), "{notice}");
    assert!(!notice.contains("sess-e"));

    assert_eq!(
        detach_saved_attachment(&data_dir, &keychain, &memory).await,
        Err("DataConnect is not attached to a server.".to_string())
    );
}

#[test]
fn detach_from_the_window_restarts_without_a_session() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    saved(data_root.path(), &closed_origin());
    let notice =
        body(invoke_from(&attach_window, "detach_from_server", json!({})).expect("detach"));
    assert!(notice
        .as_str()
        .expect("text")
        .starts_with("Disconnected from 127.0.0.1:"));
    assert_eq!(relaunches(&app), vec![None]);
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

/// Attaching elsewhere ends the old pairing: the old server is asked to
/// end its session, and the local copy is deleted.
#[test]
fn switching_servers_signs_out_of_the_previous_one() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let (previous, previous_server) =
        serve(vec![pdpp_metadata(), response("204 No Content", "", "")]);
    saved(data_root.path(), &previous);
    attach::process_memory_store()
        .save(&previous, "sess-old")
        .expect("seed");
    let key = test_key(21);
    let signer = key.clone();
    let (origin, server) = serve_with(3, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        connect_args(&origin, &key),
    )
    .expect("attached");
    server.join().expect("server");
    let (joined, waited) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = joined.send(previous_server.join());
    });
    let previous_requests = waited
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the previous server was never asked to end the session")
        .expect("previous server");
    assert!(previous_requests[1].starts_with("post /owner/logout "));
    assert!(previous_requests[1].contains("cookie: pdpp_owner_session=sess-old"));
    assert_eq!(attach::process_memory_store().load(&previous), Ok(None));
    assert_eq!(
        attach::load_attachment(&data_dir(data_root.path()))
            .expect("read")
            .expect("saved")
            .origin,
        origin
    );
}

/// A pinned server proves itself before the logout carries the session; a
/// server that does not gets nothing, and the local copy is still deleted.
#[tokio::test]
async fn disconnecting_a_pinned_server_sends_the_session_only_after_it_proves_itself() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let data_dir = data_dir(data_root.path());
    let key = test_key(22);

    let keychain = MemorySessionStore::default();
    let memory = MemorySessionStore::default();
    let signer = key.clone();
    let (origin, server) = serve_with(2, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    let pinned = key_text(&key);
    save_pairing(
        &data_dir,
        &keychain,
        &memory,
        &origin,
        Some(&pinned),
        "sess-p",
        "t".into(),
    )
    .expect("save");
    let report = detach_saved_attachment(&data_dir, &keychain, &memory)
        .await
        .expect("disconnected");
    let requests = server.join().expect("server");
    assert!(report.server_confirmed);
    let identity_at = requests
        .iter()
        .position(|request| request.starts_with("post /owner/desktop-pairings/identity "))
        .expect("identity probe");
    let session_at = requests
        .iter()
        .position(|request| request.contains("pdpp_owner_session=sess-p"))
        .expect("logout");
    assert!(identity_at < session_at, "{requests:?}");

    // Another server answers at the pinned address.
    let other = test_key(23);
    let signer = other.clone();
    let (origin, server) = serve_with(1, move |origin, request| {
        pdpp_route(origin, request, Some(&signer))
    });
    save_pairing(
        &data_dir,
        &keychain,
        &memory,
        &origin,
        Some(&pinned),
        "sess-q",
        "t".into(),
    )
    .expect("save");
    let report = detach_saved_attachment(&data_dir, &keychain, &memory)
        .await
        .expect("disconnected");
    let requests = server.join().expect("server");
    assert!(!report.server_confirmed);
    assert!(!session_sent(&requests), "{requests:?}");
    assert_eq!(keychain.load(&origin), Ok(None));
    assert!(attach::load_attachment(&data_dir).expect("read").is_none());
}
