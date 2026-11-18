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
//! writes a matching user-level entry and icon so the window finds them,
//! unless an AppImage integrator already installed a launcher for it.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Wayland `app_id` / X11 WM class. Must equal `productName` in `tauri.conf.json`.
pub const APP_ID: &str = "DataConnect";

/// Icon name the desktop entry uses. Equals the binary name, which is the
/// file name Tauri's bundler gives the hicolor icons it installs.
const ICON_NAME: &str = "dataconnect";

/// Menu category for the AppImage entry. Must equal `bundle.category` in
/// `tauri.conf.json`, which fills the packaged desktop file's `Categories`.
const CATEGORY: &str = "Utility";

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
        if c == '%' {
            // `%` starts a field code in `Exec`; `%%` is a literal percent.
            out.push_str("%%");
            continue;
        }
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
         TryExec={try_exec}\n\
         Icon={ICON_NAME}\n\
         StartupWMClass={APP_ID}\n\
         Terminal=false\n\
         Categories={CATEGORY};\n\
         {MANAGED_MARKER}\n",
        exec = quote_exec(appimage_path),
        try_exec = appimage_path
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

/// True when `current_exe` lies inside `appdir` and `appimage` is a regular
/// file. The AppImage runtime sets `APPDIR` to the mount of the running image,
/// but `APPIMAGE` and `APPDIR` are inherited by child processes, so a binary
/// started from a terminal inside another AppImage (for example a .deb
/// install) sees them too. Only a binary that lives under `APPDIR` is the
/// AppImage.
pub fn runs_from_appimage(current_exe: &Path, appdir: &Path, appimage: &Path) -> bool {
    let (Ok(exe), Ok(appdir)) = (current_exe.canonicalize(), appdir.canonicalize()) else {
        return false;
    };
    exe.starts_with(appdir) && appimage.is_file()
}

/// Whether another launcher entry in `apps_dir` already runs `appimage_path`,
/// as AppImageLauncher, Gear Lever and appimaged install them.
fn integrator_entry_exists(apps_dir: &Path, appimage_path: &str, ours: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(apps_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path != ours
            && path.extension().is_some_and(|ext| ext == "desktop")
            && std::fs::read_to_string(&path).is_ok_and(|text| {
                text.lines().any(|line| {
                    (line.starts_with("Exec=") || line.starts_with("TryExec="))
                        && line.contains(appimage_path)
                })
            })
    })
}

/// Install the launcher entry and icon under `data_home` for `appimage_path`.
/// Returns whether an entry was written. Writes only when the entry is absent
/// or ours; an unreadable or unmarked file is foreign and stays. When an
/// integrator already has an entry for this AppImage, writes nothing and
/// removes our own entry.
pub fn integrate_appimage_at(data_home: &Path, appimage_path: &str) -> std::io::Result<bool> {
    let apps = data_home.join("applications");
    let desktop = apps.join(format!("{APP_ID}.desktop"));
    let ours = match std::fs::read_to_string(&desktop) {
        Ok(existing) if existing.contains(MANAGED_MARKER) => true,
        Ok(_) => return Ok(false),
        Err(err) if err.kind() == ErrorKind::NotFound => false,
        Err(_) => return Ok(false),
    };
    if integrator_entry_exists(&apps, appimage_path, &desktop) {
        if ours {
            std::fs::remove_file(&desktop)?;
        }
        return Ok(false);
    }
    let icon = data_home
        .join("icons/hicolor/128x128/apps")
        .join(format!("{ICON_NAME}.png"));
    write_if_changed(&icon, ICON_PNG)?;
    write_if_changed(&desktop, appimage_desktop_entry(appimage_path).as_bytes())?;
    Ok(true)
}

/// The failure from [`integrate_appimage_if_needed`], kept until the log
/// plugin exists: `run()` integrates before Tauri starts, so logging there is
/// lost.
static INTEGRATION_ERROR: OnceLock<String> = OnceLock::new();

/// When running from an AppImage, make the window's `app_id` resolve to an icon.
pub fn integrate_appimage_if_needed() {
    let (Some(appimage), Some(appdir)) = (
        std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()),
        std::env::var_os("APPDIR").filter(|v| !v.is_empty()),
    ) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if !runs_from_appimage(&exe, Path::new(&appdir), Path::new(&appimage)) {
        return;
    }
    let (Some(data_home), Some(appimage)) = (data_home(), appimage.to_str()) else {
        return;
    };
    if let Err(err) = integrate_appimage_at(&data_home, appimage) {
        let _ = INTEGRATION_ERROR.set(err.to_string());
    }
}

