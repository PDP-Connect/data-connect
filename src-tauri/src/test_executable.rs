// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! Test fixtures that a test executes after it creates them.
//!
//! Unit tests run on many threads in one process. If a thread holds a file
//! open for writing while another thread spawns a child, the child inherits
//! that descriptor until it calls exec. If the test executes the file in that
//! window, exec fails with ETXTBSY ("Text file busy"). Closing, syncing or
//! renaming the file does not help: the inherited descriptor refers to the
//! same inode. So on Unix the file is written by a `cp` process, which spawns
//! no children, and this process never opens the executable for writing.

use std::fs;
use std::path::Path;

/// Writes `contents` to `path` and makes it executable.
pub(crate) fn write(path: &Path, contents: impl AsRef<[u8]>) {
    // The source is only read, never executed, so a leaked descriptor to it
    // is harmless.
    let source = tempfile::NamedTempFile::new().expect("create executable source");
    fs::write(source.path(), contents).expect("write executable source");
    copy(source.path(), path);
}

/// Copies `source` to `destination` and makes the copy executable.
pub(crate) fn copy(source: &Path, destination: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let status = std::process::Command::new("cp")
            .arg(source)
            .arg(destination)
            .stdin(std::process::Stdio::null())
            .status()
            .expect("run cp");
        assert!(
            status.success(),
            "cp {} {} failed: {status}",
            source.display(),
            destination.display()
        );
        // chmod(2) opens no descriptor.
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))
            .expect("make test executable");
    }
    #[cfg(not(unix))]
    {
        fs::copy(source, destination).expect("copy test executable");
    }
}
