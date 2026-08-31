//! An exclusive, owner-confined browser lease for PDPP Collection Profiles.
//!
//! This deliberately does not expose the legacy Playwright page API. A PDPP
//! artifact receives a loopback CDP endpoint through its supported environment
//! seam and owns its browser automation protocol. Each lease starts a fresh
//! browser process with
//! the durable profile for exactly one `(connector, connection owner)` pair.
//! Closing a lease removes only its process and lock; an explicit reset removes
//! the authenticated profile. This preserves scheduled collection while
//! preventing any profile or live browser from crossing owners.

use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);
const BROWSER_STOP_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PdppBrowserInteractionState {
    Launching,
    Collecting,
    WaitingForUser,
    Closing,
    Closed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdppBrowserBinding {
    pub backend: &'static str,
    pub cdp_http_url: String,
    pub lease_id: String,
    pub profile_key: String,
}

pub struct PdppBrowserLease {
    binding: PdppBrowserBinding,
    profile_dir: PathBuf,
    // Keep the OS lock descriptor alive for the full browser lifetime. A
    // marker file alone can be deleted by another process and cannot recover
    // safely after a crash; an advisory lock is released by the OS when this
    // owner dies, while the durable profile remains untouched.
    lease_lock: Option<File>,
    state: PdppBrowserInteractionState,
    child: Option<Child>,
    termination_failed: bool,
}

impl PdppBrowserLease {
    pub fn launch(
        connector_id: &str,
        owner_id: &str,
        run_id: &str,
        resource_dir: Option<&Path>,
    ) -> Result<Self, String> {
        validate_owner_id(owner_id)?;
        let browser = resolve_pdpp_browser_path(resource_dir).ok_or(
            "No system, downloaded, or bundled Chromium browser is available for PDPP browser automation",
        )?;
        let (profile_dir, lease_lock) =
            acquire_profile_lease(&profile_root()?, connector_id, owner_id)?;
        // A stale port file must never point a new owner lease at an old
        // browser. Authentication data remains in the durable profile.
        let _ = fs::remove_file(profile_dir.join("DevToolsActivePort"));
        let mut command = Command::new(browser);
        command
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .args([
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                release_profile_lease(Some(lease_lock));
                return Err(format!("Failed to launch PDPP browser: {error}"));
            }
        };
        let lease_id = lease_id(connector_id, owner_id, run_id);
        let (endpoint, child) = match wait_for_devtools_endpoint(&profile_dir, child) {
            Ok(ready) => ready,
            Err(failure) => {
                if failure.terminated {
                    release_profile_lease(Some(lease_lock));
                } else {
                    std::mem::forget(lease_lock);
                }
                return Err(failure.message);
            }
        };
        Ok(Self {
            binding: PdppBrowserBinding {
                backend: "neko",
                cdp_http_url: endpoint,
                lease_id,
                profile_key: profile_key(connector_id, owner_id),
            },
            profile_dir,
            lease_lock: Some(lease_lock),
            state: PdppBrowserInteractionState::Collecting,
            child: Some(child),
            termination_failed: false,
        })
    }

    #[cfg(test)]
    fn fixture(
        root: &Path,
        connector_id: &str,
        owner_id: &str,
        run_id: &str,
    ) -> Result<Self, String> {
        validate_owner_id(owner_id)?;
        let (profile_dir, lease_lock) = acquire_profile_lease(root, connector_id, owner_id)?;
        Ok(Self {
            binding: PdppBrowserBinding {
                backend: "neko",
                cdp_http_url: "http://127.0.0.1:9222".into(),
                lease_id: lease_id(connector_id, owner_id, run_id),
                profile_key: profile_key(connector_id, owner_id),
            },
            profile_dir,
            lease_lock: Some(lease_lock),
            state: PdppBrowserInteractionState::Launching,
            child: None,
            termination_failed: false,
        })
    }

    pub fn binding(&self) -> &PdppBrowserBinding {
        &self.binding
    }

    pub fn mark_waiting_for_user(&mut self) {
        if self.state == PdppBrowserInteractionState::Collecting {
            self.state = PdppBrowserInteractionState::WaitingForUser;
        }
    }

    #[cfg(test)]
    fn state(&self) -> PdppBrowserInteractionState {
        self.state.clone()
    }

    #[cfg(test)]
    fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    pub fn close(&mut self) {
        self.close_with_before_release_hook(|_| {});
    }

    fn close_with_before_release_hook<F>(&mut self, before_release: F)
    where
        F: FnOnce(&Path),
    {
        self.close_with_terminator(terminate_browser, before_release);
    }

    fn close_with_terminator<T, F>(&mut self, mut terminate: T, before_release: F)
    where
        T: FnMut(&mut Child) -> bool,
        F: FnOnce(&Path),
    {
        if self.state == PdppBrowserInteractionState::Closed {
            return;
        }
        self.state = PdppBrowserInteractionState::Closing;
        if let Some(mut child) = self.child.take() {
            if !terminate(&mut child) {
                self.child = Some(child);
                self.termination_failed = true;
                return;
            }
        }
        self.termination_failed = false;
        before_release(&self.profile_dir);
        release_profile_lease(self.lease_lock.take());
        self.state = PdppBrowserInteractionState::Closed;
    }

    /// Removes an authenticated PDPP profile only when no browser lease owns
    /// it. Call this from an explicit disconnect/reset action, never from the
    /// normal run lifecycle.
    pub fn reset_profile(connector_id: &str, owner_id: &str) -> Result<(), String> {
        reset_profile_in(&profile_root()?, connector_id, owner_id)
    }

    /// A setup marker is insufficient when its owner profile is gone.
    pub fn profile_exists(connector_id: &str, owner_id: &str) -> Result<bool, String> {
        validate_owner_id(owner_id)?;
        Ok(profile_dir(&profile_root()?, connector_id, owner_id).is_dir())
    }
}

impl Drop for PdppBrowserLease {
    fn drop(&mut self) {
        if self.termination_failed {
            if let Some(lock) = self.lease_lock.take() {
                std::mem::forget(lock);
            }
            return;
        }
        self.close();
        if self.child.is_some() {
            if let Some(lock) = self.lease_lock.take() {
                std::mem::forget(lock);
            }
        }
    }
}

fn validate_owner_id(owner_id: &str) -> Result<(), String> {
    if owner_id.is_empty()
        || owner_id.len() > 128
        || !owner_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err("PDPP browser binding requires an explicit URL-safe connectionId owner".into());
    }
    Ok(())
}

