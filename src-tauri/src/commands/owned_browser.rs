// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A browser the host launched, owned together with the display it renders
// on, from startup through readiness to termination. Callers name a display
// backend and a deadline; they never see display sessions, child processes
// or DevTools probing.
//
// One rule governs cleanup on every path, including a failed launch: the
// browser stops before its display, and nothing is forgotten until its stop
// is confirmed. A launch that cannot confirm its own cleanup hands the
// leftovers back to the caller, who keeps them and retries, because a
// half-stopped browser still holds its profile.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::browser_display::{DisplayProviders, DisplaySession};
use super::browser_presentation::DisplayBackend;

/// How long a launch outside the browser surface host (the browser check)
/// waits for DevTools.
pub(crate) const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);
const DEVTOOLS_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// Bytes of browser stderr kept for diagnosing a failed launch.
const STDERR_TAIL_BYTES: usize = 8 * 1024;
/// Chromium prints this when it cannot create its sandbox, for example when
/// AppArmor restricts unprivileged user namespaces (Ubuntu 23.10+).
pub(crate) const NO_USABLE_SANDBOX_SIGNATURE: &str = "No usable sandbox!";
pub(crate) const BROWSER_SANDBOX_UNAVAILABLE: &str = "browser_sandbox_unavailable";
pub(crate) const SURFACE_START_FAILED: &str = "surface_start_failed";
pub(crate) const SURFACE_START_TIMEOUT: &str = "surface_start_timeout";
pub(crate) const BROWSER_DISPLAY_UNAVAILABLE: &str = "browser_display_unavailable";
/// Switches every host browser gets: the companion streams pages that the
/// owner is not looking at, so Chromium must not throttle them.
const BACKGROUND_RENDERING_ARGS: [&str; 3] = [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
];

/// A browser launch failure with a stable, machine-readable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserLaunchError {
    pub code: &'static str,
    pub message: String,
}

impl BrowserLaunchError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn start_failed(message: impl Into<String>) -> Self {
        Self::new(SURFACE_START_FAILED, message)
    }

    fn timed_out(stage: &str) -> Self {
        Self::new(
            SURFACE_START_TIMEOUT,
            format!("The browser launch deadline passed while {stage}"),
        )
    }

    fn sandbox_unavailable() -> Self {
        Self::new(BROWSER_SANDBOX_UNAVAILABLE, sandbox_unavailable_message())
    }

    pub(crate) fn is_sandbox_unavailable(&self) -> bool {
        self.code == BROWSER_SANDBOX_UNAVAILABLE
    }
}

impl From<String> for BrowserLaunchError {
    fn from(message: String) -> Self {
        Self::start_failed(message)
    }
}

impl From<&str> for BrowserLaunchError {
    fn from(message: &str) -> Self {
        Self::start_failed(message)
    }
}

