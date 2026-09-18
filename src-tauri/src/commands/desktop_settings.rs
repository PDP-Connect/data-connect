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

use tauri::AppHandle;
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
