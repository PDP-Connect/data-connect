// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! A small, policy-driven supervisor for local sidecar processes.
//!
//! The `process_group` option is implemented with POSIX process groups on Unix.
//! Windows has no POSIX process-group equivalent in `std::process`; until a
//! Job Object implementation is added, graceful group signalling is not
//! available there and the option stops only the leader after escalation.

use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SUPERVISOR_EVENT: &str = "process-supervisor";
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The complete environment policy for a supervised process.
///
/// `clear` is explicit instead of being an implicit `Command` default. A
/// cleared environment makes the allowlist in `vars` the whole child
/// environment. The inherited mode exists only to represent legacy launches
/// that intentionally still depend on the parent environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentSpec {
    pub clear: bool,
    pub vars: BTreeMap<OsString, OsString>,
}

impl EnvironmentSpec {
    pub fn cleared(vars: BTreeMap<OsString, OsString>) -> Self {
        Self { clear: true, vars }
    }

    pub fn inherited(vars: BTreeMap<OsString, OsString>) -> Self {
        Self { clear: false, vars }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readiness {
    HttpGet {
        /// A URL template containing `{port}`, for example
        /// `http://127.0.0.1:{port}/health`.
        url_from_port: String,
        deadline: Duration,
    },
    StdoutMarker {
        marker: String,
        deadline: Duration,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestartPolicy {
    /// `max` is the number of restarts after the initial attempt.
    Bounded {
        max: u32,
        backoff: Duration,
    },
    Never,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopPolicy {
    /// How long to wait after the graceful signal before escalating.
    pub grace: Duration,
    /// How long to wait after the forceful signal before using the platform
    /// fallback (`Child::kill`) and waiting for the leader.
    pub escalate: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessSpec {
    pub label: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: EnvironmentSpec,
    pub readiness: Readiness,
    pub restart: RestartPolicy,
    pub process_group: bool,
    pub stop: StopPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LifecycleState {
    Starting,
    Ready,
    Exited { code: Option<i32> },
    Restarting,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessLifecycleEvent {
    pub label: String,
    #[serde(flatten)]
    pub state: LifecycleState,
}

/// Event output is injectable so readiness and lifecycle behavior can be
/// tested without constructing a Tauri application.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: ProcessLifecycleEvent);
}

/// Emits the same kind of app event used by the existing Personal Server and
/// reference-server commands (`AppHandle::emit`).
#[derive(Clone)]
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: ProcessLifecycleEvent) {
        if let Err(error) = self.app.emit(SUPERVISOR_EVENT, event) {
            log::warn!("Failed to emit process supervisor event: {}", error);
        }
    }
}

#[derive(Debug)]
pub enum SupervisorError {
    Io(io::Error),
    Message(String),
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for SupervisorError {}

impl From<io::Error> for SupervisorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

struct SupervisorState {
    stopping: AtomicBool,
    child: Mutex<Option<Child>>,
    finished: Mutex<bool>,
    finished_signal: Condvar,
}

impl SupervisorState {
    fn new() -> Self {
        Self {
            stopping: AtomicBool::new(false),
            child: Mutex::new(None),
            finished: Mutex::new(false),
            finished_signal: Condvar::new(),
        }
    }

    fn finish(&self) {
        if let Ok(mut finished) = self.finished.lock() {
            *finished = true;
            self.finished_signal.notify_all();
        }
    }
}

pub struct Supervisor {
    spec: ProcessSpec,
    sink: Arc<dyn EventSink>,
}

impl Supervisor {
    pub fn new<S>(spec: ProcessSpec, sink: S) -> Self
    where
        S: EventSink + 'static,
    {
        Self {
            spec,
            sink: Arc::new(sink),
        }
    }

    pub fn with_tauri_events(spec: ProcessSpec, app: AppHandle) -> Self {
        Self::new(spec, TauriEventSink::new(app))
    }

    /// Allocate the loopback port once, then reuse it for every restart.
    /// Readiness and a `{port}` environment value both resolve from this same
    /// allocation.
    pub fn start(self) -> Result<SupervisorHandle, SupervisorError> {
        let port = allocate_loopback_port()?;
        let state = Arc::new(SupervisorState::new());
        let (ready_sender, ready_receiver) = mpsc::channel();
        let thread_state = Arc::clone(&state);
        let thread_sink = Arc::clone(&self.sink);
        let spec = self.spec;

        thread::Builder::new()
            .name(format!("{}-supervisor", spec.label))
            .spawn(move || {
                run_supervisor(spec, port, thread_state, thread_sink, ready_sender);
            })
            .map_err(SupervisorError::Io)?;

        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(SupervisorHandle { state, port }),
            Ok(Err(error)) => Err(SupervisorError::Message(error)),
            Err(_) => Err(SupervisorError::Message(
                "supervisor stopped before reporting readiness".to_string(),
            )),
        }
    }
}

pub struct SupervisorHandle {
    state: Arc<SupervisorState>,
    port: u16,
}

impl SupervisorHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Request graceful shutdown and wait until the supervisor has reaped its
    /// child and emitted `stopped`.
    pub fn stop(&self) -> Result<(), SupervisorError> {
        self.state.stopping.store(true, Ordering::Release);
        let mut finished =
            self.state.finished.lock().map_err(|_| {
                SupervisorError::Message("supervisor state was poisoned".to_string())
            })?;
        while !*finished {
            finished = self.state.finished_signal.wait(finished).map_err(|_| {
                SupervisorError::Message("supervisor state was poisoned".to_string())
            })?;
        }
        Ok(())
    }
}

impl Drop for SupervisorHandle {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn run_supervisor(
    spec: ProcessSpec,
    port: u16,
    state: Arc<SupervisorState>,
    sink: Arc<dyn EventSink>,
    ready_sender: mpsc::Sender<Result<(), String>>,
) {
    let mut restart_count = 0;
    let mut readiness_reported = false;

    loop {
        if state.stopping.load(Ordering::Acquire) {
            emit_stopped(&spec, &state, &sink);
            if !readiness_reported {
                let _ = ready_sender.send(Err("supervisor stopped before readiness".to_string()));
            }
            state.finish();
            return;
        }

        emit(&spec, &sink, LifecycleState::Starting);
        #[cfg(unix)]
        kill_stale_server_on_port(port);

        let spawned = match spawn_process(&spec, port) {
            Ok(spawned) => spawned,
            Err(error) => {
                if !schedule_restart(
                    &spec,
                    &state,
                    &sink,
                    &mut restart_count,
                    &format!("spawn failed: {error}"),
                ) {
                    if !readiness_reported {
                        let _ = ready_sender
                            .send(Err(format!("failed to spawn {}: {error}", spec.label)));
                    }
                    state.finish();
                    return;
                }
                continue;
            }
        };

        if let Ok(mut child) = state.child.lock() {
            *child = Some(spawned.child);
        } else {
            let _ = ready_sender.send(Err("supervisor state was poisoned".to_string()));
            state.finish();
            return;
        }

        match wait_for_readiness(&spec.readiness, port, &state, &spawned.stdout_lines) {
            ReadinessOutcome::Ready => {
                emit(&spec, &sink, LifecycleState::Ready);
                if !readiness_reported {
                    let _ = ready_sender.send(Ok(()));
                    readiness_reported = true;
                }
                if monitor_ready_process(&spec, &state, &sink, &mut restart_count) {
                    continue;
                }
                state.finish();
                return;
            }
            ReadinessOutcome::Exited(status) => {
                emit(
                    &spec,
                    &sink,
                    LifecycleState::Exited {
                        code: status.and_then(|status| status.code()),
                    },
                );
            }
            ReadinessOutcome::TimedOut(message) => {
                log::error!("[{}] {}", spec.label, message);
                match stop_current_child(&spec, &state) {
                    Ok(Some(status)) => emit(
                        &spec,
                        &sink,
                        LifecycleState::Exited {
                            code: status.code(),
                        },
                    ),
                    Ok(None) => {}
                    Err(error) => log::error!(
                        "[{}] failed to stop after readiness timeout: {error}",
                        spec.label
                    ),
                }
            }
            ReadinessOutcome::StopRequested => {
                let _ = stop_current_child(&spec, &state);
                emit_stopped(&spec, &state, &sink);
                if !readiness_reported {
                    let _ =
                        ready_sender.send(Err("supervisor stopped before readiness".to_string()));
                }
                state.finish();
                return;
            }
        }

        if state.stopping.load(Ordering::Acquire) {
            emit_stopped(&spec, &state, &sink);
            if !readiness_reported {
                let _ = ready_sender.send(Err("supervisor stopped before readiness".to_string()));
            }
            state.finish();
            return;
        }

        if !schedule_restart(&spec, &state, &sink, &mut restart_count, "readiness failed") {
            if !readiness_reported {
                let _ = ready_sender.send(Err(format!(
                    "{} did not become ready before its deadline",
                    spec.label
                )));
            }
            state.finish();
            return;
        }
    }
}

fn monitor_ready_process(
    spec: &ProcessSpec,
    state: &SupervisorState,
    sink: &Arc<dyn EventSink>,
    restart_count: &mut u32,
) -> bool {
    loop {
        if state.stopping.load(Ordering::Acquire) {
            match stop_current_child(spec, state) {
                Ok(Some(status)) => emit(
                    spec,
                    sink,
                    LifecycleState::Exited {
                        code: status.code(),
                    },
                ),
                Ok(None) => {}
                Err(error) => log::error!("[{}] stop failed: {error}", spec.label),
            }
            emit_stopped(spec, state, sink);
            return false;
        }

        match take_exited_child(state) {
            Ok(Some(status)) => {
                emit(
                    spec,
                    sink,
                    LifecycleState::Exited {
                        code: status.code(),
                    },
                );
                if !schedule_restart(spec, state, sink, restart_count, "process exited") {
                    return false;
                }
                return true;
            }
            Ok(None) => thread::sleep(READINESS_POLL_INTERVAL),
            Err(error) => {
                log::error!("[{}] failed to inspect child: {error}", spec.label);
                return false;
            }
        }
    }
}

fn schedule_restart(
    spec: &ProcessSpec,
    state: &SupervisorState,
    sink: &Arc<dyn EventSink>,
    restart_count: &mut u32,
    reason: &str,
) -> bool {
    let (max, backoff) = match spec.restart {
        RestartPolicy::Never => return false,
        RestartPolicy::Bounded { max, backoff } => (max, backoff),
    };
    if *restart_count >= max || state.stopping.load(Ordering::Acquire) {
        log::error!(
            "[{}] not restarting after {} ({restart_count}/{max})",
            spec.label,
            reason
        );
        return false;
    }

    *restart_count += 1;
    emit(spec, sink, LifecycleState::Restarting);
    let deadline = Instant::now() + backoff;
    while Instant::now() < deadline {
        if state.stopping.load(Ordering::Acquire) {
            return false;
        }
        thread::sleep(
            READINESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    true
}

fn emit(spec: &ProcessSpec, sink: &Arc<dyn EventSink>, state: LifecycleState) {
    sink.emit(ProcessLifecycleEvent {
        label: spec.label.clone(),
        state,
    });
}

fn emit_stopped(spec: &ProcessSpec, state: &SupervisorState, sink: &Arc<dyn EventSink>) {
    if state.stopping.load(Ordering::Acquire) {
        emit(spec, sink, LifecycleState::Stopped);
    }
}

struct SpawnedProcess {
    child: Child,
    stdout_lines: mpsc::Receiver<String>,
}

fn spawn_process(spec: &ProcessSpec, port: u16) -> Result<SpawnedProcess, SupervisorError> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }

    if spec.env.clear {
        command.env_clear();
    }
    for (key, value) in &spec.env.vars {
        command.env(key, render_port(value, port));
    }

    #[cfg(unix)]
    if spec.process_group {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::Message(
                "failed to pipe supervisor stdout".to_string(),
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::Message(
                "failed to pipe supervisor stderr".to_string(),
            ));
        }
    };

    let (stdout_sender, stdout_lines) = mpsc::channel();
    let label = spec.label.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    log::info!("[{label}] stdout: {line}");
                    let _ = stdout_sender.send(line);
                }
                Err(error) => {
                    log::warn!("[{label}] stdout read error: {error}");
                    break;
                }
            }
        }
    });

    let label = spec.label.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => log::warn!("[{label}] stderr: {line}"),
                Err(error) => {
                    log::warn!("[{label}] stderr read error: {error}");
                    break;
                }
            }
        }
    });

    Ok(SpawnedProcess {
        child,
        stdout_lines,
    })
}

