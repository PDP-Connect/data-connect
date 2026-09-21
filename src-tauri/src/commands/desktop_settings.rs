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
/// This file, `autostart.json`, is the request/ack protocol that lets the
/// reference server (`server/routes/owner-autostart.ts`) ask for a change
/// and this process apply it, modeled on
/// `unified.rs::spawn_remote_access_config_watcher`'s poll-a-shared-file
/// shape. `desiredEnabled` + `requestId` are written by the server; the
/// remaining fields are written by the watcher after it applies a change.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartState {
    pub(crate) desired_enabled: bool,
    pub(crate) request_id: u64,
    pub(crate) applied_request_id: u64,
    pub(crate) enabled: bool,
    pub(crate) error: Option<String>,
}

const AUTOSTART_STATE_FILE: &str = "autostart.json";

/// Resolve the shared state file path, under the SAME directory
/// `remote_access_config_path` uses (see `remote_access.rs`), so this
/// process and the reference server agree on one file, never two.
pub(crate) fn autostart_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(AUTOSTART_STATE_FILE)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

/// What `load_autostart_state` found on disk. Distinguishes a state file
/// that never existed from one that existed but was empty/unparseable --
/// both mean "treat as absent and seed a fresh default", but the watcher
/// tick logs and reacts to them differently. `Missing` needs no repair (the
/// next `save_autostart_state` call will create it as part of normal
/// operation); `Corrupt` means a stale, invalid file is sitting on disk
/// RIGHT NOW and must be overwritten before the next tick, or the same
/// parse failure recurs forever -- see `tick_autostart_watcher`.
pub(crate) enum LoadedAutostartState {
    Present(AutostartState),
    Missing,
    /// The file existed but its content was empty or failed to parse (e.g.
    /// a zero-byte file left by a process killed mid-write). Carries the
    /// underlying error for logging.
    Corrupt(String),
}

/// A zero-byte or otherwise unparseable `autostart.json` is an ordinary,
/// expected artifact of this process being killed mid-write (a crash, a
/// `kill -9`, or a rebuild terminating the dev binary) -- NOT a fatal
/// condition. Treating it as fatal is exactly what produced the reported
/// incident: an infinite "Autostart watcher tick failed: Failed to parse
/// autostart state: EOF while parsing a value at line 1 column 0" loop that
/// never recovered because nothing ever rewrote the file.
///
/// This function itself never fails on a parse error -- it reports
/// `Corrupt` instead, so the caller can fall back to the default state and
/// self-heal the file (see `tick_autostart_watcher` in `unified.rs`). It
/// still returns `Err` for a genuine read failure (e.g. a permissions
/// error), which is a different, real problem that retrying blindly would
/// not fix either.
pub(crate) fn load_autostart_state(path: &Path) -> Result<LoadedAutostartState, String> {
    if !path.exists() {
        return Ok(LoadedAutostartState::Missing);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read autostart state: {error}"))?;
    match serde_json::from_str(&content) {
        Ok(state) => Ok(LoadedAutostartState::Present(state)),
        Err(error) => Ok(LoadedAutostartState::Corrupt(format!(
            "Failed to parse autostart state: {error}"
        ))),
    }
}

pub(crate) fn save_autostart_state(path: &Path, state: &AutostartState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create autostart state directory: {error}"))?;
    }
    crate::atomic_write::write_json_atomically(path, state, "Failed to write autostart state")
}

