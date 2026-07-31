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
}

impl PdppBrowserLease {
    pub fn launch(connector_id: &str, owner_id: &str, run_id: &str) -> Result<Self, String> {
        validate_owner_id(owner_id)?;
        let browser = super::connector::resolve_automation_browser_path().ok_or(
            "No system or downloaded Chromium browser is available for PDPP browser automation",
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
            Err(error) => {
                release_profile_lease(Some(lease_lock));
                return Err(error);
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
        if self.state == PdppBrowserInteractionState::Closed {
            return;
        }
        self.state = PdppBrowserInteractionState::Closing;
        if let Some(mut child) = self.child.take() {
            terminate_browser(&mut child);
        }
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
        self.close();
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
    format!("{:x}", Sha256::digest(value.as_bytes()))
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
) -> Result<(String, Child), String> {
    let deadline = Instant::now() + BROWSER_START_TIMEOUT;
    let active_port = profile_dir.join("DevToolsActivePort");
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "PDPP browser exited before becoming ready: {status}"
            ));
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
    terminate_browser(&mut child);
    Err("Timed out waiting for PDPP browser CDP endpoint".into())
}

fn terminate_browser(child: &mut Child) {
    #[cfg(unix)]
    {
        crate::commands::server::kill_process_group(child.id(), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let deadline = Instant::now() + BROWSER_STOP_WAIT;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    crate::commands::server::kill_process_group(child.id(), libc::SIGKILL);
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const LOCK_HOLDER_ROOT: &str = "PDPP_BROWSER_LOCK_HOLDER_ROOT";

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
}