fn render_port(value: &OsStr, port: u16) -> OsString {
    let Some(value) = value.to_str() else {
        return value.to_os_string();
    };
    OsString::from(value.replace("{port}", &port.to_string()))
}

enum ReadinessOutcome {
    Ready,
    Exited(Option<ExitStatus>),
    TimedOut(String),
    StopRequested,
}

fn wait_for_readiness(
    readiness: &Readiness,
    port: u16,
    state: &SupervisorState,
    stdout_lines: &mpsc::Receiver<String>,
) -> ReadinessOutcome {
    let deadline = match readiness {
        Readiness::HttpGet { deadline, .. } | Readiness::StdoutMarker { deadline, .. } => {
            Instant::now() + *deadline
        }
    };

    match readiness {
        Readiness::StdoutMarker { marker, .. } => loop {
            if state.stopping.load(Ordering::Acquire) {
                return ReadinessOutcome::StopRequested;
            }
            if let Some(status) = child_exit_status(state) {
                return ReadinessOutcome::Exited(Some(status));
            }
            if Instant::now() >= deadline {
                return ReadinessOutcome::TimedOut(format!(
                    "stdout marker {:?} was not seen before the deadline",
                    marker
                ));
            }
            let wait =
                READINESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now()));
            match stdout_lines.recv_timeout(wait) {
                Ok(line) if line.contains(marker) => return ReadinessOutcome::Ready,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return ReadinessOutcome::TimedOut(
                        "stdout closed before its readiness marker was seen".to_string(),
                    );
                }
            }
        },
        Readiness::HttpGet { url_from_port, .. } => {
            let url = url_from_port.replace("{port}", &port.to_string());
            let client = match reqwest::blocking::Client::builder()
                .timeout(READINESS_POLL_INTERVAL)
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    return ReadinessOutcome::TimedOut(format!(
                        "HTTP readiness client failed: {error}"
                    ))
                }
            };
            loop {
                if state.stopping.load(Ordering::Acquire) {
                    return ReadinessOutcome::StopRequested;
                }
                if let Some(status) = child_exit_status(state) {
                    return ReadinessOutcome::Exited(Some(status));
                }
                if Instant::now() >= deadline {
                    return ReadinessOutcome::TimedOut(format!(
                        "HTTP readiness URL {url} did not respond successfully before the deadline"
                    ));
                }
                if client
                    .get(&url)
                    .send()
                    .map(|response| response.status().is_success())
                    .unwrap_or(false)
                {
                    return ReadinessOutcome::Ready;
                }
                thread::sleep(
                    READINESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
    }
}

