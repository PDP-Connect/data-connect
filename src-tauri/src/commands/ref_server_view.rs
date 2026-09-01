// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The "Server & Repairs" tab: an embedded child Webview (Tauri 2's
// `Window::add_child`, gated behind the `unstable` cargo feature) pointed at
// the reference server's own UI, authenticated with the owner-session
// cookie minted by `login_reference_server`.
//
// A real child webview (not an <iframe>) is used so the embedded page keeps
// its own navigation, cookies, and storage without fighting this app's CSP
// (`default-src 'self'` has no `frame-src` allowance, and adding one would
// weaken the whole app's CSP just for this one tab). It is repositioned to
// track the React-rendered placeholder <div> on every resize event the
// frontend reports, since Tauri does not auto-layout child webviews against
// DOM elements.
use serde::Deserialize;
use tauri::webview::Cookie;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

const REF_SERVER_VIEW_LABEL: &str = "reference-server-view";

#[derive(Debug, Deserialize)]
pub struct ViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Create (or navigate + show, if already created) the embedded reference
/// server webview at the given bounds, authenticated with the owner session
/// cookie.
#[tauri::command]
pub async fn open_reference_server_view(
    app: AppHandle,
    origin: String,
    session_cookie: String,
    bounds: ViewBounds,
) -> Result<(), String> {
    let url: tauri::Url = origin
        .parse()
        .map_err(|e| format!("Invalid reference server origin: {}", e))?;
    let host = url.host_str().unwrap_or("localhost").to_string();

    let cookie = Cookie::build(("pdpp_owner_session", session_cookie))
        .domain(host)
        .path("/")
        .http_only(true)
        .build();

    if let Some(existing) = app.get_webview(REF_SERVER_VIEW_LABEL) {
        existing
            .set_cookie(cookie)
            .map_err(|e| format!("Failed to set owner session cookie: {}", e))?;
        existing
            .navigate(url)
            .map_err(|e| format!("Failed to navigate reference server view: {}", e))?;
        existing
            .set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let Some(main_window) = app.get_window("main") else {
        return Err("Main window not found".to_string());
    };

    let webview_builder =
        WebviewBuilder::new(REF_SERVER_VIEW_LABEL, WebviewUrl::External(url.clone()));

    let webview = main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("Failed to create reference server webview: {}", e))?;

    webview
        .set_cookie(cookie)
        .map_err(|e| format!("Failed to set owner session cookie: {}", e))?;

    // Cookie must be present before the initial navigation for the first
    // request to be authenticated, so navigate only after set_cookie above.
    webview
        .navigate(url)
        .map_err(|e| format!("Failed to navigate reference server view: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn resize_reference_server_view(
    app: AppHandle,
    bounds: ViewBounds,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(REF_SERVER_VIEW_LABEL) else {
        return Ok(()); // not open yet — nothing to resize
    };
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide (not destroy) the embedded view when the user navigates away from
/// the Server & Repairs tab, so switching back doesn't require a fresh
/// login round-trip.
#[tauri::command]
pub async fn hide_reference_server_view(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(REF_SERVER_VIEW_LABEL) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_reference_server_view(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(REF_SERVER_VIEW_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
