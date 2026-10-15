// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! Install authentication cookies without recursively pumping the UI event loop.
use std::future::Future;
use tauri::{webview::Cookie, Url, Webview};

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

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn set_cookie(webview: &Webview, cookie: Cookie<'static>, url: &Url) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let url = url.clone();
    // with_webview queues work on the UI thread. The native completion returns
    // through a channel; only the async caller waits, never the UI thread.
    webview
        .with_webview(move |platform| install_cookie(platform, cookie, url, send))
        .map_err(|_| "Failed to dispatch authentication cookie installation".to_string())?;
    receive
        .await
        .map_err(|_| "Authentication cookie completion was dropped".to_string())?
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
    let Some(mut native_cookie) = soup::Cookie::parse(&cookie.to_string(), None) else {
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
                    receive.await.unwrap()?;
                    receive_second.await.unwrap()
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
    async fn propagates_navigation_failure() {
        let error = navigate_after_cookie_completion(async { Ok(()) }, || {
            Err("navigation failed".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(error, "navigation failed");
    }
}
