// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! Install authentication cookies without recursively pumping the UI event loop.
use std::future::Future;
use tauri::{webview::Cookie, Url, Webview};

#[cfg(any(target_os = "macos", target_os = "linux", test))]
const COOKIE_COMPLETION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(crate) async fn set_cookies_then_navigate(
    webview: &Webview,
    cookies: Vec<Cookie<'static>>,
    url: Url,
) -> Result<(), String> {
    navigate_after_cookie_completion(
        async {
            for cookie in cookies {
                set_cookie(webview, cookie, &url).await?;
            }
            Ok(())
        },
        || {
            webview
                .navigate(url.clone())
                .map_err(|_| "Failed to navigate authenticated webview".to_string())
        },
    )
    .await
}

async fn navigate_after_cookie_completion(
    completion: impl Future<Output = Result<(), String>>,
    navigate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    completion.await?;
    navigate()
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
async fn wait_for_cookie_completion(
    receive: tokio::sync::oneshot::Receiver<Result<(), String>>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, receive)
        .await
        .map_err(|_| "Timed out waiting for authentication cookie completion".to_string())?
        .map_err(|_| "Authentication cookie completion was dropped".to_string())?
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn set_cookie(webview: &Webview, cookie: Cookie<'static>, url: &Url) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let url = url.clone();
    // with_webview queues work on the UI thread. The native completion returns
    // through a channel; only the async caller waits, never the UI thread.
    webview
        .with_webview(move |platform| install_cookie(platform, cookie, url, send))
        .map_err(|_| "Failed to dispatch authentication cookie installation".to_string())?;
    wait_for_cookie_completion(receive, COOKIE_COMPLETION_TIMEOUT).await
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn set_cookie(webview: &Webview, cookie: Cookie<'static>, _url: &Url) -> Result<(), String> {
    webview
        .set_cookie(cookie)
        .map_err(|_| "Failed to set authentication cookie".to_string())
}

#[cfg(target_os = "macos")]
fn install_cookie(
    platform: tauri::webview::PlatformWebview,
    cookie: Cookie<'static>,
    url: Url,
    send: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use objc2_foundation::{NSDictionary, NSHTTPCookie, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    // SAFETY: Tauri supplies a live WKWebView on the main thread for the
    // duration of with_webview. No native pointer leaves this closure.
    unsafe {
        let view = &*platform.inner().cast::<WKWebView>();
        let Some(origin) = NSURL::URLWithString(&NSString::from_str(url.as_str())) else {
            let _ = send.send(Err("Invalid authentication cookie origin".to_string()));
            return;
        };
        // Use the native Set-Cookie parser to preserve HttpOnly, Secure,
        // SameSite, path and lifetime attributes. Never log the header/value.
        let headers = NSDictionary::from_slices(
            &[&*NSString::from_str("Set-Cookie")],
            &[&*NSString::from_str(&cookie.to_string())],
        );
        let parsed = NSHTTPCookie::cookiesWithResponseHeaderFields_forURL(&headers, &origin);
        if parsed.count() != 1 {
            let _ = send.send(Err("Failed to construct authentication cookie".to_string()));
            return;
        }
        let native_cookie = parsed.objectAtIndex(0);
        let send = std::cell::RefCell::new(Some(send));
        let completion = block2::RcBlock::new(move || {
            if let Some(send) = send.borrow_mut().take() {
                let _ = send.send(Ok(()));
            }
        });
        view.configuration()
            .websiteDataStore()
            .httpCookieStore()
            .setCookie_completionHandler(&native_cookie, Some(&completion));
    }
}

#[cfg(target_os = "linux")]
fn install_cookie(
    platform: tauri::webview::PlatformWebview,
    cookie: Cookie<'static>,
    _url: Url,
    send: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
    let Some(manager) = platform
        .inner()
        .website_data_manager()
        .and_then(|data| data.cookie_manager())
    else {
        let _ = send.send(Err("Authentication cookie store is unavailable".to_string()));
        return;
    };
    let Some(mut native_cookie) = soup_cookie(&cookie) else {
        let _ = send.send(Err("Failed to construct authentication cookie".to_string()));
        return;
    };
    manager.add_cookie(
        &mut native_cookie,
        None::<&gtk::gio::Cancellable>,
        move |result| {
            let _ =
                send.send(result.map_err(|_| "Failed to set authentication cookie".to_string()));
        },
    );
}

/// Build the libsoup cookie from the cookie's fields. Parsing a `Set-Cookie`
/// string instead (`soup::Cookie::parse`) rejects a `Domain` without an
/// embedded dot, so `localhost` and LAN names such as `nas` got no session.
/// A field-built cookie keeps the domain as a host-only domain.
#[cfg(target_os = "linux")]
fn soup_cookie(cookie: &Cookie<'static>) -> Option<soup::Cookie> {
    use tauri::webview::cookie::SameSite;
    let domain = cookie
        .domain()?
        .trim_start_matches('[')
        .trim_end_matches(']');
    if domain.is_empty() {
        return None;
    }
    let max_age = cookie
        .max_age()
        .map(|age| i32::try_from(age.whole_seconds()).unwrap_or(i32::MAX))
        .unwrap_or(-1);
    let mut native = soup::Cookie::new(
        cookie.name(),
        cookie.value(),
        domain,
        cookie.path().unwrap_or("/"),
        max_age,
    );
    native.set_http_only(cookie.http_only().unwrap_or(false));
    native.set_secure(cookie.secure().unwrap_or(false));
    if let Some(same_site) = cookie.same_site() {
        native.set_same_site_policy(match same_site {
            SameSite::Strict => soup::SameSitePolicy::Strict,
            SameSite::Lax => soup::SameSitePolicy::Lax,
            SameSite::None => soup::SameSitePolicy::None,
        });
    }
    Some(native)
}

#[cfg(all(test, target_os = "linux"))]
mod soup_cookie_tests {
    use super::*;

    fn session_cookie(host: &str) -> Cookie<'static> {
        Cookie::build(("pdpp_owner_session", "session-value"))
            .domain(host.to_string())
            .path("/")
            .http_only(true)
            .build()
    }

    /// The console of a server at `http://localhost:PORT` never got its
    /// session: parsing `Domain=localhost` from a header string fails in
    /// libsoup, because a Domain attribute needs an embedded dot.
    #[test]
    fn builds_the_native_cookie_for_single_label_hosts() {
        for host in ["localhost", "nas", "127.0.0.1", "dataconnect.example.com"] {
            let mut native = soup_cookie(&session_cookie(host))
                .unwrap_or_else(|| panic!("no native cookie for {host}"));
            assert_eq!(
                native.name().as_deref(),
                Some("pdpp_owner_session"),
                "{host}"
            );
            assert_eq!(native.value().as_deref(), Some("session-value"), "{host}");
            assert_eq!(native.domain().as_deref(), Some(host), "{host}");
            assert_eq!(native.path().as_deref(), Some("/"), "{host}");
            assert!(native.is_http_only(), "{host}");
            assert!(!native.is_secure(), "{host}");
            let uri = gtk::glib::Uri::parse(
                &format!("http://{host}:4310/settings"),
                gtk::glib::UriFlags::NONE,
            )
            .expect("uri");
            assert!(native.applies_to_uri(&uri), "{host}");
        }
    }

    #[test]
    fn keeps_secure_and_same_site_attributes() {
        let cookie = Cookie::build(("pdpp_owner_session", "v"))
            .domain("localhost")
            .path("/")
            .secure(true)
            .same_site(tauri::webview::cookie::SameSite::Strict)
            .build();
        let mut native = soup_cookie(&cookie).expect("native cookie");
        assert!(native.is_secure());
        assert_eq!(native.same_site_policy(), soup::SameSitePolicy::Strict);
    }

    /// Installs the field-built cookie through WebKitGTK's cookie manager
    /// (the same call `install_cookie` makes) and records the Cookie header a
    /// real webview sends to `http://localhost:PORT`. Needs a display:
    ///
    /// ```text
    /// xvfb-run -a dbus-run-session -- cargo test --lib -- --ignored --exact \
    ///     webview_cookies::soup_cookie_tests::webkitgtk_sends_the_localhost_session_cookie
    /// ```
    #[test]
    #[ignore = "needs a display: run under xvfb-run and dbus-run-session"]
    fn webkitgtk_sends_the_localhost_session_cookie() {
        use gtk::prelude::*;
        use std::io::{BufRead, BufReader, Write};
        use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
        use wry::{WebViewBuilderExtUnix, WebViewExtUnix};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        let (seen, requests) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut request_line = String::new();
                let _ = reader.read_line(&mut request_line);
                let mut cookie = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("cookie") {
                            cookie = value.trim().to_string();
                        }
                    }
                }
                if request_line.starts_with("GET /settings ") {
                    let _ = seen.send(cookie);
                }
                let body = "<html><body>console</body></html>";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });

        gtk::init().expect("GTK needs a display: run under xvfb-run");
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let webview = wry::WebViewBuilder::new()
            .with_url("about:blank")
            .build_gtk(&window)
            .expect("build the webview");
        window.show_all();
        let manager = webview
            .webview()
            .website_data_manager()
            .and_then(|data| data.cookie_manager())
            .expect("cookie manager");
        let mut native = soup_cookie(&session_cookie("localhost")).expect("native cookie");
        let (added, added_rx) = std::sync::mpsc::channel();
        manager.add_cookie(&mut native, None::<&gtk::gio::Cancellable>, move |result| {
            let _ = added.send(result.is_ok());
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let added = loop {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            if let Ok(added) = added_rx.try_recv() {
                break added;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "add_cookie never completed"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(added, "WebKitGTK refused the localhost cookie");
        webview
            .load_url(&format!("http://localhost:{port}/settings"))
            .expect("load the console");
        let cookie = loop {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            if let Ok(cookie) = requests.try_recv() {
                break cookie;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the webview never requested /settings"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(
            cookie
                .split("; ")
                .any(|pair| pair == "pdpp_owner_session=session-value"),
            "localhost session cookie was not sent: {cookie:?}"
        );
        println!("WEBKITGTK LOCALHOST COOKIE TEST RAN");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn waits_for_all_cookie_completions_before_navigation() {
        let (send, receive) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let (send_second, receive_second) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let navigated = Arc::new(AtomicBool::new(false));
        let observed = navigated.clone();
        let task = tokio::spawn(async move {
            navigate_after_cookie_completion(
                async {
                    wait_for_cookie_completion(receive, COOKIE_COMPLETION_TIMEOUT).await?;
                    wait_for_cookie_completion(receive_second, COOKIE_COMPLETION_TIMEOUT).await
                },
                || {
                    observed.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!navigated.load(Ordering::SeqCst));
        send.send(Ok(())).unwrap();
        tokio::task::yield_now().await;
        assert!(!navigated.load(Ordering::SeqCst));
        send_second.send(Ok(())).unwrap();
        task.await.unwrap().unwrap();
        assert!(navigated.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cookie_failure_prevents_navigation() {
        let error =
            navigate_after_cookie_completion(async { Err("cookie failed".to_string()) }, || {
                panic!("must not navigate without authentication cookies")
            })
            .await
            .unwrap_err();
        assert_eq!(error, "cookie failed");
    }

    #[tokio::test]
    async fn cookie_completion_timeout_prevents_navigation() {
        let (_send, receive) = tokio::sync::oneshot::channel();
        let navigated = Arc::new(AtomicBool::new(false));
        let observed = navigated.clone();

        let error = navigate_after_cookie_completion(
            wait_for_cookie_completion(receive, std::time::Duration::from_millis(10)),
            || {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            "Timed out waiting for authentication cookie completion"
        );
        assert!(!navigated.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn late_cookie_completion_after_timeout_is_ignored() {
        let (send, receive) = tokio::sync::oneshot::channel();
        let navigated = Arc::new(AtomicBool::new(false));
        let observed = navigated.clone();
        let task = tokio::spawn(async move {
            navigate_after_cookie_completion(
                wait_for_cookie_completion(receive, std::time::Duration::from_millis(10)),
                || {
                    observed.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        });

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(
            error,
            "Timed out waiting for authentication cookie completion"
        );

        // Match the native callbacks: a late send error is intentionally ignored.
        tokio::spawn(async move {
            let _ = send.send(Ok(()));
        })
        .await
        .unwrap();
        assert!(!navigated.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn propagates_navigation_failure() {
        let error = navigate_after_cookie_completion(async { Ok(()) }, || {
            Err("navigation failed".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(error, "navigation failed");
    }
}
