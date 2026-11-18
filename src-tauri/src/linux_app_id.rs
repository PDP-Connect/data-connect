// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The Wayland `app_id` of every window, and the launcher entry that matches it.
//!
//! Wayland compositors (KDE Plasma, GNOME) find a window's icon by looking up
//! an installed `.desktop` file whose id equals the window's `app_id`. GTK3
//! sends the program name as the `app_id`, and by default that is the binary
//! name (`dataconnect`). Tauri's bundler names the packaged desktop file after
//! `productName` (`DataConnect.desktop`), so the two never matched and KDE
//! showed its generic "W" icon.
//!
//! The program name is therefore set to [`APP_ID`], which must equal
//! `productName` in `tauri.conf.json`. `src-tauri/linux-app-id.test.ts` checks
//! that, and that the desktop template's `StartupWMClass` follows.
//!
//! An AppImage installs no `.desktop` file. When the app runs from one, it
//! writes a matching user-level entry and icon so the window finds them.

use std::path::{Path, PathBuf};

/// Wayland `app_id` / X11 WM class. Must equal `productName` in `tauri.conf.json`.
pub const APP_ID: &str = "DataConnect";

/// Icon name the desktop entry uses. Equals the binary name, which is the
/// file name Tauri's bundler gives the hicolor icons it installs.
const ICON_NAME: &str = "dataconnect";

/// Marks an entry this module wrote, so it never overwrites one it does not own.
const MANAGED_MARKER: &str = "X-DataConnect-AppImageIntegration=true";

const ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

/// Set the GTK program name. Call before GTK or Tauri starts.
pub fn set_program_name() {
    gtk::glib::set_prgname(Some(APP_ID));
}

/// Quote a path for the `Exec` key of a desktop entry.
fn quote_exec(path: &str) -> String {
    let mut out = String::from("\"");
    for c in path.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            // One backslash for the Exec quoting rule, doubled for the
            // desktop-entry string escape.
            out.push_str("\\\\");
            if c == '\\' {
                out.push_str("\\\\");
                continue;
            }
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Desktop entry for an AppImage at `appimage_path`.
pub fn appimage_desktop_entry(appimage_path: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={APP_ID}\n\
         Comment=DataConnect - Export your data from various platforms\n\
         Exec={exec} %u\n\
         Icon={ICON_NAME}\n\
         StartupWMClass={APP_ID}\n\
         Terminal=false\n\
         Categories=\n\
         {MANAGED_MARKER}\n",
        exec = quote_exec(appimage_path)
    )
}

fn data_home() -> Option<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(|h| PathBuf::from(h).join(".local/share")),
    }
}

fn write_if_changed(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if std::fs::read(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
}

/// Install the launcher entry and icon under `data_home` for `appimage_path`.
/// Leaves an existing entry alone unless this module wrote it.
pub fn integrate_appimage_at(data_home: &Path, appimage_path: &str) -> std::io::Result<bool> {
    let desktop = data_home.join("applications").join(format!("{APP_ID}.desktop"));
    if let Ok(existing) = std::fs::read_to_string(&desktop) {
        if !existing.contains(MANAGED_MARKER) {
            return Ok(false);
        }
    }
    let icon = data_home
        .join("icons/hicolor/128x128/apps")
        .join(format!("{ICON_NAME}.png"));
    write_if_changed(&icon, ICON_PNG)?;
    write_if_changed(&desktop, appimage_desktop_entry(appimage_path).as_bytes())?;
    Ok(true)
}

/// When running from an AppImage, make the window's `app_id` resolve to an icon.
pub fn integrate_appimage_if_needed() {
    let Some(appimage) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) else {
        return;
    };
    let (Some(data_home), Some(appimage)) = (data_home(), appimage.to_str()) else {
        return;
    };
    if let Err(err) = integrate_appimage_at(&data_home, appimage) {
        log::warn!("Could not install the AppImage launcher entry: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_matches_the_app_id_and_quotes_the_path() {
        let entry = appimage_desktop_entry("/opt/My Apps/DataConnect.AppImage");
        assert!(entry.contains("StartupWMClass=DataConnect\n"));
        assert!(entry.contains("Exec=\"/opt/My Apps/DataConnect.AppImage\" %u\n"));
        assert!(entry.contains("Icon=dataconnect\n"));
    }

    #[test]
    fn integration_writes_entry_and_icon_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(integrate_appimage_at(dir.path(), "/a/DataConnect.AppImage").unwrap());
        assert!(integrate_appimage_at(dir.path(), "/b/DataConnect.AppImage").unwrap());
        let entry =
            std::fs::read_to_string(dir.path().join("applications/DataConnect.desktop")).unwrap();
        assert!(entry.contains("Exec=\"/b/DataConnect.AppImage\" %u"));
        assert!(dir
            .path()
            .join("icons/hicolor/128x128/apps/dataconnect.png")
            .exists());
    }

    #[test]
    fn integration_never_overwrites_a_foreign_entry() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("DataConnect.desktop"), "[Desktop Entry]\nExec=other\n").unwrap();
        assert!(!integrate_appimage_at(dir.path(), "/a/DataConnect.AppImage").unwrap());
        let kept = std::fs::read_to_string(apps.join("DataConnect.desktop")).unwrap();
        assert_eq!(kept, "[Desktop Entry]\nExec=other\n");
    }
}