pub(crate) fn sandbox_unavailable_message() -> String {
    "This Linux distribution blocks the sandbox of the browser that DataConnect \
     bundles or downloads. Install Google Chrome or Chromium from a .deb package; \
     DataConnect uses the first of /usr/bin/google-chrome, \
     /usr/bin/google-chrome-stable, /usr/bin/chromium or /usr/bin/chromium-browser."
        .into()
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

struct SpawnedBrowser(Child);

impl BrowserProcess for SpawnedBrowser {
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

/// A launched browser and the display it renders on.
pub(crate) struct OwnedBrowser {
    /// Kept after the process is confirmed stopped, so the browser keeps its
    /// identity while its display is still being stopped.
    pid: Option<u32>,
    process: Option<Box<dyn BrowserProcess>>,
    display: Option<Box<dyn DisplaySession>>,
}

impl OwnedBrowser {
    pub(crate) fn new(
        process: Option<Box<dyn BrowserProcess>>,
        display: Option<Box<dyn DisplaySession>>,
    ) -> Self {
        Self {
            pid: process.as_ref().map(|process| process.id()),
            process,
            display,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_child(child: Child) -> Self {
        Self::new(Some(Box::new(SpawnedBrowser(child))), None)
    }

    /// The browser's process id, which is also its process group on Unix.
    /// None only for leftovers of a launch that failed before spawning.
    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Stop the browser, then its display. Idempotent. False means some
    /// stop is unconfirmed: keep this value and call again later.
    pub(crate) fn terminate(&mut self) -> bool {
        if let Some(process) = self.process.as_mut() {
            if !process.terminate() {
                return false;
            }
            self.process = None;
        }
        if let Some(display) = self.display.as_mut() {
            if !display.terminate() {
                return false;
            }
            self.display = None;
        }
        true
    }
}

/// What to launch. The deadline covers the whole launch: display start,
/// spawn and DevTools readiness.
pub(crate) struct LaunchSpec<'a> {
    pub executable: &'a Path,
    pub profile_dir: &'a Path,
    pub headless: bool,
    pub display_backend: DisplayBackend,
    pub deadline: Instant,
}

/// Facts observed while the browser became ready.
#[derive(Debug, Clone)]
pub(crate) struct Readiness {
    pub cdp_url: String,
    /// The `Browser` product string from `/json/version`, such as
    /// `Chrome/141.0.7390.54`.
    pub browser_version: Option<String>,
    pub display_ready_at: Option<Instant>,
    pub spawned_at: Instant,
    pub cdp_ready_at: Instant,
}

pub(crate) struct LaunchFailure {
    pub error: BrowserLaunchError,
    /// Present when cleanup of the failed launch is unconfirmed. The caller
    /// must keep it and retry `terminate`.
    pub unstopped: Option<OwnedBrowser>,
}

/// Launches browsers on the displays this computer provides.
pub(crate) struct BrowserLauncher {
    displays: DisplayProviders,
}

impl BrowserLauncher {
    pub(crate) fn new(displays: DisplayProviders) -> Self {
        Self { displays }
    }

    pub(crate) fn launch(
        &self,
        spec: &LaunchSpec<'_>,
    ) -> Result<(OwnedBrowser, Readiness), LaunchFailure> {
        // A display failure ends the launch before a browser exists, so the
        // browser can never fall back onto the owner's desktop.
        let display = match spec.display_backend {
            DisplayBackend::InheritedHost => None,
            backend => {
                let provider = self.displays.get(backend).ok_or_else(|| LaunchFailure {
                    error: BrowserLaunchError::new(
                        BROWSER_DISPLAY_UNAVAILABLE,
                        format!(
                            "No {} display backend is available on this computer",
                            backend.as_str()
                        ),
                    ),
                    unstopped: None,
                })?;
                Some(
                    provider
                        .start(spec.deadline)
                        .map_err(|message| LaunchFailure {
                            error: BrowserLaunchError::new(BROWSER_DISPLAY_UNAVAILABLE, message),
                            unstopped: None,
                        })?,
                )
            }
        };
        let display_ready_at = display.as_ref().map(|_| Instant::now());
        let launch = display.as_ref().map(|display| display.browser_launch());
        let mut args = BACKGROUND_RENDERING_ARGS.to_vec();
        if let Some(launch) = launch {
            args.extend(launch.args.iter().map(String::as_str));
        }
        let mut command = super::pdpp_browser::browser_command_with_args(
            spec.executable,
            spec.profile_dir,
            spec.headless,
            &args,
        );
        if let Some(launch) = launch {
            // Only the browser's environment changes; the host and its other
            // children keep the owner's display.
            for name in &launch.env_remove {
                command.env_remove(name);
            }
            command.envs(launch.env.iter().map(|(name, value)| (name, value)));
        }
        let mut owned = OwnedBrowser::new(None, display);
        let ready = spawn_and_wait(command, spec, &mut owned);
        match ready {
            Ok(mut readiness) => {
                readiness.display_ready_at = display_ready_at;
                Ok((owned, readiness))
            }
            Err(mut error) => {
                let unstopped = if owned.terminate() {
                    None
                } else {
                    error.message.push_str("; cleanup is unconfirmed");
                    Some(owned)
                };
                Err(LaunchFailure { error, unstopped })
            }
        }
    }
}

/// Spawn the browser into `owned` and wait for DevTools. On error the caller
/// stops `owned`, which by then holds whatever was started.
fn spawn_and_wait(
    mut command: std::process::Command,
    spec: &LaunchSpec<'_>,
    owned: &mut OwnedBrowser,
) -> Result<Readiness, BrowserLaunchError> {
    if Instant::now() >= spec.deadline {
        return Err(BrowserLaunchError::timed_out("starting the display"));
    }
    let _ = fs::remove_file(spec.profile_dir.join("DevToolsActivePort"));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_retrying_busy_executable(&mut command)
        .map_err(|error| format!("Failed to launch host browser: {error}"))?;
    let spawned_at = Instant::now();
    let pipes = (child.stdout.take(), child.stderr.take());
    *owned = OwnedBrowser::new(Some(Box::new(SpawnedBrowser(child))), owned.display.take());
    let (Some(stdout), Some(stderr)) = pipes else {
        return Err("Host browser output was not piped".into());
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_tail = StderrTail::default();
    let stderr_reader = stderr_tail.clone();
    // Keep draining after readiness so a chatty browser never blocks on a
    // full pipe; only the bounded tail is retained.
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
            stderr_reader.push_line(&String::from_utf8_lossy(&line));
            line.clear();
        }
    });
    let process = owned
        .process
        .as_deref_mut()
        .expect("the spawned browser was just stored");
    let (cdp_url, ready) = wait_for_devtools_endpoint(
        spec.profile_dir,
        process,
        &receiver,
        &stderr_tail,
        spec.deadline,
    )?;
    Ok(Readiness {
        cdp_url,
        browser_version: ready.browser_version,
        display_ready_at: None,
        spawned_at,
        cdp_ready_at: Instant::now(),
    })
}

/// Spawn, retrying briefly when the executable is "busy". A process forked
/// elsewhere in this app holds inherited descriptors until it execs, so a
/// browser that was just downloaded (or a test's just-written script) can
/// fail with ETXTBSY for a moment after its writer closed it.
pub(crate) fn spawn_retrying_busy_executable(
    command: &mut std::process::Command,
) -> std::io::Result<Child> {
    #[cfg(unix)]
    let busy = Some(libc::ETXTBSY);
    #[cfg(not(unix))]
    let busy = None;
    let mut attempts = 0;
    loop {
        match command.spawn() {
            Err(error) if busy.is_some() && error.raw_os_error() == busy && attempts < 5 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(20));
            }
            result => return result,
        }
    }
}

