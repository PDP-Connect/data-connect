// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::attach::tests::{closed_origin, pdpp_metadata, response, serve, BrokenKeychain};
use crate::attach::MemorySessionStore;
use crate::{invoke_from, mock_app_with_data_dir};
use serde_json::{json, Value};
use tauri::test::MockRuntime;

const COMMANDS: [&str; 5] = [
    "attach_window_view",
    "preview_attach_target",
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
    attach::save_attachment(
        &data_dir(data_root),
        &Attachment {
            origin: origin.to_string(),
            label: "DataConnect desktop (box)".to_string(),
            paired_at: "2026-11-17T00:00:00Z".to_string(),
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

#[test]
fn the_window_view_reports_prefill_once_and_the_saved_attachment() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    {
        let state = app.state::<AttachWindowState>();
        *state.prefill.lock().unwrap() = AttachPrefill {
            input: Some("https://dc.example.com".to_string()),
            code: Some("ABCDEFGHJKMN".to_string()),
            notice: Some(attach::PAIRING_ENDED_NOTICE.to_string()),
        };
    }
    saved(data_root.path(), "https://dc.example.com");
    let view = body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"));
    assert_eq!(view["environmentOverride"], json!(false));
    assert_eq!(view["environmentMessage"], Value::Null);
    assert_eq!(view["input"], json!("https://dc.example.com"));
    assert_eq!(view["code"], json!("ABCDEFGHJKMN"));
    assert_eq!(view["notice"], json!(attach::PAIRING_ENDED_NOTICE));
    assert_eq!(
        view["attached"],
        json!({"origin": "https://dc.example.com", "host": "dc.example.com"})
    );
    let again = body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"));
    assert_eq!(
        again["code"],
        Value::Null,
        "a reload must not refill the code"
    );
    assert_eq!(again["notice"], Value::Null);
}

/// A second instance started by a pairing link both routes the link and
/// re-runs the saved-attachment start, which asks for the window again
/// without a code. That second request must only focus the window.
#[test]
fn a_pairing_link_code_survives_a_later_request_without_a_code() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let link = |code: &str| AttachPrefill {
        input: Some("https://dc.example.com".to_string()),
        code: Some(code.to_string()),
        notice: None,
    };
    let pair_again = AttachPrefill {
        input: Some("https://dc.example.com".to_string()),
        code: None,
        notice: Some(attach::PAIRING_ENDED_NOTICE.to_string()),
    };
    let view = |app: &tauri::App<MockRuntime>| {
        let attach_window = app
            .get_webview_window(ATTACH_WINDOW_LABEL)
            .expect("attach window open");
        body(invoke_from(&attach_window, "attach_window_view", json!({})).expect("view"))
    };

    open_attach_window(app.handle(), link("ABCDEFGHJKMN"));
    open_attach_window(app.handle(), pair_again.clone());
    assert_eq!(view(&app)["code"], json!("ABCDEFGHJKMN"));

    // A newer link still replaces the code it shows.
    open_attach_window(app.handle(), link("NMKJHGFEDCBA"));
    assert_eq!(view(&app)["code"], json!("NMKJHGFEDCBA"));

    // After the page loaded the code, a request without one changes nothing.
    open_attach_window(app.handle(), pair_again);
    let after = view(&app);
    assert_eq!(after["code"], Value::Null);
    assert_eq!(after["notice"], Value::Null, "the window was not reloaded");
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
    for (command, args) in [
        (
            "attach_with_pairing_code",
            json!({"input": origin, "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
        ),
        (
            "attach_with_owner_password",
            json!({"input": origin, "password": "pw", "trustPlainHttp": false}),
        ),
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
}

#[test]
fn the_preview_names_the_target_and_the_plain_http_warning() {
    let https = preview("https://dc.example.com/settings", false);
    assert_eq!(https.origin.as_deref(), Some("https://dc.example.com"));
    assert_eq!(https.policy, Some(HttpsPolicy::Allowed));
    assert!(!https.plain_http);
    assert_eq!(https.warning, None);

    let link = preview(
        "vana://attach?server=https%3A%2F%2Fdc.example.com&code=ABCD-EFGH-JKMN",
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

#[test]
fn pairing_saves_the_attachment_and_restarts() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let app = app(data_root.path(), false);
    let attach_window = window(&app, ATTACH_WINDOW_LABEL);
    let (origin, server) = serve(vec![
        pdpp_metadata(),
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"object":"desktop_pairing_session","session":"sess-paired","expires_at":"2026-12-17T00:00:00.000Z","expires_in_seconds":2592000,"label":"x"}"#,
        ),
    ]);
    let outcome = body(
        invoke_from(
            &attach_window,
            "attach_with_pairing_code",
            json!({"input": origin, "code": "abcd-efgh-jkmn", "trustPlainHttp": false}),
        )
        .expect("attached"),
    );
    let requests = server.join().expect("server");
    assert!(requests[1].starts_with("post /owner/desktop-pairings/redeem "));
    assert!(
        requests[1].contains(r#""code":"abcdefghjkmn""#),
        "{}",
        requests[1]
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
    let file = std::fs::read_to_string(attach::attachment_path(&data_dir(data_root.path())))
        .expect("attach.json");
    assert!(
        !file.contains("sess-paired"),
        "the session must never reach attach.json"
    );
}

/// A server that answers the identity check, then accepts the next request
/// and never answers it. It hangs up after `stall` or when the client does.
fn serve_then_stall(stall: std::time::Duration) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buffer = [0_u8; 4096];
        let mut request = Vec::new();
        while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
            let read = stream.read(&mut buffer).expect("read request");
            if read == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        stream
            .write_all(pdpp_metadata().as_bytes())
            .expect("answer the identity check");
        drop(stream);
        let (mut stalled, _) = listener.accept().expect("accept the login");
        stalled
            .set_read_timeout(Some(stall))
            .expect("read timeout");
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
        json!({"input": origin, "password": "pw", "trustPlainHttp": false}),
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
        json!({"input": closed_origin(), "password": "pw", "trustPlainHttp": false}),
    )
    .expect_err("nothing listens");
    assert!(
        !next.as_str().expect("text").contains("already attaching"),
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
    let (origin, server) = serve(vec![
        pdpp_metadata(),
        response(
            "401 Unauthorized",
            "Content-Type: application/json\r\n",
            r#"{"error":"invalid_pairing_code"}"#,
        ),
    ]);
    let error = invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        json!({"input": origin, "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
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
    save_pairing(&data_dir, &keychain, &memory, &origin, "sess-d", "t".into()).expect("save");
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
    save_pairing(&data_dir, &keychain, &memory, &origin, "sess-e", "t".into()).expect("save");
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
        .starts_with("Detached from 127.0.0.1:"));
    assert_eq!(relaunches(&app), vec![None]);
    assert!(!attach::attachment_path(&data_dir(data_root.path())).exists());
}

#[test]
fn a_restart_drops_deep_links_from_the_arguments() {
    let args = [
        "--minimized",
        "vana://attach?server=x&code=ABCD",
        "VANA://connect?x",
        "other",
    ]
    .into_iter()
    .map(std::ffi::OsString::from);
    assert_eq!(
        relaunch_args(args),
        vec![
            std::ffi::OsString::from("--minimized"),
            std::ffi::OsString::from("other")
        ]
    );
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
    let (origin, server) = serve(vec![
        pdpp_metadata(),
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"object":"desktop_pairing_session","session":"sess-new","expires_at":"2026-12-17T00:00:00.000Z","expires_in_seconds":2592000,"label":"x"}"#,
        ),
    ]);
    invoke_from(
        &attach_window,
        "attach_with_pairing_code",
        json!({"input": origin, "code": "ABCDEFGHJKMN", "trustPlainHttp": false}),
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
