//! Bounded supervision for one PDPP Collection Profile connector process.
//!
//! This is a runtime kernel only: callers provide manifest-derived validation
//! data and consume events. It does not resolve manifests, persist state, or
//! provide an INTERACTION_RESPONSE API.

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct PdppConnectorCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub clear_env: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdppStart {
    #[serde(rename = "type")]
    message_type: &'static str,
    pub run_id: String,
    pub collection_mode: String,
    pub scope: Value,
    pub state: Option<Value>,
    pub bindings: Value,
}

impl PdppStart {
    pub fn new(
        run_id: impl Into<String>,
        collection_mode: impl Into<String>,
        scope: Value,
        state: Option<Value>,
        bindings: Value,
    ) -> Result<Self, String> {
        let start = Self {
            message_type: "START",
            run_id: run_id.into(),
            collection_mode: collection_mode.into(),
            scope,
            state,
            bindings,
        };
        start.validate()?;
        Ok(start)
    }

    fn validate(&self) -> Result<(), String> {
        if self.run_id.is_empty() {
            return Err("PDPP START requires a non-empty run_id".into());
        }
        if !matches!(
            self.collection_mode.as_str(),
            "full_refresh" | "incremental"
        ) {
            return Err("PDPP START collection_mode must be full_refresh or incremental".into());
        }
        if !self.bindings.is_object() {
            return Err("PDPP START bindings must be an object".into());
        }
        Ok(())
    }
}

/// Manifest-derived data needed to enforce collection scope. A time-range run
/// fails before spawning unless the relevant stream has a consent-time field.
#[derive(Debug, Clone, Default)]
pub struct PdppScopeValidators {
    pub consent_time_fields: HashMap<String, String>,
    pub ingest_required_fields: HashMap<String, HashSet<String>>,
}

pub type PdppEventSink = Arc<dyn Fn(PdppEvent) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct PdppRunOptions {
    pub timeout: Option<Duration>,
    pub control: PdppRunControl,
    pub scope_validators: PdppScopeValidators,
    pub max_stdout_line_bytes: usize,
    pub max_stderr_bytes: usize,
    pub max_retained_records: usize,
    pub max_retained_events: usize,
    pub on_event: Option<PdppEventSink>,
}

