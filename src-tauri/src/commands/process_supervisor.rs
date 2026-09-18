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
#[cfg(unix)]
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::OnceLock;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SUPERVISOR_EVENT: &str = "process-supervisor";
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(unix)]
type ProcessGroupRegistry = Arc<Mutex<BTreeSet<libc::pid_t>>>;

#[cfg(unix)]
static PROCESS_GROUP_REGISTRY: OnceLock<Result<ProcessGroupRegistry, String>> = OnceLock::new();

/// The complete environment policy for a supervised process.
///
/// `clear` is explicit instead of being an implicit `Command` default. A
/// cleared environment makes the allowlist in `vars` the whole child
/// environment. The inherited mode exists only to represent legacy launches
/// that intentionally still depend on the parent environment.
#[derive(Clone, PartialEq, Eq)]
pub struct EnvironmentSpec {
    pub clear: bool,
    pub vars: BTreeMap<OsString, OsString>,
}

impl fmt::Debug for EnvironmentSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnvironmentSpec")
            .field("clear", &self.clear)
            .field("keys", &self.vars.keys().collect::<Vec<_>>())
            .finish()
    }
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
        /// Overrides the `Host` header the probe sends, independent of the
        /// URL's own `127.0.0.1` authority. Needed when the target server
        /// enforces a request-host allowlist (see
        /// `reachability-contract.ts::isAllowedRequestHost` on the reference
        /// server): once a public origin is configured there, a probe whose
        /// `Host` header reads `127.0.0.1` is indistinguishable from a
        /// DNS-rebound attacker request and is correctly rejected, so this
        /// process's own internal probe of a process it just spawned needs to
        /// present a `Host` that server already trusts. `None` sends whatever
        /// the URL's authority implies, correct for any target with no such
        /// allowlist.
        host_header: Option<String>,
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
    /// fallback (`Child::kill`).
    pub escalate: Duration,
    /// The maximum time a stop request may wait for this process tree.
    pub total: Duration,
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
    /// An owner-pinned port to bind instead of an OS-assigned ephemeral one.
    /// `None` keeps the existing dynamic-allocation behavior. `Some(port)`
    /// must bind exactly that port (and `port + 1` when the spec needs an
    /// adjacent port) or fail loudly -- see `allocate_loopback_port` -- so a
    /// reverse proxy pointed at a pinned port never silently targets the
    /// wrong one.
    pub requested_port: Option<u16>,
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
    #[cfg(unix)]
    process_group_id: Mutex<Option<libc::pid_t>>,
    finished: Mutex<bool>,
    finished_signal: Condvar,
    stop_deadline: Mutex<Option<Instant>>,
    stop_wait_expired: AtomicBool,
}

impl SupervisorState {
    fn new() -> Self {
        Self {
            stopping: AtomicBool::new(false),
            child: Mutex::new(None),
            #[cfg(unix)]
            process_group_id: Mutex::new(None),
            finished: Mutex::new(false),
            finished_signal: Condvar::new(),
            stop_deadline: Mutex::new(None),
            stop_wait_expired: AtomicBool::new(false),
        }
    }

    fn finish(&self) {
        if let Ok(mut finished) = self.finished.lock() {
            *finished = true;
            self.finished_signal.notify_all();
        }
    }
}

#[cfg(unix)]
fn install_parent_signal_handlers() -> Result<(), SupervisorError> {
    let result = PROCESS_GROUP_REGISTRY.get_or_init(|| {
        let registry = Arc::new(Mutex::new(BTreeSet::new()));
        let signal_registry = Arc::clone(&registry);
        let mut signals =
            signal_hook::iterator::Signals::new([libc::SIGTERM, libc::SIGINT, libc::SIGHUP])
                .map_err(|error| format!("failed to register shutdown signals: {error}"))?;
        thread::Builder::new()
            .name("sidecar-signal-handler".to_string())
            .spawn(move || {
                if let Some(signal) = signals.forever().next() {
                    if let Ok(process_groups) = signal_registry.lock() {
                        for process_group in process_groups.iter().copied() {
                            signal_process_group_direct(process_group as u32, libc::SIGKILL);
                        }
                    }
                    let _ = signal_hook::low_level::emulate_default_handler(signal);
                }
            })
            .map_err(|error| format!("failed to start shutdown signal handler: {error}"))?;
        Ok(registry)
    });
    result
        .as_ref()
        .map(|_| ())
        .map_err(|error| SupervisorError::Message(error.clone()))
}

