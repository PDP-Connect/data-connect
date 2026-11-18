// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Attach the desktop app to a remote DataConnect server.
//!
//! This module owns the parts that need no window: what the owner pasted,
//! whether plain HTTP is allowed, the saved attachment (`attach.json`, no
//! secrets), where the owner session is kept (OS keychain, else process
//! memory, never a file) and the HTTP calls to the server's pairing and
//! session routes. Spec: `docs/design/desktop-remote-attach.md`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub(crate) const ATTACH_FILE: &str = "attach.json";
/// Keychain service for attach sessions. Distinct from the managed stack's
/// `com.vana.dataconnect` entries, so detaching never touches them.
pub(crate) const SESSION_KEYRING_SERVICE: &str = "com.vana.dataconnect.attach";
pub(crate) const OWNER_SESSION_COOKIE: &str = "pdpp_owner_session";
/// Carries a memory-only session across the attach restart. Read and
/// removed once by `take_session_handoff_from_env` before any thread starts.
pub(crate) const SESSION_HANDOFF_ENV: &str = "DATACONNECT_ATTACH_SESSION_HANDOFF";
const PAIRING_CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const PAIRING_CODE_LENGTH: usize = 12;
/// The developer escape hatch that already puts unified mode in attach mode.
/// It wins over a saved attachment.
const ENV_OVERRIDE_VARS: [&str; 2] = ["DATACONNECT_RI_URL", "DATACONNECT_CONSOLE_URL"];
const PROTECTED_RESOURCE_PATH: &str = "/.well-known/oauth-protected-resource";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// What the owner pasted, reduced to a server origin and an optional code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttachInput {
    pub origin: String,
    pub code: Option<String>,
}

/// Accepts `vana://attach?server=<origin>&code=<code>`, an `http(s)` URL,
/// or a bare `host[:port]`. A bare loopback host gets `http://`, any other
/// bare host `https://`. Path, query and fragment are dropped.
pub(crate) fn parse_attach_input(input: &str) -> Result<AttachInput, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the server address or paste the pairing link.".to_string());
    }
    if input.len() > 5 && input[..5].eq_ignore_ascii_case("vana:") {
        return parse_attach_link(input);
    }
    let candidate = if input.contains("://") {
        input.to_string()
    } else {
        let https = format!("https://{input}");
        match url::Url::parse(&https) {
            Ok(url) if url.host().as_ref().is_some_and(is_loopback_host) => {
                format!("http://{input}")
            }
            _ => https,
        }
    };
    Ok(AttachInput {
        origin: normalize_origin(&candidate)?,
        code: None,
    })
}

fn parse_attach_link(input: &str) -> Result<AttachInput, String> {
    let url = url::Url::parse(input).map_err(|_| "This pairing link is not valid.".to_string())?;
    if !url.scheme().eq_ignore_ascii_case("vana")
        || url.host_str() != Some("attach")
        || !matches!(url.path(), "" | "/")
    {
        return Err("This is not a DataConnect pairing link.".to_string());
    }
    let mut server = None;
    let mut code = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "server" => server = Some(value.into_owned()),
            "code" => code = Some(value.into_owned()),
            _ => {}
        }
    }
    let server = server
        .filter(|server| !server.trim().is_empty())
        .ok_or_else(|| "The pairing link names no server.".to_string())?;
    let origin = normalize_origin(server.trim())?;
    let code = match code.filter(|code| !code.trim().is_empty()) {
        Some(code) => Some(normalize_pairing_code(&code)?),
        None => None,
    };
    Ok(AttachInput { origin, code })
}