/// The browser announces its DevTools endpoint either on stdout (test
/// browsers) or in `DevToolsActivePort`. Either counts only once the HTTP
/// endpoint answers with a page target.
fn wait_for_devtools_endpoint(
    profile_dir: &Path,
    process: &mut dyn BrowserProcess,
    receiver: &mpsc::Receiver<String>,
    stderr_tail: &StderrTail,
    deadline: Instant,
) -> Result<(String, DevtoolsReady), BrowserLaunchError> {
    let active_port = profile_dir.join("DevToolsActivePort");
    let probe = reqwest::blocking::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| BrowserLaunchError::start_failed(error.to_string()))?;
    loop {
        if process.has_exited() {
            return Err(exited_before_ready(stderr_tail));
        }
        let from_stdout = receiver
            .try_iter()
            .take(1)
            .find_map(|line| cdp_url_from_json(&line));
        let from_port_file = fs::read_to_string(&active_port).ok().and_then(|contents| {
            contents
                .lines()
                .next()
                .and_then(|port| port.trim().parse::<u16>().ok())
                .filter(|port| *port != 0)
                .map(|port| format!("http://127.0.0.1:{port}"))
        });
        for url in [from_stdout, from_port_file].into_iter().flatten() {
            if let Some(ready) = devtools_http_ready(&probe, &url, deadline) {
                // A browser that handed off to an existing instance answers
                // briefly and then exits; that is not a ready browser.
                if process.has_exited() {
                    return Err(exited_before_ready(stderr_tail));
                }
                return Ok((url, ready));
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(BrowserLaunchError::timed_out(
                "waiting for the browser's DevTools endpoint",
            ));
        }
        thread::sleep(Duration::from_millis(25).min(remaining));
    }
}

