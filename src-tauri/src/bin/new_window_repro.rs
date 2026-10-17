// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone repro/verification harness for whether Tauri's `on_navigation`
//! handler fires for a plain `<a>` click (and for the window's own initial
//! navigation) inside a `WebviewUrl::External` window on WebKitGTK -- the
//! mechanism `waspflow/on-new-window-link-bridge-0921` settled on after two
//! prior rounds failed:
//!
//! ROUND 1 (a plain `<a target="_blank" rel="noopener">` anchor, tested via
//! `on_new_window`) was tested by Tim with a real pointer click and did NOT
//! reach the handler -- WebKitGTK evidently does not route target=_blank
//! anchor activation through `on_new_window`.
//!
//! ROUND 2 (`window.open()` from a click handler, still via `on_new_window`)
//! was never click-tested before the design moved on.
//!
//! ROUND 3 (this version): `on_navigation` instead of `on_new_window`.
//! Tauri's own doc ties `on_navigation` to every navigation attempt in the
//! webview, with no user-gesture-trust requirement the way `window.open()`
//! has -- so unlike rounds 1 and 2, a SCRIPTED click is a valid test here,
//! not a false positive risk, since the concern that motivated requiring a
//! real human click (WebKit blocking untrusted synthetic events reaching
//! window.open) does not apply to plain navigation/anchor activation.
//!
//! Not part of the shipped app. Built only behind the `stall-repro` feature,
//! same as the other throwaway measurement binaries in this crate.
//!
//! Serves a page with a same-origin link (must be ALLOWED) and an
//! external-origin link (must be DENIED and handed to the OS opener) over a
//! real `http://127.0.0.1:<port>` origin, matching the real console's
//! `WebviewUrl::External(http://...)` shape. Clicks both links via a
//! `webview.eval()`-dispatched script (a real DOM click event, `isTrusted:
//! false`, but `on_navigation` does not gate on trust) after a short delay,
//! and prints a distinct, greppable line for every `on_navigation` call this
//! process observes, so the two cases (same-origin allowed, external denied
//! and opened) are both provable from one run with no human required.

use std::io::Write;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PAGE: &str = r#"<!DOCTYPE html>
<html>
<head><title>on_navigation repro (round 3)</title></head>
<body>
<h1>on_navigation repro -- round 3</h1>
<p>Rounds 1-2 (on_new_window, anchor and window.open) either failed a real
click test or were never tested. This round uses on_navigation instead,
which fires on every navigation attempt including plain anchor clicks, and
requires no trusted-gesture context.</p>
<a id="same-origin-link" href="/settings">Same-origin link (must be ALLOWED)</a>
<br>
<a id="external-link" href="https://pdpp.dev/">External link (must be DENIED + opened externally)</a>
<div id="settings-marker" style="display:none">this is the /settings page</div>
</body>
</html>"#;

const SETTINGS_PAGE: &str = r#"<!DOCTYPE html>
<html>
<head><title>settings</title></head>
<body><div id="settings-marker">this is the /settings page</div></body>
</html>"#;

fn serve_one_request(listener: &TcpListener) {
    if let Ok((mut stream, _)) = listener.accept() {
        use std::io::Read as _;
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request_line = String::from_utf8_lossy(&buf[..n]);
        let body: &[u8] = if request_line.starts_with("GET /settings") {
            SETTINGS_PAGE.as_bytes()
        } else {
            PAGE.as_bytes()
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.write_all(body);
    }
}

fn main() {
    eprintln!("[nav-repro] pid={}", std::process::id());

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a free port");
    let port = listener.local_addr().expect("local addr").port();
    let page_url = format!("http://127.0.0.1:{port}/");
    eprintln!("[nav-repro] serving {page_url}");

    std::thread::spawn(move || loop {
        serve_one_request(&listener);
    });

    let navigations: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let navigations_for_handler = navigations.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let external_url: tauri::Url = page_url.parse().expect("valid page url");
            let console_origin = external_url.clone();
            let window = WebviewWindowBuilder::new(app, "repro", WebviewUrl::External(external_url))
                .title("on_navigation repro")
                .inner_size(800.0, 600.0)
                .on_navigation(move |url| {
                    let allowed = url.scheme() == console_origin.scheme()
                        && url.host_str() == console_origin.host_str()
                        && url.port_or_known_default() == console_origin.port_or_known_default();
                    eprintln!(
                        "[nav-repro] ON_NAVIGATION_FIRED url={url} allowed={allowed} at={:?}",
                        std::time::SystemTime::now()
                    );
                    navigations_for_handler
                        .lock()
                        .expect("lock")
                        .push(format!("{url} allowed={allowed}"));
                    let _ = std::io::stderr().flush();
                    if !allowed && url.scheme() == "https" {
                        // See src/unified.rs's OPEN_EXTERNAL_DRY_RUN_ENV_VAR
                        // doc comment: open::that_detached shells out to
                        // xdg-open, which reaches the owner's REAL desktop
                        // session regardless of this process's own DISPLAY --
                        // an isolated Xvfb display does not contain it. A
                        // verification run of this binary must set
                        // PDPP_OPEN_EXTERNAL_DRY_RUN=1 or it will pop a tab
                        // in a real browser, confirmed the hard way.
                        if std::env::var("PDPP_OPEN_EXTERNAL_DRY_RUN").as_deref() == Ok("1") {
                            eprintln!("[nav-repro] dry run: would open {url}");
                        } else if let Err(error) = open::that_detached(url.as_str()) {
                            eprintln!("[nav-repro] open::that_detached failed: {error}");
                        } else {
                            eprintln!("[nav-repro] open::that_detached called for {url}");
                        }
                    }
                    allowed
                })
                .build()
                .expect("build repro window");

            let window_for_click = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                eprintln!("[nav-repro] dispatching scripted click on external-link");
                let _ = window_for_click.eval(
                    "document.getElementById('external-link').click();",
                );
                std::thread::sleep(std::time::Duration::from_millis(1500));
                eprintln!("[nav-repro] dispatching scripted click on same-origin-link");
                let _ = window_for_click.eval(
                    "document.getElementById('same-origin-link').click();",
                );
                std::thread::sleep(std::time::Duration::from_millis(1500));
                eprintln!("[nav-repro] DONE, exiting");
                std::process::exit(0);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run repro app");
}
