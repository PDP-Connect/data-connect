// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The opt-in tray agent and authenticated console webview.
//!
//! This module deliberately attaches to already-running development services.
//! The A3 supervisor will own sidecar startup and shutdown; this lane only
//! provides the tray, bootstrap seam, and thin webview needed to exercise it.

use crate::commands::{attach_reference_server, login_reference_server_with_password};
use crate::owner_credential::{
    configured_owner_password, load_or_create_owner_credential, owner_credential_path,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub(crate) const CONSOLE_WINDOW_LABEL: &str = "console";
const TRAY_ICON_ID: &str = "dataconnect-tray";
const DEFAULT_CONSOLE_URL: &str = "http://localhost:3001";
const CONSOLE_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const CONSOLE_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum UnifiedStatus {
    #[default]
    Starting,
    Ready,
    Stopped,
    Error,
}

impl UnifiedStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "Status: Starting",
            Self::Ready => "Status: Ready",
            Self::Stopped => "Status: Stopped",
            Self::Error => "Status: Error",
        }
    }
}

#[derive(Default)]
struct UnifiedRuntimeState {
    status: Mutex<UnifiedStatus>,
    console_origin: Mutex<Option<String>>,
    session_cookie: Mutex<Option<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrayAction {
    OpenConsole,
    OpenBrowser,
    Quit,
    Unknown,
}

fn tray_action_for_menu_id(id: &str) -> TrayAction {
    match id {
        "open-console" => TrayAction::OpenConsole,
        "open-browser" => TrayAction::OpenBrowser,
        "quit" => TrayAction::Quit,
        _ => TrayAction::Unknown,
    }
}

/// Return the opt-in flag without treating any other value as enabled.
pub(crate) fn enabled_for_value(value: Option<&str>) -> bool {
    value == Some("1")
}

pub(crate) fn is_enabled() -> bool {
    enabled_for_value(std::env::var("DATACONNECT_UNIFIED_STACK").ok().as_deref())
}

fn configured_console_url() -> Result<String, String> {
    let raw = std::env::var("DATACONNECT_CONSOLE_URL")
        .unwrap_or_else(|_| DEFAULT_CONSOLE_URL.to_string());
    let mut url: tauri::Url = raw
        .parse()
        .map_err(|error| format!("Invalid DATACONNECT_CONSOLE_URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("DATACONNECT_CONSOLE_URL must be an http(s) URL with a host".to_string());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn build_tray_menu<M, R>(manager: &M, status: UnifiedStatus) -> tauri::Result<Menu<R>>
where
    M: Manager<R>,
    R: Runtime,
{
    let status_item = MenuItem::with_id(manager, "status", status.label(), false, None::<&str>)?;
    let open_console = MenuItem::with_id(
        manager,
        "open-console",
        "Open DataConnect",
        true,
        None::<&str>,
    )?;
    let open_browser = MenuItem::with_id(
        manager,
        "open-browser",
        "Open in browser",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(manager, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(
        manager,
        &[&status_item, &open_console, &open_browser, &quit],
    )
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(UnifiedRuntimeState::default());
    let menu = build_tray_menu(app, UnifiedStatus::Starting)?;
    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .menu(&menu)
        .tooltip("DataConnect")
        .on_menu_event(handle_tray_menu_event);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }
    tray_builder.build(app)?;

    if let Some(main_window) = app.get_webview_window("main") {
        main_window.hide()?;
    }

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = bootstrap_and_open_console(app_handle.clone()).await {
            log::error!("Unified DataConnect startup failed: {error}");
            set_status(&app_handle, UnifiedStatus::Error);
        }
    });
    Ok(())
}

pub(crate) fn focus_or_bootstrap(app: AppHandle) {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = bootstrap_and_open_console(app.clone()).await {
            log::error!("Failed to open DataConnect console: {error}");
            set_status(&app, UnifiedStatus::Error);
        }
    });
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match tray_action_for_menu_id(event.id().as_ref()) {
        TrayAction::OpenConsole => focus_or_bootstrap(app.clone()),
        TrayAction::OpenBrowser => match configured_console_url() {
            Ok(url) => {
                if let Err(error) = open::that_detached(url) {
                    log::error!("Failed to open console in the browser: {error}");
                    set_status(app, UnifiedStatus::Error);
                }
            }
            Err(error) => {
                log::error!("Failed to resolve console URL: {error}");
                set_status(app, UnifiedStatus::Error);
            }
        },
        TrayAction::Quit => {
            set_status(app, UnifiedStatus::Stopped);
            // RunEvent::Exit performs the existing child cleanup. In attach
            // mode that cleanup correctly leaves the owner's RI untouched.
            app.exit(0);
        }
        TrayAction::Unknown => {}
    }
}

async fn bootstrap_and_open_console(app: AppHandle) -> Result<(), String> {
    set_status(&app, UnifiedStatus::Starting);

    let reference_status = attach_reference_server(app.clone()).await?;
    let ri_origin = reference_status
        .origin
        .ok_or_else(|| "Reference server reported ready without an origin".to_string())?;

    let credential_path = owner_credential_path(&app)?;
    let stored_credential = load_or_create_owner_credential(&credential_path)?;
    let password = configured_owner_password().unwrap_or(stored_credential);
    let login = login_reference_server_with_password(ri_origin, &password).await?;

    let console_url = configured_console_url()?;
    wait_for_console(&console_url).await?;
    let console_origin: tauri::Url = console_url
        .parse()
        .map_err(|error| format!("Invalid console URL: {error}"))?;
    let cookie = owner_session_cookie(&console_origin, &login.session_cookie)?;

    {
        let state = app.state::<UnifiedRuntimeState>();
        *state
            .console_origin
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? = Some(console_url);
        *state
            .session_cookie
            .lock()
            .map_err(|_| "Unified runtime state is poisoned".to_string())? =
            Some(login.session_cookie);
    }

    create_or_update_console_window(&app, console_origin, cookie)?;
    set_status(&app, UnifiedStatus::Ready);
    Ok(())
}

async fn wait_for_console(url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + CONSOLE_WAIT_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(url).send().await {
            if response.status().is_success() || response.status().is_redirection() {
                return Ok(());
            }
        }
        tokio::time::sleep(CONSOLE_POLL_INTERVAL).await;
    }
    Err(format!(
        "Console did not answer {url} within {CONSOLE_WAIT_TIMEOUT:?}"
    ))
}