/// The last `STDERR_TAIL_BYTES` of browser stderr, with URL query strings
/// removed. Chromium stderr can name the pages it loads.
#[derive(Clone, Default)]
struct StderrTail(Arc<Mutex<std::collections::VecDeque<String>>>);

impl StderrTail {
    fn push_line(&self, line: &str) {
        let line = redact_query_strings(line.trim_end());
        let Ok(mut lines) = self.0.lock() else {
            return;
        };
        lines.push_back(line);
        let mut total: usize = lines.iter().map(String::len).sum();
        while total > STDERR_TAIL_BYTES {
            match lines.pop_front() {
                Some(dropped) => total -= dropped.len(),
                None => break,
            }
        }
    }

    fn snapshot(&self) -> String {
        self.0
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

fn redact_query_strings(line: &str) -> String {
    line.split(' ')
        .map(|word| match (word.contains("://"), word.find(['?', '#'])) {
            (true, Some(index)) => format!("{}?<redacted>", &word[..index]),
            _ => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

struct DevtoolsReady {
    browser_version: Option<String>,
}

fn devtools_http_ready(
    client: &reqwest::blocking::Client,
    cdp_url: &str,
    deadline: Instant,
) -> Option<DevtoolsReady> {
    let timeout = devtools_probe_timeout(deadline)?;
    let request = client
        .get(format!("{cdp_url}/json/version"))
        .timeout(timeout);
    if Instant::now() >= deadline {
        return None;
    }
    let Ok(response) = request.send() else {
        return None;
    };
    if !response.status().is_success() {
        return None;
    }
    let Ok(version) = response.json::<serde_json::Value>() else {
        return None;
    };
    let browser_version = version
        .get("Browser")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let has_browser_websocket = version
        .get("webSocketDebuggerUrl")
        .and_then(serde_json::Value::as_str)
        .is_some_and(is_websocket_url);
    if !has_browser_websocket {
        return None;
    }

    let timeout = devtools_probe_timeout(deadline)?;
    let request = client.get(format!("{cdp_url}/json/list")).timeout(timeout);
    if Instant::now() >= deadline {
        return None;
    }
    let Ok(response) = request.send() else {
        return None;
    };
    if !response.status().is_success() {
        return None;
    }
    let Ok(targets) = response.json::<Vec<serde_json::Value>>() else {
        return None;
    };
    targets
        .iter()
        .any(|target| {
            target.get("type").and_then(serde_json::Value::as_str) == Some("page")
                && target
                    .get("webSocketDebuggerUrl")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(is_websocket_url)
        })
        .then_some(DevtoolsReady { browser_version })
}

fn devtools_probe_timeout(deadline: Instant) -> Option<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    (!remaining.is_zero()).then_some(DEVTOOLS_PROBE_TIMEOUT.min(remaining))
}

fn is_websocket_url(url: &str) -> bool {
    url.starts_with("ws://") || url.starts_with("wss://")
}

fn exited_before_ready(stderr_tail: &StderrTail) -> BrowserLaunchError {
    // The stderr reader may still hold the last lines; give it a moment.
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut tail = stderr_tail.snapshot();
    while !tail.contains(NO_USABLE_SANDBOX_SIGNATURE) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
        tail = stderr_tail.snapshot();
    }
    log::warn!("Host browser exited before becoming ready; stderr tail:\n{tail}");
    if tail.contains(NO_USABLE_SANDBOX_SIGNATURE) {
        BrowserLaunchError::sandbox_unavailable()
    } else {
        BrowserLaunchError::start_failed("Host browser exited before becoming ready")
    }
}

fn cdp_url_from_json(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let candidate = value
        .as_str()
        .or_else(|| value.get("cdp_url").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("cdpUrl").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("url").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("endpoint").and_then(serde_json::Value::as_str))?;
    is_http_url(candidate).then(|| candidate.to_string())
}

fn is_http_url(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::commands::browser_display::{BrowserDisplayLaunch, DisplayProvider};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Shared record of lifecycle events, in order.
    #[derive(Clone, Default)]
    pub(crate) struct Events(Arc<Mutex<Vec<String>>>);

    impl Events {
        pub(crate) fn push(&self, event: impl Into<String>) {
            self.0.lock().expect("events").push(event.into());
        }

        pub(crate) fn all(&self) -> Vec<String> {
            self.0.lock().expect("events").clone()
        }
    }

    /// A process whose stop fails `failures` times before it succeeds.
    pub(crate) struct FakeProcess {
        pub events: Events,
        pub failures: Arc<AtomicUsize>,
        pub stopped: bool,
    }

    impl BrowserProcess for FakeProcess {
        fn id(&self) -> u32 {
            4242
        }

        fn has_exited(&mut self) -> bool {
            self.stopped
        }

        fn terminate(&mut self) -> bool {
            if self.failures.load(Ordering::Acquire) > 0 {
                self.failures.fetch_sub(1, Ordering::AcqRel);
                self.events.push("browser-stop-failed");
                return false;
            }
            if !self.stopped {
                self.events.push("browser-stop");
                self.stopped = true;
            }
            true
        }
    }

    /// A display whose stop fails `failures` times before it succeeds.
    pub(crate) struct FakeDisplay {
        pub events: Events,
        pub failures: Arc<AtomicUsize>,
        pub launch: BrowserDisplayLaunch,
        pub stopped: bool,
    }

    impl FakeDisplay {
        pub(crate) fn new(events: Events, failures: usize) -> Self {
            Self {
                events,
                failures: Arc::new(AtomicUsize::new(failures)),
                launch: BrowserDisplayLaunch::default(),
                stopped: false,
            }
        }
    }

    impl DisplaySession for FakeDisplay {
        fn browser_launch(&self) -> &BrowserDisplayLaunch {
            &self.launch
        }

        fn terminate(&mut self) -> bool {
            if self.failures.load(Ordering::Acquire) > 0 {
                self.failures.fetch_sub(1, Ordering::AcqRel);
                self.events.push("display-stop-failed");
                return false;
            }
            if !self.stopped {
                self.events.push("display-stop");
                self.stopped = true;
            }
            true
        }
    }

    fn owned(events: &Events, browser_failures: usize, display_failures: usize) -> OwnedBrowser {
        OwnedBrowser::new(
            Some(Box::new(FakeProcess {
                events: events.clone(),
                failures: Arc::new(AtomicUsize::new(browser_failures)),
                stopped: false,
            })),
            Some(Box::new(FakeDisplay::new(events.clone(), display_failures))),
        )
    }

    #[test]
    fn the_browser_stops_before_its_display() {
        let events = Events::default();
        let mut browser = owned(&events, 0, 0);
        assert_eq!(browser.pid(), Some(4242));
        assert!(browser.terminate());
        assert!(browser.terminate(), "terminate is idempotent");
        assert_eq!(events.all(), ["browser-stop", "display-stop"]);
    }

    #[test]
    fn the_display_is_not_stopped_while_the_browser_stop_is_unconfirmed() {
        let events = Events::default();
        let mut browser = owned(&events, 1, 0);
        assert!(!browser.terminate());
        assert_eq!(events.all(), ["browser-stop-failed"]);
        assert!(browser.terminate());
        assert_eq!(
            events.all(),
            ["browser-stop-failed", "browser-stop", "display-stop"]
        );
    }

    #[test]
    fn a_display_stop_that_fails_once_is_retried_without_stopping_the_browser_again() {
        let events = Events::default();
        let mut browser = owned(&events, 0, 1);
        assert!(!browser.terminate());
        assert_eq!(
            browser.pid(),
            Some(4242),
            "identity survives a partial stop"
        );
        assert!(browser.terminate());
        assert_eq!(
            events.all(),
            ["browser-stop", "display-stop-failed", "display-stop"]
        );
    }

    struct FailingProvider;

    impl DisplayProvider for FailingProvider {
        fn backend(&self) -> DisplayBackend {
            DisplayBackend::PrivateXvfb
        }

        fn start(&self, _deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
            Err("no display".into())
        }
    }

    #[test]
    fn a_missing_or_failing_display_ends_the_launch_before_any_spawn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let never_run = temp.path().join("not-a-browser");
        let spec = LaunchSpec {
            executable: &never_run,
            profile_dir: temp.path(),
            headless: false,
            display_backend: DisplayBackend::PrivateXvfb,
            deadline: Instant::now() + Duration::from_secs(5),
        };
        let failure = BrowserLauncher::new(DisplayProviders::default())
            .launch(&spec)
            .err()
            .expect("no provider");
        assert_eq!(failure.error.code, BROWSER_DISPLAY_UNAVAILABLE);
        assert!(failure.unstopped.is_none());
        let launcher =
            BrowserLauncher::new(DisplayProviders::default().with(Arc::new(FailingProvider)));
        let failure = launcher.launch(&spec).err().expect("display fails");
        assert_eq!(failure.error.code, BROWSER_DISPLAY_UNAVAILABLE);
        assert!(failure.unstopped.is_none());
    }

    /// A display that started but whose browser could not spawn is stopped,
    /// and handed back when that stop is unconfirmed.
    struct StartingProvider {
        events: Events,
        stop_failures: usize,
    }

    impl DisplayProvider for StartingProvider {
        fn backend(&self) -> DisplayBackend {
            DisplayBackend::PrivateXvfb
        }

        fn start(&self, _deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
            self.events.push("display-start");
            Ok(Box::new(FakeDisplay::new(
                self.events.clone(),
                self.stop_failures,
            )))
        }
    }

    #[test]
    fn a_failed_spawn_returns_an_unconfirmed_display_to_the_caller() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing-browser");
        let events = Events::default();
        let launcher =
            BrowserLauncher::new(DisplayProviders::default().with(Arc::new(StartingProvider {
                events: events.clone(),
                stop_failures: 1,
            })));
        let spec = LaunchSpec {
            executable: &missing,
            profile_dir: temp.path(),
            headless: false,
            display_backend: DisplayBackend::PrivateXvfb,
            deadline: Instant::now() + Duration::from_secs(5),
        };
        let failure = launcher.launch(&spec).err().expect("spawn fails");
        assert_eq!(failure.error.code, SURFACE_START_FAILED);
        let mut unstopped = failure.unstopped.expect("unconfirmed display is returned");
        assert_eq!(unstopped.pid(), None);
        assert!(unstopped.terminate());
        assert_eq!(
            events.all(),
            ["display-start", "display-stop-failed", "display-stop"]
        );
    }

    #[test]
    fn a_launch_whose_deadline_passed_during_display_start_does_not_spawn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing-browser");
        let events = Events::default();
        let launcher =
            BrowserLauncher::new(DisplayProviders::default().with(Arc::new(StartingProvider {
                events: events.clone(),
                stop_failures: 0,
            })));
        let spec = LaunchSpec {
            executable: &missing,
            profile_dir: temp.path(),
            headless: false,
            display_backend: DisplayBackend::PrivateXvfb,
            deadline: Instant::now(),
        };
        let failure = launcher.launch(&spec).err().expect("deadline passed");
        assert_eq!(failure.error.code, SURFACE_START_TIMEOUT);
        assert!(failure.unstopped.is_none());
        assert_eq!(events.all(), ["display-start", "display-stop"]);
    }

