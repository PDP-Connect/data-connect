// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! Spawning an executable that this process may have just written.
//!
//! `std::fs::write` and `File::create` open files with `O_CLOEXEC`, but that
//! flag closes the descriptor only when a process calls exec. A child that
//! another thread spawns while the file is open gets a copy of the write
//! descriptor and keeps it until its own exec. While any process holds the
//! file open for writing, exec of the file fails with ETXTBSY ("Text file
//! busy"). Renaming the file into place does not help, because the
//! descriptor refers to the same inode. The copy goes away when that child
//! execs or exits, so a short retry clears the error.

use std::io;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

/// How long a spawn is retried while the executable is busy. A writer that
/// stays open longer is not a transient inherited copy, so the error is
/// returned.
pub(crate) const EXECUTABLE_BUSY_RETRY_BUDGET: Duration = Duration::from_secs(2);

/// Spawns `command`, retrying for up to [`EXECUTABLE_BUSY_RETRY_BUDGET`]
/// while exec fails with ETXTBSY (`ExecutableFileBusy`). Every other result
/// is returned at once.
pub(crate) fn spawn_retrying_while_busy(command: &mut Command) -> io::Result<Child> {
    spawn_retrying_while_busy_for(command, EXECUTABLE_BUSY_RETRY_BUDGET)
}

fn spawn_retrying_while_busy_for(command: &mut Command, budget: Duration) -> io::Result<Child> {
    let deadline = Instant::now() + budget;
    let mut delay = Duration::from_millis(5);
    loop {
        match command.spawn() {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                thread::sleep(delay.min(remaining));
                delay = (delay * 2).min(Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reproduces the race deterministically. `holder` stands in for a child
    /// that another thread spawned while the executable was open for
    /// writing: it keeps a write descriptor to the file until the test
    /// releases it.
    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_waits_until_no_process_holds_the_executable_open_for_writing() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Stdio;

        let dir = tempfile::tempdir().expect("tempdir");
        let executable = dir.path().join("downloaded-tool");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("write executable");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&executable)
            .expect("open executable for writing");
        let mut holder = Command::new("sh")
            .args(["-c", "read _"])
            .stdin(Stdio::piped())
            .stdout(writer)
            .spawn()
            .expect("spawn descriptor holder");
        let mut release = holder.stdin.take().expect("holder stdin");

        let busy = Command::new(&executable)
            .status()
            .expect_err("exec must fail while another process can write the file");
        assert_eq!(busy.kind(), io::ErrorKind::ExecutableFileBusy);
        let still_busy = spawn_retrying_while_busy_for(
            &mut Command::new(&executable),
            Duration::from_millis(50),
        )
        .expect_err("the retry must stop at its budget");
        assert_eq!(still_busy.kind(), io::ErrorKind::ExecutableFileBusy);

        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            let _ = release.write_all(b"\n");
        });
        let mut child = spawn_retrying_while_busy(&mut Command::new(&executable))
            .expect("spawn once the holder has exited");
        assert!(child.wait().expect("wait for executable").success());
        releaser.join().expect("releaser thread");
        assert!(holder.wait().expect("wait for holder").success());
    }
}
