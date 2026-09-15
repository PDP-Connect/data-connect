// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Manages the PDPP reference-implementation server as a supervised child
// process, and mints the owner-session cookie the "Server & Repairs" webview
// authenticates with.
//
// This follows the same lifecycle shape as `commands/server.rs`
// (personal-server): start/health-wait/stop/restart-on-crash, process-group
// signaling on unix, and honest event surfacing to the frontend. It is
// intentionally a *separate* supervisor from `server.rs`: the reference
// implementation's operator console is a different application from the
// bundled Personal Server.
//
// Bundling status: the shipped Personal Server exposes its own `/ui` dev page,
// but it does not serve the reference operator console's `/owner/login` or
// `/_ref` surfaces. The desktop build therefore does not pretend that the
// bundled server can back this tab. A developer can explicitly configure a
// reference checkout (`PDPP_REFERENCE_CHECKOUT`) or an already-running
// reference origin (`PDPP_REFERENCE_SERVER_URL`) as an escape hatch.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(unix)]
use super::server::kill_process_group;

static REF_SERVER_PROCESS: Mutex<Option<std::process::Child>> = Mutex::new(None);
static REF_SERVER_ORIGIN: Mutex<Option<String>> = Mutex::new(None);
static REF_SERVER_STARTING: Mutex<bool> = Mutex::new(false);
/// True when stop_reference_server initiated the exit, so the health/exit
/// watcher thread knows not to report it as a crash.
static REF_SERVER_STOPPING: Mutex<bool> = Mutex::new(false);
/// True when this app spawned the process itself (vs. attaching to an
/// already-running server). Only spawned processes are ours to stop/kill.
static REF_SERVER_OWNS_PROCESS: Mutex<bool> = Mutex::new(false);

const DEFAULT_REFERENCE_SERVER_URL: &str = "http://localhost:3000";
const OPERATOR_TOOLS_UNAVAILABLE: &str = "Operator tools are not included in this build.";
const HEALTH_CHECK_PATH: &str = "/.well-known/oauth-protected-resource";
const HEALTH_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_CRASH_RESTARTS: u32 = 3;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReferenceServerStatus {
    pub running: bool,
    pub origin: Option<String>,
    /// True if this app spawned the process; false if it merely attached to
    /// an already-running server it did not start (dev-mode fallback).
    pub managed: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ReferenceServerTarget {
    Spawn {
        checkout_dir: PathBuf,
        origin: String,
    },
    Attach {
        origin: String,
    },
}

fn configured_checkout_dir() -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var("PDPP_REFERENCE_CHECKOUT")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };

    let path = PathBuf::from(value);
    if path.is_dir() {
        Ok(Some(path))
    } else {
        Err(format!(
            "PDPP_REFERENCE_CHECKOUT is set but is not a directory: {:?}",
            path
        ))
    }
}

fn configured_server_url() -> Option<String> {
    std::env::var("PDPP_REFERENCE_SERVER_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_reference_server_target(
    checkout_dir: Option<PathBuf>,
    server_url: Option<String>,
) -> Result<ReferenceServerTarget, String> {
    match checkout_dir {
        Some(checkout_dir) => Ok(ReferenceServerTarget::Spawn {
            checkout_dir,
            origin: server_url.unwrap_or_else(|| DEFAULT_REFERENCE_SERVER_URL.to_string()),
        }),
        None => server_url
            .map(|origin| ReferenceServerTarget::Attach { origin })
            .ok_or_else(|| OPERATOR_TOOLS_UNAVAILABLE.to_string()),
    }
}

fn health_check_url(origin: &str) -> String {
    format!("{}{}", origin.trim_end_matches('/'), HEALTH_CHECK_PATH)
}

async fn wait_for_health(origin: String) -> bool {
    let url = health_check_url(&origin);
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + HEALTH_WAIT_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }
    false
}