fn owner_session_cookie(url: &tauri::Url, value: &str) -> Result<Cookie<'static>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Console URL has no cookie host".to_string())?
        .to_string();
    Ok(Cookie::build(("pdpp_owner_session", value.to_string()))
        .domain(host)
        .path("/")
        .http_only(true)
        .build())
}

fn set_cookie_then_navigate<SetCookie, Navigate>(
    set_cookie: SetCookie,
    navigate: Navigate,
) -> Result<(), String>
where
    SetCookie: FnOnce() -> Result<(), String>,
    Navigate: FnOnce() -> Result<(), String>,
{
    set_cookie()?;
    navigate()
}

fn create_or_update_console_window(
    app: &AppHandle,
    url: tauri::Url,
    cookie: Cookie<'static>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONSOLE_WINDOW_LABEL) {
        set_cookie_then_navigate(
            || {
                window
                    .set_cookie(cookie.clone())
                    .map_err(|error| format!("Failed to set owner session cookie: {error}"))
            },
            || {
                window
                    .navigate(url.clone())
                    .map_err(|error| format!("Failed to navigate console: {error}"))
            },
        )?;
        window
            .show()
            .map_err(|error| format!("Failed to show console: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Failed to focus console: {error}"))?;
        return Ok(());
    }

    let blank_url: tauri::Url = "about:blank"
        .parse()
        .map_err(|error| format!("Failed to create blank console URL: {error}"))?;
    let window =
        WebviewWindowBuilder::new(app, CONSOLE_WINDOW_LABEL, WebviewUrl::External(blank_url))
            .title("DataConnect")
            .visible(false)
            .build()
            .map_err(|error| format!("Failed to create console window: {error}"))?;

    set_cookie_then_navigate(
        || {
            window
                .set_cookie(cookie)
                .map_err(|error| format!("Failed to set owner session cookie: {error}"))
        },
        || {
            window
                .navigate(url)
                .map_err(|error| format!("Failed to navigate console: {error}"))
        },
    )?;

    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_close.hide();
        }
    });
    window
        .show()
        .map_err(|error| format!("Failed to show console: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus console: {error}"))?;
    Ok(())
}

fn set_status(app: &AppHandle, status: UnifiedStatus) {
    if let Ok(state) = app.state::<UnifiedRuntimeState>().status.lock() {
        let mut state = state;
        *state = status;
    }
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    match build_tray_menu(app, status) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                log::error!("Failed to update tray status: {error}");
            }
        }
        Err(error) => log::error!("Failed to build tray status menu: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn unified_stack_requires_exact_one_flag() {
        assert!(enabled_for_value(Some("1")));
        assert!(!enabled_for_value(Some("0")));
        assert!(!enabled_for_value(Some("true")));
        assert!(!enabled_for_value(None));
    }

    #[test]
    fn tray_menu_actions_dispatch_to_the_expected_action() {
        assert_eq!(
            tray_action_for_menu_id("open-console"),
            TrayAction::OpenConsole
        );
        assert_eq!(
            tray_action_for_menu_id("open-browser"),
            TrayAction::OpenBrowser
        );
        assert_eq!(tray_action_for_menu_id("quit"), TrayAction::Quit);
        assert_eq!(tray_action_for_menu_id("status"), TrayAction::Unknown);
    }

    #[test]
    fn console_cookie_is_set_before_navigation() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let set_events = Arc::clone(&events);
        let navigate_events = Arc::clone(&events);

        set_cookie_then_navigate(
            || {
                set_events
                    .lock()
                    .expect("set events lock")
                    .push("set_cookie");
                Ok(())
            },
            || {
                let mut events = navigate_events.lock().expect("navigate events lock");
                assert_eq!(events.as_slice(), ["set_cookie"]);
                events.push("navigate");
                Ok(())
            },
        )
        .expect("navigation ordering");

        assert_eq!(
            events.lock().expect("events lock").as_slice(),
            ["set_cookie", "navigate"]
        );
    }
}
