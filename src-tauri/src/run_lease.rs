// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Run leases: an on-disk record of every long-lived child process this app
//! owns, so a later app session can find and reap the ones a dead session
//! left behind.
//!
//! ## Why this exists
//!
//! Measured on a developer machine, 2026-09-20: three reference-implementation
//! sidecars from app sessions that had ended hours earlier (6.8h, 12.0h and
//! 11.2h old) were still running, reparented to init, holding six loopback
//! ports between them. A `next-server` had been up 305646s (3.5 days) still
//! parented to a `MainThread` from a session that no longer existed, and stale
//! consoles served pages from a previous build -- which cost real debugging
//! time chasing behavior that came from code no longer on disk.
//!
//! The app could not clean these up because nothing recorded that they
//! existed. Once the owning process is gone, an in-memory `Child` handle is
//! gone with it, and the child's own identity is no help: a booted Next.js
//! server rewrites its command line to `next-server (v...)`, so matching on
//! argv finds nothing. A lease is the durable record that survives the
//! session that created it.
//!
//! ## The safety property
//!
//! The reaper's one way to cause harm is killing a HEALTHY sidecar belonging
//! to a LIVE session. Everything here is built around making that impossible
//! rather than unlikely:
//!
//! - A lease records `owner_pid` and `owner_boot_id` (the app that created
//!   it). The reaper skips any lease whose owner is still alive -- that is a
//!   live session's child, not an orphan, even though the lease looks
//!   identical otherwise.
//! - A lease records `started_at_ticks`, the child's own `starttime` from
//!   `/proc/<pid>/stat`. A PID that has been recycled by an unrelated program
//!   will not match, so the reaper cannot kill a stranger that happens to
//!   inherit a dead child's PID.
//! - Anything that does not match exactly is left alone. The reaper's failure
//!   mode is deliberately "miss an orphan", never "kill a live process".
//!
//! These checks are independent of `PR_SET_PDEATHSIG` (which lane
//! winclose-0920 is adding separately). With PDEATHSIG in place most orphans
//! stop being created; the reaper still has to clean up the ones created
//! before it shipped, and the cases PDEATHSIG cannot cover (a child that
//! re-parents itself, or a kernel without it). Neither mechanism assumes the
//! other.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Directory under the app-data dir holding one JSON file per live child.
pub(crate) const RUN_LEASE_DIRECTORY: &str = "run";

/// A durable record of one long-lived child process this app owns.
///
/// Written at spawn, removed at reap. Anything still on disk at the next
/// startup describes a process this app started and did not stop -- either
/// because it is still running under a live session, or because the session
/// that owned it died without cleaning up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RunLease {
    /// Stable name for the role, e.g. `reference-implementation`, `console`,
    /// `cloudflared`. One live lease per label.
    pub label: String,
    /// The child's PID.
    pub pid: i32,
    /// The child's process-group id, when it was spawned into its own group.
    /// Killing the group reaches grandchildren (a Node server's workers);
    /// killing only `pid` leaves them behind.
    pub pgid: Option<i32>,
    /// The child's `starttime` from `/proc/<pid>/stat`, which distinguishes
    /// this process from a later, unrelated one that reuses its PID.
    pub started_at_ticks: u64,
    /// PID of the app process that created this lease.
    pub owner_pid: i32,
    /// `starttime` of the owning app process, so a recycled owner PID cannot
    /// make a dead session's lease look live.
    pub owner_started_at_ticks: u64,
    /// The loopback port the child was given, when it has one. Recorded for
    /// diagnosis: the reaper never kills by port.
    pub port: Option<u16>,
}

/// Why the reaper did or did not act on a lease. Returned rather than logged
/// only, so the decision is testable and visible from outside the process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReapDecision {
    /// The owning app session is still running: this is a live session's
    /// child. Never touched.
    SkippedOwnerAlive,
    /// The lease does not contain enough owner identity to establish that
    /// its owner is dead. Never touched.
    SkippedOwnerIdentityUnknown,
    /// The process in the lease is gone; only the file needed removing.
    RemovedStaleFile,
    /// The PID is alive but is not the process the lease describes (its
    /// `starttime` differs), so the PID was recycled. Never touched.
    SkippedPidRecycled,
    /// An orphan from a dead session: killed, lease removed.
    Reaped { pid: i32, pgid: Option<i32> },
    /// The lease file could not be parsed. Removed, nothing killed.
    RemovedUnreadable,
}