/// Pure core of the autostart watcher tick: given the OS-independent
/// "is_enabled"/"enable"/"disable" effects as closures, decide what the new
/// state file contents should be. Kept separate from the `AppHandle`-driven
/// polling loop in `unified.rs::spawn_autostart_watcher` so the seed and
/// apply logic can run under a unit test without a real Tauri runtime --
/// mirrors how `remote_access.rs`'s `validate_remote_access_config` is pure
/// and unit-tested while its `AppHandle`-dependent callers are not.
pub(crate) fn apply_autostart_desired_state<F, E, D>(
    current: Option<AutostartState>,
    is_enabled: F,
    mut enable: E,
    mut disable: D,
) -> Result<AutostartState, String>
where
    F: Fn() -> Result<bool, String>,
    E: FnMut() -> Result<(), String>,
    D: FnMut() -> Result<(), String>,
{
    let Some(state) = current else {
        // First ever read: seed from real OS state without ever calling
        // enable()/disable() for a change nobody asked for.
        let enabled = is_enabled()?;
        return Ok(AutostartState {
            applied_request_id: 0,
            desired_enabled: enabled,
            enabled,
            error: None,
            request_id: 0,
        });
    };

    if state.request_id == state.applied_request_id {
        return Ok(state);
    }

    let mutation_error = if state.desired_enabled {
        enable().err()
    } else {
        disable().err()
    };

    // Refresh from a fresh is_enabled() read regardless of whether the
    // mutation itself reported success, so the file always reflects OS
    // truth rather than an assumed outcome.
    let enabled = is_enabled()?;

    Ok(AutostartState {
        applied_request_id: state.request_id,
        desired_enabled: state.desired_enabled,
        enabled,
        error: mutation_error,
        request_id: state.request_id,
    })
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

    #[test]
    fn seeds_from_is_enabled_without_calling_enable_or_disable() {
        let mut enable_calls = 0;
        let mut disable_calls = 0;
        let result = apply_autostart_desired_state(
            None,
            || Ok(true),
            || {
                enable_calls += 1;
                Ok(())
            },
            || {
                disable_calls += 1;
                Ok(())
            },
        )
        .expect("seed should succeed");

        assert_eq!(enable_calls, 0);
        assert_eq!(disable_calls, 0);
        assert_eq!(
            result,
            AutostartState {
                applied_request_id: 0,
                desired_enabled: true,
                enabled: true,
                error: None,
                request_id: 0,
            }
        );
    }

    #[test]
    fn applies_a_pending_request_and_advances_applied_request_id() {
        let current = AutostartState {
            applied_request_id: 0,
            desired_enabled: true,
            enabled: false,
            error: None,
            request_id: 1,
        };
        let mut enable_calls = 0;
        let result = apply_autostart_desired_state(
            Some(current),
            || Ok(true),
            || {
                enable_calls += 1;
                Ok(())
            },
            || panic!("disable() should not be called when desired_enabled is true"),
        )
        .expect("apply should succeed");

        assert_eq!(enable_calls, 1);
        assert_eq!(
            result,
            AutostartState {
                applied_request_id: 1,
                desired_enabled: true,
                enabled: true,
                error: None,
                request_id: 1,
            }
        );
    }

    #[test]
    fn a_failed_mutation_still_refreshes_enabled_from_a_fresh_read_and_records_the_error() {
        let current = AutostartState {
            applied_request_id: 0,
            desired_enabled: true,
            enabled: false,
            error: None,
            request_id: 1,
        };
        let result = apply_autostart_desired_state(
            Some(current),
            || Ok(false),
            || Err("permission denied".to_string()),
            || panic!("disable() should not be called when desired_enabled is true"),
        )
        .expect("apply should succeed even when the mutation itself failed");

        assert_eq!(result.applied_request_id, 1);
        assert_eq!(result.enabled, false);
        assert_eq!(result.error.as_deref(), Some("permission denied"));
    }

    #[test]
    fn a_request_already_applied_is_a_no_op() {
        let current = AutostartState {
            applied_request_id: 2,
            desired_enabled: false,
            enabled: false,
            error: None,
            request_id: 2,
        };
        let result = apply_autostart_desired_state(
            Some(current.clone()),
            || panic!("is_enabled() should not be called for an already-applied request"),
            || panic!("enable() should not be called for an already-applied request"),
            || panic!("disable() should not be called for an already-applied request"),
        )
        .expect("no-op should succeed");

        assert_eq!(result, current);
    }

    #[test]
    fn state_file_round_trips_through_save_and_load() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("autostart.json");
        let state = AutostartState {
            applied_request_id: 3,
            desired_enabled: true,
            enabled: true,
            error: None,
            request_id: 3,
        };

        save_autostart_state(&path, &state).expect("save should succeed");
        let loaded = load_autostart_state(&path).expect("load should succeed");

        match loaded {
            LoadedAutostartState::Present(loaded_state) => assert_eq!(loaded_state, state),
            LoadedAutostartState::Missing => panic!("expected Present, got Missing"),
            LoadedAutostartState::Corrupt(error) => {
                panic!("expected Present, got Corrupt({error})")
            }
        }
    }

    #[test]
    fn a_missing_state_file_loads_as_missing() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("autostart.json");

        let loaded = load_autostart_state(&path).expect("load should succeed");

        assert!(matches!(loaded, LoadedAutostartState::Missing));
    }

    /// Reproduces the reported incident directly: a process killed mid-write
    /// (a crash, `kill -9`, or a rebuild terminating the dev binary) can
    /// leave `autostart.json` truncated to zero bytes. `path.exists()` is
    /// still true, so `load_autostart_state` reads it, and
    /// `serde_json::from_str("")` fails with exactly the error Tim saw on
    /// his machine: "EOF while parsing a value at line 1 column 0".
    ///
    /// Before the fix, this surfaced as `Err(...)` from `load_autostart_state`
    /// itself, which `tick_autostart_watcher` propagated as a hard failure
    /// with no recovery -- the "Autostart watcher tick failed" log line
    /// this whole fix exists to stop repeating forever. After the fix,
    /// `load_autostart_state` never fails on a parse error: it reports
    /// `Corrupt` (carrying the same underlying message, still asserted
    /// below) so the caller can fall back to a default and self-heal the
    /// file, which `tick_autostart_watcher`'s own test coverage in
    /// `unified.rs` verifies end-to-end.
    #[test]
    fn an_empty_state_file_is_reported_as_corrupt_not_a_hard_error() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("autostart.json");
        fs::write(&path, "").expect("write zero-byte file");

        let result = load_autostart_state(&path)
            .expect("a corrupt file must not fail load_autostart_state itself");

        match result {
            LoadedAutostartState::Corrupt(error) => {
                assert!(
                    error.contains("EOF while parsing a value"),
                    "expected the exact serde_json EOF message Tim saw, got: {error}"
                );
            }
            LoadedAutostartState::Missing => {
                panic!("expected Corrupt for a zero-byte file, got Missing")
            }
            LoadedAutostartState::Present(_) => {
                panic!("expected Corrupt for a zero-byte file, got Present")
            }
        }
    }

    /// End-to-end proof of the self-heal: drives the exact sequence
    /// `tick_autostart_watcher` (`unified.rs`) performs against a
    /// zero-byte file -- load (sees Corrupt), fall back to `None` the same
    /// way the watcher does, run it through `apply_autostart_desired_state`
    /// (which seeds a fresh default from `is_enabled()`, same as a
    /// never-before-seen file), then save. Confirms the important part of
    /// the fix that a bare "swallow the error and keep polling" would miss:
    /// the file on disk is NO LONGER corrupt afterward, so the next tick's
    /// `load_autostart_state` reads it as `Present`, not `Corrupt` again.
    /// `tick_autostart_watcher` itself is not unit-tested directly because
    /// it requires a real `AppHandle`; this covers the same pure sequence
    /// its doc comment says it delegates to.
    #[test]
    fn a_corrupt_state_file_self_heals_on_the_next_tick_sequence() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("autostart.json");
        fs::write(&path, "").expect("write zero-byte file");

        let current = match load_autostart_state(&path).expect("load should not hard-fail") {
            LoadedAutostartState::Corrupt(_) => None,
            LoadedAutostartState::Missing => {
                panic!("expected Corrupt for a zero-byte file, got Missing")
            }
            LoadedAutostartState::Present(_) => {
                panic!("expected Corrupt for a zero-byte file, got Present")
            }
        };
        let healed = apply_autostart_desired_state(current, || Ok(false), || Ok(()), || Ok(()))
            .expect("seeding a fresh default should succeed");
        save_autostart_state(&path, &healed).expect("self-heal write should succeed");

        let reloaded = load_autostart_state(&path).expect("reload after self-heal should succeed");
        match reloaded {
            LoadedAutostartState::Present(state) => assert_eq!(state, healed),
            LoadedAutostartState::Missing => panic!("self-heal write did not create the file"),
            LoadedAutostartState::Corrupt(error) => {
                panic!("file is still corrupt after the self-heal write: {error}")
            }
        }
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
