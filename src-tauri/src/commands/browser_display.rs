// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Display backends for host-owned connector browsers. A backend decides
// where the browser's windows go: a display it starts before the browser, or
// the owner's own desktop with the windows kept concealed. It says how the
// browser must be launched, may start the browser process itself, and stops
// after the browser. The host selects a backend by the presentation policy's
// `display_backend` and never names a concrete backend at its call sites, so
// platform launch details stay inside the backend.
//
// The Linux backend runs a private Xvfb server. It is reachable only through
// an owner-only Xauthority cookie (never `-ac`) and does not listen on TCP.
// Only the browser's environment receives DISPLAY and XAUTHORITY.
//
// `hidden-native` keeps the browser's windows away from the owner's screen
// with the operating system's own means. On macOS the browser renders on a
// private virtual display (`browser_display_virtual.rs`), and falls back to
// a hidden application when that display cannot be created. On Windows its
// windows stay on the owner's desktop, concealed from launch until the host
// reveals them.

use super::browser_presentation::DisplayBackend;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

/// How the browser must be launched to render on a display.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BrowserDisplayLaunch {
    /// Variables set only in the browser's environment.
    pub env: Vec<(String, String)>,
    /// Variables removed from the browser's environment, so it cannot pick
    /// the owner's display instead.
    pub env_remove: Vec<&'static str>,
    /// Extra browser switches, before the start URL.
    pub args: Vec<String>,
    /// Open every page in the background, so the browser never activates
    /// itself: start with no window, open the first page as a background
    /// window over DevTools, and give clients a relay that opens their
    /// pages in the background too (see `cdp_relay`).
    pub pages_open_in_background: bool,
}

/// A running browser process tree. Tests substitute a fake so lifecycle
/// order can be proven without real processes or `/proc`.
pub(crate) trait BrowserProcess: Send {
    fn id(&self) -> u32;
    fn has_exited(&mut self) -> bool;
    /// Stop the process and its descendants. False when the stop could not
    /// be confirmed.
    fn terminate(&mut self) -> bool;
}

/// A browser started by a display session. The pipes are absent when the
/// operating system, not the host, started the process.
pub(crate) struct SpawnedBrowser {
    pub process: Box<dyn BrowserProcess>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

/// What the owner could see of the browser, as far as the backend observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ObservedVisibility {
    /// The backend cannot observe the owner's desktop.
    Unknown,
    /// The browser renders on a display the owner cannot see.
    IsolatedDisplay,
    /// No browser window was seen on the owner's desktop.
    Concealed,
    /// Windows appeared and were concealed; `shown` counts those seen
    /// before concealment caught them.
    ConcealedAfterShow { shown: u32 },
    /// The host revealed the browser on purpose.
    Revealed,
    /// Concealment failed; the browser is visible on the owner's desktop.
    Visible,
}

impl ObservedVisibility {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::IsolatedDisplay => "isolated-display",
            Self::Concealed => "concealed",
            Self::ConcealedAfterShow { .. } => "concealed-after-show",
            Self::Revealed => "revealed",
            Self::Visible => "visible",
        }
    }
}

/// The decisions of a backend that keeps browser windows on the owner's
/// desktop concealed. Platform code feeds it what it observes; it answers
/// whether to conceal and what to report. Pure, so every platform shares one
/// tested policy.
#[derive(Debug, Default)]
pub(crate) struct ConcealmentTracker {
    revealed: bool,
    /// Windows seen on screen before concealment caught them.
    shown: u32,
    /// Consecutive observations in which concealment did not take effect.
    unconcealed_streak: u32,
    was_visible: bool,
}

/// After this many consecutive observations with a window still on screen,
/// concealment is reported as failed. At the platform watchers' 5 ms period
/// that is about a quarter of a second.
const CONCEALMENT_FAILURE_STREAK: u32 = 50;

impl ConcealmentTracker {
    /// Record one observation of how many browser windows are on screen,
    /// and return whether to conceal them now.
    pub(crate) fn observe(&mut self, visible_windows: u32) -> bool {
        if self.revealed {
            return false;
        }
        let visible = visible_windows > 0;
        if visible && !self.was_visible {
            self.shown += visible_windows;
        }
        self.unconcealed_streak = if visible {
            self.unconcealed_streak.saturating_add(1)
        } else {
            0
        };
        self.was_visible = visible;
        visible
    }

