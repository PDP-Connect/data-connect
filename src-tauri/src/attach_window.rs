// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The attach window (`public/attach.html`), its label-gated commands, and
//! the attach/detach actions that end in a restart.
//!
//! The window is a local app page with IPC. Every command here checks the
//! calling webview's label first: the IPC ACL lets every local-origin
//! webview call app commands, so the label is the only gate.

use crate::attach::{
    self, AttachError, Attachment, HttpsPolicy, KeychainSessionStore, SessionLookup, SessionStore,
    StoredIn,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub(crate) const ATTACH_WINDOW_LABEL: &str = "attach";
const ENVIRONMENT_OVERRIDE_MESSAGE: &str = "Set by environment: DATACONNECT_RI_URL or DATACONNECT_CONSOLE_URL is set. Unset it and restart DataConnect to attach from here.";

/// What the attach window shows when it next loads.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AttachPrefill {
    pub input: Option<String>,
    pub code: Option<String>,
    pub notice: Option<String>,
}

#[derive(Default)]
pub(crate) struct AttachWindowState {
    prefill: Mutex<AttachPrefill>,
    busy: AtomicBool,
}

/// Open (or reload) the attach window with `prefill`. Never submits.
pub(crate) fn open_attach_window<R: Runtime>(app: &AppHandle<R>, prefill: AttachPrefill) {
    if let Some(state) = app.try_state::<AttachWindowState>() {
        if let Ok(mut slot) = state.prefill.lock() {
            *slot = prefill;
        }
    }
    if let Some(window) = app.get_webview_window(ATTACH_WINDOW_LABEL) {
        // The page reads the prefill on load.
        let _ = window.eval("window.location.reload()");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        ATTACH_WINDOW_LABEL,
        WebviewUrl::App("attach.html".into()),
    )
    .title("DataConnect - Attach to a server")
    .inner_size(560.0, 680.0)
    .min_inner_size(480.0, 520.0)
    .center()
    .resizable(true)
    .build();
    match result {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => log::error!("Failed to open the DataConnect attach window: {error}"),
    }
}