/// Log the failure kept by [`integrate_appimage_if_needed`]. Call once the
/// logger is up.
pub fn report_integration_error() {
    if let Some(err) = INTEGRATION_ERROR.get() {
        log::warn!("Could not install the AppImage launcher entry: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPIMAGE: &str = "/a/DataConnect.AppImage";

    fn apps_dir(root: &Path) -> PathBuf {
        let apps = root.join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        apps
    }

    #[test]
    fn entry_matches_the_app_id_and_quotes_the_path() {
        let entry = appimage_desktop_entry("/opt/My Apps/DataConnect.AppImage");
        assert!(entry.contains("StartupWMClass=DataConnect\n"));
        assert!(entry.contains("Exec=\"/opt/My Apps/DataConnect.AppImage\" %u\n"));
        assert!(entry.contains("Icon=dataconnect\n"));
        assert!(entry.contains("Categories=Utility;\n"));
    }

    #[test]
    fn entry_has_try_exec_so_menus_hide_it_after_the_appimage_is_deleted() {
        let entry = appimage_desktop_entry("/opt/My Apps/DataConnect.AppImage");
        assert!(entry.contains("TryExec=/opt/My Apps/DataConnect.AppImage\n"));
    }

    #[test]
    fn percent_is_doubled_in_exec() {
        let entry = appimage_desktop_entry("/opt/100%/DataConnect.AppImage");
        assert!(entry.contains("Exec=\"/opt/100%%/DataConnect.AppImage\" %u\n"));
    }

    #[test]
    fn exec_escapes_quote_dollar_and_backtick_in_a_path_with_a_space() {
        let entry = appimage_desktop_entry("/o p/a\"b$c`d/x.AppImage");
        assert!(entry.contains("Exec=\"/o p/a\\\\\"b\\\\$c\\\\`d/x.AppImage\" %u\n"));
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
        let apps = apps_dir(dir.path());
        std::fs::write(
            apps.join("DataConnect.desktop"),
            "[Desktop Entry]\nExec=other\n",
        )
        .unwrap();
        assert!(!integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        let kept = std::fs::read_to_string(apps.join("DataConnect.desktop")).unwrap();
        assert_eq!(kept, "[Desktop Entry]\nExec=other\n");
    }

    #[test]
    fn integration_never_overwrites_a_non_utf8_file() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = apps_dir(dir.path()).join("DataConnect.desktop");
        std::fs::write(&desktop, [0xff, 0xfe, 0x00]).unwrap();
        assert!(!integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        assert_eq!(std::fs::read(&desktop).unwrap(), vec![0xff, 0xfe, 0x00]);
    }

    #[cfg(unix)]
    #[test]
    fn integration_never_overwrites_an_unreadable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let desktop = apps_dir(dir.path()).join("DataConnect.desktop");
        std::fs::write(&desktop, "[Desktop Entry]\nExec=other\n").unwrap();
        std::fs::set_permissions(&desktop, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads any file, so the file is not unreadable to it.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        assert!(!integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        std::fs::set_permissions(&desktop, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&desktop).unwrap(),
            "[Desktop Entry]\nExec=other\n"
        );
    }

    #[test]
    fn an_integrator_entry_for_the_appimage_means_no_write_and_removes_our_stale_entry() {
        let dir = tempfile::tempdir().unwrap();
        let apps = apps_dir(dir.path());
        assert!(integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        std::fs::write(
            apps.join("appimagekit_abc-DataConnect.desktop"),
            format!("[Desktop Entry]\nExec=\"{APPIMAGE}\" %u\n"),
        )
        .unwrap();
        assert!(!integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        assert!(!apps.join("DataConnect.desktop").exists());
    }

    #[test]
    fn an_integrator_entry_does_not_remove_a_foreign_entry_of_ours_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let apps = apps_dir(dir.path());
        std::fs::write(
            apps.join("DataConnect.desktop"),
            "[Desktop Entry]\nExec=other\n",
        )
        .unwrap();
        std::fs::write(
            apps.join("appimagekit_abc-DataConnect.desktop"),
            format!("[Desktop Entry]\nTryExec={APPIMAGE}\n"),
        )
        .unwrap();
        assert!(!integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
        assert!(apps.join("DataConnect.desktop").exists());
    }

    #[test]
    fn an_entry_for_a_different_appimage_does_not_block_ours() {
        let dir = tempfile::tempdir().unwrap();
        let apps = apps_dir(dir.path());
        std::fs::write(
            apps.join("other.desktop"),
            "[Desktop Entry]\nExec=/z/Other.AppImage\n",
        )
        .unwrap();
        assert!(integrate_appimage_at(dir.path(), APPIMAGE).unwrap());
    }

    #[test]
    fn the_appdir_gate_accepts_only_a_binary_inside_appdir() {
        let dir = tempfile::tempdir().unwrap();
        let appdir = dir.path().join("mount");
        std::fs::create_dir_all(appdir.join("usr/bin")).unwrap();
        let inside = appdir.join("usr/bin/dataconnect");
        std::fs::write(&inside, "").unwrap();
        let outside = dir.path().join("dataconnect");
        std::fs::write(&outside, "").unwrap();
        let image = dir.path().join("DataConnect.AppImage");
        std::fs::write(&image, "").unwrap();

        assert!(runs_from_appimage(&inside, &appdir, &image));
        // A .deb binary that inherited APPDIR and APPIMAGE from another AppImage.
        assert!(!runs_from_appimage(&outside, &appdir, &image));
        // A sibling directory that only shares the APPDIR name prefix.
        let sibling = dir.path().join("mount2");
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling_exe = sibling.join("dataconnect");
        std::fs::write(&sibling_exe, "").unwrap();
        assert!(!runs_from_appimage(&sibling_exe, &appdir, &image));
        // APPIMAGE is missing or not a regular file.
        assert!(!runs_from_appimage(
            &inside,
            &appdir,
            &dir.path().join("gone.AppImage")
        ));
        assert!(!runs_from_appimage(&inside, &appdir, dir.path()));
    }
}
