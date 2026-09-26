// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Desktop-only lifecycle settings that carry a real OS side effect,
//! distinct from the generic config blob in file_ops.rs.
//!
//! Launch-at-login writes an OS-level artifact (e.g. a .desktop file under
//! `~/.config/autostart/` on Linux, a Login Item on macOS, a registry Run
//! key on Windows) via tauri-plugin-autostart, so it needs its own
//! enable()/disable()/is_enabled() commands rather than a value stored in
//! ~/.dataconnect/config.json. See
//! ai/research/desktop-app-packaging/tray-app-lifecycle-settings-and-defaults-2026.md
//! for the field survey this setting (and its absence of siblings like
//! auto-update-check) is grounded in.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Report whether DataConnect is currently registered to launch at login.
#[tauri::command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("Failed to read autostart state: {error}"))
}

/// Enable or disable launching DataConnect automatically at login.
#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("Failed to enable autostart: {error}"))
    } else {
        manager
            .disable()
            .map_err(|error| format!("Failed to disable autostart: {error}"))
    }
}

/// The Tauri console window cannot call `get_autostart_enabled`/
/// `set_autostart_enabled` directly (Tauri never injects `invoke()` into
/// `http://127.0.0.1:{port}`, same gap as remote-access -- see
/// `remote_access.rs`). Unlike remote-access's `user_supplied_origin`
/// provider, autostart is an imperative OS action (a `.desktop` file /
/// registry key / Login Item via `tauri_plugin_autostart`'s `auto-launch`
/// crate) that only this Rust process can perform -- the reference server
/// cannot reimplement OS autostart registration without creating a second,
/// competing mechanism.
///
/// The file protocol shared with `reference-implementation/server/autostart-store.ts`
/// lives under the same `unified` directory as `remote-access.json`:
/// - `autostart-state.json`: observed OS state, written only by this process.
/// - `autostart-commands/ast_*.json`: immutable commands, written only by the
///   server.
/// - `autostart-results/ast_*.json`: one result per command, written only by
///   this process.
pub(crate) const AUTOSTART_STATE_FILE: &str = "autostart-state.json";
pub(crate) const AUTOSTART_COMMANDS_DIR: &str = "autostart-commands";
pub(crate) const AUTOSTART_RESULTS_DIR: &str = "autostart-results";
const AUTOSTART_COMMAND_KIND: &str = "set_autostart_enabled";
/// Same window as `hasPendingCommand` in `autostart-store.ts`: an older
/// command is no longer pending, so it is never applied late.
const AUTOSTART_COMMAND_TTL: chrono::Duration = chrono::Duration::seconds(600);