    pub(crate) fn reveal(&mut self) {
        self.revealed = true;
    }

    pub(crate) fn is_revealed(&self) -> bool {
        self.revealed
    }

    pub(crate) fn visibility(&self) -> ObservedVisibility {
        if self.revealed {
            ObservedVisibility::Revealed
        } else if self.unconcealed_streak >= CONCEALMENT_FAILURE_STREAK {
            ObservedVisibility::Visible
        } else if self.shown > 0 {
            ObservedVisibility::ConcealedAfterShow { shown: self.shown }
        } else {
            ObservedVisibility::Concealed
        }
    }
}

/// A browser started as an ordinary child of the host. Its stop covers the
/// whole process tree.
pub(crate) struct ChildBrowser(pub(crate) Child);

impl BrowserProcess for ChildBrowser {
    fn id(&self) -> u32 {
        self.0.id()
    }

    fn has_exited(&mut self) -> bool {
        super::pdpp_browser::browser_child_exited(&mut self.0)
    }

    fn terminate(&mut self) -> bool {
        super::pdpp_browser::terminate_browser(&mut self.0)
    }
}

/// Start `command` as a child of the host with piped output.
pub(crate) fn spawn_child(mut command: Command) -> std::io::Result<SpawnedBrowser> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_retrying_busy_executable(&mut command)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    Ok(SpawnedBrowser {
        process: Box::new(ChildBrowser(child)),
        stdout,
        stderr,
    })
}

/// Spawn, retrying briefly when the executable is "busy". A process forked
/// elsewhere in this app holds inherited descriptors until it execs, so a
/// browser that was just downloaded (or a test's just-written script) can
/// fail with ETXTBSY for a moment after its writer closed it.
pub(crate) fn spawn_retrying_busy_executable(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(unix)]
    let busy = Some(libc::ETXTBSY);
    #[cfg(not(unix))]
    let busy = None;
    let mut attempts = 0;
    loop {
        match command.spawn() {
            Err(error) if busy.is_some() && error.raw_os_error() == busy && attempts < 5 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            result => return result,
        }
    }
}

/// A started display. It must outlive the browser that renders on it.
pub(crate) trait DisplaySession: Send {
    fn browser_launch(&self) -> &BrowserDisplayLaunch;

    /// Start the browser. Backends that must launch it through the
    /// operating system, or watch its windows from the moment it exists,
    /// override this.
    fn spawn(&mut self, command: Command) -> std::io::Result<SpawnedBrowser> {
        spawn_child(command)
    }

    fn observed_visibility(&self) -> ObservedVisibility;

    /// Whether DevTools screencast frames keep flowing while the owner
    /// cannot see the browser. When false, the companion needs `reveal`.
    fn streams_while_concealed(&self) -> bool {
        true
    }

    /// Show the browser on the owner's desktop without taking focus, and
    /// stop concealing it for the rest of the session.
    fn reveal(&mut self) -> Result<(), String> {
        Err("This display cannot be shown on the owner's desktop".into())
    }

    /// Stop the display and remove its files. Idempotent. Returns false when
    /// the stop could not be confirmed; the caller must then keep the session
    /// and retry later rather than forget it.
    fn terminate(&mut self) -> bool;
}

/// Starts displays of one backend.
pub(crate) trait DisplayProvider: Send + Sync {
    fn backend(&self) -> DisplayBackend;
    /// Start a display and prove it accepts an authenticated client before
    /// returning, giving up at `deadline`. Never falls back to another
    /// display, and leaves nothing running when it fails.
    fn start(&self, deadline: Instant) -> Result<Box<dyn DisplaySession>, String>;
}

/// The display providers the host can use, keyed by backend.
#[derive(Clone, Default)]
pub(crate) struct DisplayProviders(Vec<Arc<dyn DisplayProvider>>);

impl DisplayProviders {
    pub(crate) fn with(mut self, provider: Arc<dyn DisplayProvider>) -> Self {
        self.0
            .retain(|existing| existing.backend() != provider.backend());
        self.0.push(provider);
        self
    }