    /// Launch-level behaviour against shell-script browsers.
    #[cfg(unix)]
    mod spawned {
        use super::*;
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicBool;

        fn launch_headless(
            browser: &Path,
            profile: &Path,
            timeout: Duration,
        ) -> Result<(OwnedBrowser, Readiness), BrowserLaunchError> {
            BrowserLauncher::new(DisplayProviders::default())
                .launch(&LaunchSpec {
                    executable: browser,
                    profile_dir: profile,
                    headless: true,
                    display_backend: DisplayBackend::InheritedHost,
                    deadline: Instant::now() + timeout,
                })
                .map_err(|failure| failure.error)
        }

        fn wait_for_process_exit(pid: u32) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let alive = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
                if !alive {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            panic!("process {pid} did not exit");
        }

        #[test]
        fn slow_stdout_probes_do_not_extend_the_launch_deadline() {
            let temp = tempfile::tempdir().expect("tempdir");
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind slow DevTools server");
            let address = listener.local_addr().expect("server address");
            let stop_server = Arc::new(AtomicBool::new(false));
            let server_stop = Arc::clone(&stop_server);
            let server = thread::spawn(move || {
                listener
                    .set_nonblocking(true)
                    .expect("make slow server nonblocking");
                let deadline = Instant::now() + BROWSER_START_TIMEOUT + Duration::from_secs(1);
                while Instant::now() < deadline && !server_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut request = [0; 1024];
                            let _ = stream.read(&mut request);
                            thread::sleep(Duration::from_millis(250));
                            let _ = stream.write_all(
                                b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            );
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                }
            });
            let browser = temp.path().join("fake-browser-slow.sh");
            fs::write(
                &browser,
                format!(
                    "#!/bin/sh\nfor i in $(seq 1 100); do printf '{{\"cdp_url\":\"http://{address}\"}}\\n'; done\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n"
                ),
            )
            .expect("write slow fake browser");
            fs::set_permissions(&browser, fs::Permissions::from_mode(0o755))
                .expect("make slow fake browser executable");
            let profile = temp.path().join("profile");
            fs::create_dir_all(&profile).expect("create profile");