/// Read a process's `starttime` (field 22 of `/proc/<pid>/stat`).
///
/// Parsing starts after the LAST `)` rather than splitting on whitespace,
/// because field 2 is the executable name in parentheses and may itself
/// contain spaces and parentheses. Verified 2026-09-21: for a binary named
/// `we ) ird (x`, naive whitespace splitting yields `5` where the real
/// starttime is `94286837` -- a mismatch that would make the reaper compare
/// garbage and treat a live process as a recycled PID (or the reverse).
///
/// The returned value is only ever compared for equality against another
/// call's result (see `is_same_process`) -- never interpreted numerically,
/// never persisted across platforms, never compared against a value this
/// function did not itself produce. That is what makes it safe for
/// `process_start_ticks`'s per-platform implementations to use different,
/// platform-native identity sources (raw kernel clock ticks here, Unix-epoch
/// seconds on macOS -- see the `target_os = "macos"` implementation below):
/// each platform's lease is always read back by that same platform's build,
/// so the two numbering schemes never meet.
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn process_start_ticks(pid: i32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')? + 1..];
    // After the comm field, field 3 is `state`, so `starttime` (field 22) is
    // the 20th whitespace-separated value here.
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

/// macOS has no `/proc` filesystem. Reads the process's start time (seconds
/// since the Unix epoch, per `sysinfo::Process::start_time`) via `sysinfo`'s
/// `KERN_PROC`/`libproc`-backed process table instead. This crate is scoped
/// to macOS only (see `Cargo.toml`'s `target.'cfg(target_os = "macos")'`
/// section) -- Linux keeps its existing, independently-tested `/proc` parser
/// above, and Windows already had a `#[cfg(not(unix))]` no-op fallback that
/// this function does not touch.
///
/// A freshly-constructed `System` refreshes its whole process list on
/// creation, so this always reads current state -- never a stale snapshot
/// from an earlier call, which would make a just-recycled PID look identical
/// to the process this lease was written for.
#[cfg(target_os = "macos")]
pub(crate) fn process_start_ticks(pid: i32) -> Option<u64> {
    let system = sysinfo::System::new_all();
    let process = system.process(sysinfo::Pid::from_u32(pid.try_into().ok()?))?;
    Some(process.start_time())
}

#[cfg(not(unix))]
pub(crate) fn process_start_ticks(_pid: i32) -> Option<u64> {
    None
}

/// Is `pid` alive AND the same incarnation the lease recorded?
///
/// Both halves matter. Liveness alone would let a recycled PID look like our
/// child; identity alone cannot be checked on a process that is gone.
pub(crate) fn is_same_process(pid: i32, started_at_ticks: u64) -> bool {
    process_start_ticks(pid).is_some_and(|ticks| ticks == started_at_ticks)
}

impl RunLease {
    /// Path of this app's lease directory.
    pub(crate) fn directory(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(RUN_LEASE_DIRECTORY)
    }

    fn path_for(app_data_dir: &Path, label: &str) -> PathBuf {
        Self::directory(app_data_dir).join(format!("{}.json", sanitize_label(label)))
    }

    /// Write this lease, replacing any existing one for the same label.
    ///
    /// Written to a temporary file and renamed, so a reader never observes a
    /// half-written lease: a truncated file would parse as unreadable and the
    /// process it described would be missed.
    pub(crate) fn publish(&self, app_data_dir: &Path) -> Result<(), String> {
        let directory = Self::directory(app_data_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Failed to create the run-lease directory: {error}"))?;
        let path = Self::path_for(app_data_dir, &self.label);
        let temporary = path.with_extension("json.tmp");
        let encoded = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("Failed to encode a run lease: {error}"))?;
        fs::write(&temporary, encoded)
            .map_err(|error| format!("Failed to write a run lease: {error}"))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Failed to publish a run lease: {error}"))
    }

    /// Remove the lease for `label`. Missing is success: the caller's intent
    /// is "no lease should remain", and a reap that already happened or a
    /// never-published lease both satisfy it.
    pub(crate) fn revoke(app_data_dir: &Path, label: &str) -> Result<(), String> {
        let path = Self::path_for(app_data_dir, label);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to revoke a run lease: {error}")),
        }
    }

    /// Every lease file currently on disk, with its path.
    pub(crate) fn load_all(app_data_dir: &Path) -> Vec<(PathBuf, Option<RunLease>)> {
        let directory = Self::directory(app_data_dir);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => return Vec::new(),
        };
        let mut leases = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let parsed = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<RunLease>(&text).ok());
            leases.push((path, parsed));
        }
        leases
    }
}