impl Default for PdppRunOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            control: PdppRunControl::default(),
            scope_validators: PdppScopeValidators::default(),
            max_stdout_line_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
            max_retained_records: 0,
            max_retained_events: 32,
            on_event: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PdppRunControl {
    cancelled: Arc<AtomicBool>,
}
impl PdppRunControl {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PdppDoneStatus {
    Succeeded,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdppRecord {
    pub stream: String,
    pub key: Value,
    pub data: Value,
    pub emitted_at: String,
    pub op: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdppState {
    pub stream: String,
    pub cursor: Value,
}
#[derive(Debug, Clone, Deserialize)]
pub struct PdppDone {
    pub status: PdppDoneStatus,
    pub records_emitted: u64,
    pub error: Option<PdppDoneError>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct PdppDoneError {
    pub message: String,
    pub retryable: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdppProgress {
    pub stream: Option<String>,
    pub message: String,
    pub count: Option<u64>,
    pub total: Option<u64>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdppSkipResult {
    pub stream: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdppInteraction {
    pub request_id: String,
    pub kind: String,
    pub message: String,
    pub schema: Option<Value>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum PdppEvent {
    Record(PdppRecord),
    State(PdppState),
    Progress(PdppProgress),
    SkipResult(PdppSkipResult),
    DetailCoverage(Value),
    DetailGap(Value),
    DetailGapRecovered(Value),
    Interaction(PdppInteraction),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdppRunStatus {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}
#[derive(Debug, Clone)]
pub struct PdppRunResult {
    pub status: PdppRunStatus,
    pub record_count: u64,
    pub records: Vec<PdppRecord>,
    pub records_truncated: bool,
    pub checkpoints: HashMap<String, Value>,
    pub events: Vec<PdppEvent>,
    pub events_truncated: bool,
    pub event_counts: PdppEventCounts,
    pub done: Option<PdppDone>,
    pub stderr: String,
    pub stderr_truncated: bool,
    pub exit_code: Option<i32>,
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PdppEventCounts {
    pub records: u64,
    pub checkpoint_updates: u64,
    pub progress: u64,
    pub skip_results: u64,
    pub detail_coverage: u64,
    pub detail_gaps: u64,
    pub detail_gaps_recovered: u64,
    pub interactions: u64,
}

#[derive(Debug, Deserialize)]
struct Scope {
    streams: Vec<ScopeStream>,
}
#[derive(Debug, Deserialize)]
struct ScopeStream {
    name: String,
    resources: Option<Vec<String>>,
    fields: Option<Vec<String>>,
    time_range: Option<TimeRange>,
}
#[derive(Debug, Deserialize)]
struct TimeRange {
    since: Option<String>,
    until: Option<String>,
}
struct ScopePolicy {
    streams: HashMap<String, StreamPolicy>,
}
struct StreamPolicy {
    resources: Option<HashSet<String>>,
    fields: Option<HashSet<String>>,
    required_fields: HashSet<String>,
    time_range: Option<(
        Option<DateTime<FixedOffset>>,
        Option<DateTime<FixedOffset>>,
        String,
    )>,
}
enum ConnectorMessage {
    Record(PdppRecord),
    State(PdppState),
    Done(PdppDone),
    Progress(PdppProgress),
    SkipResult(PdppSkipResult),
    DetailCoverage(Value),
    DetailGap(Value),
    DetailGapRecovered(Value),
    Interaction(PdppInteraction),
}
enum ReaderEvent {
    Stdout(Result<String, String>),
    StdoutClosed,
    Stderr(Line),
    StderrClosed,
}
enum Line {
    Text(String),
    TooLong,
    End,
}

pub fn supervise_pdpp_connector(
    command: &PdppConnectorCommand,
    start: &PdppStart,
    options: &PdppRunOptions,
) -> Result<PdppRunResult, String> {
    start.validate()?;
    let scope = scope_policy(start, &options.scope_validators)?;
    if options.on_event.is_none() && options.max_retained_records == 0 {
        return Err(
            "PDPP connector requires an event sink or positive record retention before spawning"
                .into(),
        );
    }
    let mut process = Command::new(&command.program);
    if command.clear_env {
        process.env_clear();
    }
    if let Some(cwd) = &command.cwd {
        process.current_dir(cwd);
    }
    process
        .args(&command.args)
        .envs(&command.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = process
        .spawn()
        .map_err(|e| format!("Failed to spawn PDPP connector: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("PDPP connector stdin unavailable")?;
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(start).map_err(|e| e.to_string())?
    )
    .map_err(|e| format!("Failed to send PDPP START: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush PDPP START: {e}"))?;
    drop(stdin);
    let stdout = child
        .stdout
        .take()
        .ok_or("PDPP connector stdout unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("PDPP connector stderr unavailable")?;
    let (tx, rx) = mpsc::channel();
    let stdout_thread = spawn_reader(stdout, options.max_stdout_line_bytes, true, tx.clone());
    let stderr_thread = spawn_reader(stderr, options.max_stderr_bytes, false, tx);

    let started = Instant::now();
    let mut stdout_closed = false;
    let mut stderr_closed = false;
    let mut exit = None;
    let mut failure = None;
    let mut termination = None;
    let mut records = Vec::new();
    let mut records_truncated = false;
    let mut record_count = 0;
    let mut checkpoints = HashMap::new();
    let mut events = Vec::new();
    let mut events_truncated = false;
    let mut event_counts = PdppEventCounts::default();
    let mut done = None;
    let mut stderr_text = String::new();
    let mut stderr_truncated = false;
    while !(stdout_closed && stderr_closed && exit.is_some()) {
        if exit.is_none() {
            exit = child
                .try_wait()
                .map_err(|e| format!("Failed to poll PDPP connector: {e}"))?;
        }
        if termination.is_none() && options.control.is_cancelled() {
            termination = Some(PdppRunStatus::Cancelled);
            set_failure(&mut failure, "PDPP connector was cancelled by the runtime");
            terminate_child(&mut child);
        }
        if termination.is_none() && options.timeout.is_some_and(|t| started.elapsed() >= t) {
            termination = Some(PdppRunStatus::TimedOut);
            set_failure(&mut failure, "PDPP connector exceeded its runtime timeout");
            terminate_child(&mut child);
        }
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(ReaderEvent::Stdout(Ok(line))) => {
                if done.is_some() {
                    set_failure(&mut failure, "PDPP connector emitted a message after DONE");
                    terminate_child(&mut child);
                    continue;
                }
                match parse_message(&line, &scope) {
                    Ok(ConnectorMessage::Record(record)) => {
                        record_count += 1;
                        event_counts.records += 1;
                        dispatch(
                            &options.on_event,
                            PdppEvent::Record(record.clone()),
                            &mut failure,
                        );
                        if records.len() < options.max_retained_records {
                            records.push(record);
                        } else if options.on_event.is_some() {
                            records_truncated = true;
                        } else {
                            set_failure(
                                &mut failure,
                                "PDPP record retention limit exceeded without an event sink",
                            );
                            terminate_child(&mut child);
                        }
                    }
                    Ok(ConnectorMessage::State(state)) => {
                        event_counts.checkpoint_updates += 1;
                        dispatch(
                            &options.on_event,
                            PdppEvent::State(state.clone()),
                            &mut failure,
                        );
                        checkpoints.insert(state.stream, state.cursor);
                    }
                    Ok(ConnectorMessage::Progress(progress)) => {
                        event_counts.progress += 1;
                        retain_event(
                            options,
                            PdppEvent::Progress(progress),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        )
                    }
                    Ok(ConnectorMessage::SkipResult(skip)) => {
                        event_counts.skip_results += 1;
                        retain_event(
                            options,
                            PdppEvent::SkipResult(skip),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        )
                    }
                    Ok(ConnectorMessage::DetailCoverage(coverage)) => {
                        event_counts.detail_coverage += 1;
                        retain_event(
                            options,
                            PdppEvent::DetailCoverage(coverage),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        )
                    }
                    Ok(ConnectorMessage::DetailGap(gap)) => {
                        event_counts.detail_gaps += 1;
                        retain_event(
                            options,
                            PdppEvent::DetailGap(gap),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        )
                    }
                    Ok(ConnectorMessage::DetailGapRecovered(recovered)) => {
                        event_counts.detail_gaps_recovered += 1;
                        retain_event(
                            options,
                            PdppEvent::DetailGapRecovered(recovered),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        )
                    }
                    Ok(ConnectorMessage::Interaction(interaction)) => {
                        event_counts.interactions += 1;
                        retain_event(
                            &options,
                            PdppEvent::Interaction(interaction),
                            &mut events,
                            &mut events_truncated,
                            &mut failure,
                        );
                        set_failure(&mut failure, "PDPP INTERACTION requires an INTERACTION_RESPONSE API, which this foundation kernel does not provide");
                        terminate_child(&mut child);
                    }
                    Ok(ConnectorMessage::Done(message)) => done = Some(message),
                    Err(error) => {
                        set_failure(&mut failure, error);
                        terminate_child(&mut child);
                    }
                }
                if failure.is_some() {
                    terminate_child(&mut child);
                }
            }
            Ok(ReaderEvent::Stdout(Err(error))) => {
                set_failure(&mut failure, error);
                terminate_child(&mut child);
            }
            Ok(ReaderEvent::StdoutClosed) => stdout_closed = true,
            Ok(ReaderEvent::Stderr(Line::Text(line))) => append_stderr(
                &mut stderr_text,
                &mut stderr_truncated,
                options.max_stderr_bytes,
                &line,
            ),
            Ok(ReaderEvent::Stderr(Line::TooLong)) => {
                stderr_truncated = true;
                append_stderr(
                    &mut stderr_text,
                    &mut stderr_truncated,
                    options.max_stderr_bytes,
                    "<stderr line exceeded limit>",
                );
            }
            Ok(ReaderEvent::Stderr(Line::End)) => stderr_closed = true,
            Ok(ReaderEvent::StderrClosed) => stderr_closed = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stdout_closed = true;
                stderr_closed = true;
            }
        }
    }
    let exit = match exit {
        Some(exit) => exit,
        None => child
            .wait()
            .map_err(|e| format!("Failed to wait for PDPP connector: {e}"))?,
    };
    if stdout_thread.join().is_err() {
        set_failure(&mut failure, "PDPP stdout reader terminated unexpectedly");
    }
    if stderr_thread.join().is_err() {
        set_failure(&mut failure, "PDPP stderr reader terminated unexpectedly");
    }
    let exit_code = exit.code();
    match done.as_ref() {
        None => set_failure(
            &mut failure,
            "PDPP connector exited without a terminal DONE message",
        ),
        Some(done) if done.records_emitted != record_count => set_failure(
            &mut failure,
            format!(
                "PDPP DONE records_emitted {} does not match observed RECORD count {record_count}",
                done.records_emitted
            ),
        ),
        Some(done) if done.status == PdppDoneStatus::Succeeded && exit_code != Some(0) => {
            set_failure(
                &mut failure,
                format!("PDPP connector succeeded but exited with status {exit_code:?}"),
            )
        }
        Some(done) if done.status != PdppDoneStatus::Succeeded && exit_code == Some(0) => {
            set_failure(
                &mut failure,
                "PDPP connector reported failed/cancelled DONE but exited zero",
            )
        }
        _ => {}
    }
    let status = termination.unwrap_or_else(|| match done.as_ref().map(|d| &d.status) {
        Some(PdppDoneStatus::Succeeded) if failure.is_none() => PdppRunStatus::Succeeded,
        Some(PdppDoneStatus::Cancelled) => PdppRunStatus::Cancelled,
        _ => PdppRunStatus::Failed,
    });
    Ok(PdppRunResult {
        status,
        record_count,
        records,
        records_truncated,
        checkpoints,
        events,
        events_truncated,
        event_counts,
        done,
        stderr: stderr_text,
        stderr_truncated,
        exit_code,
        failure,
    })
}

fn scope_policy(
    start: &PdppStart,
    validators: &PdppScopeValidators,
) -> Result<ScopePolicy, String> {
    let scope: Scope = serde_json::from_value(start.scope.clone())
        .map_err(|e| format!("Invalid PDPP START scope: {e}"))?;
    if scope.streams.is_empty() {
        return Err("PDPP START scope requires at least one stream".into());
    }
    let mut streams = HashMap::new();
    for stream in scope.streams {
        if stream.name.is_empty() || stream.name == "*" || streams.contains_key(&stream.name) {
            return Err("PDPP START scope streams must have unique concrete names".into());
        }
        let resources = stream.resources.map(|values| values.into_iter().collect());
        let fields = stream.fields.map(|values| values.into_iter().collect());
        let time_range = match stream.time_range {
            None => None,
            Some(range) => {
                let field = validators.consent_time_fields.get(&stream.name).cloned().ok_or_else(|| format!("PDPP time_range for {} requires a manifest consent_time_field validator", stream.name))?;
                let since = parse_time(range.since, "since")?;
                let until = parse_time(range.until, "until")?;
                if since.is_none() && until.is_none() {
                    return Err("PDPP time_range requires since or until".into());
                }
                if since
                    .as_ref()
                    .zip(until.as_ref())
                    .is_some_and(|(since, until)| since >= until)
                {
                    return Err("PDPP time_range since must precede until".into());
                }
                Some((since, until, field))
            }
        };
        let required_fields = validators
            .ingest_required_fields
            .get(&stream.name)
            .cloned()
            .unwrap_or_default();
        streams.insert(
            stream.name,
            StreamPolicy {
                resources,
                fields,
                required_fields,
                time_range,
            },
        );
    }
    Ok(ScopePolicy { streams })
}
fn parse_time(value: Option<String>, name: &str) -> Result<Option<DateTime<FixedOffset>>, String> {
    value
        .map(|v| {
            DateTime::parse_from_rfc3339(&v)
                .map_err(|_| format!("PDPP time_range {name} must be RFC 3339"))
        })
        .transpose()
}

fn parse_message(line: &str, scope: &ScopePolicy) -> Result<ConnectorMessage, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| format!("Malformed PDPP connector JSONL message: {e}"))?;
    let ty = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("PDPP connector message requires a string type")?;
    match ty {
        "RECORD" => {
            let record: PdppRecord =
                serde_json::from_value(value).map_err(|e| format!("Invalid PDPP RECORD: {e}"))?;
            validate_record(&record, scope)?;
            Ok(ConnectorMessage::Record(record))
        }
        "STATE" => {
            let state: PdppState =
                serde_json::from_value(value).map_err(|e| format!("Invalid PDPP STATE: {e}"))?;
            if state.stream.is_empty()
                || !state.cursor.is_object()
                || !scope.streams.contains_key(&state.stream)
            {
                return Err("Invalid PDPP STATE for declared scope".into());
            }
            Ok(ConnectorMessage::State(state))
        }
        "DONE" => serde_json::from_value(value)
            .map(ConnectorMessage::Done)
            .map_err(|e| format!("Invalid PDPP DONE: {e}")),
        "PROGRESS" => {
            let progress: PdppProgress =
                serde_json::from_value(value).map_err(|e| format!("Invalid PDPP PROGRESS: {e}"))?;
            validate_optional_stream(progress.stream.as_deref(), scope)?;
            Ok(ConnectorMessage::Progress(progress))
        }
        "SKIP_RESULT" => {
            let skip: PdppSkipResult = serde_json::from_value(value)
                .map_err(|e| format!("Invalid PDPP SKIP_RESULT: {e}"))?;
            validate_optional_stream(skip.stream.as_deref(), scope)?;
            Ok(ConnectorMessage::SkipResult(skip))
        }
        "DETAIL_COVERAGE" => {
            validate_reference_evidence(&value, ty, scope)?;
            Ok(ConnectorMessage::DetailCoverage(value))
        }
        "DETAIL_GAP" => {
            validate_reference_evidence(&value, ty, scope)?;
            Ok(ConnectorMessage::DetailGap(value))
        }
        "DETAIL_GAP_RECOVERED" => {
            validate_reference_evidence(&value, ty, scope)?;
            Ok(ConnectorMessage::DetailGapRecovered(value))
        }
        "INTERACTION" => serde_json::from_value(value)
            .map(ConnectorMessage::Interaction)
            .map_err(|e| format!("Invalid PDPP INTERACTION: {e}")),
        _ => Err(format!("Unsupported PDPP connector message type: {ty}")),
    }
}

fn validate_reference_evidence(value: &Value, ty: &str, scope: &ScopePolicy) -> Result<(), String> {
    let stream = value
        .get("stream")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid PDPP {ty}: stream is required"))?;
    validate_optional_stream(Some(stream), scope)?;
    if value.get("reference_only").and_then(Value::as_bool) != Some(true) {
        return Err(format!("Invalid PDPP {ty}: reference_only must be true"));
    }
    match ty {
        "DETAIL_COVERAGE" => {
            let state_stream = value
                .get("state_stream")
                .and_then(Value::as_str)
                .ok_or("Invalid PDPP DETAIL_COVERAGE: state_stream is required")?;
            validate_optional_stream(Some(state_stream), scope)?;
            for field in ["required_keys", "hydrated_keys"] {
                if !value.get(field).is_some_and(Value::is_array) {
                    return Err(format!(
                        "Invalid PDPP DETAIL_COVERAGE: {field} must be an array"
                    ));
                }
            }
            for field in ["considered", "covered"] {
                if value
                    .get(field)
                    .is_some_and(|count| count.as_u64().is_none())
                {
                    return Err(format!(
                        "Invalid PDPP DETAIL_COVERAGE: {field} must be a non-negative integer"
                    ));
                }
            }
        }
        "DETAIL_GAP" => {
            if !value.get("detail_locator").is_some_and(Value::is_object)
                || value.get("record_key").is_none()
                || value.get("retryable").and_then(Value::as_bool) != Some(true)
                || value.get("status").and_then(Value::as_str) != Some("pending")
            {
                return Err("Invalid PDPP DETAIL_GAP envelope".into());
            }
        }
        "DETAIL_GAP_RECOVERED" => {
            if value
                .get("gap_id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("Invalid PDPP DETAIL_GAP_RECOVERED: gap_id is required".into());
            }
        }
        _ => unreachable!("reference evidence type was matched before validation"),
    }
    Ok(())
}
fn validate_optional_stream(stream: Option<&str>, scope: &ScopePolicy) -> Result<(), String> {
    if stream.is_some_and(|stream| !scope.streams.contains_key(stream)) {
        return Err("PDPP message stream is outside START scope".into());
    }
    Ok(())
}
fn validate_record(record: &PdppRecord, scope: &ScopePolicy) -> Result<(), String> {
    if record.stream.is_empty()
        || !record.data.is_object()
        || record.emitted_at.is_empty()
        || record
            .op
            .as_deref()
            .is_some_and(|op| !matches!(op, "upsert" | "delete"))
    {
        return Err("Invalid PDPP RECORD envelope".into());
    }
    let key = canonical_key(&record.key)?;
    let stream = scope
        .streams
        .get(&record.stream)
        .ok_or("PDPP RECORD stream is outside START scope")?;
    if stream
        .resources
        .as_ref()
        .is_some_and(|resources| !resources.contains(&key))
    {
        return Err("PDPP RECORD key is outside START resources".into());
    }
    if let Some(fields) = &stream.fields {
        let data = record.data.as_object().ok_or("Invalid PDPP RECORD data")?;
        if data
            .keys()
            .any(|field| !fields.contains(field) && !stream.required_fields.contains(field))
        {
            return Err("PDPP RECORD data contains fields outside START scope".into());
        }
    }
    if let Some((since, until, field)) = &stream.time_range {
        let value = record
            .data
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("PDPP RECORD requires manifest consent_time_field {field}"))?;
        let timestamp = DateTime::parse_from_rfc3339(value)
            .map_err(|_| format!("PDPP RECORD consent_time_field {field} must be RFC 3339"))?;
        if since.as_ref().is_some_and(|start| timestamp < *start)
            || until.as_ref().is_some_and(|end| timestamp >= *end)
        {
            return Err("PDPP RECORD is outside START time_range".into());
        }
    }
    Ok(())
}
fn canonical_key(key: &Value) -> Result<String, String> {
    if let Some(key) = key.as_str() {
        Ok(key.to_string())
    } else if key
        .as_array()
        .is_some_and(|parts| !parts.is_empty() && parts.iter().all(Value::is_string))
    {
        serde_json::to_string(key).map_err(|e| e.to_string())
    } else {
        Err("PDPP RECORD key must be a string or non-empty string array".into())
    }
}
fn dispatch(sink: &Option<PdppEventSink>, event: PdppEvent, failure: &mut Option<String>) {
    if let Some(sink) = sink {
        if let Err(error) = sink(event) {
            set_failure(failure, format!("PDPP event consumer failed: {error}"));
        }
    }
}
fn retain_event(
    options: &PdppRunOptions,
    event: PdppEvent,
    events: &mut Vec<PdppEvent>,
    truncated: &mut bool,
    failure: &mut Option<String>,
) {
    dispatch(&options.on_event, event.clone(), failure);
    if events.len() < options.max_retained_events {
        events.push(event);
    } else {
        *truncated = true;
    }
}
fn set_failure(failure: &mut Option<String>, message: impl Into<String>) {
    if failure.is_none() {
        *failure = Some(message.into());
    }
}
fn append_stderr(output: &mut String, truncated: &mut bool, limit: usize, line: &str) {
    let needed = line.len() + usize::from(!output.is_empty());
    if output.len().saturating_add(needed) > limit {
        *truncated = true;
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(line);
}
fn terminate_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
}
fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
    stdout: bool,
    sender: mpsc::Sender<ReaderEvent>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        loop {
            match read_line(&mut reader, limit, stdout) {
                Ok(Line::Text(line)) => {
                    let event = if stdout {
                        ReaderEvent::Stdout(Ok(line))
                    } else {
                        ReaderEvent::Stderr(Line::Text(line))
                    };
                    if sender.send(event).is_err() {
                        break;
                    }
                }
                Ok(Line::TooLong) => {
                    let event = if stdout {
                        ReaderEvent::Stdout(
                            Err("PDPP stdout line exceeded configured limit".into()),
                        )
                    } else {
                        ReaderEvent::Stderr(Line::TooLong)
                    };
                    let _ = sender.send(event);
                    if stdout {
                        break;
                    }
                }
                Ok(Line::End) => break,
                Err(error) => {
                    if stdout {
                        let _ = sender.send(ReaderEvent::Stdout(Err(format!(
                            "Failed to read PDPP stdout: {error}"
                        ))));
                    }
                    break;
                }
            }
        }
        let _ = sender.send(if stdout {
            ReaderEvent::StdoutClosed
        } else {
            ReaderEvent::StderrClosed
        });
    })
}
fn read_line<R: Read>(reader: &mut R, limit: usize, strict_utf8: bool) -> std::io::Result<Line> {
    let mut bytes = Vec::new();
    let mut over = false;
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte)? {
            0 => {
                return if bytes.is_empty() && !over {
                    Ok(Line::End)
                } else if over {
                    Ok(Line::TooLong)
                } else {
                    decode_line(bytes, strict_utf8)
                }
            }
            _ if byte[0] == b'\n' => {
                return if over {
                    Ok(Line::TooLong)
                } else {
                    decode_line(bytes, strict_utf8)
                }
            }
            _ if bytes.len() < limit => bytes.push(byte[0]),
            _ => over = true,
        }
    }
}

fn decode_line(bytes: Vec<u8>, strict_utf8: bool) -> std::io::Result<Line> {
    if strict_utf8 {
        String::from_utf8(bytes).map(Line::Text).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "PDPP stdout is not valid UTF-8",
            )
        })
    } else {
        Ok(Line::Text(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn start(scope: Value) -> PdppStart {
        PdppStart::new(
            "run_test",
            "incremental",
            scope,
            None,
            json!({"network": {}}),
        )
        .unwrap()
    }
    fn scoped() -> PdppStart {
        start(
            json!({"streams":[{"name":"items","resources":["item-1"],"fields":["id"],"time_range":{"since":"2026-01-01T00:00:00Z","until":"2027-01-01T00:00:00Z"}}]}),
        )
    }
    fn fixture(mode: &str) -> PdppConnectorCommand {
        PdppConnectorCommand {
            program: "node".into(),
            args: vec![
                format!(
                    "{}/tests/fixtures/pdpp-connector-fixture.mjs",
                    env!("CARGO_MANIFEST_DIR")
                ),
                mode.into(),
            ],
            cwd: None,
            env: HashMap::new(),
            clear_env: false,
        }
    }
    fn options() -> PdppRunOptions {
        let mut options = PdppRunOptions {
            max_retained_records: 4,
            ..Default::default()
        };
        options
            .scope_validators
            .consent_time_fields
            .insert("items".into(), "source_updated_at".into());
        options.scope_validators.ingest_required_fields.insert(
            "items".into(),
            ["source_updated_at".into()].into_iter().collect(),
        );
        options
    }
    #[test]
    fn accepts_scoped_success_and_retains_bounded_output() {
        let result = supervise_pdpp_connector(&fixture("success"), &scoped(), &options()).unwrap();
        assert_eq!(result.status, PdppRunStatus::Succeeded);
        assert_eq!(result.record_count, 1);
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.checkpoints["items"], json!({"cursor":"next"}));
        assert_eq!(result.stderr, "fixture diagnostic");
    }
    #[test]
    fn rejects_malformed_duplicate_and_missing_done() {
        for mode in ["malformed", "duplicate-done", "missing-done"] {
            let result = supervise_pdpp_connector(&fixture(mode), &scoped(), &options()).unwrap();
            assert_eq!(result.status, PdppRunStatus::Failed, "{mode}");
        }
    }
    #[test]
    fn rejects_counter_scope_field_and_resource_violations() {
        for mode in [
            "counter-mismatch",
            "undeclared-stream",
            "extra-field",
            "wrong-resource",
        ] {
            let result = supervise_pdpp_connector(&fixture(mode), &scoped(), &options()).unwrap();
            assert_eq!(result.status, PdppRunStatus::Failed, "{mode}");
        }
    }
    #[test]
    fn accepts_exact_compound_key_encoding() {
        let start =
            start(json!({"streams":[{"name":"items","resources":["[\"user-1\",\"item-1\"]"]}]}));
        let result = supervise_pdpp_connector(
            &fixture("compound-key"),
            &start,
            &PdppRunOptions {
                max_retained_records: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::Succeeded);
    }
    #[test]
    fn fails_closed_without_time_field_validator() {
        let result =
            supervise_pdpp_connector(&fixture("success"), &scoped(), &PdppRunOptions::default());
        assert!(result.unwrap_err().contains("consent_time_field"));
    }
    #[test]
    fn supports_progress_and_skip_and_reports_interaction() {
        let ok = supervise_pdpp_connector(&fixture("events"), &scoped(), &options()).unwrap();
        assert_eq!(ok.status, PdppRunStatus::Succeeded);
        assert_eq!(ok.events.len(), 2);
        let interaction =
            supervise_pdpp_connector(&fixture("interaction"), &scoped(), &options()).unwrap();
        assert_eq!(interaction.status, PdppRunStatus::Failed);
        assert!(interaction
            .failure
            .unwrap()
            .contains("INTERACTION_RESPONSE"));
    }
    #[test]
    fn requires_a_sink_or_positive_record_retention_before_spawning() {
        let result = supervise_pdpp_connector(
            &fixture("success"),
            &scoped(),
            &PdppRunOptions {
                max_retained_records: 0,
                ..options()
            },
        );
        assert!(result
            .unwrap_err()
            .contains("event sink or positive record retention"));
    }
    #[test]
    fn fails_when_unsunk_record_retention_is_exceeded() {
        let result = supervise_pdpp_connector(
            &fixture("two-records"),
            &scoped(),
            &PdppRunOptions {
                max_retained_records: 1,
                ..options()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::Failed);
        assert!(result.failure.unwrap().contains("retention limit exceeded"));
    }
    #[test]
    fn reports_record_truncation_when_a_sink_consumes_records() {
        let sink: PdppEventSink = Arc::new(|_| Ok(()));
        let result = supervise_pdpp_connector(
            &fixture("two-records"),
            &scoped(),
            &PdppRunOptions {
                max_retained_records: 1,
                on_event: Some(sink),
                ..options()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::Succeeded);
        assert!(result.records_truncated);
    }
    #[test]
    fn bounds_stdout_stderr_and_handles_terminal_exit_statuses() {
        let mut limits = options();
        limits.max_stdout_line_bytes = 32;
        let oversized =
            supervise_pdpp_connector(&fixture("oversized-stdout"), &scoped(), &limits).unwrap();
        assert_eq!(oversized.status, PdppRunStatus::Failed);
        let invalid_utf8 =
            supervise_pdpp_connector(&fixture("invalid-utf8-stdout"), &scoped(), &options())
                .unwrap();
        assert_eq!(invalid_utf8.status, PdppRunStatus::Failed);
        assert!(invalid_utf8.failure.unwrap().contains("not valid UTF-8"));
        let mut stderr = options();
        stderr.max_stderr_bytes = 16;
        let bounded =
            supervise_pdpp_connector(&fixture("oversized-stderr"), &scoped(), &stderr).unwrap();
        assert!(bounded.stderr_truncated);
        for mode in ["failed-done", "cancelled-done", "nonzero-success"] {
            let result = supervise_pdpp_connector(&fixture(mode), &scoped(), &options()).unwrap();
            assert_ne!(result.status, PdppRunStatus::Succeeded, "{mode}");
        }
    }
    #[test]
    fn cancels_and_times_out_a_sleeping_connector() {
        let control = PdppRunControl::default();
        let cancellation = control.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            cancellation.cancel();
        });
        let cancelled = supervise_pdpp_connector(
            &fixture("sleep"),
            &scoped(),
            &PdppRunOptions {
                control,
                ..options()
            },
        )
        .unwrap();
        assert_eq!(cancelled.status, PdppRunStatus::Cancelled);
        let timed_out = supervise_pdpp_connector(
            &fixture("sleep"),
            &scoped(),
            &PdppRunOptions {
                timeout: Some(Duration::from_millis(20)),
                ..options()
            },
        )
        .unwrap();
        assert_eq!(timed_out.status, PdppRunStatus::TimedOut);
    }
    #[test]
    fn preserves_optional_skip_result_fields() {
        let scope = scope_policy(&scoped(), &options().scope_validators).unwrap();
        assert!(parse_message(
            r#"{"type":"SKIP_RESULT","stream":"items","reason":"rate_limited","message":"retry later"}"#,
            &scope,
        )
        .is_ok());
        assert!(parse_message(
            r#"{"type":"SKIP_RESULT","stream":"items","reason":"rate_limited"}"#,
            &scope,
        )
        .is_ok());
    }
    #[test]
    fn accepts_scoped_reference_evidence_and_rejects_invalid_envelopes() {
        let scope = scope_policy(&scoped(), &options().scope_validators).unwrap();
        assert!(matches!(
            parse_message(
                r#"{"type":"DETAIL_COVERAGE","stream":"items","state_stream":"items","required_keys":[],"hydrated_keys":[],"considered":1,"reference_only":true}"#,
                &scope,
            ),
            Ok(ConnectorMessage::DetailCoverage(_))
        ));
        assert!(matches!(
            parse_message(
                r#"{"type":"DETAIL_GAP","stream":"items","record_key":"item-1","detail_locator":{"kind":"api"},"reason":"temporary_unavailable","retryable":true,"status":"pending","reference_only":true}"#,
                &scope,
            ),
            Ok(ConnectorMessage::DetailGap(_))
        ));
        assert!(matches!(
            parse_message(
                r#"{"type":"DETAIL_GAP_RECOVERED","stream":"items","gap_id":"gap-1","reference_only":true}"#,
                &scope,
            ),
            Ok(ConnectorMessage::DetailGapRecovered(_))
        ));
        assert!(parse_message(
            r#"{"type":"DETAIL_COVERAGE","stream":"outside","state_stream":"items","required_keys":[],"hydrated_keys":[],"reference_only":true}"#,
            &scope,
        )
        .is_err());
        assert!(parse_message(
            r#"{"type":"DETAIL_GAP","stream":"items","record_key":"item-1","detail_locator":{},"retryable":false,"status":"pending","reference_only":true}"#,
            &scope,
        )
        .is_err());
    }
    #[test]
    fn strictly_decodes_stdout_and_lossily_decodes_stderr() {
        assert!(read_line(&mut &b"\xff\n"[..], 16, true).is_err());
        assert!(matches!(
            read_line(&mut &b"\xff\n"[..], 16, false).unwrap(),
            Line::Text(_)
        ));
    }
    #[cfg(unix)]
    #[test]
    fn unix_process_group_termination_kills_a_grandchild() {
        let marker = tempfile::NamedTempFile::new().unwrap();
        let marker_path = marker.path().to_string_lossy().into_owned();
        let command = PdppConnectorCommand {
            program: "node".into(),
            args: vec![
                format!(
                    "{}/tests/fixtures/pdpp-connector-fixture.mjs",
                    env!("CARGO_MANIFEST_DIR")
                ),
                "grandchild-sleep".into(),
                marker_path.clone(),
            ],
            cwd: None,
            env: HashMap::new(),
            clear_env: false,
        };
        let result = supervise_pdpp_connector(
            &command,
            &scoped(),
            &PdppRunOptions {
                timeout: Some(Duration::from_millis(100)),
                ..options()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::TimedOut);
        thread::sleep(Duration::from_millis(300));
        assert!(std::fs::read_to_string(marker.path()).unwrap().is_empty());
    }
}