fn profile_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine a home directory for PDPP browser profiles")?;
    Ok(PathBuf::from(home)
        .join(".dataconnect")
        .join("pdpp-browser-leases"))
}

fn resolve_pdpp_browser_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    super::connector::resolve_automation_browser_path(resource_dir)
}

fn profile_dir(root: &Path, connector_id: &str, owner_id: &str) -> PathBuf {
    root.join("profiles")
        .join(stable_segment(connector_id))
        .join(stable_segment(owner_id))
}

fn lock_path(root: &Path, connector_id: &str, owner_id: &str) -> PathBuf {
    root.join("leases")
        .join(stable_segment(connector_id))
        .join(format!("{}.lock", stable_segment(owner_id)))
}

fn acquire_profile_lease(
    root: &Path,
    connector_id: &str,
    owner_id: &str,
) -> Result<(PathBuf, File), String> {
    validate_owner_id(owner_id)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("Failed to create PDPP browser profile root: {error}"))?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Failed to confine PDPP browser profile root: {error}"))?;
    let profile_dir = profile_dir(&canonical_root, connector_id, owner_id);
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Failed to create PDPP browser profile: {error}"))?;
    let canonical_profile = fs::canonicalize(&profile_dir)
        .map_err(|error| format!("Failed to confine PDPP browser profile: {error}"))?;
    if !canonical_profile.starts_with(&canonical_root) {
        return Err("PDPP browser profile escaped its lease root".into());
    }
    let lock_path = lock_path(&canonical_root, connector_id, owner_id);
    let lock_parent = lock_path
        .parent()
        .ok_or("PDPP browser lease lock has no parent")?;
    fs::create_dir_all(lock_parent)
        .map_err(|error| format!("Failed to create PDPP browser lease directory: {error}"))?;
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open PDPP browser lease: {error}"))?;
    match lock_file.try_lock_exclusive() {
        Ok(()) => Ok((canonical_profile, lock_file)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Err(
            "PDPP browser profile is already leased by an active run for this connection".into(),
        ),
        Err(error) => Err(format!("Failed to acquire PDPP browser lease: {error}")),
    }
}

fn release_profile_lease(lock_file: Option<File>) {
    if let Some(lock_file) = lock_file {
        let _ = FileExt::unlock(&lock_file);
        // Do not remove the lock file. Removing an inode while a concurrent
        // waiter still holds it permits a second lock file to be created and
        // would split ownership between two live leases.
    }
}

fn reset_profile_in(root: &Path, connector_id: &str, owner_id: &str) -> Result<(), String> {
    let (profile_dir, lease_lock) = acquire_profile_lease(root, connector_id, owner_id)?;
    let removal = fs::remove_dir_all(&profile_dir)
        .map_err(|error| format!("Failed to reset PDPP browser profile: {error}"));
    release_profile_lease(Some(lease_lock));
    removal
}