/// Keep a label usable as a filename. Labels are internal constants today,
/// but a lease path must never escape its directory even if a label later
/// becomes caller-supplied.
fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// Decide what to do with one lease, without doing it.
///
/// Split from the killing so the decision can be tested exhaustively against
/// real processes without a test ever having to kill something to prove the
/// rule. `self_pid` is the current app's PID, which is never treated as a
/// dead owner.
pub(crate) fn decide(lease: &RunLease, self_pid: i32) -> ReapDecision {
    // 1. Is the owning session still alive? A live owner means this is its
    //    child, running exactly as intended. This check comes first because
    //    it is the one that prevents the only harmful outcome.
    // The current process is definitively live, even when its starttime was
    // unavailable when the lease was written. This also makes self_pid a
    // meaningful safety input rather than a special case that skips the
    // owner check.
    if lease.owner_pid == self_pid {
        return ReapDecision::SkippedOwnerAlive;
    }

    // A zero owner starttime is the persisted fallback used when some other
    // owner's identity could not be read. It cannot prove that the owner is
    // dead, so the conservative action is to leave the child and lease alone.
    if lease.owner_started_at_ticks == 0 {
        return ReapDecision::SkippedOwnerIdentityUnknown;
    }
    if is_same_process(lease.owner_pid, lease.owner_started_at_ticks) {
        return ReapDecision::SkippedOwnerAlive;
    }

    // 2. The owner is gone. Is the child itself still there?
    let Some(actual_ticks) = process_start_ticks(lease.pid) else {
        // A process group can outlive its leader. On Unix the group id remains
        // reserved while any member exists, so probing the recorded group is
        // sufficient to reap descendants without targeting a recycled group.
        #[cfg(unix)]
        if lease.pgid.is_some_and(process_group_exists) {
            return ReapDecision::Reaped {
                pid: lease.pid,
                pgid: lease.pgid,
            };
        }
        return ReapDecision::RemovedStaleFile;
    };

    // 3. The PID is alive -- but is it still OUR child, or a stranger that
    //    inherited the number after our child exited?
    if actual_ticks != lease.started_at_ticks {
        return ReapDecision::SkippedPidRecycled;
    }

    ReapDecision::Reaped {
        pid: lease.pid,
        pgid: lease.pgid,
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: i32) -> bool {
    pgid > 0 && unsafe { libc::kill(-pgid, 0) == 0 }
}

/// Reap orphans left by dead app sessions.
///
/// Called once at startup, before any sidecar is spawned, so a reclaimed port
/// is free by the time the new stack asks for one. Returns each lease's
/// decision for logging and for tests.
pub(crate) fn reap_orphans(app_data_dir: &Path, self_pid: i32) -> Vec<(String, ReapDecision)> {
    let mut decisions = Vec::new();
    for (path, parsed) in RunLease::load_all(app_data_dir) {
        let label = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("unknown")
            .to_string();
        decisions.push((label, act_on_lease(&path, parsed, self_pid)));
    }
    decisions
}

/// Reap the orphan recorded under one label, leaving every other lease alone.
///
/// For a caller that owns a single role and must not act on the others'
/// leases. `None` means no lease exists for `label`: nothing is recorded, so
/// nothing is provably ours to reap.
pub(crate) fn reap_orphan_with_label(
    app_data_dir: &Path,
    label: &str,
    self_pid: i32,
) -> Option<ReapDecision> {
    let path = RunLease::path_for(app_data_dir, label);
    if !path.is_file() {
        return None;
    }
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<RunLease>(&text).ok());
    Some(act_on_lease(&path, parsed, self_pid))
}

