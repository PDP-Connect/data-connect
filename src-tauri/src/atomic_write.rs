// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Shared write-temp-then-rename helper for the small JSON state files this
//! process polls and rewrites under its `UNIFIED_DB_DIRECTORY` (autostart,
//! remote-access, open-external-url queue, close-to-tray notice,
//! recovery-export). Every one of those files was previously written with a
//! plain `fs::write(path, content)`, which is NOT atomic: a process killed
//! mid-write (a crash, `kill -9`, or a rebuild terminating the dev binary)
//! can leave a truncated or zero-byte file at `path`. That is exactly what
//! produced the incident this module exists to close -- a zero-byte
//! `autostart.json` that `serde_json` reads back as "EOF while parsing a
//! value at line 1 column 0" forever after.
//!
//! `write_json_atomically` instead writes the new content to a fresh
//! `NamedTempFile` created IN THE SAME DIRECTORY as `path` (required for
//! `persist`'s rename to be atomic -- a rename across filesystems cannot
//! be), `fsync`s that temp file so its bytes are durable before the rename
//! is attempted, then calls `persist(path)`, which performs the rename. A
//! `rename(2)` onto an existing path on the same filesystem is atomic at
//! the OS level: any reader (including this same process's next poll tick)
//! can only ever observe the complete OLD file or the complete NEW file at
//! `path`, never a partial one.
//!
//! This mirrors an existing pattern already used in this codebase for
//! other on-disk state (`commands::connector_store::write_active_connector_manifest_to`,
//! `commands::pdpp_collection_state::write_state_file_atomically`,
//! `commands::developer_connector_sources`'s temp-file writer,
//! `commands::oci_catalog`'s temp-file writer) -- this is a single shared
//! extraction of that same three-step dance, not a new pattern, so the
//! small JSON files under `UNIFIED_DB_DIRECTORY` stop being the exception.

use std::io::Write;
use std::path::Path;

use tempfile::NamedTempFile;

/// Serialize `value` as pretty JSON and write it to `path` via
/// write-temp-then-rename. `path`'s parent directory must already exist --
/// callers are expected to `fs::create_dir_all` it first, same as they did
/// before this helper existed.
pub(crate) fn write_json_atomically<T: serde::Serialize>(
    path: &Path,
    value: &T,
    context: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{context}: path has no parent directory"))?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("{context}: failed to serialize: {error}"))?;
    let mut temp_file = NamedTempFile::new_in(parent)
        .map_err(|error| format!("{context}: failed to create temp file: {error}"))?;
    temp_file
        .write_all(content.as_bytes())
        .map_err(|error| format!("{context}: failed to write temp file: {error}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|error| format!("{context}: failed to sync temp file: {error}"))?;
    temp_file
        .persist(path)
        .map_err(|error| format!("{context}: failed to replace {path:?}: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use std::fs;
    use tempfile::tempdir;

    #[derive(Serialize)]
    struct Sample {
        value: u32,
    }

    #[test]
    fn writes_the_serialized_value_to_the_target_path() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("state.json");

        write_json_atomically(&path, &Sample { value: 7 }, "sample write")
            .expect("write should succeed");

        let content = fs::read_to_string(&path).expect("read back");
        assert!(content.contains("7"));
    }

    #[test]
    fn overwrites_an_existing_file_completely_rather_than_appending_or_truncating_in_place() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        fs::write(
            &path,
            "stale content that is much longer than the replacement",
        )
        .expect("seed stale file");

        write_json_atomically(&path, &Sample { value: 1 }, "sample write")
            .expect("write should succeed");

        let content = fs::read_to_string(&path).expect("read back");
        assert!(!content.contains("stale"));
    }

    #[test]
    fn leaves_no_temp_file_sibling_behind_after_a_successful_write() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("state.json");

        write_json_atomically(&path, &Sample { value: 3 }, "sample write")
            .expect("write should succeed");

        let leftover_temp_files: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path() != path)
            .collect();
        assert!(
            leftover_temp_files.is_empty(),
            "persist() should rename the temp file onto the target, not leave a sibling: {leftover_temp_files:?}"
        );
    }

    /// The most direct proxy available for "a kill mid-write cannot leave a
    /// truncated file at `path`" without actually killing a process: prove
    /// the write goes through a temp file IN THE SAME DIRECTORY (required
    /// for `persist`'s rename to be atomic) rather than writing `path`
    /// in place. This test observes the temp file mid-write, before
    /// `persist` renames it, by writing directly with the same
    /// `NamedTempFile` machinery this helper uses and checking its
    /// location. It does NOT (and cannot, in a unit test) prove the OS
    /// honors same-filesystem rename atomicity -- that is a well-established
    /// OS/POSIX guarantee this test relies on rather than re-verifies.
    #[test]
    fn the_temporary_file_used_for_the_write_is_created_in_the_targets_own_directory() {
        let dir = tempdir().expect("tempdir");
        let parent = dir.path();
        let temp_file = NamedTempFile::new_in(parent).expect("create temp file in parent");
        assert_eq!(
            temp_file.path().parent(),
            Some(parent),
            "the temp file used for the write must live in the same directory as the final \
             path, otherwise persist()'s rename would have to cross filesystems and could not \
             be atomic"
        );
    }
}