/// Start the reference server from an explicitly configured development
/// checkout or attach to an explicitly configured origin. The shipped
/// Personal Server is not a reference operator-console host. Emits
/// `reference-server-ready` on success, `reference-server-error` on failure.
#[tauri::command]
pub async fn start_reference_server(app: AppHandle) -> Result<ReferenceServerStatus, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    if let Ok(mut s) = REF_SERVER_STOPPING.lock() {
        *s = false;
    }

    {
        let mut starting = REF_SERVER_STARTING.lock().map_err(|e| e.to_string())?;
        if *starting {
            let origin = REF_SERVER_ORIGIN.lock().map_err(|e| e.to_string())?.clone();
            return Ok(ReferenceServerStatus {
                running: true,
                origin,
                managed: *REF_SERVER_OWNS_PROCESS.lock().map_err(|e| e.to_string())?,
            });
        }
        let guard = REF_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            let origin = REF_SERVER_ORIGIN.lock().map_err(|e| e.to_string())?.clone();
            return Ok(ReferenceServerStatus {
                running: true,
                origin,
                managed: true,
            });
        }
        *starting = true;
    }

    let clear_starting = || {
        if let Ok(mut s) = REF_SERVER_STARTING.lock() {
            *s = false;
        }
    };

    let checkout_dir = match configured_checkout_dir() {
        Ok(checkout_dir) => checkout_dir,
        Err(message) => {
            clear_starting();
            let _ = app.emit(
                "reference-server-error",
                serde_json::json!({ "message": message }),
            );
            return Err(message);
        }
    };
    let target = match resolve_reference_server_target(checkout_dir, configured_server_url()) {
        Ok(target) => target,
        Err(message) => {
            clear_starting();
            let _ = app.emit(
                "reference-server-error",
                serde_json::json!({ "message": message }),
            );
            return Err(message);
        }
    };

    let (checkout_dir, origin) = match target {
        ReferenceServerTarget::Attach { origin } => {
            log::info!(
                "PDPP_REFERENCE_CHECKOUT not set; attaching to explicitly configured reference server at {}",
                origin
            );
            if wait_for_health(origin.clone()).await {
                if let Ok(mut guard) = REF_SERVER_ORIGIN.lock() {
                    *guard = Some(origin.clone());
                }
                if let Ok(mut guard) = REF_SERVER_OWNS_PROCESS.lock() {
                    *guard = false;
                }
                clear_starting();
                let _ = app.emit(
                    "reference-server-ready",
                    serde_json::json!({ "origin": origin, "managed": false }),
                );
                return Ok(ReferenceServerStatus {
                    running: true,
                    origin: Some(origin),
                    managed: false,
                });
            }
            clear_starting();
            let message = format!(
                "PDPP_REFERENCE_SERVER_URL is set, but no reference server answered {} within {:?}.",
                health_check_url(&origin),
                HEALTH_WAIT_TIMEOUT
            );
            let _ = app.emit(
                "reference-server-error",
                serde_json::json!({ "message": message }),
            );
            return Err(message);
        }
        ReferenceServerTarget::Spawn {
            checkout_dir,
            origin,
        } => (checkout_dir, origin),
    };

    // Spawn `pnpm dev` from the configured checkout. This is the same
    // composed-mode entrypoint a developer runs by hand; see
    // reference-implementation/README.md "Same-origin local reference
    // composition" in the pdpp repo.
    log::info!(
        "Starting reference server via 'pnpm dev' in {:?}, expecting origin {}",
        checkout_dir,
        origin
    );

    let mut cmd = Command::new("pnpm");
    cmd.arg("dev")
        .current_dir(&checkout_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting();
            let message = format!("Failed to spawn 'pnpm dev' in {:?}: {}", checkout_dir, e);
            let _ = app.emit(
                "reference-server-error",
                serde_json::json!({ "message": message }),
            );
            return Err(message);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = REF_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }
    {
        let mut guard = REF_SERVER_ORIGIN.lock().map_err(|e| e.to_string())?;
        *guard = Some(origin.clone());
    }
    if let Ok(mut guard) = REF_SERVER_OWNS_PROCESS.lock() {
        *guard = true;
    }

    if let Some(stdout) = stdout {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                log::debug!("Reference server stdout: {}", line);
                let _ = app_handle.emit(
                    "reference-server-log",
                    serde_json::json!({ "message": line }),
                );
            }
        });
    }
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::warn!("Reference server stderr: {}", line);
            }
        });
    }

    // Health-wait, then declare readiness (or failure) honestly instead of
    // assuming the process coming up means the HTTP server is serving.
    let health_origin = origin.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        if wait_for_health(health_origin.clone()).await {
            log::info!("Reference server healthy at {}", health_origin);
            let _ = app_handle.emit(
                "reference-server-ready",
                serde_json::json!({ "origin": health_origin, "managed": true }),
            );
        } else {
            log::error!(
                "Reference server did not become healthy within {:?}",
                HEALTH_WAIT_TIMEOUT
            );
            let _ = app_handle.emit(
                "reference-server-error",
                serde_json::json!({ "message": "Reference server did not become healthy in time" }),
            );
        }
    });

    clear_starting();
    spawn_exit_and_restart_watcher(app.clone(), 0);

    Ok(ReferenceServerStatus {
        running: true,
        origin: Some(origin),
        managed: true,
    })
}