    pub(crate) fn get(&self, backend: DisplayBackend) -> Option<&Arc<dyn DisplayProvider>> {
        self.0.iter().find(|provider| provider.backend() == backend)
    }

    /// The backends whose software is installed, most preferred first.
    /// Installed is not proven startable: a display can still fail to start,
    /// and that launch then fails rather than falling back.
    pub(crate) fn installed_backends(&self) -> Vec<DisplayBackend> {
        self.0.iter().map(|provider| provider.backend()).collect()
    }

    /// The providers whose software is installed on this machine: a private
    /// Xvfb on Linux when the `Xvfb` executable is found, a private virtual
    /// display on macOS, and concealed windows on the owner's desktop on
    /// Windows.
    pub(crate) fn discover(runtime_dir: &std::path::Path) -> Self {
        #[cfg(target_os = "linux")]
        {
            if let Some(provider) = xvfb::XvfbProvider::find(runtime_dir.to_path_buf()) {
                return Self::default().with(Arc::new(provider));
            }
            log::info!(
                "Xvfb is not installed; connector browsers open on the desktop. Install the xvfb package to keep them off-screen."
            );
            Self::default()
        }
        #[cfg(target_os = "macos")]
        {
            let _ = runtime_dir;
            Self::default().with(Arc::new(virtual_display::VirtualDisplayProvider::new(
                Arc::new(macos::MacDisplays),
            )))
        }
        #[cfg(windows)]
        {
            let _ = runtime_dir;
            Self::default().with(Arc::new(windows::HiddenNativeProvider))
        }
    }
}

#[path = "browser_display_virtual.rs"]
pub(crate) mod virtual_display;

#[cfg(target_os = "macos")]
#[path = "browser_display_macos.rs"]
mod macos;