/// Resolve the shared protocol directory, the SAME directory
/// `remote_access_config_path` uses (see `remote_access.rs`).
pub(crate) fn autostart_protocol_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(crate::unified::UNIFIED_DB_DIRECTORY))
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedAutostartState {
    pub(crate) enabled: bool,
    pub(crate) error: Option<String>,
    pub(crate) observed_at: String,
    pub(crate) revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutostartCommand {
    command_id: String,
    kind: String,
    desired_enabled: bool,
    created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartResult {
    pub(crate) command_id: String,
    pub(crate) kind: String,
    pub(crate) desired_enabled: bool,
    pub(crate) status: String,
    pub(crate) enabled: bool,
    pub(crate) error: Option<String>,
    pub(crate) started_at: String,
    pub(crate) finished_at: String,
}

fn iso(time: chrono::DateTime<chrono::Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Same shape `autostart-store.ts` generates: `ast_` + 22 base64url chars.
fn is_command_file_name(name: &str) -> bool {
    name.strip_prefix("ast_")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|id| {
            id.len() == 22
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
}

/// A missing, empty, or unparseable state file (e.g. zero bytes from a
/// process killed mid-write) reads as `None` so the tick rewrites it rather
/// than failing the same way every poll.
fn load_observed_state(path: &Path) -> Option<ObservedAutostartState> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn write_protocol_json<T: Serialize>(path: &Path, value: &T, context: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{context}: {error}"))?;
    }
    crate::atomic_write::write_json_atomically(path, value, context)
}

/// One watcher tick, with the OS effects passed in as closures so it runs
/// under a unit test without a Tauri runtime:
/// 1. Answer every unanswered, unexpired command in `createdAt` order with
///    exactly one result file. Expired commands and their results are
///    removed without being applied.
/// 2. Rewrite `autostart-state.json` when the observed state changed or the
///    file is missing/corrupt. It is seeded from `is_enabled()` without ever
///    calling `enable()`/`disable()` for a change nobody asked for.
pub(crate) fn tick_autostart_protocol<F, E, D>(
    root: &Path,
    now: chrono::DateTime<chrono::Utc>,
    is_enabled: F,
    mut enable: E,
    mut disable: D,
) -> Result<(), String>
where
    F: Fn() -> Result<bool, String>,
    E: FnMut() -> Result<(), String>,
    D: FnMut() -> Result<(), String>,
{
    let commands_dir = root.join(AUTOSTART_COMMANDS_DIR);
    let results_dir = root.join(AUTOSTART_RESULTS_DIR);
    let mut pending = Vec::new();
    let entries = match fs::read_dir(&commands_dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Failed to read autostart commands: {error}")),
    };
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_command_file_name(&name) {
            continue;
        }
        let command_path = entry.path();
        let result_path = results_dir.join(&name);
        let Some(command) = fs::read_to_string(&command_path)
            .ok()
            .and_then(|content| serde_json::from_str::<AutostartCommand>(&content).ok())
        else {
            continue;
        };
        let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&command.created_at) else {
            continue;
        };
        let created_at = created_at.with_timezone(&chrono::Utc);
        if now - created_at >= AUTOSTART_COMMAND_TTL {
            let _ = fs::remove_file(&command_path);
            let _ = fs::remove_file(&result_path);
            continue;
        }
        if command.kind != AUTOSTART_COMMAND_KIND
            || format!("{}.json", command.command_id) != name
            || result_path.exists()
        {
            continue;
        }
        pending.push((created_at, command, result_path));
    }
    pending.sort_by_key(|(created_at, _, _)| *created_at);

    let state_path = root.join(AUTOSTART_STATE_FILE);
    let previous = load_observed_state(&state_path);
    let mut error = previous.as_ref().and_then(|state| state.error.clone());
    for (_, command, result_path) in pending {
        let started_at = iso(chrono::Utc::now());
        let mutation_error = if command.desired_enabled {
            enable().err()
        } else {
            disable().err()
        };
        // Report OS truth from a fresh read, not the assumed outcome.
        let enabled = is_enabled()?;
        let succeeded = mutation_error.is_none() && enabled == command.desired_enabled;
        let result = AutostartResult {
            command_id: command.command_id,
            kind: AUTOSTART_COMMAND_KIND.to_string(),
            desired_enabled: command.desired_enabled,
            status: if succeeded { "succeeded" } else { "failed" }.to_string(),
            enabled,
            error: mutation_error.clone(),
            started_at,
            finished_at: iso(chrono::Utc::now()),
        };
        write_protocol_json(&result_path, &result, "Failed to write autostart result")?;
        error = mutation_error;
    }

    let enabled = is_enabled()?;
    let changed = previous
        .as_ref()
        .is_none_or(|state| state.enabled != enabled || state.error != error);
    if changed {
        let observed_at = iso(now);
        let state = ObservedAutostartState {
            enabled,
            error,
            revision: observed_at.clone(),
            observed_at,
        };
        write_protocol_json(&state_path, &state, "Failed to write autostart state")?;
    }
    Ok(())
}

/// Whether the one-time "DataConnect keeps running in the tray" toast has
/// already been shown. Deliberately its own tiny file rather than a field
/// on `AppConfig` (file_ops.rs): the console's settings UI reads/writes
/// `AppConfig` as a full-object replace (see `set_app_config`), so a
/// Rust-owned, JS-invisible flag living in that struct would risk being
/// silently reset to its default the next time a user changes an unrelated
/// setting from a partial view of the config. Same rationale as
/// `AutostartState` above.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct CloseToTrayNoticeState {
    pub(crate) shown: bool,
}

const CLOSE_TO_TRAY_NOTICE_FILE: &str = "close_to_tray_notice.json";

pub(crate) fn close_to_tray_notice_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(CLOSE_TO_TRAY_NOTICE_FILE)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// Missing file or any read/parse error both mean "not shown yet" -- the
/// safe failure mode is showing the toast an extra time, not never showing
/// it because of a transient disk error.
pub(crate) fn load_close_to_tray_notice_state(path: &Path) -> CloseToTrayNoticeState {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn save_close_to_tray_notice_state(
    path: &Path,
    state: &CloseToTrayNoticeState,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create notice-state directory: {error}"))?;
    }
    crate::atomic_write::write_json_atomically(path, state, "Failed to write notice state")
}