/// Watches the spawned child for an unexpected exit and restarts it, up to
/// MAX_CRASH_RESTARTS times, with honest `reference-server-crashed` /
/// `reference-server-restart-failed` events. A stop_reference_server()
/// call (which sets REF_SERVER_STOPPING) suppresses the crash report and
/// restart for that exit.
fn spawn_exit_and_restart_watcher(app: AppHandle, restart_count: u32) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let exited = {
                let mut guard = match REF_SERVER_PROCESS.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => return, // stopped/cleared elsewhere
                }
            };
            if !exited {
                continue;
            }

            let was_intentional = REF_SERVER_STOPPING.lock().map(|s| *s).unwrap_or(false);
            if let Ok(mut guard) = REF_SERVER_PROCESS.lock() {
                *guard = None;
            }
            if let Ok(mut guard) = REF_SERVER_ORIGIN.lock() {
                *guard = None;
            }

            if was_intentional {
                log::info!("Reference server stopped intentionally");
                return;
            }

            log::warn!(
                "Reference server exited unexpectedly (restart {}/{})",
                restart_count,
                MAX_CRASH_RESTARTS
            );
            let _ = app.emit(
                "reference-server-crashed",
                serde_json::json!({ "restartAttempt": restart_count + 1, "maxRestarts": MAX_CRASH_RESTARTS }),
            );

            if restart_count >= MAX_CRASH_RESTARTS {
                log::error!(
                    "Reference server exceeded max crash restarts ({})",
                    MAX_CRASH_RESTARTS
                );
                let _ = app.emit(
                    "reference-server-restart-failed",
                    serde_json::json!({ "message": "Reference server crashed repeatedly and was not restarted" }),
                );
                return;
            }

            let app_for_restart = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_reference_server(app_for_restart.clone()).await {
                    log::error!("Reference server restart failed: {}", e);
                    let _ = app_for_restart.emit(
                        "reference-server-restart-failed",
                        serde_json::json!({ "message": e }),
                    );
                    return;
                }
                spawn_exit_and_restart_watcher(app_for_restart, restart_count + 1);
            });
            return;
        }
    });
}

/// Stop the reference server, if this app spawned it. Attached
/// (dev-mode-fallback) servers are left running since we don't own them.
#[tauri::command]
pub async fn stop_reference_server() -> Result<(), String> {
    if let Ok(mut s) = REF_SERVER_STOPPING.lock() {
        *s = true;
    }
    if let Ok(mut s) = REF_SERVER_STARTING.lock() {
        *s = false;
    }

    let owns_process = REF_SERVER_OWNS_PROCESS.lock().map(|g| *g).unwrap_or(false);
    if !owns_process {
        if let Ok(mut guard) = REF_SERVER_ORIGIN.lock() {
            *guard = None;
        }
        return Ok(());
    }

    let mut guard = REF_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        log::info!("Stopping reference server...");
        #[cfg(unix)]
        {
            kill_process_group(child.id(), libc::SIGTERM);
        }
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => break,
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        if child.try_wait().map(|s| s.is_none()).unwrap_or(true) {
            #[cfg(unix)]
            {
                kill_process_group(child.id(), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }

    if let Ok(mut guard) = REF_SERVER_ORIGIN.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = REF_SERVER_OWNS_PROCESS.lock() {
        *guard = false;
    }
    Ok(())
}

#[tauri::command]
pub fn get_reference_server_status() -> Result<ReferenceServerStatus, String> {
    let mut guard = REF_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
    let origin = REF_SERVER_ORIGIN.lock().map_err(|e| e.to_string())?.clone();
    let managed = REF_SERVER_OWNS_PROCESS.lock().map(|g| *g).unwrap_or(false);

    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                return Ok(ReferenceServerStatus {
                    running: false,
                    origin: None,
                    managed: false,
                });
            }
            Ok(None) => {
                return Ok(ReferenceServerStatus {
                    running: true,
                    origin,
                    managed,
                })
            }
            Err(_) => {}
        }
    } else if origin.is_some() && !managed {
        // Attached (unmanaged) mode: we don't hold a child handle, so
        // "running" reflects whether we last saw it healthy at start.
        return Ok(ReferenceServerStatus {
            running: true,
            origin,
            managed: false,
        });
    }

    Ok(ReferenceServerStatus {
        running: false,
        origin: None,
        managed: false,
    })
}

