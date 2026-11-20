// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The app-owned data directory is private to the owner.
//!
//! Gozar (remote access) refuses a state path that has a group- or
//! world-writable ancestor. Many Linux setups run with `umask 002`, so the
//! directory Tauri creates for `app_data_dir()` comes out `0775` and Remote
//! access then fails with "Reachability could not complete". The app owns
//! this directory, so it creates it and sets `0700` itself at startup. The
//! owner never runs `chmod`.

use std::io;
use std::path::Path;

/// Create `dir` if needed and make it owner-only (`0700` on Unix). Only the
/// directory itself changes: no ancestors, no contents. A symlink is refused
/// so the chmod can never land on a target the app does not own.
pub(crate) fn ensure_private(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        if std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the app data directory is a symlink",
            ));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Secure the directories the managed host hands to Gozar: the app data
/// directory and the `unified` directory inside it (the host's data
/// directory, whose `reachability` folder is the Gozar state path).
pub(crate) fn ensure_app_state(app_data_dir: &Path) -> io::Result<()> {
    ensure_private(app_data_dir)?;
    ensure_private(&app_data_dir.join(crate::unified::UNIFIED_DB_DIRECTORY))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn creates_a_missing_directory_as_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dev.dataconnect");
        ensure_private(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn secures_the_managed_host_data_directory_too() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("dev.dataconnect");
        let unified = app.join("unified");
        std::fs::create_dir_all(&unified).unwrap();
        for dir in [&app, &unified] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o775)).unwrap();
        }
        ensure_app_state(&app).unwrap();
        assert_eq!(mode(&app), 0o700);
        assert_eq!(mode(&unified), 0o700);
    }

    #[test]
    fn refuses_a_symlinked_directory_and_leaves_its_target_alone() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o775)).unwrap();
        let link = root.path().join("dev.dataconnect");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(ensure_private(&link).is_err());
        assert_eq!(mode(&target), 0o775);
    }

    #[test]
    fn tightens_a_group_writable_directory_without_losing_its_contents() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dev.dataconnect");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o775)).unwrap();
        std::fs::write(dir.join("keep"), b"x").unwrap();
        ensure_private(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert!(dir.join("keep").exists());
    }

    #[test]
    fn mkdirs_start_private_under_permissive_umask() {
        // umask is process-wide; never change the parallel test runner's mask.
        // Only the exact child fixture does so, before touching its temp tree.
        const CHILD: &str = "DATACONNECT_PRIVATE_DIR_UMASK_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let filter = format!(
                "{}::mkdirs_start_private_under_permissive_umask",
                module_path!().split_once("::").unwrap().1
            );
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", "umask 000 && exec \"$@\"", "private-dir-test"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", &filter])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "fixture did not pass: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let root = tempfile::tempdir().unwrap();
        let intermediate = root.path().join("missing-parent");
        let leaf = intermediate.join("new-app-data");
        ensure_private(&leaf).unwrap();
        assert_eq!(mode(&intermediate), 0o700, "the intermediate is never repaired later");
        assert_eq!(mode(&leaf), 0o700);
    }
}