/// `scheme://host[:port]` of an `http(s)` URL, without a default port.
pub(crate) fn normalize_origin(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| {
        "Enter a server address such as https://dataconnect.example.com.".to_string()
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Use an http:// or https:// address.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Remove the user name or password from the address.".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The address has no host name.".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

/// Trim, uppercase, drop dashes and spaces; 12 characters of the code
/// alphabet. The alphabet has no I, L, O, U, 0 or 1.
pub(crate) fn normalize_pairing_code(raw: &str) -> Result<String, String> {
    let code: String = raw
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .map(|character| character.to_ascii_uppercase())
        .collect();
    if code.chars().count() == PAIRING_CODE_LENGTH
        && code
            .chars()
            .all(|character| PAIRING_CODE_ALPHABET.contains(character))
    {
        Ok(code)
    } else {
        Err("A pairing code has 12 letters and digits, like ABCD-EFGH-JKLM.".to_string())
    }
}

fn is_loopback_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HttpsPolicy {
    /// `https`, or plain HTTP to this computer.
    Allowed,
    /// Plain HTTP to another machine, accepted because the owner trusts the
    /// network. The window keeps the warning visible.
    Warn,
    /// Plain HTTP to another machine without that confirmation.
    Refuse,
}

pub(crate) fn https_policy(origin: &str, trust_plain_http: bool) -> HttpsPolicy {
    let Ok(url) = url::Url::parse(origin) else {
        return HttpsPolicy::Refuse;
    };
    match url.scheme() {
        "https" => HttpsPolicy::Allowed,
        "http" if url.host().as_ref().is_some_and(is_loopback_host) => HttpsPolicy::Allowed,
        "http" if trust_plain_http => HttpsPolicy::Warn,
        _ => HttpsPolicy::Refuse,
    }
}

pub(crate) const PLAIN_HTTP_WARNING: &str = "This address uses plain HTTP. Anyone on the network between this computer and the server can read your data and take over the session. Continue only on a network you trust.";

/// The saved attachment. It holds no secret: the session is in the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Attachment {
    pub origin: String,
    pub label: String,
    pub paired_at: String,
}

impl Attachment {
    pub(crate) fn host(&self) -> String {
        url::Url::parse(&self.origin)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_string(),
                })
            })
            .unwrap_or_else(|| self.origin.clone())
    }
}

pub(crate) fn attachment_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ATTACH_FILE)
}

pub(crate) fn load_attachment(app_data_dir: &Path) -> Result<Option<Attachment>, String> {
    let path = attachment_path(app_data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read {ATTACH_FILE}: {error}")),
    };
    let attachment: Attachment = serde_json::from_str(&text)
        .map_err(|error| format!("{ATTACH_FILE} is not valid: {error}"))?;
    if normalize_origin(&attachment.origin).as_deref() != Ok(attachment.origin.as_str()) {
        return Err(format!("{ATTACH_FILE} names an invalid server origin"));
    }
    Ok(Some(attachment))
}

pub(crate) fn save_attachment(app_data_dir: &Path, attachment: &Attachment) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("Could not create the app data directory: {error}"))?;
    crate::atomic_write::write_json_atomically(
        &attachment_path(app_data_dir),
        attachment,
        "Could not save the attachment",
    )
}

pub(crate) fn remove_attachment(app_data_dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(attachment_path(app_data_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove {ATTACH_FILE}: {error}")),
    }
}

/// Which server this process uses. Read once at startup: switching restarts
/// the app, so every `attach_mode()` caller sees one answer per process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AttachTarget {
    Local,
    /// `DATACONNECT_RI_URL` / `DATACONNECT_CONSOLE_URL` are set.
    Environment,
    Saved(Attachment),
}

pub(crate) fn resolve_attach_target(env_override: bool, saved: Option<Attachment>) -> AttachTarget {
    if env_override {
        return AttachTarget::Environment;
    }
    saved.map_or(AttachTarget::Local, AttachTarget::Saved)
}

pub(crate) fn env_override_from(get: impl Fn(&str) -> Option<String>) -> bool {
    ENV_OVERRIDE_VARS
        .into_iter()
        .any(|name| get(name).is_some_and(|value| !value.trim().is_empty()))
}

pub(crate) fn env_override_active() -> bool {
    env_override_from(|name| std::env::var(name).ok())
}

static SAVED_ATTACHMENT: OnceLock<Option<Attachment>> = OnceLock::new();

/// Load `attach.json` once for this process. An unreadable file is logged
/// and treated as no attachment, so the app still starts on this computer.
pub(crate) fn init_saved_attachment(app_data_dir: &Path) {
    let saved = load_attachment(app_data_dir).unwrap_or_else(|error| {
        log::error!("Ignoring the saved server attachment: {error}");
        None
    });
    let _ = SAVED_ATTACHMENT.set(saved);
}

pub(crate) fn saved_attachment() -> Option<&'static Attachment> {
    SAVED_ATTACHMENT.get().and_then(Option::as_ref)
}

pub(crate) fn current_target() -> AttachTarget {
    resolve_attach_target(env_override_active(), saved_attachment().cloned())
}

/// Where the owner session for an origin is kept.
pub(crate) trait SessionStore: Send + Sync {
    fn load(&self, origin: &str) -> Result<Option<String>, String>;
    fn save(&self, origin: &str, session: &str) -> Result<(), String>;
    fn delete(&self, origin: &str) -> Result<(), String>;
}

/// OS keychain, one entry per origin under `SESSION_KEYRING_SERVICE`.
pub(crate) struct KeychainSessionStore;