fn stable_segment(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn lease_id(connector_id: &str, owner_id: &str, run_id: &str) -> String {
    stable_segment(&format!("{connector_id}:{owner_id}:{run_id}"))
}

fn profile_key(connector_id: &str, owner_id: &str) -> String {
    stable_segment(&format!("{connector_id}:{owner_id}"))
}

fn wait_for_devtools_endpoint(
    profile_dir: &Path,
    mut child: Child,
) -> Result<(String, Child), BrowserLaunchFailure> {
    let deadline = Instant::now() + BROWSER_START_TIMEOUT;
    let active_port = profile_dir.join("DevToolsActivePort");
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(BrowserLaunchFailure {
                message: format!("PDPP browser exited before becoming ready: {status}"),
                terminated: true,
            });
        }
        if let Ok(contents) = fs::read_to_string(&active_port) {
            if let Some(port) = contents
                .lines()
                .next()
                .and_then(|port| port.parse::<u16>().ok())
            {
                return Ok((format!("http://127.0.0.1:{port}"), child));
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(BrowserLaunchFailure {
        message: "Timed out waiting for PDPP browser CDP endpoint".into(),
        terminated: terminate_browser(&mut child),
    })
}

struct BrowserLaunchFailure {
    message: String,
    terminated: bool,
}

fn terminate_browser(child: &mut Child) -> bool {
    #[cfg(unix)]
    {
        let process_group = child.id();
        signal_process_group(process_group, libc::SIGTERM);
        let leader_exited = wait_for_child_exit(child, BROWSER_STOP_WAIT);
        if leader_exited && wait_for_process_group_exit(process_group, BROWSER_STOP_WAIT) {
            return true;
        }
        signal_process_group(process_group, libc::SIGKILL);
        let _ = wait_for_child_exit(child, BROWSER_STOP_WAIT);
        return wait_for_process_group_exit(process_group, BROWSER_STOP_WAIT);
    }

    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        {
            run_windows_taskkill(child.id(), BROWSER_STOP_WAIT);
        }
        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }
        if wait_for_child_exit(child, BROWSER_STOP_WAIT) {
            return true;
        }
        #[cfg(windows)]
        {
            run_windows_taskkill(child.id(), BROWSER_STOP_WAIT);
        }
        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }
        wait_for_child_exit(child, BROWSER_STOP_WAIT)
    }
}

#[cfg(unix)]
fn signal_process_group(process_group: u32, signal: libc::c_int) {
    unsafe {
        libc::kill(-(process_group as i32), signal);
    }
}

#[cfg(unix)]
fn wait_for_process_group_exit(process_group: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_group_exists(process_group) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    !process_group_exists(process_group)
}