/// Best-effort cleanup on app exit — mirrors cleanup_personal_server.
pub fn cleanup_reference_server() {
    if let Ok(mut s) = REF_SERVER_STOPPING.lock() {
        *s = true;
    }
    let owns_process = REF_SERVER_OWNS_PROCESS.lock().map(|g| *g).unwrap_or(false);
    if !owns_process {
        return;
    }
    if let Ok(mut guard) = REF_SERVER_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            log::info!("Cleaning up reference server on app exit...");
            #[cfg(unix)]
            {
                kill_process_group(child.id(), libc::SIGTERM);
            }
            for _ in 0..10 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            #[cfg(unix)]
            {
                kill_process_group(child.id(), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceServerLoginResult {
    /// The `pdpp_owner_session` cookie value the caller can pass to
    /// `Webview::set_cookie` for the embedded webview. Never logged.
    pub session_cookie: String,
    pub origin: String,
}

/// Owner-session auth handoff seam: obtain a session from the reference
/// server the SAME way any third-party client would — `POST /owner/login`
/// with the owner password, over the server's own public, unprivileged
/// mechanism (see reference-implementation/server/owner-auth.ts in pdpp).
/// JSON request bodies are exempt from the server's CSRF requirement by
/// design (CSRF only guards browser-submittable encodings), so no
/// token-scraping handshake is needed here — this is not a backdoor, it is
/// the documented API-client path through the same login endpoint a human
/// hitting the login form also uses.
///
/// Requires `PDPP_OWNER_PASSWORD` to be set to the same value the reference
/// server was started with. If unset, returns an honest error rather than
/// silently trying an empty password.
#[tauri::command]
pub async fn login_reference_server(origin: String) -> Result<ReferenceServerLoginResult, String> {
    let password = std::env::var("PDPP_OWNER_PASSWORD").map_err(|_| {
        "PDPP_OWNER_PASSWORD is not set in this app's environment. Set it to the same value the \
         reference server was started with so the app can sign in as the owner."
            .to_string()
    })?;

    // The server's own /owner/login handler answers a successful login with a
    // 302 redirect back to the login page (a browser-form-compatible shape),
    // setting pdpp_owner_session on THAT response, not on whatever it
    // redirects to. A client that follows the redirect (reqwest's default
    // policy) only sees the final response's headers, so the session cookie
    // set on the intermediate 302 is invisible to it -- confirmed live: the
    // final GET /owner/login response carries a fresh pdpp_owner_csrf but no
    // pdpp_owner_session. Disable redirect-following so this code inspects
    // the 302 itself.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let login_url = format!("{}/owner/login", origin.trim_end_matches('/'));
    let response = client
        .post(&login_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "password": password }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach {}: {}", login_url, e))?;

    let status = response.status();
    if !(status.is_success() || status.is_redirection()) {
        return Err(format!(
            "Owner login rejected by reference server: HTTP {}",
            status
        ));
    }

    let set_cookie_header = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with("pdpp_owner_session="))
        .map(|v| v.to_string());

    let Some(raw_cookie) = set_cookie_header else {
        return Err(
            "Owner login succeeded but the reference server did not return a pdpp_owner_session cookie."
                .to_string(),
        );
    };

    // Extract just the cookie value (between '=' and the first ';').
    let value = raw_cookie
        .split_once('=')
        .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_string())
        .ok_or_else(|| "Malformed Set-Cookie header from reference server".to_string())?;

    Ok(ReferenceServerLoginResult {
        session_cookie: value,
        origin,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_reference_server_target, ReferenceServerTarget, OPERATOR_TOOLS_UNAVAILABLE,
    };
    use std::path::PathBuf;

    #[test]
    fn explicit_server_url_overrides_the_default_origin() {
        let target = resolve_reference_server_target(
            Some(PathBuf::from("/pdpp")),
            Some("http://127.0.0.1:4310".to_string()),
        )
        .expect("configured checkout should be spawnable");

        assert_eq!(
            target,
            ReferenceServerTarget::Spawn {
                checkout_dir: PathBuf::from("/pdpp"),
                origin: "http://127.0.0.1:4310".to_string(),
            }
        );
    }

    #[test]
    fn explicit_server_url_without_checkout_attaches_to_that_origin() {
        let target =
            resolve_reference_server_target(None, Some("http://127.0.0.1:4310".to_string()))
                .expect("explicit origin should enable dev attachment");

        assert_eq!(
            target,
            ReferenceServerTarget::Attach {
                origin: "http://127.0.0.1:4310".to_string(),
            }
        );
    }

    #[test]
    fn no_explicit_reference_configuration_returns_honest_error() {
        let error = resolve_reference_server_target(None, None)
            .expect_err("the bundled Personal Server is not a reference operator host");

        assert_eq!(error, OPERATOR_TOOLS_UNAVAILABLE);
    }
}