#[cfg(unix)]
fn register_process_group(process_group: u32) -> Result<(), SupervisorError> {
    let registry = PROCESS_GROUP_REGISTRY
        .get()
        .and_then(|result| result.as_ref().ok())
        .ok_or_else(|| {
            SupervisorError::Message("parent signal handlers are not installed".to_string())
        })?;
    registry
        .lock()
        .map_err(|_| SupervisorError::Message("process-group registry was poisoned".to_string()))?
        .insert(process_group as libc::pid_t);
    Ok(())
}

#[cfg(unix)]
fn unregister_process_group(process_group: libc::pid_t) {
    if let Some(Ok(registry)) = PROCESS_GROUP_REGISTRY.get() {
        if let Ok(mut process_groups) = registry.lock() {
            process_groups.remove(&process_group);
        }
    }
}

#[cfg(unix)]
fn take_process_group_id(state: &SupervisorState) -> Option<libc::pid_t> {
    state.process_group_id.lock().ok()?.take()
}

#[cfg(unix)]
struct ProcessGroupRegistration(Option<libc::pid_t>);

#[cfg(unix)]
impl Drop for ProcessGroupRegistration {
    fn drop(&mut self) {
        if let Some(slot) = self.0.take() {
            unregister_process_group(slot);
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
        self.start_on_port(None)
    }

    /// Same as `start`, but tries `preferred_port` (and its adjacent port, if
    /// the spec needs one) first, falling back to a freshly allocated port
    /// when the preferred one is unavailable -- for example another process
    /// has since bound it, or it was never freed in time after the previous
    /// occupant stopped. Used to keep a sidecar's port stable across a
    /// stack-level restart (a new `Supervisor` each time) rather than only
    /// across this supervisor's own internal crash-restarts, which already
    /// reuse the one port allocated in `start`. `None` behaves exactly like
    /// `start`.
    pub fn start_on_port(
        self,
        preferred_port: Option<u16>,
    ) -> Result<SupervisorHandle, SupervisorError> {
        #[cfg(unix)]
        if self.spec.process_group {
            install_parent_signal_handlers()?;
        }
        let adjacent = spec_requires_adjacent_port(&self.spec);
        // An owner-pinned port (self.spec.requested_port) always wins over a
        // best-effort restart-stability hint (preferred_port): a pin exists
        // so an external reverse proxy has a stable, known target, and must
        // fail loudly rather than silently reallocate elsewhere (see
        // allocate_loopback_port's doc comment). preferred_port only applies
        // when nothing is pinned.
        let port = if self.spec.requested_port.is_some() {
            allocate_loopback_port(adjacent, self.spec.requested_port)?
        } else {
            match preferred_port {
                Some(port) if loopback_port_range_is_free(port, adjacent) => port,
                _ => allocate_loopback_port(adjacent, None)?,
            }
        };
        let state = Arc::new(SupervisorState::new());
        let (ready_sender, ready_receiver) = mpsc::channel();
        let thread_state = Arc::clone(&state);
        let thread_sink = Arc::clone(&self.sink);
        let spec = self.spec;
        let stop_budget = spec.stop.total;

        thread::Builder::new()
            .name(format!("{}-supervisor", spec.label))
            .spawn(move || {
                run_supervisor(spec, port, thread_state, thread_sink, ready_sender);
            })
            .map_err(SupervisorError::Io)?;

        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(SupervisorHandle {
                state,
                port,
                stop_budget,
            }),
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
    stop_budget: Duration,
}

impl SupervisorHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Request graceful shutdown and wait until the supervisor has reaped its
    /// child and emitted `stopped`, bounded by the process stop policy.
    pub fn stop(&self) -> Result<(), SupervisorError> {
        self.stop_until(Instant::now() + self.stop_budget)
    }

    /// Request shutdown and wait until the supervisor finishes or the supplied
    /// deadline expires. The deadline is also shared with the supervisor so
    /// its child and process-group waits use the same bound.
    pub fn stop_until(&self, deadline: Instant) -> Result<(), SupervisorError> {
        let deadline = deadline.min(Instant::now() + self.stop_budget);
        if self.state.stop_wait_expired.load(Ordering::Acquire) {
            return Err(SupervisorError::Message(
                "supervisor stop budget expired".to_string(),
            ));
        }

        if let Ok(mut stop_deadline) = self.state.stop_deadline.lock() {
            *stop_deadline = Some(
                stop_deadline
                    .map(|existing| existing.min(deadline))
                    .unwrap_or(deadline),
            );
        } else {
            return Err(SupervisorError::Message(
                "supervisor state was poisoned".to_string(),
            ));
        }
        self.state.stopping.store(true, Ordering::Release);
        let mut finished =
            self.state.finished.lock().map_err(|_| {
                SupervisorError::Message("supervisor state was poisoned".to_string())
            })?;
        while !*finished {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.state.stop_wait_expired.store(true, Ordering::Release);
                return Err(SupervisorError::Message(
                    "supervisor did not stop before its deadline".to_string(),
                ));
            }
            let (next_finished, timeout) = self
                .state
                .finished_signal
                .wait_timeout(finished, remaining)
                .map_err(|_| {
                    SupervisorError::Message("supervisor state was poisoned".to_string())
                })?;
            finished = next_finished;
            if timeout.timed_out() && !*finished {
                self.state.stop_wait_expired.store(true, Ordering::Release);
                return Err(SupervisorError::Message(
                    "supervisor did not stop before its deadline".to_string(),
                ));
            }
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
            #[cfg(unix)]
            if let Ok(mut process_group_id) = state.process_group_id.lock() {
                *process_group_id = spawned.process_group_id;
            }
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
    #[cfg(unix)]
    process_group_id: Option<libc::pid_t>,
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
    #[cfg(unix)]
    let process_group_id = if spec.process_group {
        match register_process_group(child.id()) {
            Ok(()) => Some(child.id() as libc::pid_t),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    } else {
        None
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            #[cfg(unix)]
            if let Some(process_group) = process_group_id {
                unregister_process_group(process_group);
            }
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
            #[cfg(unix)]
            if let Some(process_group) = process_group_id {
                unregister_process_group(process_group);
            }
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
        #[cfg(unix)]
        process_group_id,
    })
}

fn render_port(value: &OsStr, port: u16) -> OsString {
    let Some(value) = value.to_str() else {
        return value.to_os_string();
    };
    OsString::from(render_port_string(value, port))
}

fn render_port_string(value: &str, port: u16) -> String {
    let adjacent_port = port.saturating_add(1).to_string();
    value
        .replace("{port+1}", &adjacent_port)
        .replace("{port}", &port.to_string())
}

fn spec_requires_adjacent_port(spec: &ProcessSpec) -> bool {
    spec.env
        .vars
        .values()
        .any(|value| value.to_string_lossy().contains("{port+1}"))
        || matches!(
            &spec.readiness,
            Readiness::HttpGet { url_from_port, .. }
                if url_from_port.contains("{port+1}")
        )
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
        Readiness::HttpGet {
            url_from_port,
            host_header,
            ..
        } => {
            let url = render_port_string(url_from_port, port);
            let client = match reqwest::blocking::Client::builder()
                .timeout(READINESS_POLL_INTERVAL)
                .redirect(reqwest::redirect::Policy::none())
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
                let mut request = client.get(&url);
                if let Some(host) = host_header {
                    request = request.header(reqwest::header::HOST, host);
                }
                if request
                    .send()
                    .map(|response| {
                        response.status().is_success() || response.status().is_redirection()
                    })
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
            #[cfg(unix)]
            if let Ok(mut process_group_id) = state.process_group_id.lock() {
                if let Some(process_group) = process_group_id.take() {
                    unregister_process_group(process_group);
                }
            }
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
    #[cfg(unix)]
    let _process_group_registration = ProcessGroupRegistration(take_process_group_id(state));
    let pid = child.id();
    let deadline = state
        .stop_deadline
        .lock()
        .ok()
        .and_then(|deadline| *deadline)
        .unwrap_or_else(|| Instant::now() + spec.stop.total);

    log::info!(
        "[{}] stopping process tree pid={} with a {:?} budget",
        spec.label,
        pid,
        deadline.saturating_duration_since(Instant::now())
    );

    #[cfg(unix)]
    if spec.process_group {
        log::info!("[{}] sending SIGTERM to process group {}", spec.label, pid);
        signal_process_group(pid, libc::SIGTERM);
    }

    #[cfg(not(unix))]
    if spec.process_group {
        log::warn!(
            "[{}] process_group requested, but this platform has no POSIX process-group implementation; stopping leader only",
            spec.label
        );
    }

    let graceful_deadline = deadline.min(Instant::now() + spec.stop.grace);
    if wait_for_process_tree_exit(&mut child, pid, spec.process_group, graceful_deadline)? {
        log::info!("[{}] process tree exited after graceful stop", spec.label);
        return child.try_wait();
    }

    log::warn!(
        "[{}] graceful stop exceeded {:?}; forcing process tree termination",
        spec.label,
        spec.stop.grace
    );
    #[cfg(unix)]
    if spec.process_group {
        log::info!("[{}] sending SIGKILL to process group {}", spec.label, pid);
        signal_process_group(pid, libc::SIGKILL);
    } else {
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    let escalate_deadline = deadline.min(Instant::now() + spec.stop.escalate);
    if wait_for_process_tree_exit(&mut child, pid, spec.process_group, escalate_deadline)? {
        log::info!("[{}] process tree exited after force-kill", spec.label);
        return child.try_wait();
    }

    log::error!(
        "[{}] process tree did not exit within its {:?} shutdown budget",
        spec.label,
        spec.stop.total
    );
    if child.try_wait()?.is_none() {
        log::warn!(
            "[{}] retrying direct leader kill without waiting",
            spec.label
        );
        let _ = child.kill();
    }
    #[cfg(unix)]
    if spec.process_group {
        signal_process_group(pid, libc::SIGKILL);
    }
    child.try_wait()
}

fn wait_for_process_tree_exit(
    child: &mut Child,
    process_group: u32,
    has_process_group: bool,
    deadline: Instant,
) -> io::Result<bool> {
    loop {
        let leader_exited = child.try_wait()?.is_some();
        let group_exited = {
            #[cfg(unix)]
            {
                !has_process_group || !process_group_exists(process_group)
            }
            #[cfg(not(unix))]
            {
                true
            }
        };
        if leader_exited && group_exited {
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
    signal_process_group_direct(pid, signal);
}

#[cfg(unix)]
fn signal_process_group_direct(pid: u32, signal: libc::c_int) {
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
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

fn loopback_port_range_is_free(port: u16, adjacent: bool) -> bool {
    let required_ports = if adjacent { 2 } else { 1 };
    (0..required_ports).all(|offset| {
        port.checked_add(offset)
            .is_some_and(loopback_port_is_free)
    })
}

/// Resolve the loopback port (and, when `adjacent`, the port right after it)
/// this process will bind. `requested_port` pins the owner's chosen port: it
/// must be free, or this returns an error naming the exact port that
/// collided -- there is no silent fallback to a different port, because a
/// pinned port exists specifically so an external reverse proxy has a
/// stable, known target. Absent a request, an OS-assigned ephemeral port is
/// chosen as before.
fn allocate_loopback_port(adjacent: bool, requested_port: Option<u16>) -> io::Result<u16> {
    if let Some(port) = requested_port {
        return loopback_port_range_is_free(port, adjacent)
            .then_some(port)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("the pinned port {port} is already in use"),
                )
            });
    }
    for _ in 0..64 {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        drop(listener);
        if loopback_port_range_is_free(port, adjacent) {
            return Ok(port);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "could not allocate the required loopback port range",
    ))
}

fn loopback_port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok() && TcpListener::bind(("::1", port)).is_ok()
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
            total: Duration::from_secs(8),
        },
        requested_port: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::{tempdir, NamedTempFile};

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
                total: Duration::from_secs(2),
            },
            requested_port: None,
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

    #[cfg(unix)]
    #[test]
    #[ignore]
    fn unix_parent_signal_helper() {
        if std::env::var_os("DATACONNECT_PARENT_SIGNAL_HELPER").is_none() {
            return;
        }
        let pid_file = PathBuf::from(
            std::env::var_os("DATACONNECT_PARENT_SIGNAL_PID_FILE")
                .expect("parent-signal PID file path"),
        );
        let script = node_script(&format!(
            r#"const fs = require('node:fs');
const {{ spawn }} = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000);'], {{ stdio: 'ignore' }});
fs.writeFileSync({:?}, JSON.stringify({{ leader: process.pid, child: child.pid }}));
console.log('PARENT-SIGNAL-READY');
setInterval(() => {{}}, 1000);
"#,
            pid_file
        ));
        let sink = Arc::new(RecordingSink::default());
        let handle = Supervisor::new(
            base_spec(
                script.path(),
                Readiness::StdoutMarker {
                    marker: "PARENT-SIGNAL-READY".to_string(),
                    deadline: Duration::from_secs(3),
                },
            ),
            ArcSink(sink),
        )
        .start()
        .expect("parent-signal helper supervisor should start");
        std::mem::forget(handle);
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_parent_signal_terminates_sidecar_process_group() {
        let directory = tempdir().unwrap();
        let pid_file = directory.path().join("sidecar-pids.json");
        let mut helper = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::process_supervisor::tests::unix_parent_signal_helper",
                "--nocapture",
                "--ignored",
            ])
            .env("DATACONNECT_PARENT_SIGNAL_HELPER", "1")
            .env("DATACONNECT_PARENT_SIGNAL_PID_FILE", &pid_file)
            .spawn()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() && Instant::now() < deadline {
            if let Some(status) = helper.try_wait().unwrap() {
                panic!("parent-signal helper exited before spawning sidecar: {status}");
            }
            thread::sleep(Duration::from_millis(20));
        }
        let pids: Value = serde_json::from_str(&fs::read_to_string(&pid_file).unwrap()).unwrap();
        let leader = pids["leader"].as_i64().unwrap() as libc::pid_t;
        let child = pids["child"].as_i64().unwrap() as libc::pid_t;
        assert_eq!(unsafe { libc::kill(leader, 0) }, 0);
        assert_eq!(unsafe { libc::kill(child, 0) }, 0);