            let started = Instant::now();
            let result = launch_headless(&browser, &profile, BROWSER_START_TIMEOUT);
            let elapsed = started.elapsed();
            stop_server.store(true, Ordering::Release);
            let server_joined = server.join();

            assert!(result.is_err(), "unready endpoint must time out");
            assert!(
                elapsed <= BROWSER_START_TIMEOUT + Duration::from_millis(300),
                "launch took {elapsed:?}, beyond the deadline and one short probe"
            );
            server_joined.expect("slow server thread");
        }

        #[test]
        fn acquire_waits_until_the_devtools_http_endpoint_is_ready() {
            let temp = tempfile::tempdir().expect("tempdir");
            let reservation = TcpListener::bind("127.0.0.1:0").expect("reserve port");
            let address = reservation.local_addr().expect("port address");
            drop(reservation);

            let ready_server = thread::spawn(move || {
                thread::sleep(Duration::from_millis(200));
                let listener = TcpListener::bind(address).expect("bind delayed DevTools endpoint");
                listener
                    .set_nonblocking(true)
                    .expect("make DevTools endpoint nonblocking");
                let deadline = Instant::now() + Duration::from_secs(2);
                let mut requests = 0;
                while Instant::now() < deadline {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut request = [0; 1024];
                            let _ = stream.read(&mut request);
                            let body = if request.starts_with(b"GET /json/version ") {
                                format!(
                                    r#"{{"webSocketDebuggerUrl":"ws://{}/devtools/browser/test"}}"#,
                                    address
                                )
                            } else {
                                format!(
                                    r#"[{{"type":"page","webSocketDebuggerUrl":"ws://{}/devtools/page/test"}}]"#,
                                    address
                                )
                            };
                            write!(
                                stream,
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            )
                            .expect("write DevTools version response");
                            requests += 1;
                            if requests == 2 {
                                return true;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => return false,
                    }
                }
                false
            });

            let browser = temp.path().join("fake-browser-delayed.sh");
            fs::write(
                &browser,
                format!(
                    "#!/bin/sh\nprofile=\"\"\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    --user-data-dir=*) profile=\"${{arg#*=}}\" ;;\n  esac\ndone\nprintf '%s\\n' {} > \"$profile/DevToolsActivePort\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
                    address.port()
                ),
            )
            .expect("write delayed fake browser");
            fs::set_permissions(&browser, fs::Permissions::from_mode(0o755))
                .expect("make delayed fake browser executable");
            let profile = temp.path().join("profile");
            fs::create_dir_all(&profile).expect("create profile");

            let started = Instant::now();
            let launched = launch_headless(&browser, &profile, BROWSER_START_TIMEOUT);
            let elapsed = started.elapsed();
            let launch_succeeded = match launched {
                Ok((mut browser, readiness)) => {
                    assert!(browser.terminate());
                    assert_eq!(readiness.cdp_url, format!("http://{address}"));
                    true
                }
                Err(_) => false,
            };
            let server_ready = ready_server.join().expect("DevTools server thread");

            assert!(
                server_ready,
                "host must wait for a live /json/version response"
            );
            assert!(elapsed >= Duration::from_millis(200));
            assert!(launch_succeeded);
        }