#[cfg(windows)]
#[path = "browser_display_windows.rs"]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) mod xvfb {
    use super::{
        BrowserDisplayLaunch, DisplayBackend, DisplayProvider, DisplaySession, ObservedVisibility,
    };
    use std::fs::{self, File};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    /// Fixed, tested geometry. The browser window fills the screen, so the
    /// companion's frames match what the page lays out.
    pub(crate) const SCREEN_WIDTH: u32 = 1440;
    pub(crate) const SCREEN_HEIGHT: u32 = 900;
    const SCREEN_DEPTH: u32 = 24;
    const DISPLAY_START_TIMEOUT: Duration = Duration::from_secs(5);
    const DISPLAY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
    const COOKIE_NAME: &[u8] = b"MIT-MAGIC-COOKIE-1";
    const FAMILY_LOCAL: u16 = 256;
    const FAMILY_WILD: u16 = 65535;
    const X11_SOCKET_DIR: &str = "/tmp/.X11-unix";
    const LOG_TAIL_BYTES: usize = 2 * 1024;

    pub(crate) struct XvfbProvider {
        binary: PathBuf,
        runtime_dir: PathBuf,
    }

    impl XvfbProvider {
        /// Find `Xvfb` on PATH (or /usr/bin). See
        /// `removing_stale_sessions` for the effect on `runtime_dir`.
        pub(crate) fn find(runtime_dir: PathBuf) -> Option<Self> {
            let binary = find_executable("Xvfb")?;
            Some(Self::removing_stale_sessions(binary, runtime_dir))
        }

        /// Session directories left in `runtime_dir` by an earlier process
        /// are deleted. Their displays exit on their own once their last
        /// client is gone, because each one runs with `-terminate`.
        pub(crate) fn removing_stale_sessions(binary: PathBuf, runtime_dir: PathBuf) -> Self {
            if let Ok(entries) = fs::read_dir(&runtime_dir) {
                for entry in entries.flatten() {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
            Self {
                binary,
                runtime_dir,
            }
        }
    }

    impl DisplayProvider for XvfbProvider {
        fn backend(&self) -> DisplayBackend {
            DisplayBackend::PrivateXvfb
        }

        fn start(&self, deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
            let session = XvfbSession::start(&self.binary, &self.runtime_dir, deadline)?;
            Ok(Box::new(session))
        }
    }

    impl XvfbProvider {
        #[cfg(test)]
        pub(crate) fn start_session(&self) -> Result<XvfbSession, String> {
            XvfbSession::start(
                &self.binary,
                &self.runtime_dir,
                Instant::now() + DISPLAY_START_TIMEOUT,
            )
        }
    }

    pub(crate) struct XvfbSession {
        child: Child,
        dir: PathBuf,
        display: u32,
        /// An authenticated client connection, held for the session. With
        /// `-terminate`, the server exits once its last client is gone; this
        /// connection keeps it up until the browser connects, and closes
        /// with the host process, so a crashed host leaves no display behind
        /// once its browser is gone.
        probe: Option<UnixStream>,
        launch: BrowserDisplayLaunch,
        stopped: bool,
    }

    impl XvfbSession {
        fn start(binary: &Path, runtime_dir: &Path, deadline: Instant) -> Result<Self, String> {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(runtime_dir)
                .map_err(|error| format!("Failed to create the display directory: {error}"))?;
            let dir = runtime_dir.join(uuid::Uuid::new_v4().as_simple().to_string());
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|error| format!("Failed to create the display directory: {error}"))?;
            // An Xvfb that is slow to start is a fault, so the display gets
            // its own bound even when the launch has time to spare.
            let deadline = deadline.min(Instant::now() + DISPLAY_START_TIMEOUT);
            match Self::start_in(binary, dir.clone(), deadline) {
                Ok(session) => Ok(session),
                Err(error) => {
                    let _ = fs::remove_dir_all(&dir);
                    Err(error)
                }
            }
        }

        fn start_in(binary: &Path, dir: PathBuf, deadline: Instant) -> Result<Self, String> {
            let mut cookie = [0_u8; 16];
            getrandom::fill(&mut cookie)
                .map_err(|error| format!("Failed to generate the display cookie: {error}"))?;
            // The server loads every cookie in its file regardless of the
            // display number, which is unknown until it starts.
            let server_auth = dir.join("server.xauth");
            write_private(&server_auth, &xauth_entry(FAMILY_WILD, b"", b"", &cookie))?;
            let log_path = dir.join("xvfb.log");
            let log = File::create(&log_path)
                .map_err(|error| format!("Failed to create the display log: {error}"))?;

            let (read_end, write_end) = pipe()?;
            let write_fd = write_end.as_raw_fd();
            let mut command = Command::new(binary);
            command
                .arg("-displayfd")
                .arg(write_fd.to_string())
                .arg("-auth")
                .arg(&server_auth)
                .args(["-nolisten", "tcp", "-terminate", "-screen", "0"])
                .arg(format!("{SCREEN_WIDTH}x{SCREEN_HEIGHT}x{SCREEN_DEPTH}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .process_group(0);
            // SAFETY: fcntl is async-signal-safe; it only clears close-on-exec
            // on the pipe end Xvfb must inherit for -displayfd.
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(write_fd, libc::F_SETFD, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command
                .spawn()
                .map_err(|error| format!("Failed to start Xvfb: {error}"))?;
            drop(write_end);

            let display = match read_display_number(&read_end, &mut child, deadline) {
                Ok(display) => display,
                Err(error) => {
                    let _ = super::super::pdpp_browser::terminate_browser(&mut child);
                    log_failure_output(&log_path);
                    return Err(error);
                }
            };
            let client_auth = dir.join("client.xauth");
            let display_number = display.to_string();
            let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
                .map(|hostname| hostname.trim().to_string())
                .unwrap_or_default();
            let mut client_entries =
                xauth_entry(FAMILY_WILD, b"", display_number.as_bytes(), &cookie);
            if !hostname.is_empty() {
                client_entries.extend(xauth_entry(
                    FAMILY_LOCAL,
                    hostname.as_bytes(),
                    display_number.as_bytes(),
                    &cookie,
                ));
            }
            let probe = write_private(&client_auth, &client_entries)
                .and_then(|()| probe_display(display, &cookie));
            let probe = match probe {
                Ok(probe) => probe,
                Err(error) => {
                    let _ = super::super::pdpp_browser::terminate_browser(&mut child);
                    log_failure_output(&log_path);
                    return Err(error);
                }
            };
            Ok(Self {
                child,
                display,
                probe: Some(probe),
                launch: BrowserDisplayLaunch {
                    env: vec![
                        ("DISPLAY".into(), format!(":{display}")),
                        ("XAUTHORITY".into(), client_auth.display().to_string()),
                    ],
                    env_remove: vec!["WAYLAND_DISPLAY"],
                    args: vec![
                        "--ozone-platform=x11".into(),
                        "--window-position=0,0".into(),
                        format!("--window-size={SCREEN_WIDTH},{SCREEN_HEIGHT}"),
                    ],
                    pages_open_in_background: false,
                },
                dir,
                stopped: false,
            })
        }

        #[cfg(test)]
        pub(crate) fn display(&self) -> u32 {
            self.display
        }

        #[cfg(test)]
        pub(crate) fn pid(&self) -> u32 {
            self.child.id()
        }

        #[cfg(test)]
        pub(crate) fn dir(&self) -> &Path {
            &self.dir
        }
    }

    impl DisplaySession for XvfbSession {
        fn browser_launch(&self) -> &BrowserDisplayLaunch {
            &self.launch
        }

        fn observed_visibility(&self) -> ObservedVisibility {
            ObservedVisibility::IsolatedDisplay
        }

        fn terminate(&mut self) -> bool {
            if !self.stopped {
                self.probe.take();
                if !super::super::pdpp_browser::terminate_browser(&mut self.child) {
                    return false;
                }
                self.stopped = true;
                log::info!("Stopped private browser display :{}", self.display);
            }
            match fs::remove_dir_all(&self.dir) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => {
                    log::warn!("Failed to remove the private display directory: {error}");
                    false
                }
            }
        }
    }

    impl Drop for XvfbSession {
        fn drop(&mut self) {
            if !self.terminate() {
                log::warn!(
                    "Private browser display :{} did not stop cleanly",
                    self.display
                );
            }
        }
    }

    fn find_executable(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        std::env::split_paths(&path)
            .chain([PathBuf::from("/usr/bin")])
            .map(|dir| dir.join(name))
            .find(|candidate| is_executable(candidate))
    }

    fn is_executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    fn pipe() -> Result<(OwnedFd, OwnedFd), String> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: pipe2 writes two new descriptors into `fds` on success.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(format!(
                "Failed to create the display pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: both descriptors are new and owned by nothing else.
        Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
    }

    /// Wait for Xvfb to write its display number. It does so only once it
    /// accepts connections.
    fn read_display_number(
        read_end: &OwnedFd,
        child: &mut Child,
        deadline: Instant,
    ) -> Result<u32, String> {
        let mut output = Vec::new();
        loop {
            if let Some(end) = output.iter().position(|byte| *byte == b'\n') {
                return std::str::from_utf8(&output[..end])
                    .ok()
                    .and_then(|line| line.trim().parse::<u32>().ok())
                    .ok_or_else(|| "Xvfb reported an invalid display number".to_string());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for Xvfb to start".into());
            }
            let mut poll = libc::pollfd {
                fd: read_end.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let wait_ms = remaining.as_millis().min(100) as libc::c_int;
            // SAFETY: `poll` points at one valid pollfd for the call.
            let ready = unsafe { libc::poll(&mut poll, 1, wait_ms) };
            if ready > 0 {
                let mut buffer = [0_u8; 32];
                // SAFETY: reads into a local buffer from a descriptor we own.
                let read = unsafe {
                    libc::read(
                        read_end.as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if read > 0 {
                    output.extend_from_slice(&buffer[..read as usize]);
                    if output.len() > 64 {
                        return Err("Xvfb reported an invalid display number".into());
                    }
                    continue;
                }
                if read == 0 {
                    return Err("Xvfb exited before reporting its display".into());
                }
            }
            if super::super::pdpp_browser::browser_child_exited(child) {
                return Err("Xvfb exited before reporting its display".into());
            }
        }
    }

    /// Connect to the display with the cookie and require the X server to
    /// accept the connection setup. A server started without access control
    /// would also pass, so `display_refuses_a_client_without_the_cookie`
    /// proves the cookie is required.
    pub(crate) fn probe_display(display: u32, cookie: &[u8]) -> Result<UnixStream, String> {
        let mut stream = UnixStream::connect(format!("{X11_SOCKET_DIR}/X{display}"))
            .map_err(|error| format!("Failed to connect to the private display: {error}"))?;
        stream
            .set_read_timeout(Some(DISPLAY_PROBE_TIMEOUT))
            .and_then(|()| stream.set_write_timeout(Some(DISPLAY_PROBE_TIMEOUT)))
            .map_err(|error| format!("Failed to configure the display probe: {error}"))?;
        stream
            .write_all(&connection_setup(cookie))
            .map_err(|error| format!("Failed to probe the private display: {error}"))?;
        let mut status = [0_u8; 1];
        stream
            .read_exact(&mut status)
            .map_err(|error| format!("The private display did not answer: {error}"))?;
        if status[0] != 1 {
            return Err("The private display refused the authenticated connection".into());
        }
        Ok(stream)
    }

    /// An X11 connection setup request in little-endian byte order.
    pub(crate) fn connection_setup(cookie: &[u8]) -> Vec<u8> {
        let name: &[u8] = if cookie.is_empty() { b"" } else { COOKIE_NAME };
        let mut request = vec![b'l', 0];
        request.extend_from_slice(&11_u16.to_le_bytes());
        request.extend_from_slice(&0_u16.to_le_bytes());
        request.extend_from_slice(&(name.len() as u16).to_le_bytes());
        request.extend_from_slice(&(cookie.len() as u16).to_le_bytes());
        request.extend_from_slice(&[0, 0]);
        for part in [name, cookie] {
            request.extend_from_slice(part);
            request.resize(request.len().div_ceil(4) * 4, 0);
        }
        request
    }

    /// One Xauthority entry: family, address, display number, auth name and
    /// data, each length-prefixed in big-endian order.
    pub(crate) fn xauth_entry(
        family: u16,
        address: &[u8],
        number: &[u8],
        cookie: &[u8],
    ) -> Vec<u8> {
        let mut entry = family.to_be_bytes().to_vec();
        for field in [address, number, COOKIE_NAME, cookie] {
            entry.extend_from_slice(&(field.len() as u16).to_be_bytes());
            entry.extend_from_slice(field);
        }
        entry
    }

    fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("Failed to create the display cookie file: {error}"))?;
        file.write_all(contents)
            .map_err(|error| format!("Failed to write the display cookie file: {error}"))
    }

    fn log_failure_output(path: &Path) {
        let Ok(contents) = fs::read(path) else {
            return;
        };
        let start = contents.len().saturating_sub(LOG_TAIL_BYTES);
        let tail = String::from_utf8_lossy(&contents[start..]);
        if !tail.trim().is_empty() {
            log::warn!("Xvfb output before failure:\n{}", tail.trim());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NamedProvider(DisplayBackend);

    impl DisplayProvider for NamedProvider {
        fn backend(&self) -> DisplayBackend {
            self.0
        }

        fn start(&self, _deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
            Err("not startable".into())
        }
    }

    #[test]
    fn concealment_reports_what_the_owner_could_have_seen() {
        let mut tracker = ConcealmentTracker::default();
        assert!(!tracker.observe(0));
        assert_eq!(tracker.visibility(), ObservedVisibility::Concealed);

        // A window appears, is concealed, and stays hidden: one flash.
        assert!(tracker.observe(1));
        assert!(!tracker.observe(0));
        assert_eq!(
            tracker.visibility(),
            ObservedVisibility::ConcealedAfterShow { shown: 1 }
        );
        // One window seen over consecutive observations is still one flash.
        assert!(tracker.observe(1));
        assert!(tracker.observe(1));
        assert!(!tracker.observe(0));
        assert_eq!(
            tracker.visibility(),
            ObservedVisibility::ConcealedAfterShow { shown: 2 }
        );
    }

    #[test]
    fn concealment_that_does_not_take_effect_is_reported_as_visible() {
        let mut tracker = ConcealmentTracker::default();
        for _ in 0..CONCEALMENT_FAILURE_STREAK - 1 {
            assert!(tracker.observe(1));
        }
        assert_ne!(tracker.visibility(), ObservedVisibility::Visible);
        assert!(tracker.observe(1));
        assert_eq!(tracker.visibility(), ObservedVisibility::Visible);
        // Recovers once the window is concealed again.
        assert!(!tracker.observe(0));
        assert_eq!(
            tracker.visibility(),
            ObservedVisibility::ConcealedAfterShow { shown: 1 }
        );
    }

    #[test]
    fn a_revealed_browser_is_never_concealed_again() {
        let mut tracker = ConcealmentTracker::default();
        tracker.reveal();
        assert!(tracker.is_revealed());
        assert!(!tracker.observe(1), "a revealed window stays shown");
        assert_eq!(tracker.visibility(), ObservedVisibility::Revealed);
    }

    #[test]
    fn providers_are_looked_up_by_backend_and_replaced_not_duplicated() {
        let providers = DisplayProviders::default()
            .with(Arc::new(NamedProvider(DisplayBackend::PrivateXvfb)))
            .with(Arc::new(NamedProvider(DisplayBackend::PrivateXvfb)));
        assert_eq!(providers.0.len(), 1);
        assert!(providers.get(DisplayBackend::PrivateXvfb).is_some());
        assert!(providers.get(DisplayBackend::InheritedHost).is_none());
    }

    #[cfg(target_os = "linux")]
    mod xvfb_tests {
        use super::super::xvfb::*;
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        #[test]
        fn xauthority_entries_use_the_xau_wire_format() {
            let entry = xauth_entry(256, b"host", b"7", &[0xAB; 16]);
            let mut expected = vec![0x01, 0x00, 0x00, 0x04];
            expected.extend_from_slice(b"host");
            expected.extend_from_slice(&[0x00, 0x01, b'7', 0x00, 18]);
            expected.extend_from_slice(b"MIT-MAGIC-COOKIE-1");
            expected.extend_from_slice(&[0x00, 16]);
            expected.extend_from_slice(&[0xAB; 16]);
            assert_eq!(entry, expected);
        }

        #[test]
        fn connection_setup_pads_the_auth_name_and_data() {
            let request = connection_setup(&[1; 16]);
            assert_eq!(&request[..12], &[b'l', 0, 11, 0, 0, 0, 18, 0, 16, 0, 0, 0]);
            // 12-byte header, 18-byte name padded to 20, 16-byte cookie.
            assert_eq!(request.len(), 12 + 20 + 16);
            assert_eq!(connection_setup(&[]).len(), 12);
        }

        fn fake_xvfb(temp: &tempfile::TempDir, script: &str) -> std::path::PathBuf {
            let path = temp.path().join("Xvfb");
            std::fs::write(&path, format!("#!/bin/bash\n{script}\n")).expect("write fake Xvfb");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("make fake Xvfb executable");
            path
        }

        #[test]
        fn a_display_that_exits_before_reporting_fails_and_leaves_no_files() {
            let temp = tempfile::tempdir().expect("tempdir");
            let runtime = temp.path().join("displays");
            let provider =
                XvfbProvider::removing_stale_sessions(fake_xvfb(&temp, "exit 1"), runtime.clone());
            let error = provider
                .start(std::time::Instant::now() + std::time::Duration::from_secs(5))
                .err()
                .expect("start must fail");
            assert!(error.contains("exited before reporting"), "{error}");
            assert_eq!(std::fs::read_dir(&runtime).expect("runtime dir").count(), 0);
        }

        #[test]
        fn a_display_that_never_reports_times_out_and_is_stopped() {
            let temp = tempfile::tempdir().expect("tempdir");
            let runtime = temp.path().join("displays");
            let pid_file = temp.path().join("pid");
            let provider = XvfbProvider::removing_stale_sessions(
                fake_xvfb(
                    &temp,
                    &format!("echo $$ > {}\nexec sleep 30", pid_file.display()),
                ),
                runtime.clone(),
            );
            let started = std::time::Instant::now();
            let error = provider
                .start(std::time::Instant::now() + std::time::Duration::from_secs(5))
                .err()
                .expect("start must fail");
            assert!(error.contains("Timed out"), "{error}");
            assert!(started.elapsed() < std::time::Duration::from_secs(9));
            let pid = std::fs::read_to_string(&pid_file)
                .expect("pid")
                .trim()
                .to_string();
            assert!(
                !std::path::Path::new("/proc").join(&pid).exists(),
                "the display process must be stopped"
            );
            assert_eq!(std::fs::read_dir(&runtime).expect("runtime dir").count(), 0);
        }

        #[test]
        fn a_display_number_without_a_server_fails_the_health_check() {
            let temp = tempfile::tempdir().expect("tempdir");
            let runtime = temp.path().join("displays");
            // Reports a display number on the -displayfd descriptor ($2) but
            // never serves it.
            let provider = XvfbProvider::removing_stale_sessions(
                fake_xvfb(&temp, "echo 65000 >&\"$2\"\nexec sleep 30"),
                runtime.clone(),
            );
            let error = provider
                .start(std::time::Instant::now() + std::time::Duration::from_secs(5))
                .err()
                .expect("start must fail");
            assert!(error.contains("private display"), "{error}");
            assert_eq!(std::fs::read_dir(&runtime).expect("runtime dir").count(), 0);
        }

        #[test]
        fn leftover_session_directories_are_removed_at_discovery() {
            let temp = tempfile::tempdir().expect("tempdir");
            let runtime = temp.path().join("displays");
            std::fs::create_dir_all(runtime.join("stale")).expect("stale dir");
            let _provider =
                XvfbProvider::removing_stale_sessions(temp.path().join("Xvfb"), runtime.clone());
            assert!(!runtime.join("stale").exists());
        }

        fn real_xvfb() -> Option<XvfbProvider> {
            let temp = std::env::temp_dir().join(format!(
                "dataconnect-display-test-{}",
                uuid::Uuid::new_v4().as_simple()
            ));
            ["/usr/bin/Xvfb", "/usr/local/bin/Xvfb"]
                .into_iter()
                .map(std::path::PathBuf::from)
                .find(|path| path.exists())
                .map(|binary| XvfbProvider::removing_stale_sessions(binary, temp))
        }

        /// Runs only where Xvfb is installed (CI installs it for the WebKitGTK
        /// test). Prints a marker so a silent skip is visible.
        #[test]
        fn real_xvfb_requires_the_cookie_and_stops_without_leftovers() {
            let Some(provider) = real_xvfb() else {
                eprintln!("SKIPPED: Xvfb is not installed");
                return;
            };
            let mut session = provider.start_session().expect("start Xvfb");
            let launch = session.browser_launch().clone();
            let (display, pid, dir) = (
                session.display(),
                session.pid(),
                session.dir().to_path_buf(),
            );
            assert!(launch
                .env
                .contains(&("DISPLAY".into(), format!(":{display}"))));
            let xauthority = &launch
                .env
                .iter()
                .find(|(name, _)| name == "XAUTHORITY")
                .expect("XAUTHORITY")
                .1;
            let mode = std::fs::metadata(xauthority)
                .expect("xauthority")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = std::fs::metadata(&dir).expect("dir").permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
            assert!(launch.env_remove.contains(&"WAYLAND_DISPLAY"));
            assert!(launch.args.contains(&"--ozone-platform=x11".to_string()));

            let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).expect("cmdline");
            let args: Vec<&[u8]> = cmdline.split(|byte| *byte == 0).collect();
            assert!(
                !args.contains(&b"-ac".as_slice()),
                "access control must stay on"
            );
            assert!(args.contains(&b"tcp".as_slice()), "TCP must be disabled");

            assert!(
                probe_display(display, &[]).is_err(),
                "a client without the cookie must be refused"
            );
            assert!(
                probe_display(display, &[0; 16]).is_err(),
                "a client with a wrong cookie must be refused"
            );
            assert!(session.terminate());
            assert!(session.terminate(), "terminate is idempotent");
            assert!(!std::path::Path::new("/proc").join(pid.to_string()).exists());
            assert!(!dir.exists());
            println!("REAL XVFB TEST RAN");
        }
    }
}