impl KeychainSessionStore {
    fn entry(origin: &str) -> Result<keyring::Entry, String> {
        // Never touch the owner's real keychain from `cargo test`.
        if cfg!(test) {
            return Err("the OS keychain is not used under cargo test".to_string());
        }
        keyring::Entry::new(SESSION_KEYRING_SERVICE, origin)
            .map_err(|error| format!("could not initialize OS keychain: {error}"))
    }
}

impl SessionStore for KeychainSessionStore {
    fn load(&self, origin: &str) -> Result<Option<String>, String> {
        match Self::entry(origin)?.get_password() {
            Ok(value) if !value.is_empty() => Ok(Some(value)),
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("could not read OS keychain: {error}")),
        }
    }

    fn save(&self, origin: &str, session: &str) -> Result<(), String> {
        Self::entry(origin)?
            .set_password(session)
            .map_err(|error| format!("could not write OS keychain: {error}"))
    }

    fn delete(&self, origin: &str) -> Result<(), String> {
        match Self::entry(origin)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("could not delete from OS keychain: {error}")),
        }
    }
}

#[derive(Default)]
pub(crate) struct MemorySessionStore(Mutex<HashMap<String, String>>);

impl SessionStore for MemorySessionStore {
    fn load(&self, origin: &str) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "session memory is poisoned".to_string())?
            .get(origin)
            .cloned())
    }

    fn save(&self, origin: &str, session: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "session memory is poisoned".to_string())?
            .insert(origin.to_string(), session.to_string());
        Ok(())
    }

    fn delete(&self, origin: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "session memory is poisoned".to_string())?
            .remove(origin);
        Ok(())
    }
}

/// Sessions this process holds only in memory (keychain unavailable).
pub(crate) fn process_memory_store() -> &'static MemorySessionStore {
    static STORE: OnceLock<MemorySessionStore> = OnceLock::new();
    STORE.get_or_init(MemorySessionStore::default)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoredIn {
    Keychain,
    /// The keychain refused the session. It lives in this process only.
    MemoryOnly,
}

pub(crate) const MEMORY_ONLY_NOTICE: &str = "This computer's keychain is unavailable, so DataConnect keeps the pairing in memory only. You will pair again after DataConnect quits.";

pub(crate) fn store_session(
    keychain: &dyn SessionStore,
    memory: &dyn SessionStore,
    origin: &str,
    session: &str,
) -> Result<StoredIn, String> {
    match keychain.save(origin, session) {
        Ok(()) => {
            let _ = memory.delete(origin);
            Ok(StoredIn::Keychain)
        }
        Err(error) => {
            log::warn!("Keeping the attach session in memory only: {error}");
            memory.save(origin, session)?;
            Ok(StoredIn::MemoryOnly)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionLookup {
    Found(String),
    Missing,
    KeychainUnavailable,
}

pub(crate) fn load_session(
    keychain: &dyn SessionStore,
    memory: &dyn SessionStore,
    origin: &str,
) -> SessionLookup {
    if let Ok(Some(session)) = memory.load(origin) {
        return SessionLookup::Found(session);
    }
    match keychain.load(origin) {
        Ok(Some(session)) => SessionLookup::Found(session),
        Ok(None) => SessionLookup::Missing,
        Err(error) => {
            log::warn!("Could not read the attach session from the keychain: {error}");
            SessionLookup::KeychainUnavailable
        }
    }
}

/// Delete the session from both stores. A keychain failure is returned so
/// the caller can say so; the memory copy is always gone.
pub(crate) fn forget_session(
    keychain: &dyn SessionStore,
    memory: &dyn SessionStore,
    origin: &str,
) -> Result<(), String> {
    let _ = memory.delete(origin);
    keychain.delete(origin)
}

static HANDED_OFF_SESSION: Mutex<Option<String>> = Mutex::new(None);

/// Move a memory-only session handed over by the previous process out of
/// the environment. Call before any thread starts: removing a variable while
/// another thread reads the environment is not safe on every libc.
pub(crate) fn take_session_handoff_from_env() {
    let Some(session) = std::env::var_os(SESSION_HANDOFF_ENV) else {
        return;
    };
    std::env::remove_var(SESSION_HANDOFF_ENV);
    if let (Some(session), Ok(mut slot)) = (session.to_str(), HANDED_OFF_SESSION.lock()) {
        if !session.is_empty() {
            *slot = Some(session.to_string());
        }
    }
}

pub(crate) fn take_handed_off_session() -> Option<String> {
    HANDED_OFF_SESSION
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// The label the server shows for this desktop's session.
pub(crate) fn desktop_session_label() -> String {
    format!("DataConnect desktop ({})", local_hostname())
}

fn local_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0_u8; 256];
        // SAFETY: the buffer is valid for its full length; gethostname
        // writes at most that many bytes.
        let result =
            unsafe { libc::gethostname(buffer.as_mut_ptr().cast::<libc::c_char>(), buffer.len()) };
        if result == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            if let Ok(name) = std::str::from_utf8(&buffer[..end]) {
                if !name.trim().is_empty() {
                    return name.trim().to_string();
                }
            }
        }
    }
    #[cfg(windows)]
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    "this computer".to_string()
}