/// Carry out `decide` for one lease file: kill only on `Reaped`, and remove
/// the file whenever it no longer describes a process worth tracking.
fn act_on_lease(path: &Path, parsed: Option<RunLease>, self_pid: i32) -> ReapDecision {
    let Some(lease) = parsed else {
        let _ = fs::remove_file(path);
        return ReapDecision::RemovedUnreadable;
    };

    let decision = decide(&lease, self_pid);
    match &decision {
        ReapDecision::Reaped { pid, pgid } => {
            log::warn!(
                "Reaping orphaned '{}' (pid {}) left by app session {}; it was holding {}",
                lease.label,
                pid,
                lease.owner_pid,
                lease
                    .port
                    .map(|port| format!("port {port}"))
                    .unwrap_or_else(|| "no recorded port".to_string())
            );
            kill_orphan(*pid, *pgid);
            let _ = fs::remove_file(path);
        }
        ReapDecision::RemovedStaleFile | ReapDecision::RemovedUnreadable => {
            let _ = fs::remove_file(path);
        }
        ReapDecision::SkippedOwnerAlive => {
            log::debug!(
                "Leaving '{}' (pid {}) alone: its app session {} is still running",
                lease.label,
                lease.pid,
                lease.owner_pid
            );
        }
        ReapDecision::SkippedOwnerIdentityUnknown => {
            log::debug!(
                "Leaving '{}' (pid {}) alone: its app session {} has unknown identity",
                lease.label,
                lease.pid,
                lease.owner_pid
            );
        }
        ReapDecision::SkippedPidRecycled => {
            log::warn!(
                "Lease for '{}' points at pid {}, which now belongs to a different \
                 process; leaving it alone and dropping the lease",
                lease.label,
                lease.pid
            );
            let _ = fs::remove_file(path);
        }
    }
    decision
}

/// SIGKILL an orphan, preferring its process group so a Node server's own
/// workers go with it.
///
/// SIGKILL rather than SIGTERM escalation: this process has already outlived
/// the session that could have shut it down gracefully, there is nobody left
/// to save state for, and it is holding a port the app is about to need.
#[cfg(unix)]
fn kill_orphan(pid: i32, pgid: Option<i32>) {
    match pgid {
        Some(pgid) if pgid > 0 => unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        },
        _ => unsafe {
            libc::kill(pid, libc::SIGKILL);
        },
    }
}