fn child_exit_status(state: &SupervisorState) -> Option<ExitStatus> {
    let mut child = state.child.lock().ok()?;
    child.as_mut()?.try_wait().ok().flatten()
}

fn take_exited_child(state: &SupervisorState) -> io::Result<Option<ExitStatus>> {
    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| io::Error::other("supervisor child state was poisoned"))?;
    let Some(child) = child_slot.as_mut() else {
        return Ok(None);
    };
    match child.try_wait()? {
        Some(status) => {
            let _ = child_slot.take();
            Ok(Some(status))
        }
        None => Ok(None),
    }
}

fn stop_current_child(
    spec: &ProcessSpec,
    state: &SupervisorState,
) -> io::Result<Option<ExitStatus>> {
    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| io::Error::other("supervisor child state was poisoned"))?;
    let Some(mut child) = child_slot.take() else {
        return Ok(None);
    };
    let pid = child.id();

    if let Some(status) = child.try_wait()? {
        #[cfg(unix)]
        if spec.process_group {
            wait_for_process_group_exit(pid, spec.stop.grace);
        }
        return Ok(Some(status));
    }

    #[cfg(unix)]
    if spec.process_group {
        signal_process_group(pid, libc::SIGTERM);
    }

    #[cfg(not(unix))]
    if spec.process_group {
        log::warn!(
            "[{}] process_group requested, but this platform has no POSIX process-group implementation; stopping leader only",
            spec.label
        );
    }

    if wait_for_child_exit(&mut child, spec.stop.grace)? {
        #[cfg(unix)]
        if spec.process_group {
            if wait_for_process_group_exit(pid, spec.stop.grace) {
                return child.try_wait();
            }
        } else {
            return child.try_wait();
        }
        #[cfg(not(unix))]
        return child.try_wait();
    }

    #[cfg(unix)]
    if spec.process_group {
        signal_process_group(pid, libc::SIGKILL);
    } else {
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    let _ = wait_for_child_exit(&mut child, spec.stop.escalate)?;
    if child.try_wait()?.is_none() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    #[cfg(unix)]
    if spec.process_group {
        let _ = wait_for_process_group_exit(pid, spec.stop.escalate);
    }
    Ok(Some(status))
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(
            READINESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    // Reuse the existing PS group-signal behavior while the leader is alive.
    super::server::kill_process_group(pid, signal);
    // If the leader has already exited, getpgid(pid) can fail even while a
    // descendant remains in the group. The direct group id is stable because
    // this module creates the group with CommandExt::process_group(0).
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

#[cfg(unix)]
fn wait_for_process_group_exit(process_group: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_group_exists(process_group) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(
            READINESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(unix)]
fn process_group_exists(process_group: u32) -> bool {
    let result = unsafe { libc::kill(-(process_group as libc::pid_t), 0) };
    if result == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Keep the stale-port behavior aligned with `server.rs` without refactoring
/// that existing module in this lane.
#[cfg(unix)]
fn kill_stale_server_on_port(port: u16) {
    let output = match Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            log::warn!("Failed to check stale port {port}: {error}");
            return;
        }
    };

    if !output.status.success() || output.stdout.is_empty() {
        return;
    }
    for pid in String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|pid| pid.parse::<libc::pid_t>().ok())
    {
        log::warn!("Found stale process {pid} on port {port}, sending SIGKILL");
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn allocate_loopback_port() -> io::Result<u16> {
    #[cfg(unix)]
    for port in [8080_u16, 8081, 8082, 8083, 8084, 8085] {
        kill_stale_server_on_port(port);
    }

    for port in [8080_u16, 8081, 8082, 8083, 8084, 8085] {
        let ipv4_free = TcpListener::bind(("127.0.0.1", port)).is_ok();
        let ipv6_free = TcpListener::bind(("::1", port)).is_ok();
        if ipv4_free && ipv6_free {
            return Ok(port);
        }
    }

    TcpListener::bind(("127.0.0.1", 0))?
        .local_addr()
        .map(|address| address.port())
}

/// Build the new typed equivalent of the current Personal Server launch.
///
/// The caller supplies the already-resolved bundled binary or dev entrypoint
/// (`personal-server`, `node index.js`, etc.) and its current explicit launch
/// environment. `PORT={port}` is added when absent so the supervisor's one
/// loopback allocation is used by both the child and readiness policy. The
/// adapter is intentionally not wired into existing call sites in this lane.
pub fn personal_server_spec(
    program: PathBuf,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    mut env: BTreeMap<OsString, OsString>,
) -> ProcessSpec {
    env.entry(OsString::from("PORT"))
        .or_insert_with(|| OsString::from("{port}"));
    ProcessSpec {
        label: "personal-server".to_string(),
        program,
        args,
        cwd,
        env: EnvironmentSpec::cleared(env),
        readiness: Readiness::StdoutMarker {
            marker: "\"type\":\"ready\"".to_string(),
            deadline: Duration::from_secs(30),
        },
        restart: RestartPolicy::Never,
        process_group: true,
        stop: StopPolicy {
            grace: Duration::from_secs(5),
            escalate: Duration::from_secs(3),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::NamedTempFile;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<ProcessLifecycleEvent>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: ProcessLifecycleEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    fn node_script(source: &str) -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        fs::write(file.path(), source).unwrap();
        file
    }

    fn node_program() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").expect("test PATH"))
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
            .expect("node executable in test PATH")
    }

    fn base_spec(script: &Path, readiness: Readiness) -> ProcessSpec {
        let mut env = BTreeMap::new();
        env.insert(OsString::from("PORT"), OsString::from("{port}"));
        ProcessSpec {
            label: "test-sidecar".to_string(),
            program: node_program(),
            args: vec![script.as_os_str().to_os_string()],
            cwd: None,
            env: EnvironmentSpec::cleared(env),
            readiness,
            restart: RestartPolicy::Never,
            process_group: true,
            stop: StopPolicy {
                grace: Duration::from_millis(300),
                escalate: Duration::from_secs(1),
            },
        }
    }

    fn states(sink: &RecordingSink) -> Vec<LifecycleState> {
        sink.events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.state.clone())
            .collect()
    }

    #[test]
    fn personal_server_adapter_describes_the_existing_launch_shape() {
        let mut env = BTreeMap::new();
        env.insert(OsString::from("NODE_ENV"), OsString::from("production"));
        env.insert(OsString::from("CONFIG_DIR"), OsString::from("/tmp/ps"));
        let spec = personal_server_spec(PathBuf::from("personal-server"), vec![], None, env);

        assert_eq!(spec.label, "personal-server");
        assert_eq!(spec.program, PathBuf::from("personal-server"));
        assert!(spec.env.clear);
        assert_eq!(
            spec.env.vars.get(OsStr::new("PORT")),
            Some(&OsString::from("{port}"))
        );
        assert!(matches!(spec.readiness, Readiness::StdoutMarker { .. }));
        assert_eq!(spec.restart, RestartPolicy::Never);
        assert!(spec.process_group);
    }

    #[test]
    fn stdout_marker_readiness_emits_ready_and_stopped() {
        let script =
            node_script(r#"process.stdout.write('READY-MARKER\n'); setInterval(() => {}, 1000);"#);
        let sink = Arc::new(RecordingSink::default());
        let spec = base_spec(
            script.path(),
            Readiness::StdoutMarker {
                marker: "READY-MARKER".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        handle.stop().unwrap();

        let events = states(&sink);
        assert!(matches!(events[0], LifecycleState::Starting));
        assert!(events
            .iter()
            .any(|event| matches!(event, LifecycleState::Ready)));
        assert!(events
            .iter()
            .any(|event| matches!(event, LifecycleState::Exited { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, LifecycleState::Stopped)));
    }

    #[test]
    fn http_readiness_uses_the_allocated_port() {
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/ready' ? 200 : 404);
  response.end('ok');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
"#,
        );
        let sink = Arc::new(RecordingSink::default());
        let spec = base_spec(
            script.path(),
            Readiness::HttpGet {
                url_from_port: "http://127.0.0.1:{port}/ready".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        assert!(TcpListener::bind(("127.0.0.1", handle.port())).is_err());
        handle.stop().unwrap();
        assert!(states(&sink)
            .iter()
            .any(|event| matches!(event, LifecycleState::Ready)));
    }

    #[test]
    fn bounded_restart_recovers_after_one_real_child_crash() {
        let marker = NamedTempFile::new().unwrap();
        fs::remove_file(marker.path()).unwrap();
        let script = node_script(&format!(
            r#"const fs = require('node:fs');
const marker = {:?};
if (!fs.existsSync(marker)) {{
  fs.writeFileSync(marker, 'first-start');
  console.log('READY');
  setTimeout(() => process.exit(17), 100);
}} else {{
  console.log('READY');
  setInterval(() => {{}}, 1000);
}}
"#,
            marker.path().to_string_lossy()
        ));
        let sink = Arc::new(RecordingSink::default());
        let mut spec = base_spec(
            script.path(),
            Readiness::StdoutMarker {
                marker: "READY".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        spec.restart = RestartPolicy::Bounded {
            max: 1,
            backoff: Duration::from_millis(50),
        };
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && states(&sink)
                .iter()
                .filter(|event| matches!(event, LifecycleState::Ready))
                .count()
                < 2
        {
            thread::sleep(Duration::from_millis(20));
        }
        handle.stop().unwrap();

        let events = states(&sink);
        assert!(events
            .iter()
            .any(|event| matches!(event, LifecycleState::Exited { code: Some(17) })));
        assert!(events
            .iter()
            .any(|event| matches!(event, LifecycleState::Restarting)));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, LifecycleState::Ready))
                .count(),
            2
        );
    }

    #[test]
    fn cleared_environment_contains_only_the_spec_allowlist() {
        let report = NamedTempFile::new().unwrap();
        let script = node_script(
            r#"const fs = require('node:fs');
fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify(process.env));
console.log('ENV-READY');
setInterval(() => {}, 1000);
"#,
        );
        let sink = Arc::new(RecordingSink::default());
        let mut spec = base_spec(
            script.path(),
            Readiness::StdoutMarker {
                marker: "ENV-READY".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        spec.env.vars.insert(
            OsString::from("REPORT_PATH"),
            report.path().as_os_str().to_os_string(),
        );
        spec.env
            .vars
            .insert(OsString::from("ALLOWED"), OsString::from("yes"));
        spec.env
            .vars
            .insert(OsString::from("SECRET"), OsString::from("should-not-leak"));
        spec.env.vars.remove(OsStr::new("SECRET"));
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        handle.stop().unwrap();

        let environment: Value =
            serde_json::from_str(&fs::read_to_string(report.path()).unwrap()).unwrap();
        let object = environment.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(object.get("ALLOWED").and_then(Value::as_str), Some("yes"));
        assert!(object.get("SECRET").is_none());
        assert!(object
            .get("PORT")
            .and_then(Value::as_str)
            .unwrap()
            .parse::<u16>()
            .is_ok());
        assert_eq!(
            object.get("REPORT_PATH").and_then(Value::as_str),
            Some(report.path().to_str().unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_process_group_stop_kills_a_child_of_a_child() {
        let child_pid = NamedTempFile::new().unwrap();
        let grandchild_done = NamedTempFile::new().unwrap();
        let script = node_script(&format!(
            r#"const fs = require('node:fs');
const {{ spawn }} = require('node:child_process');
const done = {:?};
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {{ require('node:fs').writeFileSync(process.env.DONE, 'terminated'); process.exit(0); }}); setInterval(() => {{}}, 1000);"], {{ env: {{ DONE: done }}, stdio: 'ignore' }});
fs.writeFileSync({:?}, String(child.pid));
console.log('GROUP-READY');
setInterval(() => {{}}, 1000);
"#,
            grandchild_done.path().to_string_lossy(),
            child_pid.path().to_string_lossy()
        ));
        let sink = Arc::new(RecordingSink::default());
        let spec = base_spec(
            script.path(),
            Readiness::StdoutMarker {
                marker: "GROUP-READY".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        handle.stop().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && fs::read_to_string(grandchild_done.path())
                .unwrap()
                .is_empty()
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            fs::read_to_string(grandchild_done.path()).unwrap(),
            "terminated"
        );
        let pid = fs::read_to_string(child_pid.path())
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        let result = unsafe { libc::kill(pid, 0) };
        assert_eq!(result, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    #[derive(Clone)]
    struct ArcSink(Arc<RecordingSink>);

    impl EventSink for ArcSink {
        fn emit(&self, event: ProcessLifecycleEvent) {
            self.0.emit(event);
        }
    }
}