/// A failure the attach window can name in plain words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AttachError {
    Unreachable,
    NotPdppServer,
    InvalidCode,
    RateLimited { retry_after_seconds: Option<u64> },
    PairingUnsupported,
    WrongPassword,
    Server { status: u16 },
}

impl AttachError {
    pub(crate) fn message(&self, origin: &str) -> String {
        match self {
            Self::Unreachable => format!("DataConnect cannot reach {origin}. Check the address and the network."),
            Self::NotPdppServer => format!("{origin} does not answer as a DataConnect server. Check the address."),
            Self::InvalidCode => "This code is wrong, already used, or expired. Create a new code in the server's Settings and try again.".to_string(),
            Self::RateLimited { retry_after_seconds: Some(seconds) } => {
                format!("Too many attempts. Wait {seconds} seconds and try again.")
            }
            Self::RateLimited { retry_after_seconds: None } => {
                "Too many attempts. Wait a minute and try again.".to_string()
            }
            Self::PairingUnsupported => "This server is older and cannot pair with a code. Use the owner password instead.".to_string(),
            Self::WrongPassword => "The server did not accept this owner password.".to_string(),
            Self::Server { status } => format!("{origin} answered with an error (HTTP {status}). Try again later."),
        }
    }
}

fn http_client() -> Result<reqwest::Client, AttachError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .map_err(|_| AttachError::Unreachable)
}

fn endpoint(origin: &str, path: &str) -> String {
    format!("{}{path}", origin.trim_end_matches('/'))
}

fn is_gateway_failure(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
}