#[cfg(not(unix))]
fn kill_orphan(_pid: i32, _pgid: Option<i32>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    struct TestChild(std::process::Child);

    impl std::ops::Deref for TestChild {
        type Target = std::process::Child;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl std::ops::DerefMut for TestChild {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.0
        }
    }

    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn spawn_sleeper() -> TestChild {
        TestChild(
            Command::new("sleep")
                .arg("300")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a test process"),
        )
    }

    fn lease_for(child: &std::process::Child, label: &str, owner_pid: i32) -> RunLease {
        let pid = child.id() as i32;
        RunLease {
            label: label.to_string(),
            pid,
            pgid: None,
            started_at_ticks: process_start_ticks(pid).expect("child starttime"),
            owner_pid,
            owner_started_at_ticks: process_start_ticks(owner_pid).unwrap_or(0),
            port: Some(45999),
        }
    }

    // Cross-checks the Linux /proc parser directly against a from-the-right
    // re-parse of the same file -- genuinely Linux-specific (there is no
    // /proc/<pid>/stat on macOS to re-read), unlike the rest of this test
    // module's safety-property tests below, which all go through
    // process_start_ticks/lease_for and are exercised identically on every
    // platform run_lease.rs supports.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn start_ticks_parses_a_name_containing_spaces_and_parentheses() {
        // Field 2 of /proc/<pid>/stat is `(comm)` and can contain `) `, so a
        // naive whitespace split reads the wrong field. Our own process name
        // is tame, so this asserts the parser agrees with a from-the-right
        // parse rather than a from-the-left one.
        let pid = std::process::id() as i32;
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).expect("read stat");
        let expected: u64 = stat[stat.rfind(')').unwrap() + 1..]
            .split_whitespace()
            .nth(19)
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(process_start_ticks(pid), Some(expected));
    }

    /// macOS equivalent of the Linux cross-check above: reads this test
    /// process's own start time twice through the same sysinfo-backed
    /// process_start_ticks call and confirms it's a stable, non-zero
    /// identity value -- there is no independent second source to compare
    /// against the way /proc/<pid>/stat is on Linux (sysinfo already IS the
    /// implementation, not a wrapper over something else this test could
    /// re-parse by hand), so this proves stability and non-triviality
    /// rather than agreement with a second parser.
    #[cfg(target_os = "macos")]
    #[test]
    fn start_ticks_is_stable_and_present_for_the_current_process() {
        let pid = std::process::id() as i32;
        let first = process_start_ticks(pid);
        let second = process_start_ticks(pid);
        assert!(first.is_some(), "a live process must report a start time");
        assert_eq!(
            first, second,
            "the same live process must report the same start time on repeated reads"
        );
    }

    #[test]
    fn a_live_sessions_child_is_never_reaped() {
        // THE safety property. The owner is this very test process, which is
        // alive, so its child must be left running even though the lease
        // looks identical to an orphan's in every other respect.
        let directory = tempdir().expect("temp app data");
        let mut child = spawn_sleeper();
        let self_pid = std::process::id() as i32;
        let lease = lease_for(&child, "console", self_pid);
        lease.publish(directory.path()).expect("publish");

        // A DIFFERENT app pid runs the reaper, so the "owner is me" shortcut
        // cannot be what saves the child -- only the owner-is-alive check.
        let decisions = reap_orphans(directory.path(), self_pid + 1);

        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].1, ReapDecision::SkippedOwnerAlive);
        assert!(
            is_same_process(child.id() as i32, lease.started_at_ticks),
            "a live session's child must survive a reaper pass"
        );
        assert!(
            RunLease::directory(directory.path())
                .join("console.json")
                .exists(),
            "a live child's lease must be left in place"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn the_current_live_owner_is_never_reaped() {
        // The old self_pid exclusion classified a live owner's child as orphaned.
        let child = spawn_sleeper();
        let self_pid = std::process::id() as i32;
        let mut lease = lease_for(&child, "console", self_pid);
        assert_ne!(lease.owner_started_at_ticks, 0);
        assert_eq!(decide(&lease, self_pid), ReapDecision::SkippedOwnerAlive);

        lease.owner_started_at_ticks = 0;
        assert_eq!(decide(&lease, self_pid), ReapDecision::SkippedOwnerAlive);
    }

    #[test]
    fn an_unknown_owner_identity_is_never_reaped() {
        // Production records zero when it cannot read the owner's starttime.
        let child = spawn_sleeper();
        let mut lease = lease_for(&child, "console", 1);
        lease.owner_started_at_ticks = 0;

        let decision = decide(&lease, std::process::id() as i32);

        assert_eq!(decision, ReapDecision::SkippedOwnerIdentityUnknown);
    }

    /// Composition with #205's immutable staging generations.
    ///
    /// After a restage the previous generation directory still exists on
    /// disk with a live server inside it, which is exactly what that change
    /// is for. A superseded generation must not therefore start reading as
    /// an orphan. It cannot: the reaper never inspects a build directory,
    /// a cwd, or `reference-stack` at all -- it decides purely on pid,
    /// `/proc` starttime and owner liveness. This pins that, so a future
    /// change cannot quietly add a directory-based heuristic that would
    /// kill a healthy sidecar running from an older generation.
    #[test]
    fn a_process_in_a_superseded_generation_is_not_an_orphan() {
        let directory = tempdir().expect("temp app data");
        let generations = directory.path().join("reference-stack");
        let superseded = generations.join("console-oldgen");
        fs::create_dir_all(&superseded).expect("superseded generation");
        fs::create_dir_all(generations.join("console-newgen")).expect("current generation");

        let mut child = TestChild(
            Command::new("sleep")
                .arg("300")
                .current_dir(&superseded)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a process inside the superseded generation"),
        );

        let self_pid = std::process::id() as i32;
        let lease = lease_for(&child, "console", self_pid);
        lease.publish(directory.path()).expect("publish");

        // A different app pid runs the reaper, so only the owner-alive check
        // can save this child -- not the "owner is me" shortcut.
        let decisions = reap_orphans(directory.path(), self_pid + 1);
        assert_eq!(decisions[0].1, ReapDecision::SkippedOwnerAlive);
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "a live sidecar running from a superseded generation must survive"
        );
        assert!(
            superseded.exists(),
            "the reaper must not delete build directories; that is the staging pruner's job"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn an_orphan_from_a_dead_session_is_reaped() {
        let directory = tempdir().expect("temp app data");
        let mut child = spawn_sleeper();
        let pid = child.id() as i32;

        // Owner pid 1 is init, whose starttime is not what we record here, so
        // the owner reads as dead -- the same shape as a lease left behind by
        // an app session that has exited.
        let mut lease = lease_for(&child, "reference-implementation", 1);
        lease.owner_started_at_ticks = u64::MAX;
        lease.publish(directory.path()).expect("publish");

        let decisions = reap_orphans(directory.path(), std::process::id() as i32);
        assert_eq!(
            decisions[0].1,
            ReapDecision::Reaped { pid, pgid: None },
            "an orphan whose owning session is gone must be reaped"
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            child.try_wait().ok().flatten().is_some(),
            "the orphan process must actually be dead"
        );
        assert!(
            !RunLease::directory(directory.path())
                .join("reference-implementation.json")
                .exists(),
            "a reaped orphan's lease must be removed"
        );
        let _ = child.wait();
    }

    #[test]
    fn a_recycled_pid_is_never_killed() {
        // The lease points at a live process, but records a starttime that
        // does not match it: the PID was reused by something unrelated after
        // our child exited. Killing it would kill a stranger.
        let directory = tempdir().expect("temp app data");
        let mut child = spawn_sleeper();
        let mut lease = lease_for(&child, "console", 1);
        lease.owner_started_at_ticks = u64::MAX;
        lease.started_at_ticks = lease.started_at_ticks.wrapping_add(1);
        lease.publish(directory.path()).expect("publish");

        let decisions = reap_orphans(directory.path(), std::process::id() as i32);
        assert_eq!(decisions[0].1, ReapDecision::SkippedPidRecycled);
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "a process whose starttime does not match the lease must not be killed"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn a_lease_whose_process_is_already_gone_is_just_cleaned_up() {
        let directory = tempdir().expect("temp app data");
        let mut child = spawn_sleeper();
        let mut lease = lease_for(&child, "console", 1);
        // Make the owner read as dead, so this exercises the child-is-gone
        // branch rather than being short-circuited by the owner-alive check
        // (pid 1 is init, which is always running).
        lease.owner_started_at_ticks = u64::MAX;
        lease.publish(directory.path()).expect("publish");
        let _ = child.kill();
        let _ = child.wait();

        let decisions = reap_orphans(directory.path(), std::process::id() as i32);
        assert_eq!(decisions[0].1, ReapDecision::RemovedStaleFile);
        assert!(!RunLease::directory(directory.path())
            .join("console.json")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_surviving_process_group_is_reaped_after_its_leader_exits() {
        use std::os::unix::process::CommandExt;

        let directory = tempdir().expect("temp app data");
        let mut child = TestChild(
            Command::new("sh")
                .args(["-c", "sleep 300 & wait"])
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a process-group leader"),
        );
        let pid = child.id() as i32;
        let pgid = pid;
        let mut lease = lease_for(&child, "console", 1);
        lease.owner_started_at_ticks = u64::MAX;
        lease.pgid = Some(pgid);
        lease.publish(directory.path()).expect("publish lease");

        child.kill().expect("stop group leader");
        child.wait().expect("wait for group leader");
        assert!(process_group_exists(pgid));

        let decisions = reap_orphans(directory.path(), std::process::id() as i32);
        assert_eq!(
            decisions[0].1,
            ReapDecision::Reaped {
                pid,
                pgid: Some(pgid)
            }
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && process_group_exists(pgid) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            !process_group_exists(pgid),
            "the surviving group must be gone"
        );
    }

    #[test]
    fn an_unreadable_lease_is_dropped_without_killing_anything() {
        let directory = tempdir().expect("temp app data");
        fs::create_dir_all(RunLease::directory(directory.path())).expect("mkdir");
        fs::write(
            RunLease::directory(directory.path()).join("console.json"),
            b"{ truncated",
        )
        .expect("write");

        let decisions = reap_orphans(directory.path(), std::process::id() as i32);
        assert_eq!(decisions[0].1, ReapDecision::RemovedUnreadable);
    }

    #[test]
    fn publish_then_revoke_leaves_nothing_for_the_reaper() {
        let directory = tempdir().expect("temp app data");
        let mut child = spawn_sleeper();
        let lease = lease_for(&child, "cloudflared", std::process::id() as i32);
        lease.publish(directory.path()).expect("publish");
        RunLease::revoke(directory.path(), "cloudflared").expect("revoke");

        assert!(RunLease::load_all(directory.path()).is_empty());
        assert!(reap_orphans(directory.path(), std::process::id() as i32).is_empty());
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn revoking_a_missing_lease_succeeds() {
        let directory = tempdir().expect("temp app data");
        RunLease::revoke(directory.path(), "never-published").expect("revoke must be idempotent");
    }

    #[test]
    fn labels_cannot_escape_the_lease_directory() {
        let directory = tempdir().expect("temp app data");
        let lease = RunLease {
            label: "../../escape".to_string(),
            pid: 1,
            pgid: None,
            started_at_ticks: 1,
            owner_pid: 1,
            owner_started_at_ticks: 1,
            port: None,
        };
        lease.publish(directory.path()).expect("publish");
        assert!(
            !directory
                .path()
                .parent()
                .unwrap()
                .join("escape.json")
                .exists(),
            "a label must never write outside the lease directory"
        );
    }
}
