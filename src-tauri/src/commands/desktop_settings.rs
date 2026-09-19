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

pub(crate) fn load_autostart_state(path: &Path) -> Result<Option<AutostartState>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read autostart state: {error}"))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("Failed to parse autostart state: {error}"))
}

pub(crate) fn save_autostart_state(path: &Path, state: &AutostartState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create autostart state directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize autostart state: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Failed to write autostart state: {error}"))
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

        assert_eq!(loaded, Some(state));
    }

    #[test]
    fn a_missing_state_file_loads_as_none() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("autostart.json");

        let loaded = load_autostart_state(&path).expect("load should succeed");

        assert_eq!(loaded, None);
    }
}