fn require_attach_window(label: &str) -> Result<(), String> {
    if label == ATTACH_WINDOW_LABEL {
        Ok(())
    } else {
        Err("Only the DataConnect attach window can do this.".to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachedView {
    origin: String,
    host: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachWindowView {
    environment_override: bool,
    environment_message: Option<String>,
    attached: Option<AttachedView>,
    input: Option<String>,
    code: Option<String>,
    notice: Option<String>,
}

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

fn environment_override_for<R: Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(test)]
    if let Some(value) = app.try_state::<EnvironmentOverrideForTest>() {
        return value.0;
    }
    let _ = app;
    attach::env_override_active()
}

/// The window's initial state. Takes the prefill, so a reload after an
/// attempt starts clean.
#[tauri::command]
pub(crate) fn attach_window_view<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<AttachWindowView, String> {
    require_attach_window(webview.label())?;
    let prefill = app
        .try_state::<AttachWindowState>()
        .and_then(|state| {
            state
                .prefill
                .lock()
                .ok()
                .map(|mut slot| std::mem::take(&mut *slot))
        })
        .unwrap_or_default();
    let environment_override = environment_override_for(&app);
    let attached = attach::load_attachment(&app_data_dir(&app)?)
        .unwrap_or(None)
        .map(|attachment| AttachedView {
            host: attachment.host(),
            origin: attachment.origin,
        });
    Ok(AttachWindowView {
        environment_override,
        environment_message: environment_override.then(|| ENVIRONMENT_OVERRIDE_MESSAGE.to_string()),
        attached,
        input: prefill.input,
        code: prefill.code,
        notice: prefill.notice,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachPreview {
    origin: Option<String>,
    code: Option<String>,
    policy: Option<HttpsPolicy>,
    /// True for plain HTTP to another machine: the window shows the trust
    /// checkbox and the warning.
    plain_http: bool,
    warning: Option<String>,
    error: Option<String>,
}

pub(crate) fn preview(input: &str, trust_plain_http: bool) -> AttachPreview {
    match attach::parse_attach_input(input) {
        Ok(parsed) => {
            let policy = attach::https_policy(&parsed.origin, trust_plain_http);
            let plain_http = attach::https_policy(&parsed.origin, true) == HttpsPolicy::Warn;
            AttachPreview {
                origin: Some(parsed.origin),
                code: parsed.code,
                policy: Some(policy),
                plain_http,
                warning: plain_http.then(|| attach::PLAIN_HTTP_WARNING.to_string()),
                error: None,
            }
        }
        Err(error) => AttachPreview {
            origin: None,
            code: None,
            policy: None,
            plain_http: false,
            warning: None,
            error: (!input.trim().is_empty()).then_some(error),
        },
    }
}

/// Live target line for the window. Pure: no network.
#[tauri::command]
pub(crate) fn preview_attach_target<R: Runtime>(
    webview: tauri::WebviewWindow<R>,
    input: String,
    trust_plain_http: bool,
) -> Result<AttachPreview, String> {
    require_attach_window(webview.label())?;
    Ok(preview(&input, trust_plain_http))
}

/// The origin to attach to, once the input parses and HTTPS policy allows it.
fn checked_origin(input: &str, trust_plain_http: bool) -> Result<attach::AttachInput, String> {
    let parsed = attach::parse_attach_input(input)?;
    match attach::https_policy(&parsed.origin, trust_plain_http) {
        HttpsPolicy::Refuse => Err(
            "This address uses plain HTTP. Tick \"I trust this network\" to continue, or use an https:// address."
                .to_string(),
        ),
        HttpsPolicy::Allowed | HttpsPolicy::Warn => Ok(parsed),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachOutcome {
    origin: String,
    notice: Option<String>,
}

/// Keep the session, then write `attach.json`, so the file never names a
/// server whose session was not kept. A previous attachment to another
/// origin loses its local session.
pub(crate) fn save_pairing(
    data_dir: &Path,
    keychain: &dyn SessionStore,
    memory: &dyn SessionStore,
    origin: &str,
    session: &str,
    paired_at: String,
) -> Result<StoredIn, String> {
    if let Ok(Some(previous)) = attach::load_attachment(data_dir) {
        if previous.origin != origin {
            if let Err(error) = attach::forget_session(keychain, memory, &previous.origin) {
                log::warn!("Could not delete the previous attach session: {error}");
            }
        }
    }
    let stored = attach::store_session(keychain, memory, origin, session)?;
    let attachment = Attachment {
        origin: origin.to_string(),
        label: attach::desktop_session_label(),
        paired_at,
    };
    if let Err(error) = attach::save_attachment(data_dir, &attachment) {
        let _ = attach::forget_session(keychain, memory, origin);
        return Err(error);
    }
    Ok(stored)
}

/// Runs one attach attempt at a time per window.
struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    fn take(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self(flag))
            .map_err(|_| "DataConnect is already attaching. Wait for it to finish.".to_string())
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

enum Credential {
    PairingCode(String),
    OwnerPassword(String),
}

async fn attach_with<R: Runtime>(
    app: AppHandle<R>,
    input: String,
    credential: Credential,
    trust_plain_http: bool,
) -> Result<AttachOutcome, String> {
    if environment_override_for(&app) {
        return Err(ENVIRONMENT_OVERRIDE_MESSAGE.to_string());
    }
    let parsed = checked_origin(&input, trust_plain_http)?;
    let origin = parsed.origin;
    let state = app
        .try_state::<AttachWindowState>()
        .ok_or_else(|| "The attach window state is unavailable.".to_string())?;
    let _busy = BusyGuard::take(&state.busy)?;
    let message = |error: AttachError| error.message(&origin);
    attach::verify_pdpp_server(&origin).await.map_err(message)?;
    let session = match credential {
        Credential::PairingCode(code) => {
            let code = if code.trim().is_empty() {
                parsed.code.ok_or_else(|| {
                    "Enter the pairing code shown in the server's Settings.".to_string()
                })?
            } else {
                attach::normalize_pairing_code(&code)?
            };
            attach::redeem_pairing(&origin, &code, &attach::desktop_session_label())
                .await
                .map_err(message)?
                .session
        }
        Credential::OwnerPassword(password) => {
            if password.is_empty() {
                return Err("Enter the server's owner password.".to_string());
            }
            attach::login_with_password(&origin, &password)
                .await
                .map_err(message)?
        }
    };
    let data_dir = app_data_dir(&app)?;
    let memory = attach::process_memory_store();
    let stored = save_pairing(
        &data_dir,
        &KeychainSessionStore,
        memory,
        &origin,
        &session,
        chrono::Utc::now().to_rfc3339(),
    )?;
    log::info!("Attached to {origin}; restarting into the attached state");
    let (notice, handoff) = match stored {
        StoredIn::Keychain => (None, None),
        StoredIn::MemoryOnly => (Some(attach::MEMORY_ONLY_NOTICE.to_string()), Some(session)),
    };
    request_relaunch(&app, handoff);
    Ok(AttachOutcome { origin, notice })
}

#[tauri::command]
pub(crate) async fn attach_with_pairing_code<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
    input: String,
    code: String,
    trust_plain_http: bool,
) -> Result<AttachOutcome, String> {
    require_attach_window(webview.label())?;
    attach_with(app, input, Credential::PairingCode(code), trust_plain_http).await
}

/// Fallback for servers without pairing. The password is used once for
/// `POST /owner/login` and dropped.
#[tauri::command]
pub(crate) async fn attach_with_owner_password<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
    input: String,
    password: String,
    trust_plain_http: bool,
) -> Result<AttachOutcome, String> {
    require_attach_window(webview.label())?;
    attach_with(
        app,
        input,
        Credential::OwnerPassword(password),
        trust_plain_http,
    )
    .await
}

#[tauri::command]
pub(crate) async fn detach_from_server<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<String, String> {
    require_attach_window(webview.label())?;
    detach_and_restart(&app).await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DetachReport {
    pub attachment: Attachment,
    /// The server answered the sign-out with success.
    pub server_confirmed: bool,
    pub keychain_error: Option<String>,
}

impl DetachReport {
    pub(crate) fn notice(&self) -> String {
        let host = self.attachment.host();
        let mut notice = if self.server_confirmed {
            format!("Detached from {host}. The server ended this computer's session.")
        } else {
            format!(
                "Detached from {host}. The server did not confirm that the session ended; you can revoke it in the server's Settings."
            )
        };
        if self.keychain_error.is_some() {
            notice.push_str(
                " DataConnect could not delete the session from this computer's keychain.",
            );
        }
        notice
    }
}

/// Revoke (best effort), then delete the session and `attach.json`. Local
/// deletion happens whether or not the server answered.
pub(crate) async fn detach_saved_attachment(
    data_dir: &Path,
    keychain: &dyn SessionStore,
    memory: &dyn SessionStore,
) -> Result<DetachReport, String> {
    let attachment = attach::load_attachment(data_dir)?
        .ok_or_else(|| "DataConnect is not attached to a server.".to_string())?;
    let server_confirmed = match attach::load_session(keychain, memory, &attachment.origin) {
        SessionLookup::Found(session) => attach::revoke_session(&attachment.origin, &session).await,
        SessionLookup::Missing | SessionLookup::KeychainUnavailable => false,
    };
    let keychain_error = attach::forget_session(keychain, memory, &attachment.origin).err();
    attach::remove_attachment(data_dir)?;
    Ok(DetachReport {
        attachment,
        server_confirmed,
        keychain_error,
    })
}

/// Detach, drop the remote session cookie from the console webview, tell
/// the owner whether the server confirmed, and restart on this computer.
pub(crate) async fn detach_and_restart<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let report = detach_saved_attachment(
        &app_data_dir(app)?,
        &KeychainSessionStore,
        attach::process_memory_store(),
    )
    .await?;
    forget_console_session_cookie(app, &report.attachment.origin).await;
    let notice = report.notice();
    log::info!("{notice}");
    show_notification(app, "DataConnect detached", &notice);
    request_relaunch(app, None);
    Ok(notice)
}

/// Delete the remote session cookie from the console webview's store.
/// Cookies are keyed by host, not port, so a stale remote cookie could
/// otherwise reach a different server on the same host. Session cookies are
/// not persisted across restarts (`cookies` in the app data directory keeps
/// only persistent cookies), so this matters while this process runs.
pub(crate) async fn forget_console_session_cookie<R: Runtime>(app: &AppHandle<R>, origin: &str) {
    let Some(window) = app.get_webview_window(crate::unified::CONSOLE_WINDOW_LABEL) else {
        return;
    };
    let Ok(url) = tauri::Url::parse(origin) else {
        return;
    };
    match crate::webview_cookies::delete_cookies_named(
        window.as_ref(),
        &url,
        attach::OWNER_SESSION_COOKIE,
    )
    .await
    {
        Ok(count) => log::info!("Deleted {count} console session cookie(s) for {origin}"),
        Err(error) => log::warn!("Could not delete the console session cookie: {error}"),
    }
}

pub(crate) fn show_notification<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    // `notification()` panics when the plugin is not registered (tests).
    let Some(notification) = app.try_state::<tauri_plugin_notification::Notification<R>>() else {
        return;
    };
    if let Err(error) = notification.builder().title(title).body(body).show() {
        log::warn!("Failed to show the attach notification: {error}");
    }
}

/// A restart this process asked for, carried out at `RunEvent::Exit` after
/// the normal shutdown stopped any sidecars.
struct Relaunch {
    binary: PathBuf,
    session_handoff: Option<String>,
}

static RELAUNCH: Mutex<Option<Relaunch>> = Mutex::new(None);

/// Restart into the new attach state through the normal exit path. Unlike
/// `AppHandle::restart`, the new process does not get `vana://` arguments
/// (a used pairing link would reopen the window) and can receive a
/// memory-only session in its environment, never on disk or argv.
pub(crate) fn request_relaunch<R: Runtime>(app: &AppHandle<R>, session_handoff: Option<String>) {
    #[cfg(test)]
    if let Some(recorder) = app.try_state::<RelaunchRecorderForTest>() {
        if let Ok(mut calls) = recorder.0.lock() {
            calls.push(session_handoff);
        }
        return;
    }
    match tauri::process::current_binary(&app.env()) {
        Ok(binary) => {
            if let Ok(mut slot) = RELAUNCH.lock() {
                *slot = Some(Relaunch {
                    binary,
                    session_handoff,
                });
            }
        }
        Err(error) => log::error!("Cannot find this app's binary to restart it: {error}"),
    }
    app.exit(0);
}

/// Called from `RunEvent::Exit`. Spawns the new process if one was asked for.
pub(crate) fn relaunch_if_requested() {
    let Some(relaunch) = RELAUNCH.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    let mut command = std::process::Command::new(&relaunch.binary);
    command.args(relaunch_args(std::env::args_os().skip(1)));
    if let Some(session) = relaunch.session_handoff {
        command.env(attach::SESSION_HANDOFF_ENV, session);
    }
    if let Err(error) = command.spawn() {
        log::error!("Failed to restart DataConnect: {error}");
    }
}

/// The current arguments without deep links.
pub(crate) fn relaunch_args(
    args: impl Iterator<Item = std::ffi::OsString>,
) -> Vec<std::ffi::OsString> {
    args.filter(|arg| {
        !arg.to_str()
            .is_some_and(|arg| arg.len() >= 5 && arg[..5].eq_ignore_ascii_case("vana:"))
    })
    .collect()
}

#[cfg(test)]
pub(crate) struct RelaunchRecorderForTest(pub(crate) Mutex<Vec<Option<String>>>);

#[cfg(test)]
pub(crate) struct EnvironmentOverrideForTest(pub(crate) bool);

#[cfg(test)]
#[path = "attach_window_tests.rs"]
mod tests;