/// Ask the origin for its protected-resource metadata before sending it any
/// credential. A DataConnect (PDPP) server answers 200 with a JSON object
/// that names its `resource`.
pub(crate) async fn verify_pdpp_server(origin: &str) -> Result<(), AttachError> {
    let response = http_client()?
        .get(endpoint(origin, PROTECTED_RESOURCE_PATH))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| AttachError::Unreachable)?;
    let status = response.status();
    if is_gateway_failure(status) {
        return Err(AttachError::Unreachable);
    }
    if status != reqwest::StatusCode::OK {
        return Err(AttachError::NotPdppServer);
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| AttachError::NotPdppServer)?;
    match body.get("resource").and_then(serde_json::Value::as_str) {
        Some(resource) if !resource.is_empty() => Ok(()),
        _ => Err(AttachError::NotPdppServer),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RedeemedSession {
    pub session: String,
    pub expires_at: Option<String>,
}

fn retry_after_seconds(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Exchange a pairing code for an owner session. Never logs the code or
/// the session.
pub(crate) async fn redeem_pairing(
    origin: &str,
    code: &str,
    label: &str,
) -> Result<RedeemedSession, AttachError> {
    let response = http_client()?
        .post(endpoint(origin, "/owner/desktop-pairings/redeem"))
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({ "code": code, "label": label }))
        .send()
        .await
        .map_err(|_| AttachError::Unreachable)?;
    let status = response.status();
    match status.as_u16() {
        200 | 201 => {}
        400 | 401 | 403 | 410 => return Err(AttachError::InvalidCode),
        404 | 405 => return Err(AttachError::PairingUnsupported),
        429 => {
            return Err(AttachError::RateLimited {
                retry_after_seconds: retry_after_seconds(&response),
            })
        }
        _ if is_gateway_failure(status) => return Err(AttachError::Unreachable),
        other => return Err(AttachError::Server { status: other }),
    }
    let body: serde_json::Value = response.json().await.map_err(|_| AttachError::Server {
        status: status.as_u16(),
    })?;
    let session = body
        .get("session")
        .and_then(serde_json::Value::as_str)
        .filter(|session| !session.is_empty())
        .ok_or(AttachError::Server {
            status: status.as_u16(),
        })?;
    Ok(RedeemedSession {
        session: session.to_string(),
        expires_at: body
            .get("expires_at")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
    })
}

/// Fallback for servers without pairing: sign in once with the owner
/// password over the existing `POST /owner/login` path. The password is
/// not kept. No session label is sent: "This computer" would replace the
/// remote server's own desktop-shell session.
pub(crate) async fn login_with_password(
    origin: &str,
    password: &str,
) -> Result<String, AttachError> {
    crate::commands::login_reference_server_with_password_and_host(
        origin.to_string(),
        password,
        None,
        None,
    )
    .await
    .map(|login| login.session_cookie)
    .map_err(|error| password_login_error(&error))
}

/// Maps `login_reference_server_with_password_and_host`'s error text.
/// `password_login_errors_follow_the_login_function` pins this mapping to
/// that function's real output.
fn password_login_error(error: &str) -> AttachError {
    if error.starts_with("Failed to reach") || error.starts_with("Failed to build") {
        return AttachError::Unreachable;
    }
    let status = error
        .rsplit_once("HTTP ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|code| code.parse::<u16>().ok());
    match status {
        Some(401) | Some(403) => AttachError::WrongPassword,
        Some(429) => AttachError::RateLimited {
            retry_after_seconds: None,
        },
        Some(502..=504) => AttachError::Unreachable,
        Some(status) => AttachError::Server { status },
        None => AttachError::Server { status: 0 },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionCheck {
    Valid,
    Expired,
    Unreachable(AttachError),
}

/// Identity check first, then `GET /owner/session` with the session cookie:
/// 204 signed in, 401 ended (the server answers 401 to JSON callers). Any
/// other answer, 403 and redirects included, keeps the pairing: it may come
/// from a proxy or a fault, and ending the pairing deletes the session.
pub(crate) async fn check_session(origin: &str, session: &str) -> SessionCheck {
    if let Err(error) = verify_pdpp_server(origin).await {
        return SessionCheck::Unreachable(error);
    }
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return SessionCheck::Unreachable(error),
    };
    let response = client
        .get(endpoint(origin, "/owner/session"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::COOKIE,
            format!("{OWNER_SESSION_COOKIE}={session}"),
        )
        .send()
        .await;
    let Ok(response) = response else {
        return SessionCheck::Unreachable(AttachError::Unreachable);
    };
    let status = response.status();
    if status.is_success() {
        SessionCheck::Valid
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        SessionCheck::Expired
    } else if is_gateway_failure(status) {
        SessionCheck::Unreachable(AttachError::Unreachable)
    } else {
        SessionCheck::Unreachable(AttachError::Server {
            status: status.as_u16(),
        })
    }
}

/// End the session on the server: `POST /owner/logout` as a JSON client
/// (JSON is exempt from the owner CSRF check; `owner-auth.ts`
/// `handleOwnerLogout`). Returns whether the server confirmed. Best effort:
/// the caller deletes the local copy either way.
pub(crate) async fn revoke_session(origin: &str, session: &str) -> bool {
    if verify_pdpp_server(origin).await.is_err() {
        return false;
    }
    let Ok(client) = http_client() else {
        return false;
    };
    client
        .post(endpoint(origin, "/owner/logout"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::COOKIE,
            format!("{OWNER_SESSION_COOKIE}={session}"),
        )
        .json(&serde_json::json!({}))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

pub(crate) const PAIRING_ENDED_NOTICE: &str = "This pairing ended. Pair again.";
const KEYCHAIN_LOST_NOTICE: &str =
    "DataConnect could not read the pairing from this computer's keychain. Pair again.";

/// What a launch in the attached state does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AttachedLaunch {
    OpenConsole {
        session: String,
    },
    /// Open the attach window with this notice. Never retried on its own.
    PairAgain {
        notice: String,
    },
    /// Keep the pairing; say which origin did not answer.
    Unreachable {
        message: String,
    },
}

pub(crate) async fn decide_attached_launch(origin: &str, lookup: SessionLookup) -> AttachedLaunch {
    let session = match lookup {
        SessionLookup::Found(session) => session,
        SessionLookup::Missing => {
            return AttachedLaunch::PairAgain {
                notice: PAIRING_ENDED_NOTICE.to_string(),
            }
        }
        SessionLookup::KeychainUnavailable => {
            return AttachedLaunch::PairAgain {
                notice: KEYCHAIN_LOST_NOTICE.to_string(),
            }
        }
    };
    match check_session(origin, &session).await {
        SessionCheck::Valid => AttachedLaunch::OpenConsole { session },
        SessionCheck::Expired => AttachedLaunch::PairAgain {
            notice: PAIRING_ENDED_NOTICE.to_string(),
        },
        SessionCheck::Unreachable(error) => AttachedLaunch::Unreachable {
            message: format!(
                "{} The pairing is kept. Choose Open DataConnect in the tray to try again, or detach.",
                error.message(origin)
            ),
        },
    }
}

#[cfg(test)]
#[path = "attach_tests.rs"]
pub(crate) mod tests;