        unsafe { libc::kill(helper.id() as libc::pid_t, libc::SIGTERM) };
        let _ = helper.wait().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && (unsafe { libc::kill(leader, 0) } == 0 || unsafe { libc::kill(child, 0) } == 0)
        {
            thread::sleep(Duration::from_millis(20));
        }
        let leader_alive = unsafe { libc::kill(leader, 0) } == 0;
        let child_alive = unsafe { libc::kill(child, 0) } == 0;
        if leader_alive || child_alive {
            unsafe { libc::kill(-(leader as libc::pid_t), libc::SIGKILL) };
        }
        assert!(!leader_alive, "sidecar leader survived parent SIGTERM");
        assert!(!child_alive, "sidecar descendant survived parent SIGTERM");
    }

    #[test]
    fn prompt_sidecar_stop_returns_within_its_budget() {
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
        let budget = spec.stop.total;
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        let started = Instant::now();
        handle.stop().unwrap();

        assert!(
            started.elapsed() <= budget,
            "prompt stop exceeded {:?}: {:?}",
            budget,
            started.elapsed()
        );
    }

    #[test]
    fn http_readiness_uses_the_allocated_port() {
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
	response.writeHead(request.url === '/ready' ? 302 : 404, { location: '/login' });
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
                host_header: None,
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
    fn start_on_port_reuses_the_preferred_port_when_it_is_free() {
        // The shape `reuse_or_start_ngrok_provider` (unified.rs) depends on:
        // a fresh `Supervisor` for a NEW process instance still lands on the
        // SAME port a caller asks for, when nothing else has taken it in the
        // gap. This is what lets an ngrok tunnel forwarding to the previous
        // RI's port keep working after the RI restarts.
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/ready' ? 302 : 404, { location: '/login' });
  response.end('ok');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
"#,
        );
        let sink = Arc::new(RecordingSink::default());
        let readiness = Readiness::HttpGet {
            url_from_port: "http://127.0.0.1:{port}/ready".to_string(),
            deadline: Duration::from_secs(3),
            host_header: None,
        };
        let first = Supervisor::new(base_spec(script.path(), readiness.clone()), ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        let first_port = first.port();
        first.stop().unwrap();

        let second = Supervisor::new(base_spec(script.path(), readiness), ArcSink(Arc::clone(&sink)))
            .start_on_port(Some(first_port))
            .unwrap();
        assert_eq!(second.port(), first_port);
        second.stop().unwrap();
    }

    #[test]
    fn start_on_port_falls_back_to_a_fresh_port_when_the_preferred_one_is_taken() {
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/ready' ? 302 : 404, { location: '/login' });
  response.end('ok');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
"#,
        );
        let sink = Arc::new(RecordingSink::default());
        let readiness = Readiness::HttpGet {
            url_from_port: "http://127.0.0.1:{port}/ready".to_string(),
            deadline: Duration::from_secs(3),
            host_header: None,
        };
        // Occupy a port, then ask a fresh supervisor to prefer it -- it must
        // not fail, just fall back to an allocated port instead.
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();

        let handle = Supervisor::new(base_spec(script.path(), readiness), ArcSink(Arc::clone(&sink)))
            .start_on_port(Some(occupied_port))
            .unwrap();
        assert_ne!(handle.port(), occupied_port);
        drop(occupied);
        handle.stop().unwrap();
    }

    #[test]
    fn a_pinned_port_is_bound_exactly_and_reused_across_restarts() {
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/ready' ? 302 : 404, { location: '/login' });
  response.end('ok');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
"#,
        );
        let sink = Arc::new(RecordingSink::default());
        // Free the port right before use rather than picking a fixed literal,
        // so the test cannot collide with another process already listening.
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let pinned_port = probe.local_addr().unwrap().port();
        drop(probe);
        let mut spec = base_spec(
            script.path(),
            Readiness::HttpGet {
                url_from_port: "http://127.0.0.1:{port}/ready".to_string(),
                deadline: Duration::from_secs(3),
                host_header: None,
            },
        );
        spec.requested_port = Some(pinned_port);
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        assert_eq!(handle.port(), pinned_port);
        handle.stop().unwrap();
    }

    #[test]
    fn a_pinned_port_already_in_use_fails_loudly_instead_of_picking_another() {
        let script = node_script(
            r#"const http = require('node:http');
http.createServer((_req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
"#,
        );
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let sink = Arc::new(RecordingSink::default());
        let mut spec = base_spec(
            script.path(),
            Readiness::HttpGet {
                url_from_port: "http://127.0.0.1:{port}/ready".to_string(),
                deadline: Duration::from_secs(1),
                host_header: None,
            },
        );
        spec.requested_port = Some(occupied_port);
        let result = Supervisor::new(spec, ArcSink(Arc::clone(&sink))).start();

        assert!(result.is_err());
        drop(occupied);
    }

    #[test]
    fn http_readiness_sends_the_configured_host_header() {
        // Simulates the reference server's reachability-contract host
        // allowlist: only succeeds (302) for the one Host it trusts, 400 for
        // anything else -- including the bare 127.0.0.1 a probe would send
        // with no override. Proves `host_header` actually reaches the wire,
        // not just that it's stored on the enum variant.
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  const trusted = request.headers.host === 'trusted.example';
  response.writeHead(trusted ? 302 : 400, { location: '/login' });
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
                host_header: Some("trusted.example".to_string()),
            },
        );
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .expect("readiness should succeed once the trusted Host header is presented");
        handle.stop().unwrap();
        assert!(states(&sink)
            .iter()
            .any(|event| matches!(event, LifecycleState::Ready)));
    }

    #[test]
    fn http_readiness_without_a_host_header_fails_against_a_host_allowlist() {
        // The inverse of the above: no override sent, so the probe presents
        // whatever the URL's own 127.0.0.1 authority implies, which a
        // trusted-host-only server rejects -- this is the exact failure mode
        // that motivated adding `host_header` (a restart after ngrok assigns
        // an origin, probed with no override, times out).
        let script = node_script(
            r#"const http = require('node:http');
const server = http.createServer((request, response) => {
  const trusted = request.headers.host === 'trusted.example';
  response.writeHead(trusted ? 302 : 400, { location: '/login' });
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
                deadline: Duration::from_millis(300),
                host_header: None,
            },
        );
        let result = Supervisor::new(spec, ArcSink(Arc::clone(&sink))).start();
        assert!(result.is_err());
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

    #[cfg(unix)]
    #[test]
    fn unix_force_kill_terminates_signal_ignoring_descendant_within_budget() {
        let child_pid = NamedTempFile::new().unwrap();
        let script = node_script(&format!(
            r#"const fs = require('node:fs');
const {{ spawn }} = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {{}}); setInterval(() => {{}}, 1000);"], {{ stdio: 'ignore' }});
fs.writeFileSync({:?}, String(child.pid));
process.on('SIGTERM', () => {{}});
console.log('FORCE-READY');
setInterval(() => {{}}, 1000);
"#,
            child_pid.path().to_string_lossy()
        ));
        let sink = Arc::new(RecordingSink::default());
        let mut spec = base_spec(
            script.path(),
            Readiness::StdoutMarker {
                marker: "FORCE-READY".to_string(),
                deadline: Duration::from_secs(3),
            },
        );
        spec.stop = StopPolicy {
            grace: Duration::from_millis(100),
            escalate: Duration::from_millis(300),
            total: Duration::from_millis(750),
        };
        let budget = spec.stop.total;
        let handle = Supervisor::new(spec, ArcSink(Arc::clone(&sink)))
            .start()
            .unwrap();
        let pid_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < pid_deadline
            && fs::read_to_string(child_pid.path())
                .unwrap()
                .trim()
                .is_empty()
        {
            thread::sleep(Duration::from_millis(20));
        }
        let pid = fs::read_to_string(child_pid.path())
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();

        let started = Instant::now();
        handle.stop().unwrap();

        assert!(
            started.elapsed() <= budget + Duration::from_millis(250),
            "force stop exceeded {:?}: {:?}",
            budget,
            started.elapsed()
        );
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
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