/// Mark the toast shown, if it has not already been recorded as shown.
/// Returns true if this call is the one that should actually display it
/// (i.e. it was NOT already marked shown), false otherwise -- this is what
/// makes the notification one-time-ever rather than once-per-session.
///
/// Reads then writes to the same file with no lock: two `CloseRequested`
/// events cannot fire concurrently from the same single-threaded window
/// event loop, so a TOCTOU race is not reachable here in practice, unlike a
/// multi-writer scenario.
pub(crate) fn mark_close_to_tray_notice_shown_if_first_time(
    app: &AppHandle,
) -> Result<bool, String> {
    let path = close_to_tray_notice_path(app)?;
    let state = load_close_to_tray_notice_state(&path);
    if state.shown {
        return Ok(false);
    }
    save_close_to_tray_notice_state(&path, &CloseToTrayNoticeState { shown: true })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    use std::cell::Cell;

    const COMMAND_ID: &str = "ast_AAAAAAAAAAAAAAAAAAAAAA";

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    /// Write a command exactly as `autostart-store.ts` `requestChange` does.
    fn write_server_command(
        root: &Path,
        command_id: &str,
        desired_enabled: bool,
        created_at: chrono::DateTime<chrono::Utc>,
    ) {
        let directory = root.join("autostart-commands");
        fs::create_dir_all(&directory).expect("commands dir");
        fs::write(
            directory.join(format!("{command_id}.json")),
            format!(
                "{}\n",
                serde_json::json!({
                    "commandId": command_id,
                    "kind": "set_autostart_enabled",
                    "desiredEnabled": desired_enabled,
                    "createdAt": iso(created_at),
                    "status": "accepted",
                })
            ),
        )
        .expect("command file");
    }

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).expect("read json")).expect("parse json")
    }

    #[test]
    fn protocol_file_names_match_the_reference_server_store() {
        // Pinned against reference-implementation/server/autostart-store.ts.
        let store = include_str!("../../../reference-implementation/server/autostart-store.ts");
        for name in [
            AUTOSTART_STATE_FILE,
            AUTOSTART_COMMANDS_DIR,
            AUTOSTART_RESULTS_DIR,
            AUTOSTART_COMMAND_KIND,
        ] {
            assert!(
                store.contains(&format!("\"{name}\"")),
                "autostart-store.ts no longer uses {name}"
            );
        }
    }

    #[test]
    fn seeds_observed_state_from_is_enabled_without_mutating() {
        let dir = tempdir().expect("tempdir");
        let calls = Cell::new(0);

        tick_autostart_protocol(
            dir.path(),
            now(),
            || Ok(true),
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
        )
        .expect("tick");

        assert_eq!(calls.get(), 0);
        let state = read_json(&dir.path().join("autostart-state.json"));
        assert_eq!(state["enabled"], true);
        assert_eq!(state["error"], serde_json::Value::Null);
        assert!(state["observedAt"].is_string());
        assert!(state["revision"].is_string());
    }

    #[test]
    fn corrupt_state_file_is_rewritten_instead_of_failing_every_tick() {
        let dir = tempdir().expect("tempdir");
        let state_path = dir.path().join("autostart-state.json");
        fs::write(&state_path, b"").expect("zero-byte state file");

        tick_autostart_protocol(dir.path(), now(), || Ok(false), || Ok(()), || Ok(()))
            .expect("corrupt state must not fail the tick");

        assert_eq!(read_json(&state_path)["enabled"], false);
    }

    #[test]
    fn server_command_is_applied_and_answered_with_its_own_result() {
        let dir = tempdir().expect("tempdir");
        let enabled = Cell::new(false);
        write_server_command(dir.path(), COMMAND_ID, true, now());

        tick_autostart_protocol(
            dir.path(),
            now(),
            || Ok(enabled.get()),
            || {
                enabled.set(true);
                Ok(())
            },
            || {
                enabled.set(false);
                Ok(())
            },
        )
        .expect("tick");

        let result = read_json(
            &dir.path()
                .join(format!("autostart-results/{COMMAND_ID}.json")),
        );
        assert_eq!(result["commandId"], COMMAND_ID);
        assert_eq!(result["kind"], "set_autostart_enabled");
        assert_eq!(result["desiredEnabled"], true);
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["enabled"], true);
        assert_eq!(result["error"], serde_json::Value::Null);
        assert_eq!(
            read_json(&dir.path().join("autostart-state.json"))["enabled"],
            true
        );
    }

    #[test]
    fn failed_mutation_is_reported_as_failed_with_a_fresh_os_read() {
        let dir = tempdir().expect("tempdir");
        write_server_command(dir.path(), COMMAND_ID, true, now());

        tick_autostart_protocol(
            dir.path(),
            now(),
            || Ok(false),
            || Err("permission denied".to_string()),
            || Ok(()),
        )
        .expect("tick");

        let result = read_json(
            &dir.path()
                .join(format!("autostart-results/{COMMAND_ID}.json")),
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(result["enabled"], false);
        assert_eq!(result["error"], "permission denied");
        let state = read_json(&dir.path().join("autostart-state.json"));
        assert_eq!(state["error"], "permission denied");
    }

    #[test]
    fn answered_command_is_not_applied_again() {
        let dir = tempdir().expect("tempdir");
        let calls = Cell::new(0);
        write_server_command(dir.path(), COMMAND_ID, true, now());
        let enable = || {
            calls.set(calls.get() + 1);
            Ok(())
        };

        tick_autostart_protocol(dir.path(), now(), || Ok(true), enable, || Ok(())).expect("tick");
        tick_autostart_protocol(dir.path(), now(), || Ok(true), enable, || Ok(())).expect("tick");

        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn concurrent_commands_are_applied_in_created_order() {
        let dir = tempdir().expect("tempdir");
        let enabled = Cell::new(false);
        let second = "ast_BBBBBBBBBBBBBBBBBBBBBB";
        let created = now();
        // The later command has the lexically smaller id, so directory order
        // alone would apply it first.
        write_server_command(dir.path(), second, false, created);
        write_server_command(
            dir.path(),
            "ast_zzzzzzzzzzzzzzzzzzzzzz",
            true,
            created - chrono::Duration::milliseconds(1),
        );

        tick_autostart_protocol(
            dir.path(),
            now(),
            || Ok(enabled.get()),
            || {
                enabled.set(true);
                Ok(())
            },
            || {
                enabled.set(false);
                Ok(())
            },
        )
        .expect("tick");

        assert!(!enabled.get(), "the newest command must win");
        let result = read_json(&dir.path().join(format!("autostart-results/{second}.json")));
        assert_eq!(result["desiredEnabled"], false);
        assert_eq!(result["status"], "succeeded");
    }

    #[test]
    fn expired_command_is_removed_without_being_applied() {
        let dir = tempdir().expect("tempdir");
        let calls = Cell::new(0);
        write_server_command(
            dir.path(),
            COMMAND_ID,
            true,
            now() - chrono::Duration::seconds(601),
        );

        tick_autostart_protocol(
            dir.path(),
            now(),
            || Ok(false),
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            || Ok(()),
        )
        .expect("tick");

        assert_eq!(calls.get(), 0);
        assert!(!dir
            .path()
            .join(format!("autostart-commands/{COMMAND_ID}.json"))
            .exists());
        assert!(!dir
            .path()
            .join(format!("autostart-results/{COMMAND_ID}.json"))
            .exists());
    }

    #[test]
    fn close_to_tray_notice_defaults_to_not_shown_when_file_is_missing() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("close_to_tray_notice.json");

        let state = load_close_to_tray_notice_state(&path);

        assert!(
            !state.shown,
            "a missing notice-state file must mean the toast has not been shown yet"
        );
    }

    #[test]
    fn close_to_tray_notice_defaults_to_not_shown_on_a_corrupt_file() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("close_to_tray_notice.json");
        fs::write(&path, "not json").expect("write garbage");

        let state = load_close_to_tray_notice_state(&path);

        assert!(
            !state.shown,
            "an unparsable notice-state file must fail safe to 'not shown', not panic or hide the toast forever"
        );
    }

    #[test]
    fn close_to_tray_notice_round_trips_through_save_and_load() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("close_to_tray_notice.json");

        save_close_to_tray_notice_state(&path, &CloseToTrayNoticeState { shown: true })
            .expect("save should succeed");
        let loaded = load_close_to_tray_notice_state(&path);

        assert!(loaded.shown);
    }

    #[test]
    fn close_to_tray_notice_marking_shown_is_one_time_only() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("close_to_tray_notice.json");

        // First call: file does not exist yet, so this is genuinely the
        // first time -- it should report true (caller should show the
        // toast) and persist shown = true.
        let state = load_close_to_tray_notice_state(&path);
        assert!(!state.shown);
        save_close_to_tray_notice_state(&path, &CloseToTrayNoticeState { shown: true })
            .expect("save should succeed");

        // Second call: already marked shown -- must not report "first
        // time" again.
        let state = load_close_to_tray_notice_state(&path);
        assert!(
            state.shown,
            "state must persist across a save/load cycle so the toast fires only once ever"
        );
    }
}