        #[test]
        fn early_exit_without_sandbox_signature_stays_surface_start_failed() {
            let temp = tempfile::tempdir().expect("tempdir");
            let path = temp.path().join("crashing-browser.sh");
            fs::write(&path, "#!/bin/sh\necho 'some other failure' >&2\nexit 1\n")
                .expect("write crashing browser");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
            let error = launch_headless(&path, temp.path(), BROWSER_START_TIMEOUT)
                .err()
                .expect("launch must fail");
            assert_eq!(error.code, "surface_start_failed");
            assert!(error.message.contains("exited before becoming ready"));
        }

        #[test]
        fn readiness_failure_terminates_descendant_browser_processes() {
            let temp = tempfile::tempdir().expect("tempdir");
            let profile = temp.path().join("profile");
            fs::create_dir_all(&profile).expect("profile dir");
            let pid_file = profile.join("orphan.pid");
            let browser = temp.path().join("handoff-browser.sh");
            fs::write(
                &browser,
                format!(
                    "#!/bin/sh\npython3 -c 'import time; time.sleep(30)' --user-data-dir={} &\necho $! > {}\nexit 1\n",
                    profile.display(),
                    pid_file.display()
                ),
            )
            .expect("write fake handoff browser");
            fs::set_permissions(&browser, fs::Permissions::from_mode(0o755)).expect("chmod");

            assert!(launch_headless(&browser, &profile, BROWSER_START_TIMEOUT).is_err());
            let pid = fs::read_to_string(pid_file)
                .expect("handoff process pid")
                .trim()
                .parse::<u32>()
                .expect("valid pid");
            wait_for_process_exit(pid);
        }

        #[test]
        fn stderr_tail_is_bounded_and_redacts_query_strings() {
            let tail = StderrTail::default();
            tail.push_line("loading https://bank.example/login?session=secret#frag done\n");
            assert_eq!(
                tail.snapshot(),
                "loading https://bank.example/login?<redacted> done"
            );
            for _ in 0..2_000 {
                tail.push_line("0123456789");
            }
            let snapshot = tail.snapshot();
            assert!(snapshot.len() <= STDERR_TAIL_BYTES + 2_000);
            assert!(!snapshot.contains("secret"));
        }
    }
}