#[cfg(unix)]
fn process_group_exists(process_group: u32) -> bool {
    let result = unsafe { libc::kill(-(process_group as i32), 0) };
    if result == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

#[cfg(windows)]
fn run_windows_taskkill(pid: u32, timeout: Duration) {
    let (program, args) = windows_taskkill_command(pid);
    let Ok(mut taskkill) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if taskkill.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = taskkill.kill();
    let _ = wait_for_child_exit(&mut taskkill, Duration::from_millis(200));
}

fn windows_taskkill_command(pid: u32) -> (&'static str, Vec<String>) {
    (
        "taskkill",
        vec!["/PID".into(), pid.to_string(), "/T".into(), "/F".into()],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    const LOCK_HOLDER_ROOT: &str = "PDPP_BROWSER_LOCK_HOLDER_ROOT";
    const LOCK_EXPECT_BLOCKED_ROOT: &str = "PDPP_BROWSER_LOCK_EXPECT_BLOCKED_ROOT";

    struct ReapedTestChild(Child);

    impl Drop for ReapedTestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn holds_a_live_profile_lease_until_killed() {
        let Ok(root) = std::env::var(LOCK_HOLDER_ROOT) else {
            return;
        };
        let root = PathBuf::from(root);
        let _lease = PdppBrowserLease::fixture(&root, "chatgpt-pdpp", "alice", "holder")
            .expect("lock holder must acquire its profile lease");
        fs::write(root.join("lock-holder-ready"), "ready")
            .expect("lock holder must signal readiness");
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn expects_profile_lease_to_be_blocked() {
        let Ok(root) = std::env::var(LOCK_EXPECT_BLOCKED_ROOT) else {
            return;
        };
        let blocked =
            PdppBrowserLease::fixture(Path::new(&root), "chatgpt-pdpp", "alice", "blocked-check");
        assert!(matches!(blocked, Err(error) if error.contains("already leased")));
    }

    #[test]
    fn fixture_leases_persist_per_owner_and_clean_only_ephemeral_state() {
        let root = tempfile::tempdir().unwrap();
        let mut first =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-1").unwrap();
        let profile = first.profile_dir().to_owned();
        assert!(first.profile_dir().starts_with(root.path()));
        first.state = PdppBrowserInteractionState::Collecting;
        first.mark_waiting_for_user();
        assert_eq!(first.state(), PdppBrowserInteractionState::WaitingForUser);
        first.close();
        assert_eq!(first.state(), PdppBrowserInteractionState::Closed);
        assert!(profile.exists());
        let second =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-2").unwrap();
        assert_eq!(second.profile_dir(), profile);
        assert_ne!(second.binding().lease_id, "");
    }

    #[test]
    fn fixture_leases_are_owner_confined_and_exclusive() {
        let root = tempfile::tempdir().unwrap();
        let first =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-1").unwrap();
        let concurrent = PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-2");
        assert!(matches!(concurrent, Err(error) if error.contains("already leased")));
        let second =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "bob", "run-1").unwrap();
        assert_ne!(first.profile_dir(), second.profile_dir());
    }

    #[test]
    fn live_process_lease_cannot_be_stolen_and_recovers_after_owner_is_killed() {
        let root = tempfile::tempdir().unwrap();
        let mut holder = ReapedTestChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "commands::pdpp_browser::tests::holds_a_live_profile_lease_until_killed",
                    "--nocapture",
                ])
                .env(LOCK_HOLDER_ROOT, root.path())
                .spawn()
                .expect("spawn lock holder test process"),
        );
        let ready = root.path().join("lock-holder-ready");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "lock holder did not become ready");

        let blocked = PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-2");
        assert!(matches!(blocked, Err(error) if error.contains("already leased")));

        holder.0.kill().expect("kill lock holder");
        holder.0.wait().expect("reap killed lock holder");

        let recovered = PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-3");
        assert!(
            recovered.is_ok(),
            "OS lock must be released when its owner dies"
        );
    }

    #[test]
    fn reset_deletes_only_an_idle_owner_profile() {
        let root = tempfile::tempdir().unwrap();
        let lease =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-1").unwrap();
        let profile = lease.profile_dir().to_owned();
        assert!(reset_profile_in(root.path(), "chatgpt-pdpp", "alice").is_err());
        drop(lease);
        reset_profile_in(root.path(), "chatgpt-pdpp", "alice").unwrap();
        assert!(!profile.exists());
    }

    #[test]
    fn refuses_implicit_or_unsafe_browser_owners() {
        assert!(validate_owner_id("").is_err());
        assert!(validate_owner_id("../other-owner").is_err());
        assert!(validate_owner_id("account-one").is_ok());
    }

    #[test]
    fn windows_tree_cleanup_targets_only_the_browser_process_tree() {
        let (program, args) = windows_taskkill_command(4242);

        assert_eq!(program, "taskkill");
        assert_eq!(args, ["/PID", "4242", "/T", "/F"]);
    }

    #[cfg(unix)]
    #[test]
    fn close_releases_profile_lock_after_bounded_browser_termination() {
        let root = tempfile::tempdir().unwrap();
        let mut lease =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-1").unwrap();
        lease.state = PdppBrowserInteractionState::Collecting;
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        command.process_group(0);
        lease.child = Some(command.spawn().expect("spawn test browser process"));
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let lock_path = lock_path(&canonical_root, "chatgpt-pdpp", "alice");
        let mut observed_still_locked = false;

        lease.close_with_before_release_hook(|_| {
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .unwrap();
            let error = lock.try_lock_exclusive().unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
            observed_still_locked = true;
        });

        assert!(observed_still_locked);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        lock.try_lock_exclusive()
            .expect("profile lock releases only after close completes");
    }

    #[cfg(unix)]
    #[test]
    fn drop_preserves_profile_lock_when_browser_tree_is_not_reaped() {
        let root = tempfile::tempdir().unwrap();
        let mut lease =
            PdppBrowserLease::fixture(root.path(), "chatgpt-pdpp", "alice", "run-1").unwrap();
        lease.state = PdppBrowserInteractionState::Collecting;
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        command.process_group(0);
        let child = command.spawn().expect("spawn test browser process");
        let process_group = child.id();
        lease.child = Some(child);

        lease.close_with_terminator(|_| false, |_| panic!("lock must not release"));
        drop(lease);

        let blocked = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::pdpp_browser::tests::expects_profile_lease_to_be_blocked",
                "--nocapture",
            ])
            .env(LOCK_EXPECT_BLOCKED_ROOT, root.path())
            .status()
            .expect("spawn blocked lock oracle");
        assert!(blocked.success());
        crate::commands::server::kill_process_group(process_group, libc::SIGKILL);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_browser_waits_for_descendant_process_group_exit() {
        let mut command = Command::new("sh");
        command.args(["-c", "trap '' TERM; (trap '' TERM; sleep 30) & exit 0"]);
        command.process_group(0);
        let mut child = command.spawn().expect("spawn test browser process tree");
        let process_group = child.id();

        assert!(terminate_browser(&mut child));
        assert!(!process_group_exists(process_group));
    }
}
