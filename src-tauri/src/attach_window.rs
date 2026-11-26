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
use crate::attach_identity::{self, ServerIdentity};
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
    pub notice: Option<String>,
    /// Set when a start found something other than the pinned server.
    pub identity_changed: Option<IdentityChanged>,
}

/// The Server IDs the "identity changed" state shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityChanged {
    pub pinned_id: Option<String>,
    /// Shown only when the answering server proved a key of its own.
    pub answering_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct AttachWindowState {
    /// What the next page load shows; `attach_window_view` takes it.
    prefill: Mutex<AttachPrefill>,
    busy: AtomicBool,
}

/// Open (or reload) the attach window with `prefill`. Never submits.
pub(crate) fn open_attach_window<R: Runtime>(app: &AppHandle<R>, prefill: AttachPrefill) {
    let open_window = app.get_webview_window(ATTACH_WINDOW_LABEL);
    if let Some(state) = app.try_state::<AttachWindowState>() {
        if let Ok(mut slot) = state.prefill.lock() {
            *slot = prefill;
        }
    }
    if let Some(window) = open_window {
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
    .title(crate::profile::decorate("Connect to a server"))
    .inner_size(560.0, 720.0)
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
    /// The pinned Server ID; absent for a server that cannot prove its identity.
    server_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachWindowView {
    environment_override: bool,
    environment_message: Option<String>,
    attached: Option<AttachedView>,
    input: Option<String>,
    notice: Option<String>,
    identity_changed: Option<IdentityChanged>,
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
            server_id: attachment.server_id(),
            origin: attachment.origin,
        });
    Ok(AttachWindowView {
        environment_override,
        environment_message: environment_override.then(|| ENVIRONMENT_OVERRIDE_MESSAGE.to_string()),
        attached,
        input: prefill.input,
        notice: prefill.notice,
        identity_changed: prefill.identity_changed,
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

/// First contact with a server, before any code or password is sent: it is a
/// DataConnect server, and it proves the identity it names (or cannot).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Contact {
    Proven(ServerIdentity),
    /// 404 on the identity route: only the owner password can connect.
    Unproven,
}

async fn contact_server(origin: &str, link_key: Option<&str>) -> Result<Contact, AttachError> {
    attach::verify_pdpp_server(origin).await?;
    match attach_identity::probe_identity(origin).await {
        Ok(identity) if link_key.is_some_and(|key| key != identity.public_key) => {
            Err(AttachError::KeyDiffersFromLink)
        }
        Ok(identity) => Ok(Contact::Proven(identity)),
        // A link names a key, so a server that cannot prove one is not it.
        Err(AttachError::IdentityUnsupported) if link_key.is_some() => {
            Err(AttachError::KeyDiffersFromLink)
        }
        Err(AttachError::IdentityUnsupported) => Ok(Contact::Unproven),
        Err(error) => Err(error),
    }
}

/// What the confirm step shows.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInspection {
    origin: String,
    host: String,
    /// Absent when the server cannot prove its identity.
    server_id: Option<String>,
    /// Passed back with Connect so the connection is made to this key.
    server_key: Option<String>,
    /// The pasted link carried a key and it equals the server's.
    matches_link: bool,
    code: Option<String>,
    /// A server saved before at this address now answers with another ID.
    previously_connected_id: Option<String>,
    plain_http: bool,
}

#[tauri::command]
pub(crate) async fn inspect_server<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
    input: String,
    trust_plain_http: bool,
) -> Result<ServerInspection, String> {
    require_attach_window(webview.label())?;
    if environment_override_for(&app) {
        return Err(ENVIRONMENT_OVERRIDE_MESSAGE.to_string());
    }
    let parsed = checked_origin(&input, trust_plain_http)?;
    let origin = parsed.origin.clone();
    let state = app
        .try_state::<AttachWindowState>()
        .ok_or_else(|| "The attach window state is unavailable.".to_string())?;
    let _busy = BusyGuard::take(&state.busy)?;
    let contact = contact_server(&origin, parsed.key.as_deref())
        .await
        .map_err(|error| error.message(&origin))?;
    let identity = match &contact {
        Contact::Proven(identity) => Some(identity),
        Contact::Unproven => None,
    };
    let previously_connected_id = attach::load_attachment(&app_data_dir(&app)?)
        .ok()
        .flatten()
        .filter(|previous| previous.origin == origin)
        .and_then(|previous| previous.server_id())
        .filter(|previous_id| identity.is_none_or(|identity| *previous_id != identity.fingerprint));
    Ok(ServerInspection {
        host: Attachment::host_of(&origin),
        origin,
        server_id: identity.map(|identity| identity.fingerprint.clone()),
        server_key: identity.map(|identity| identity.public_key.clone()),
        matches_link: parsed.key.is_some() && identity.is_some(),
        code: parsed.code,
        previously_connected_id,
        plain_http: attach::https_policy(&parsed.origin, true) == HttpsPolicy::Warn,
    })
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
    server_key: Option<&str>,
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
        server_key: server_key.map(ToOwned::to_owned),
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
            .map_err(|_| "DataConnect is already connecting. Wait for it to finish.".to_string())
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

/// What the owner confirmed in the window before pressing Connect.
struct Confirmation {
    /// The Server ID's key shown in the confirm step.
    server_key: Option<String>,
    /// The tick-box for a server that cannot prove its identity.
    accept_unverified: bool,
}

async fn attach_with<R: Runtime>(
    app: AppHandle<R>,
    input: String,
    credential: Credential,
    trust_plain_http: bool,
    confirmation: Confirmation,
) -> Result<AttachOutcome, String> {
    if environment_override_for(&app) {
        return Err(ENVIRONMENT_OVERRIDE_MESSAGE.to_string());
    }
    let parsed = checked_origin(&input, trust_plain_http)?;
    let origin = parsed.origin.clone();
    let state = app
        .try_state::<AttachWindowState>()
        .ok_or_else(|| "The attach window state is unavailable.".to_string())?;
    let _busy = BusyGuard::take(&state.busy)?;
    let message = |error: AttachError| error.message(&origin);
    // Identity first: no code or password goes to a server that has not
    // proven the identity the owner confirmed.
    let contact = contact_server(&origin, parsed.key.as_deref())
        .await
        .map_err(message)?;
    let pinned_key = match &contact {
        Contact::Proven(identity) => {
            if confirmation.server_key.as_deref() != Some(identity.public_key.as_str()) {
                return Err(
                    "This server's ID is not the one you confirmed. Check the Server ID and try again."
                        .to_string(),
                );
            }
            Some(identity.public_key.clone())
        }
        Contact::Unproven => {
            if matches!(credential, Credential::PairingCode(_)) {
                return Err(format!(
                    "{} Use the owner password instead.",
                    AttachError::IdentityUnsupported.message(&origin)
                ));
            }
            if !confirmation.accept_unverified {
                return Err(
                    "This server cannot prove its identity. Tick the box to connect with the owner password anyway."
                        .to_string(),
                );
            }
            None
        }
    };
    let session = match credential {
        Credential::PairingCode(code) => {
            let code = if code.trim().is_empty() {
                parsed.code.ok_or_else(|| {
                    "Enter the pairing code shown in the server's Settings.".to_string()
                })?
            } else {
                attach::normalize_pairing_code(&code)?
            };
            let redeemed = attach::redeem_pairing(&origin, &code, &attach::desktop_session_label())
                .await
                .map_err(message)?;
            if redeemed.server_public_key != pinned_key {
                return Err(message(AttachError::KeyChangedWhileConnecting));
            }
            redeemed.session
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
    // A switch ends the old pairing at its server (best effort, and only when
    // that server proves its pinned identity) before `save_pairing` deletes
    // the local copy.
    let previous = attach::load_attachment(&data_dir)
        .ok()
        .flatten()
        .filter(|previous| previous.origin != origin);
    if let Some(previous) = &previous {
        if let SessionLookup::Found(old) =
            attach::load_session(&KeychainSessionStore, memory, &previous.origin)
        {
            let confirmed =
                attach::revoke_session(&previous.origin, previous.server_key.as_deref(), &old)
                    .await;
            log::info!(
                "Switching servers; {} confirmed the old session ended: {confirmed}",
                previous.origin
            );
        }
    }
    let stored = save_pairing(
        &data_dir,
        &KeychainSessionStore,
        memory,
        &origin,
        pinned_key.as_deref(),
        &session,
        chrono::Utc::now().to_rfc3339(),
    )?;
    if let Some(previous) = &previous {
        forget_console_session_cookie(&app, &previous.origin).await;
    }
    log::info!("Connected to {origin}; restarting into the connected state");
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
    confirmed_key: Option<String>,
) -> Result<AttachOutcome, String> {
    require_attach_window(webview.label())?;
    attach_with(
        app,
        input,
        Credential::PairingCode(code),
        trust_plain_http,
        Confirmation {
            server_key: confirmed_key,
            accept_unverified: false,
        },
    )
    .await
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
    confirmed_key: Option<String>,
    accept_unverified: Option<bool>,
) -> Result<AttachOutcome, String> {
    require_attach_window(webview.label())?;
    attach_with(
        app,
        input,
        Credential::OwnerPassword(password),
        trust_plain_http,
        Confirmation {
            server_key: confirmed_key,
            accept_unverified: accept_unverified.unwrap_or(false),
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn detach_from_server<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<String, String> {
    require_attach_window(webview.label())?;
    // The environment chooses the server; detaching here would change nothing
    // it uses, only delete the saved pairing behind the owner's back.
    if environment_override_for(&app) {
        return Err(ENVIRONMENT_OVERRIDE_MESSAGE.to_string());
    }
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
            format!("Disconnected from {host}. The server ended this computer's session.")
        } else {
            format!(
                "Disconnected from {host}. The server did not confirm that the session ended; you can revoke it in the server's Settings."
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
        SessionLookup::Found(session) => {
            attach::revoke_session(
                &attachment.origin,
                attachment.server_key.as_deref(),
                &session,
            )
            .await
        }
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

/// Disconnect, drop the remote session cookie from the console webview, tell
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
    show_notification(app, "DataConnect disconnected", &notice);
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
/// `AppHandle::restart`, the new process can receive a memory-only session
/// in its environment, never on disk or argv.
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
    command.args(std::env::args_os().skip(1));
    if let Some(session) = relaunch.session_handoff {
        command.env(attach::SESSION_HANDOFF_ENV, session);
    }
    if let Err(error) = command.spawn() {
        log::error!("Failed to restart DataConnect: {error}");
    }
}

#[cfg(test)]
pub(crate) struct RelaunchRecorderForTest(pub(crate) Mutex<Vec<Option<String>>>);

#[cfg(test)]
pub(crate) struct EnvironmentOverrideForTest(pub(crate) bool);

#[cfg(test)]
#[path = "attach_window_tests.rs"]
mod tests;
