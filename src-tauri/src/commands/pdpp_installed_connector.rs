//! Host route for installed PDPP Collection Profile connector artifacts.
//!
//! This module is intentionally narrow: it resolves an active installed
//! `pdpp-collection-profile` artifact, validates the manifest-derived network
//! capability, then delegates process supervision to the PDPP connector kernel.

use super::connector_store::{get_active_connector_install, ActiveConnectorInstall};
use super::pdpp_browser::{PdppBrowserBinding, PdppBrowserLease};
use super::pdpp_collection_state::{
    clear_connection_setup_complete, commit_terminal_run, is_connection_setup_complete,
    load_connection_state, mark_connection_setup_complete, stage_succeeded_run,
    PdppCollectionConnectionState, DEFAULT_CONNECTION_ID,
};
use super::pdpp_connector::{
    supervise_pdpp_connector, PdppConnectorCommand, PdppEvent, PdppInteractionResponder,
    PdppInteractionResponseStatus, PdppRecord, PdppRunControl, PdppRunOptions, PdppRunResult,
    PdppRunStatus, PdppScopeValidators, PdppStart,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const PDPP_ARTIFACT_KIND: &str = "pdpp-collection-profile";
const DEFAULT_TIMEOUT_SECONDS: u64 = 120;
const MAX_TIMEOUT_SECONDS: u64 = 900;
const MAX_RUN_ID_BYTES: usize = 128;
const MINIMUM_NODE_MAJOR: u64 = 22;
const BUNDLED_NODE_NAME: &str = if cfg!(windows) {
    "pdpp-node.exe"
} else {
    "pdpp-node"
};
const CLEANUP_WAIT: Duration = Duration::from_secs(2);
const GITHUB_CONNECTOR_KEY: &str = "github";
const GITHUB_CONNECTOR_ID: &str = "https://registry.pdpp.org/connectors/github";
const CHATGPT_CONNECTOR_KEY: &str = "chatgpt";
const CHATGPT_CONNECTOR_ID: &str = "https://registry.pdpp.org/connectors/chatgpt";
const CHATGPT_CONNECTOR_INSTALL_ID: &str = "chatgpt-pdpp";
static ACTIVE_PDPP_RUNS: LazyLock<Mutex<HashMap<String, ActivePdppRun>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING_PDPP_INTERACTIONS: LazyLock<
    Mutex<HashMap<(String, String), PdppInteractionResponder>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A run remains registered until its child-supervision task has returned.
/// Keeping connector identity alongside the cancellation control makes the
/// one-live-run-per-installed-connector policy atomic with registration.
#[derive(Clone)]
struct ActivePdppRun {
    connector_id: String,
    connection_id: String,
    control: PdppRunControl,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInstalledPdppConnectorRequest {
    pub run_id: String,
    pub connector_id: String,
    #[serde(default = "default_collection_mode")]
    pub collection_mode: String,
    #[serde(default)]
    pub streams: Vec<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub github_token: Option<String>,
    /// The pinned ChatGPT profile declares exactly two static-secret fields.
    /// They are accepted for this invocation only and never enter run state,
    /// export data, or a command response.
    #[serde(default)]
    pub setup_secrets: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPdppConnectorRunResponse {
    pub run_id: String,
    pub connector_id: String,
    pub status: String,
    pub record_count: u64,
    pub checkpoints: HashMap<String, Value>,
    pub event_summary: PdppEventSummary,
    pub progress: Vec<SanitizedConnectorMessage>,
    pub records_truncated: bool,
    pub events_truncated: bool,
    pub failure: Option<String>,
    pub stderr_bytes: usize,
    pub stderr_truncated: bool,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdppEventSummary {
    pub records: u64,
    pub checkpoint_updates: u64,
    pub checkpoint_streams: u64,
    pub progress: u64,
    pub skip_results: u64,
    pub detail_coverage: u64,
    pub detail_gaps: u64,
    pub detail_gaps_recovered: u64,
    pub interactions: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedConnectorMessage {
    pub message_type: String,
    pub stream: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug)]
struct ResolvedInstalledPdppConnector {
    connector_id: String,
    manifest_sha256: String,
    root: PathBuf,
    manifest_path: PathBuf,
    entrypoint_path: PathBuf,
    manifest: PdppConnectorManifest,
}

#[derive(Default)]
struct CommandCustomization {
    node_imports: Vec<PathBuf>,
    max_retained_records: usize,
    control: PdppRunControl,
    on_event: Option<super::pdpp_connector::PdppEventSink>,
    on_interaction: Option<super::pdpp_connector::PdppInteractionSink>,
}

#[derive(Debug, Deserialize)]
struct PdppConnectorManifest {
    connector_id: Option<String>,
    connector_key: Option<String>,
    display_name: Option<String>,
    version: Option<String>,
    runtime_requirements: Option<RuntimeRequirements>,
    setup: Option<PdppStaticSecretSetup>,
    streams: Vec<PdppManifestStream>,
}

#[derive(Debug, Deserialize)]
struct PdppStaticSecretSetup {
    modality: String,
    credential_capture: PdppCredentialCapture,
}

#[derive(Debug, Deserialize)]
struct PdppCredentialCapture {
    fields: Vec<PdppStaticSecretField>,
}

#[derive(Debug, Deserialize)]
struct PdppStaticSecretField {
    name: String,
    required: bool,
    secret: bool,
    #[serde(default)]
    env: Vec<String>,
}

#[derive(Default)]
struct PdppChildSecrets {
    environment: HashMap<String, String>,
    values: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeRequirements {
    bindings: Option<HashMap<String, BindingRequirement>>,
}

#[derive(Debug, Deserialize)]
struct BindingRequirement {
    required: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PdppManifestStream {
    name: String,
    schema: Option<Value>,
    consent_time_field: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PdppArtifactProvenance {
    #[serde(default)]
    external_runtime_packages: Vec<PdppRuntimePackageRequirement>,
}

#[derive(Debug, Deserialize)]
struct PdppRuntimePackageRequirement {
    name: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct NodePackageMetadata {
    version: String,
}

/// The kernel validates every record before this accumulator sees it. Keeping
/// the complete stream here is intentionally distinct from the kernel's small
/// diagnostic retention buffers: the former is the user's export, the latter
/// is bounded operational evidence for the command response.
#[derive(Debug, Clone, Default)]
struct PdppExportAccumulator {
    records_by_stream: HashMap<String, Vec<PdppRecord>>,
    skipped_streams: HashSet<String>,
    has_streamless_skip: bool,
}

struct InstalledPdppRunCompletion {
    response: InstalledPdppConnectorRunResponse,
    export: Option<Value>,
}

fn default_collection_mode() -> String {
    "incremental".into()
}

#[tauri::command]
pub async fn start_installed_pdpp_connector_run(
    app: AppHandle,
    request: StartInstalledPdppConnectorRequest,
) -> Result<InstalledPdppConnectorRunResponse, String> {
    validate_request(&request)?;
    let run_id = request.run_id.clone();
    let control = register_run(&run_id, &request.connector_id, request.connection_id())?;
    emit_running_status(&app, &run_id, "Starting PDPP connector...");
    let app_for_task = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        start_installed_pdpp_connector_run_impl(app_for_task, request, control)
    })
    .await
    .map_err(|e| format!("PDPP connector host task failed: {e}"));
    unregister_run(&run_id);
    match result? {
        Ok(completion) => {
            emit_terminal_status(&app, &completion.response, completion.export.as_ref());
            Ok(completion.response)
        }
        Err(error) => {
            emit_failed_terminal_status(&app, &run_id, &error);
            Err(error)
        }
    }
}

fn start_installed_pdpp_connector_run_impl(
    app: AppHandle,
    request: StartInstalledPdppConnectorRequest,
    control: PdppRunControl,
) -> Result<InstalledPdppRunCompletion, String> {
    validate_request(&request)?;
    let resource_dir = app.path().resource_dir().ok();
    let runtime_root = resolve_pdpp_runtime_root(resource_dir.as_deref())?;
    let resolved = resolve_active_installed_pdpp_connector(&request.connector_id, &runtime_root)?;
    let saved_state = load_connection_state(&resolved.connector_id, request.connection_id())?;
    let setup_complete = chatgpt_setup_complete(&resolved, request.connection_id())?;
    let secrets = resolve_child_secrets_for_connection(&request, &resolved, setup_complete)?;
    let start_state = persisted_start_state(&request, &saved_state);
    let export_accumulator = Arc::new(Mutex::new(PdppExportAccumulator::default()));
    let sink = event_sink_for_run(
        app.clone(),
        request.run_id.clone(),
        export_accumulator.clone(),
        secrets.values.clone(),
    );
    let result = run_resolved_installed_pdpp_connector_with_state(
        &resolved,
        &request,
        CommandCustomization {
            control,
            on_event: Some(sink),
            on_interaction: Some(interaction_sink_for_run(
                app.clone(),
                request.run_id.clone(),
                secrets.values.clone(),
            )),
            ..Default::default()
        },
        &secrets,
        start_state,
        resource_dir,
        runtime_root,
    )?;
    let export = if result.status == PdppRunStatus::Succeeded {
        let accumulated = export_accumulator
            .lock()
            .map_err(|_| "PDPP export accumulator is unavailable")?
            .clone();
        let records_by_stream = accumulated.records_by_stream;
        let selected_streams = selected_streams(&request, &resolved.manifest);
        let snapshot_reset_streams = snapshot_reset_streams(
            &request.collection_mode,
            &selected_streams,
            &accumulated.skipped_streams,
            accumulated.has_streamless_skip,
        );
        let committed_checkpoints = checkpoints_for_commit(
            &result.checkpoints,
            &accumulated.skipped_streams,
            accumulated.has_streamless_skip,
        );
        // Validate the new storage projection before writing its checkpoint.
        // This leaves the prior checkpoint intact if the host cannot make the
        // successfully collected data usable by its current local store.
        let staged = stage_succeeded_run(
            &saved_state,
            &request.collection_mode,
            &snapshot_reset_streams,
            &records_by_stream,
            &committed_checkpoints,
        )?;
        let export = build_export_data(&resolved, &request, &staged, &snapshot_reset_streams)?;
        commit_terminal_run(
            &result.status,
            &resolved.connector_id,
            request.connection_id(),
            &request.collection_mode,
            &snapshot_reset_streams,
            &records_by_stream,
            &committed_checkpoints,
        )?
        .ok_or("PDPP collection state was not committed after a successful run")?;
        // Mark setup only after the credentialed run and its export/state
        // commit have succeeded. A failed launch, login, cancellation, or
        // timeout must leave the next attempt in owner-attended setup.
        if should_mark_chatgpt_setup_complete(&resolved, &request, &result.status) {
            mark_connection_setup_complete(&resolved.connector_id, request.connection_id())?;
        }
        Some(export)
    } else {
        None
    };
    Ok(InstalledPdppRunCompletion {
        response: to_response(
            request.run_id,
            resolved.connector_id,
            result,
            &secrets.values,
        ),
        export,
    })
}

#[cfg(test)]
fn run_resolved_installed_pdpp_connector(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    customization: CommandCustomization,
    secrets: &PdppChildSecrets,
) -> Result<PdppRunResult, String> {
    run_resolved_installed_pdpp_connector_with_state(
        resolved,
        request,
        customization,
        secrets,
        None,
        None,
        resolve_pdpp_runtime_root(None)?,
    )
}

fn run_resolved_installed_pdpp_connector_with_state(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    customization: CommandCustomization,
    secrets: &PdppChildSecrets,
    state: Option<Value>,
    resource_dir: Option<PathBuf>,
    runtime_root: PathBuf,
) -> Result<PdppRunResult, String> {
    validate_request(request)?;
    let browser_lease = if requires_browser(&resolved.manifest) {
        let owner_id = request.connection_id.as_deref().filter(|owner| !owner.is_empty()).ok_or(
            "PDPP browser connector requires an explicit connectionId owner; the default owner is not permitted",
        )?;
        Some(Arc::new(Mutex::new(PdppBrowserLease::launch(
            &resolved.connector_id,
            owner_id,
            &request.run_id,
            resource_dir.as_deref(),
        )?)))
    } else {
        None
    };
    let browser_binding = browser_lease
        .as_ref()
        .map(|lease| {
            lease
                .lock()
                .map_err(|_| "PDPP browser lease is unavailable")
        })
        .transpose()?
        .map(|lease| lease.binding().clone());
    let start = build_start(request, &resolved.manifest, state)?;
    let command = build_command(
        resolved,
        secrets,
        &customization,
        browser_binding.as_ref(),
        &runtime_root,
    )?;
    let host_interaction = customization.on_interaction.clone();
    let browser_for_interaction = browser_lease.clone();
    let options = PdppRunOptions {
        timeout: Some(Duration::from_secs(
            request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS),
        )),
        scope_validators: validators_from_manifest(&resolved.manifest),
        max_retained_records: customization.max_retained_records,
        max_retained_events: 64,
        on_event: Some(
            customization
                .on_event
                .unwrap_or_else(|| Arc::new(|_| Ok(()))),
        ),
        control: customization.control,
        on_interaction: host_interaction.map(|host_interaction| {
            Arc::new(
                move |interaction: &super::pdpp_connector::PdppInteraction, responder| {
                    if let Some(lease) = &browser_for_interaction {
                        lease
                            .lock()
                            .map_err(|_| "PDPP browser lease is unavailable")?
                            .mark_waiting_for_user();
                    }
                    host_interaction(interaction, responder)
                },
            ) as super::pdpp_connector::PdppInteractionSink
        }),
        on_interaction_closed: Some(interaction_closed_sink_for_run(request.run_id.clone())),
        ..Default::default()
    };
    let mut result = supervise_pdpp_connector(&command, &start, &options);
    if let (Ok(result), Some(binding)) = (&mut result, browser_binding.as_ref()) {
        redact_browser_endpoint(result, &binding.cdp_http_url);
    }
    if let Some(lease) = browser_lease {
        if let Ok(mut lease) = lease.lock() {
            lease.close();
        }
    }
    result
}

fn redact_browser_endpoint(result: &mut PdppRunResult, endpoint: &str) {
    if endpoint.is_empty() {
        return;
    }
    result.stderr = result
        .stderr
        .replace(endpoint, "[REDACTED_BROWSER_ENDPOINT]");
    if let Some(failure) = &mut result.failure {
        *failure = failure.replace(endpoint, "[REDACTED_BROWSER_ENDPOINT]");
    }
    for event in &mut result.events {
        match event {
            PdppEvent::Progress(progress) => {
                progress.message = progress
                    .message
                    .replace(endpoint, "[REDACTED_BROWSER_ENDPOINT]");
            }
            PdppEvent::SkipResult(skip) => {
                if let Some(message) = &mut skip.message {
                    *message = message.replace(endpoint, "[REDACTED_BROWSER_ENDPOINT]");
                }
            }
            PdppEvent::Interaction(interaction) => {
                interaction.message = interaction
                    .message
                    .replace(endpoint, "[REDACTED_BROWSER_ENDPOINT]");
            }
            _ => {}
        }
    }
}

#[cfg(test)]
fn run_resolved_installed_pdpp_connector_for_test(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    node_imports: Vec<PathBuf>,
) -> Result<PdppRunResult, String> {
    run_resolved_installed_pdpp_connector(
        resolved,
        request,
        CommandCustomization {
            node_imports,
            max_retained_records: 256,
            ..Default::default()
        },
        &resolve_child_secrets(request, resolved)?,
    )
}

fn register_run(
    run_id: &str,
    connector_id: &str,
    connection_id: &str,
) -> Result<PdppRunControl, String> {
    let mut runs = ACTIVE_PDPP_RUNS
        .lock()
        .map_err(|_| "PDPP run registry is unavailable")?;
    if runs.contains_key(run_id) {
        return Err(format!("PDPP runId {run_id} is already active"));
    }
    if let Some(active_run_id) = runs.iter().find_map(|(active_run_id, run)| {
        (run.connector_id == connector_id && run.connection_id == connection_id)
            .then_some(active_run_id)
    }) {
        return Err(format!(
            "PDPP connector {connector_id} connection {connection_id} is already active as runId {active_run_id}"
        ));
    }
    let control = PdppRunControl::default();
    runs.insert(
        run_id.to_owned(),
        ActivePdppRun {
            connector_id: connector_id.to_owned(),
            connection_id: connection_id.to_owned(),
            control: control.clone(),
        },
    );
    Ok(control)
}

fn unregister_run(run_id: &str) {
    if let Ok(mut runs) = ACTIVE_PDPP_RUNS.lock() {
        runs.remove(run_id);
    }
    invalidate_pending_interactions_for_run(run_id);
}

fn cancel_run(run_id: &str) -> Result<(), String> {
    let control = ACTIVE_PDPP_RUNS
        .lock()
        .map_err(|_| "PDPP run registry is unavailable")?
        .get(run_id)
        .map(|run| run.control.clone())
        .ok_or_else(|| format!("PDPP runId {run_id} is not active"))?;
    // Remove owner-visible responders before signalling the supervisor. A
    // late Tauri command must not claim success while cancellation is queued.
    invalidate_pending_interactions_for_run(run_id);
    control.cancel();
    Ok(())
}

#[tauri::command]
pub fn stop_installed_pdpp_connector_run(run_id: String) -> Result<(), String> {
    validate_run_id(&run_id)?;
    cancel_run(&run_id)
}

/// Sends one authoritative Collection Profile `INTERACTION_RESPONSE` to the
/// still-pending request for this run. OTP values stay only in this command
/// payload and the child stdin; they are never retained in state, events, or
/// logs.
#[tauri::command]
pub fn submit_installed_pdpp_interaction_response(
    run_id: String,
    request_id: String,
    status: String,
    data: Option<Value>,
) -> Result<(), String> {
    validate_run_id(&run_id)?;
    validate_interaction_request_id(&request_id)?;
    let status = match status.as_str() {
        "success" => PdppInteractionResponseStatus::Success,
        "cancelled" => PdppInteractionResponseStatus::Cancelled,
        "timeout" => PdppInteractionResponseStatus::Timeout,
        _ => {
            return Err(
                "PDPP INTERACTION_RESPONSE status must be success, cancelled, or timeout".into(),
            )
        }
    };
    if data.as_ref().is_some_and(|value| !value.is_object()) {
        return Err("PDPP INTERACTION_RESPONSE data must be an object".into());
    }
    let responder = PENDING_PDPP_INTERACTIONS
        .lock()
        .map_err(|_| "PDPP interaction registry is unavailable")?
        .remove(&(run_id.clone(), request_id.clone()))
        .ok_or("PDPP interaction is no longer pending for this run")?;
    responder.respond(status, data)
}

/// Explicitly disconnects an installed PDPP browser connector by deleting the
/// durable, owner-confined authenticated profile. It refuses while that owner
/// has a live lease, so a reset can never race a collection run.
#[tauri::command]
pub fn reset_installed_pdpp_browser_profile(
    connector_id: String,
    connection_id: String,
) -> Result<(), String> {
    if connector_id != CHATGPT_CONNECTOR_INSTALL_ID {
        return Err("PDPP browser profile reset is only available for ChatGPT".into());
    }
    validate_connection_id(&connection_id)?;
    PdppBrowserLease::reset_profile(&connector_id, &connection_id)?;
    clear_connection_setup_complete(&connector_id, &connection_id)
}

/// A non-secret marker and its durable owner profile are both required before
/// the UI may omit recovery credentials for a scheduled ChatGPT run.
#[tauri::command]
pub fn is_installed_pdpp_browser_setup_complete(
    connector_id: String,
    connection_id: String,
) -> Result<bool, String> {
    if connector_id != CHATGPT_CONNECTOR_INSTALL_ID {
        return Err("PDPP browser setup state is only available for ChatGPT".into());
    }
    validate_connection_id(&connection_id)?;
    Ok(is_connection_setup_complete(&connector_id, &connection_id)?
        && PdppBrowserLease::profile_exists(&connector_id, &connection_id)?)
}

pub fn cleanup_installed_pdpp_connector_runs() {
    let controls = ACTIVE_PDPP_RUNS
        .lock()
        .map(|runs| {
            runs.values()
                .map(|run| run.control.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for control in controls {
        control.cancel();
    }

    let deadline = Instant::now() + CLEANUP_WAIT;
    while Instant::now() < deadline {
        if ACTIVE_PDPP_RUNS.lock().map_or(true, |runs| runs.is_empty()) {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    log::warn!("Timed out waiting for installed PDPP connector runs to stop");
}

fn validate_request(request: &StartInstalledPdppConnectorRequest) -> Result<(), String> {
    validate_run_id(&request.run_id)?;
    if !matches!(
        request.collection_mode.as_str(),
        "full_refresh" | "incremental"
    ) {
        return Err("PDPP collectionMode must be full_refresh or incremental".into());
    }
    if request
        .timeout_seconds
        .is_some_and(|seconds| seconds == 0 || seconds > MAX_TIMEOUT_SECONDS)
    {
        return Err(format!(
            "PDPP timeoutSeconds must be between 1 and {MAX_TIMEOUT_SECONDS}"
        ));
    }
    validate_connection_id(request.connection_id())?;
    Ok(())
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > MAX_RUN_ID_BYTES
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("PDPP runId must be 1-128 URL-safe identifier characters".into());
    }
    Ok(())
}

fn validate_connection_id(connection_id: &str) -> Result<(), String> {
    if connection_id.is_empty()
        || connection_id.len() > MAX_RUN_ID_BYTES
        || !connection_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("PDPP connectionId must be 1-128 URL-safe identifier characters".into());
    }
    Ok(())
}

fn validate_interaction_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > MAX_RUN_ID_BYTES
        || !request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(
            "PDPP interaction requestId must be 1-128 URL-safe identifier characters".into(),
        );
    }
    Ok(())
}

fn persisted_start_state(
    request: &StartInstalledPdppConnectorRequest,
    saved_state: &PdppCollectionConnectionState,
) -> Option<Value> {
    (request.collection_mode == "incremental")
        .then(|| (!saved_state.checkpoints.is_empty()).then(|| json!(saved_state.checkpoints)))
        .flatten()
}

impl StartInstalledPdppConnectorRequest {
    fn connection_id(&self) -> &str {
        self.connection_id
            .as_deref()
            .filter(|connection_id| !connection_id.is_empty())
            .unwrap_or(DEFAULT_CONNECTION_ID)
    }
}

fn resolve_active_installed_pdpp_connector(
    connector_id: &str,
    runtime_root: &Path,
) -> Result<ResolvedInstalledPdppConnector, String> {
    let install = get_active_connector_install(connector_id)
        .ok_or_else(|| format!("PDPP connector {connector_id} is not installed"))?;
    resolve_installed_pdpp_connector_with_runtime(&install, runtime_root)
}

fn resolve_installed_pdpp_connector(
    install: &ActiveConnectorInstall,
) -> Result<ResolvedInstalledPdppConnector, String> {
    let runtime_root = resolve_pdpp_runtime_root(None)?;
    resolve_installed_pdpp_connector_with_runtime(install, &runtime_root)
}

fn resolve_installed_pdpp_connector_with_runtime(
    install: &ActiveConnectorInstall,
    runtime_root: &Path,
) -> Result<ResolvedInstalledPdppConnector, String> {
    if install.artifact_kind.as_deref() != Some(PDPP_ARTIFACT_KIND) {
        return Err(format!(
            "{} is not a PDPP Collection Profile artifact",
            install.connector_id
        ));
    }
    let manifest_relative = install
        .manifest_path
        .as_deref()
        .ok_or("PDPP active install is missing manifestPath")?;
    let entrypoint_relative = install
        .entrypoint_path
        .as_deref()
        .ok_or("PDPP active install is missing entrypointPath")?;
    let root = canonical_existing_dir(Path::new(&install.root_path), "PDPP install root")?;
    let manifest_path = confined_existing_file(&root, manifest_relative, "PDPP manifest path")?;
    let entrypoint_path =
        confined_existing_file(&root, entrypoint_relative, "PDPP entrypoint path")?;
    let provenance_relative = install
        .provenance_path
        .as_deref()
        .ok_or("PDPP active install is missing provenancePath")?;
    let provenance_path =
        confined_existing_file(&root, provenance_relative, "PDPP provenance path")?;
    let manifest_sha256 = required_hash(install.manifest_sha256.as_deref(), "manifestSha256")?;
    verify_file_hash(&manifest_path, Some(manifest_sha256), "PDPP manifest")?;
    verify_file_hash(
        &entrypoint_path,
        Some(required_hash(
            install.entrypoint_sha256.as_deref(),
            "entrypointSha256",
        )?),
        "PDPP entrypoint",
    )?;
    verify_file_hash(
        &provenance_path,
        Some(required_hash(
            install.provenance_sha256.as_deref(),
            "provenanceSha256",
        )?),
        "PDPP provenance",
    )?;
    let manifest: PdppConnectorManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read PDPP connector manifest: {e}"))?,
    )
    .map_err(|e| format!("Failed to parse PDPP connector manifest: {e}"))?;
    validate_manifest(&install.connector_id, &install.version, &manifest)?;
    validate_chatgpt_runtime_requirements(&provenance_path, &manifest, runtime_root)?;
    Ok(ResolvedInstalledPdppConnector {
        connector_id: install.connector_id.clone(),
        manifest_sha256: manifest_sha256.to_owned(),
        root,
        manifest_path,
        entrypoint_path,
        manifest,
    })
}

fn canonical_existing_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("{label} is not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} must be a directory"));
    }
    Ok(canonical)
}

fn confined_existing_file(root: &Path, relative: &str, label: &str) -> Result<PathBuf, String> {
    let rel = validate_relative_path(relative, label)?;
    let joined = root.join(rel);
    let canonical = fs::canonicalize(&joined)
        .map_err(|e| format!("{label} is not accessible within install root: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("{label} escapes the PDPP install root"));
    }
    if !canonical.is_file() {
        return Err(format!("{label} must resolve to a file"));
    }
    Ok(canonical)
}

fn validate_relative_path(path: &str, label: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    let rel = Path::new(path);
    if rel.is_absolute() {
        return Err(format!("{label} must be relative"));
    }
    if rel.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("{label} must stay within the artifact"));
    }
    Ok(rel.to_path_buf())
}

fn validate_manifest(
    connector_id: &str,
    active_version: &str,
    manifest: &PdppConnectorManifest,
) -> Result<(), String> {
    if manifest.streams.is_empty() {
        return Err("PDPP connector manifest must declare at least one stream".into());
    }
    let identity_matches = match manifest.connector_key.as_deref() {
        Some(GITHUB_CONNECTOR_KEY) => {
            connector_id == "github-pdpp"
                && manifest.connector_id.as_deref() == Some(GITHUB_CONNECTOR_ID)
                && !requires_browser(manifest)
        }
        Some(CHATGPT_CONNECTOR_KEY) => {
            connector_id == CHATGPT_CONNECTOR_INSTALL_ID
                && manifest.connector_id.as_deref() == Some(CHATGPT_CONNECTOR_ID)
                && requires_browser(manifest)
                && required_chatgpt_static_secret_fields(manifest).is_ok()
        }
        _ => false,
    };
    if !identity_matches {
        return Err(format!(
            "PDPP connector manifest does not match active install id {connector_id}"
        ));
    }
    if manifest.version.as_deref() != Some(active_version) {
        return Err("PDPP connector manifest version does not match active install".into());
    }
    let bindings = manifest
        .runtime_requirements
        .as_ref()
        .and_then(|requirements| requirements.bindings.as_ref());
    let network_required = bindings
        .and_then(|bindings| bindings.get("network"))
        .and_then(|binding| binding.required)
        .unwrap_or(false);
    if !network_required {
        return Err("PDPP connector manifest must require the network binding".into());
    }
    for (binding, requirement) in bindings.into_iter().flat_map(|bindings| bindings.iter()) {
        if binding != "network" && binding != "browser" && requirement.required.unwrap_or(false) {
            return Err(format!(
                "PDPP connector requires unsupported binding {binding}"
            ));
        }
    }
    let mut stream_names = HashSet::new();
    for stream in &manifest.streams {
        if stream.name.is_empty() || !stream_names.insert(&stream.name) {
            return Err("PDPP connector manifest stream names must be unique".into());
        }
    }
    Ok(())
}

fn required_chatgpt_static_secret_fields(
    manifest: &PdppConnectorManifest,
) -> Result<Vec<(&str, &str)>, String> {
    let setup = manifest
        .setup
        .as_ref()
        .ok_or("ChatGPT PDPP connector must declare setup")?;
    if setup.modality != "static_secret" {
        return Err("ChatGPT PDPP connector must use setup.modality static_secret".into());
    }
    let fields = &setup.credential_capture.fields;
    if fields.len() != 2
        || fields[0].name != "username"
        || !fields[0].required
        || !fields[0].secret
        || fields[0].env != ["CHATGPT_USERNAME"]
        || fields[1].name != "password"
        || !fields[1].required
        || !fields[1].secret
        || fields[1].env != ["CHATGPT_PASSWORD"]
    {
        return Err(
            "ChatGPT PDPP setup must declare only required secret username and password fields"
                .into(),
        );
    }
    Ok(vec![
        ("username", "CHATGPT_USERNAME"),
        ("password", "CHATGPT_PASSWORD"),
    ])
}

fn validate_chatgpt_runtime_requirements(
    provenance_path: &Path,
    manifest: &PdppConnectorManifest,
    runtime_root: &Path,
) -> Result<(), String> {
    if manifest.connector_key.as_deref() != Some(CHATGPT_CONNECTOR_KEY) {
        return Ok(());
    }
    // The distributable tar does not carry build-only artifact.json. The
    // artifact builder copies declared external_packages into signed provenance,
    // whose hash is verified before this parse.
    let provenance: PdppArtifactProvenance = serde_json::from_str(
        &fs::read_to_string(provenance_path)
            .map_err(|error| format!("Failed to read ChatGPT PDPP provenance: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse ChatGPT PDPP provenance: {error}"))?;
    for expected in ["p-queue", "patchright"] {
        let requirement = provenance
            .external_runtime_packages
            .iter()
            .find(|package| package.name == expected)
            .ok_or_else(|| format!("ChatGPT PDPP provenance must declare {expected}"))?;
        let metadata: NodePackageMetadata = serde_json::from_str(
            &fs::read_to_string(confined_existing_file(
                &runtime_root,
                &format!("node_modules/{expected}/package.json"),
                &format!("PDPP runtime dependency {expected}"),
            )?)
            .map_err(|error| {
                format!("Failed to read PDPP runtime dependency {expected}: {error}")
            })?,
        )
        .map_err(|error| format!("Failed to parse PDPP runtime dependency {expected}: {error}"))?;
        if !satisfies_caret_requirement(&metadata.version, &requirement.version) {
            return Err(format!(
                "PDPP runtime dependency {expected}@{} does not satisfy artifact requirement {}",
                metadata.version, requirement.version
            ));
        }
    }
    Ok(())
}

fn satisfies_caret_requirement(installed: &str, requirement: &str) -> bool {
    let Some(required) = requirement.strip_prefix('^').and_then(parse_semver) else {
        return false;
    };
    let Some(installed) = parse_semver(installed) else {
        return false;
    };
    installed.0 == required.0 && installed >= required
}

fn parse_semver(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.split(['-', '+']).next()?.parse().ok()?,
    ))
}

fn build_start(
    request: &StartInstalledPdppConnectorRequest,
    manifest: &PdppConnectorManifest,
    state: Option<Value>,
) -> Result<PdppStart, String> {
    let available: HashSet<&str> = manifest
        .streams
        .iter()
        .map(|stream| stream.name.as_str())
        .collect();
    let selected = selected_streams(request, manifest);
    for stream in &selected {
        if !available.contains(stream.as_str()) {
            return Err(format!(
                "Requested PDPP stream {stream} is not in the connector manifest"
            ));
        }
    }
    let scope = json!({
        "streams": selected.into_iter().map(|name| json!({ "name": name })).collect::<Vec<_>>()
    });
    PdppStart::new(&request.run_id, &request.collection_mode, scope, state)
}

fn requires_browser(manifest: &PdppConnectorManifest) -> bool {
    manifest
        .runtime_requirements
        .as_ref()
        .and_then(|requirements| requirements.bindings.as_ref())
        .and_then(|bindings| bindings.get("browser"))
        .and_then(|binding| binding.required)
        .unwrap_or(false)
}

fn is_chatgpt_connector(manifest: &PdppConnectorManifest) -> bool {
    manifest.connector_key.as_deref() == Some(CHATGPT_CONNECTOR_KEY)
}

fn selected_streams(
    request: &StartInstalledPdppConnectorRequest,
    manifest: &PdppConnectorManifest,
) -> Vec<String> {
    if !request.streams.is_empty() {
        return request.streams.clone();
    }
    manifest
        .streams
        .iter()
        .map(|stream| stream.name.clone())
        .collect()
}

fn snapshot_reset_streams(
    collection_mode: &str,
    selected_streams: &[String],
    skipped_streams: &HashSet<String>,
    has_streamless_skip: bool,
) -> Vec<String> {
    if collection_mode != "full_refresh" || has_streamless_skip {
        return Vec::new();
    }
    selected_streams
        .iter()
        .filter(|stream| !skipped_streams.contains(*stream))
        .cloned()
        .collect()
}

fn checkpoints_for_commit(
    checkpoints: &HashMap<String, Value>,
    skipped_streams: &HashSet<String>,
    has_streamless_skip: bool,
) -> HashMap<String, Value> {
    if has_streamless_skip {
        return HashMap::new();
    }
    checkpoints
        .iter()
        .filter(|(stream, _)| !skipped_streams.contains(*stream))
        .map(|(stream, checkpoint)| (stream.clone(), checkpoint.clone()))
        .collect()
}

fn validators_from_manifest(manifest: &PdppConnectorManifest) -> PdppScopeValidators {
    let mut validators = PdppScopeValidators::default();
    for stream in &manifest.streams {
        if let Some(field) = &stream.consent_time_field {
            validators
                .consent_time_fields
                .insert(stream.name.clone(), field.clone());
        }
        if let Some(required) = stream
            .schema
            .as_ref()
            .and_then(|schema| schema.get("required"))
            .and_then(Value::as_array)
        {
            validators.ingest_required_fields.insert(
                stream.name.clone(),
                required
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
        }
    }
    validators
}

fn resolve_child_secrets(
    request: &StartInstalledPdppConnectorRequest,
    resolved: &ResolvedInstalledPdppConnector,
) -> Result<PdppChildSecrets, String> {
    resolve_child_secrets_for_connection(request, resolved, false)
}

fn resolve_child_secrets_for_connection(
    request: &StartInstalledPdppConnectorRequest,
    resolved: &ResolvedInstalledPdppConnector,
    setup_complete: bool,
) -> Result<PdppChildSecrets, String> {
    let manifest_key = resolved.manifest.connector_key.as_deref().unwrap_or("");
    if manifest_key == CHATGPT_CONNECTOR_KEY {
        if request.github_token.is_some() {
            return Err("githubToken can only be passed to the GitHub PDPP connector".into());
        }
        let expected = required_chatgpt_static_secret_fields(&resolved.manifest)?;
        let Some(provided) = request.setup_secrets.as_ref() else {
            return if setup_complete {
                Ok(PdppChildSecrets::default())
            } else {
                Err("ChatGPT PDPP connector requires setupSecrets.username and setupSecrets.password for first setup or explicit recovery".into())
            };
        };
        if provided.len() != expected.len()
            || expected.iter().any(|(field, _)| {
                provided
                    .get(*field)
                    .is_none_or(|value| value.trim().is_empty())
            })
        {
            return Err(
                "ChatGPT PDPP connector requires only non-empty setupSecrets.username and setupSecrets.password"
                    .into(),
            );
        }
        let mut secrets = PdppChildSecrets::default();
        for (field, environment_key) in expected {
            let value = provided[field].clone();
            secrets.values.push(value.clone());
            secrets
                .environment
                .insert(environment_key.to_owned(), value);
        }
        return Ok(secrets);
    }

    if request.setup_secrets.is_some() {
        return Err("setupSecrets can only be passed to the ChatGPT PDPP connector".into());
    }
    if manifest_key != GITHUB_CONNECTOR_KEY {
        return Err("DataConnect does not support this PDPP connector identity".into());
    }

    let token = resolve_github_credential(request)?;
    let mut secrets = PdppChildSecrets::default();
    secrets.values.push(token.clone());
    secrets
        .environment
        .insert("GITHUB_TOKEN".into(), token.clone());
    secrets
        .environment
        .insert("GITHUB_PERSONAL_ACCESS_TOKEN".into(), token);
    Ok(secrets)
}

fn chatgpt_setup_complete(
    resolved: &ResolvedInstalledPdppConnector,
    connection_id: &str,
) -> Result<bool, String> {
    if !is_chatgpt_connector(&resolved.manifest) {
        return Ok(false);
    }
    is_connection_setup_complete(&resolved.connector_id, connection_id)
}

fn should_mark_chatgpt_setup_complete(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    status: &PdppRunStatus,
) -> bool {
    is_chatgpt_connector(&resolved.manifest)
        && request.setup_secrets.is_some()
        && *status == PdppRunStatus::Succeeded
}

fn resolve_github_credential(
    request: &StartInstalledPdppConnectorRequest,
) -> Result<String, String> {
    if let Some(token) = request
        .github_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        return Ok(token.to_owned());
    }

    // A local desktop UAT may use a shell-provided credential, but release
    // builds cannot silently acquire one. It is only read into the scoped
    // child-process environment and never enters the response or export.
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("PDPP_E2E_GITHUB_TOKEN") {
        if !token.is_empty() {
            return Ok(token);
        }
    }

    Err(
        "GitHub PDPP connector requires githubToken (or PDPP_E2E_GITHUB_TOKEN in a debug build)"
            .into(),
    )
}

fn build_command(
    resolved: &ResolvedInstalledPdppConnector,
    secrets: &PdppChildSecrets,
    customization: &CommandCustomization,
    browser_binding: Option<&PdppBrowserBinding>,
    runtime_root: &Path,
) -> Result<PdppConnectorCommand, String> {
    let mut env = secrets.environment.clone();
    if let Some(binding) = browser_binding {
        if resolved.manifest.connector_key.as_deref() != Some(CHATGPT_CONNECTOR_KEY) {
            return Err("PDPP browser binding is only available to the ChatGPT connector".into());
        }
        // The pinned runtime resolves this documented compatibility seam before it
        // considers an isolated local browser. It is a PDPP runtime concern,
        // unrelated to DataConnect's legacy Playwright page API.
        env.insert(
            "PDPP_CHATGPT_REMOTE_CDP_URL".into(),
            binding.cdp_http_url.clone(),
        );
    }
    env.insert("PDPP_CONNECTOR_NETWORK".into(), "1".into());
    env.insert(
        "PDPP_CONNECTOR_MANIFEST_PATH".into(),
        resolved.manifest_path.to_string_lossy().into_owned(),
    );
    let mut args = Vec::new();
    for import in &customization.node_imports {
        if !import.is_absolute() {
            return Err("PDPP test Node import path must be absolute".into());
        }
        args.push("--import".into());
        args.push(import.to_string_lossy().into_owned());
    }
    args.push("--import".into());
    args.push(
        runtime_root
            .join("connector-loader-bootstrap.mjs")
            .to_string_lossy()
            .into_owned(),
    );
    env.insert(
        "DATACONNECT_PDPP_RUNTIME_ROOT".into(),
        runtime_root.to_string_lossy().into_owned(),
    );
    args.push(resolved.entrypoint_path.to_string_lossy().into_owned());
    Ok(PdppConnectorCommand {
        program: resolve_node_program()?,
        args,
        cwd: Some(resolved.root.clone()),
        env,
        clear_env: true,
    })
}

fn resolve_pdpp_runtime_root(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(resource_dir) = resource_dir {
        let root = resource_dir.join("pdpp-runtime");
        let root = canonical_existing_dir(&root, "PDPP runtime root")?;
        return validate_pdpp_runtime_root(root);
    }
    if let Some(configured) = std::env::var_os("DATACONNECT_PDPP_RUNTIME_ROOT") {
        let root = canonical_existing_dir(Path::new(&configured), "PDPP runtime root")?;
        return validate_pdpp_runtime_root(root);
    }
    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("pdpp-runtime")];
    if let Ok(executable) = std::env::current_exe() {
        if let Some(macos_resources) = executable
            .parent()
            .and_then(Path::parent)
            .map(|contents| contents.join("Resources").join("pdpp-runtime"))
        {
            candidates.push(macos_resources);
        }
        if let Some(executable_dir) = executable.parent() {
            candidates.push(executable_dir.join("pdpp-runtime"));
            candidates.push(executable_dir.join("resources").join("pdpp-runtime"));
        }
    }
    for candidate in candidates {
        if let Ok(root) = canonical_existing_dir(&candidate, "PDPP runtime root") {
            if let Ok(root) = validate_pdpp_runtime_root(root) {
                return Ok(root);
            }
        }
    }
    Err("Packaged PDPP runtime dependencies p-queue and patchright are unavailable".into())
}

fn validate_pdpp_runtime_root(root: PathBuf) -> Result<PathBuf, String> {
    confined_existing_file(&root, "connector-loader.mjs", "PDPP runtime loader")?;
    confined_existing_file(
        &root,
        "connector-loader-bootstrap.mjs",
        "PDPP runtime loader bootstrap",
    )?;
    for package in ["p-queue", "patchright"] {
        confined_existing_file(
            &root,
            &format!("node_modules/{package}/package.json"),
            &format!("PDPP runtime dependency {package}"),
        )?;
    }
    Ok(root)
}

fn event_sink_for_run(
    app: AppHandle,
    run_id: String,
    export_accumulator: Arc<Mutex<PdppExportAccumulator>>,
    secrets: Vec<String>,
) -> super::pdpp_connector::PdppEventSink {
    Arc::new(move |event| match event {
        PdppEvent::Record(record) => {
            if value_contains_any_secret(&record.key, &secrets)
                || value_contains_any_secret(&record.data, &secrets)
            {
                return Err("PDPP connector attempted to emit its credential as data".into());
            }
            let mut collected = export_accumulator
                .lock()
                .map_err(|_| "PDPP export accumulator is unavailable")?;
            collected
                .records_by_stream
                .entry(record.stream.clone())
                .or_default()
                .push(record);
            Ok(())
        }
        PdppEvent::Progress(progress) => {
            emit_running_status(&app, &run_id, &redact_secrets(&progress.message, &secrets));
            Ok(())
        }
        PdppEvent::SkipResult(skip) => {
            let mut collected = export_accumulator
                .lock()
                .map_err(|_| "PDPP export accumulator is unavailable")?;
            if let Some(stream) = skip.stream {
                collected.skipped_streams.insert(stream);
            } else {
                collected.has_streamless_skip = true;
            }
            Ok(())
        }
        // States and detail envelopes are already reflected in the sanitized
        // command response. They are deliberately not copied to the export:
        // the export is the full validated data stream, keyed by scope.
        PdppEvent::State(_)
        | PdppEvent::DetailCoverage(_)
        | PdppEvent::DetailGap(_)
        | PdppEvent::DetailGapRecovered(_) => Ok(()),
        PdppEvent::Interaction(_) => {
            emit_running_status(&app, &run_id, "Waiting for browser interaction...");
            Ok(())
        }
    })
}

fn interaction_sink_for_run(
    app: AppHandle,
    run_id: String,
    secrets: Vec<String>,
) -> super::pdpp_connector::PdppInteractionSink {
    Arc::new(
        move |interaction: &super::pdpp_connector::PdppInteraction, responder| {
            if responder.run_id() != run_id || interaction.request_id != responder.request_id() {
                return Err("PDPP interaction responder is not bound to this run/request".into());
            }
            validate_interaction_request_id(&interaction.request_id)?;
            let key = (run_id.clone(), interaction.request_id.clone());
            PENDING_PDPP_INTERACTIONS
                .lock()
                .map_err(|_| "PDPP interaction registry is unavailable")?
                .insert(key, responder);
            let message = redact_secrets(&interaction.message, &secrets);
            emit_running_status(&app, &run_id, "Waiting for owner interaction...");
            let _ = app.emit(
                "pdpp-interaction",
                json!({
                    "runId": run_id,
                    "requestId": interaction.request_id,
                    "kind": interaction.kind,
                    "message": message,
                    "schema": interaction.schema,
                    "timeoutSeconds": interaction.timeout_seconds,
                }),
            );
            Ok(())
        },
    )
}

fn interaction_closed_sink_for_run(
    run_id: String,
) -> super::pdpp_connector::PdppInteractionClosedSink {
    Arc::new(move |closed_run_id, request_id| {
        if closed_run_id == run_id {
            invalidate_pending_interaction(closed_run_id, request_id);
        }
    })
}

fn invalidate_pending_interaction(run_id: &str, request_id: &str) {
    if let Ok(mut pending) = PENDING_PDPP_INTERACTIONS.lock() {
        pending.remove(&(run_id.to_owned(), request_id.to_owned()));
    }
}

fn invalidate_pending_interactions_for_run(run_id: &str) {
    if let Ok(mut pending) = PENDING_PDPP_INTERACTIONS.lock() {
        pending.retain(|(pending_run_id, _), _| pending_run_id != run_id);
    }
}

fn value_contains_secret(value: &Value, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    match value {
        Value::String(value) => value.contains(secret),
        Value::Array(values) => values
            .iter()
            .any(|value| value_contains_secret(value, secret)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(secret) || value_contains_secret(value, secret)),
        _ => false,
    }
}

fn value_contains_any_secret(value: &Value, secrets: &[String]) -> bool {
    secrets
        .iter()
        .any(|secret| value_contains_secret(value, secret))
}

fn build_export_data(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    collection_state: &PdppCollectionConnectionState,
    snapshot_reset_streams: &[String],
) -> Result<Value, String> {
    let connector_key = resolved
        .manifest
        .connector_key
        .as_deref()
        .ok_or("PDPP connector manifest is missing connector_key")?;
    let connector_id = resolved
        .manifest
        .connector_id
        .as_deref()
        .ok_or("PDPP connector manifest is missing connector_id")?;
    if connector_key != GITHUB_CONNECTOR_KEY && connector_key != CHATGPT_CONNECTOR_KEY {
        return Err(
            "DataConnect does not yet have a storage projection for this PDPP connector".into(),
        );
    }
    let selected_streams = selected_streams(request, &resolved.manifest);
    let records_by_stream = &collection_state.snapshot_by_stream;
    let mut stream_counts = serde_json::Map::new();
    let mut record_count = 0usize;
    let mut projected_scopes = serde_json::Map::new();

    for stream in &selected_streams {
        let records = records_by_stream.get(stream).cloned().unwrap_or_default();
        record_count += records.len();
        stream_counts.insert(stream.clone(), json!(records.len()));
        let projection = match (connector_key, stream.as_str()) {
            // The Personal Server's existing GitHub schemas deliberately use
            // these shapes. This is a DataConnect storage projection, not a
            // claim that the PDPP connector only supports three streams.
            (GITHUB_CONNECTOR_KEY, "user") if !records.is_empty() => {
                Some(("github.profile", project_github_profile(&records)?))
            }
            (GITHUB_CONNECTOR_KEY, "repositories") => Some((
                "github.repositories",
                project_github_repositories(&records)?,
            )),
            (GITHUB_CONNECTOR_KEY, "starred") => {
                Some(("github.starred", project_github_starred(&records)?))
            }
            // Fixture contract: the ChatGPT Collection Profile emits one
            // PDPP record per conversation. Preserve each record's data as
            // supplied; schema-specific normalization belongs upstream.
            (CHATGPT_CONNECTOR_KEY, "conversations") => Some((
                "chatgpt.conversations",
                json!({ "conversations": records.iter().map(|record| record.data.clone()).collect::<Vec<_>>() }),
            )),
            _ => None,
        };
        if let Some((scope, value)) = projection {
            projected_scopes.insert(scope.to_owned(), value);
        }
    }

    let timestamp = chrono::Utc::now().to_rfc3339();
    let requested_scopes = projected_scopes.keys().cloned().collect::<Vec<_>>();
    let mut export = projected_scopes;
    // This is not a serving scope (see METADATA_KEYS in
    // personalServerIngest.ts). It is the lossless *current* PDPP snapshot.
    // A successful full refresh may authoritatively remove a record, so the
    // serving input cannot be the append-only history below.
    export.insert(
        "pdpp.recordsByStream".into(),
        snapshot_for_export(collection_state, snapshot_reset_streams)?,
    );
    // Preserve the complete validated envelope history for local export and
    // inspection. The Personal Server deliberately serves the current
    // snapshot above, then maintains its own durable read change history.
    export.insert(
        "pdpp.recordHistoryByStream".into(),
        serde_json::to_value(&collection_state.raw_records_by_stream)
            .map_err(|error| format!("Failed to serialize PDPP record history: {error}"))?,
    );
    export.insert("requestedScopes".into(), json!(requested_scopes));
    export.insert("timestamp".into(), json!(timestamp));
    export.insert("exportedAt".into(), json!(timestamp));
    export.insert(
        "pdpp.snapshot".into(),
        json!({
            "collection_mode": request.collection_mode,
            "reset_streams": snapshot_reset_streams,
            "completed_at": timestamp,
        }),
    );
    export.insert(
        "pdpp.provenance".into(),
        json!({
            "connector_key": connector_key,
            "connector_id": connector_id,
            "manifest_version": resolved.manifest.version,
            "manifest_sha256": resolved.manifest_sha256,
            "run_id": request.run_id,
            "connection_id": request.connection_id(),
        }),
    );
    export.insert(
        "version".into(),
        json!(resolved
            .manifest
            .version
            .as_deref()
            .unwrap_or("pdpp-collection-profile")),
    );
    export.insert("platform".into(), json!(connector_key));
    export.insert(
        "company".into(),
        json!(resolved
            .manifest
            .display_name
            .as_deref()
            .unwrap_or(connector_key)),
    );
    export.insert(
        "exportSummary".into(),
        json!({
            "count": record_count,
            "label": format!("{record_count} {connector_key} records exported"),
            "details": {
                "pdppStorageProjection": if connector_key == GITHUB_CONNECTOR_KEY { "github-v1" } else { "chatgpt-fixture-v1" },
                "pdppStreamRecords": stream_counts,
            }
        }),
    );
    export.insert("errors".into(), json!([]));
    Ok(Value::Object(export))
}

/// An authoritative full refresh must carry an explicit, empty stream entry
/// when it found no records. Without it, a receiver cannot distinguish an
/// empty successful scan from a partially omitted stream.
fn snapshot_for_export(
    collection_state: &PdppCollectionConnectionState,
    snapshot_reset_streams: &[String],
) -> Result<Value, String> {
    let mut snapshot = collection_state.snapshot_by_stream.clone();
    for stream in snapshot_reset_streams {
        snapshot.entry(stream.clone()).or_default();
    }
    serde_json::to_value(snapshot)
        .map_err(|error| format!("Failed to serialize current PDPP snapshot: {error}"))
}

fn project_github_profile(records: &[PdppRecord]) -> Result<Value, String> {
    let record = records
        .last()
        .ok_or("GitHub profile projection requires a user record")?;
    let data = record_data_object(record, "user")?;
    let login = required_string(data, "login", "user")?;
    let mut profile = serde_json::Map::new();
    profile.insert("username".into(), json!(login));
    profile.insert(
        "profileUrl".into(),
        json!(format!("https://github.com/{login}")),
    );
    insert_optional_string(&mut profile, "fullName", data.get("name"));
    insert_optional_string(&mut profile, "bio", data.get("bio"));
    insert_optional_string(&mut profile, "company", data.get("company"));
    insert_optional_string(&mut profile, "location", data.get("location"));
    insert_optional_string(&mut profile, "website", data.get("blog"));
    insert_optional_string(&mut profile, "avatarUrl", data.get("avatar_url"));
    Ok(Value::Object(profile))
}

fn project_github_repositories(records: &[PdppRecord]) -> Result<Value, String> {
    let repositories = records
        .iter()
        .map(|record| project_github_repository(record, "repositories", false))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "repositories": repositories }))
}

fn project_github_starred(records: &[PdppRecord]) -> Result<Value, String> {
    let starred = records
        .iter()
        .map(|record| project_github_repository(record, "starred", true))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "starred": starred }))
}

fn project_github_repository(
    record: &PdppRecord,
    stream: &str,
    starred: bool,
) -> Result<Value, String> {
    let data = record_data_object(record, stream)?;
    let full_name = required_string(data, "full_name", stream)?;
    let url = optional_string(data.get("html_url"))
        .unwrap_or_else(|| format!("https://github.com/{full_name}"));
    let mut projected = serde_json::Map::new();
    if starred {
        projected.insert("fullName".into(), json!(full_name));
    } else {
        let name = optional_string(data.get("name")).unwrap_or_else(|| {
            full_name
                .rsplit('/')
                .next()
                .unwrap_or(&full_name)
                .to_owned()
        });
        projected.insert("name".into(), json!(name));
    }
    projected.insert("url".into(), json!(url));
    insert_optional_string(&mut projected, "description", data.get("description"));
    insert_optional_string(&mut projected, "language", data.get("language"));
    insert_optional_number(&mut projected, "stars", data.get("stargazers_count"));
    insert_optional_string(&mut projected, "updatedAt", data.get("updated_at"));
    if !starred {
        insert_optional_number(&mut projected, "forks", data.get("forks_count"));
        if let Some(private) = data.get("private").and_then(Value::as_bool) {
            projected.insert(
                "visibility".into(),
                json!(if private { "private" } else { "public" }),
            );
        }
        if let Some(topics) = data.get("topics").and_then(Value::as_array) {
            projected.insert(
                "topics".into(),
                json!(topics.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
            );
        }
    }
    Ok(Value::Object(projected))
}

fn record_data_object<'a>(
    record: &'a PdppRecord,
    stream: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    record
        .data
        .as_object()
        .ok_or_else(|| format!("PDPP {stream} record data is not an object"))
}

fn required_string(
    data: &serde_json::Map<String, Value>,
    field: &str,
    stream: &str,
) -> Result<String, String> {
    optional_string(data.get(field)).ok_or_else(|| {
        format!("PDPP {stream} record is missing required {field} for storage projection")
    })
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn insert_optional_string(
    target: &mut serde_json::Map<String, Value>,
    field: &str,
    value: Option<&Value>,
) {
    if let Some(value) = optional_string(value) {
        target.insert(field.into(), json!(value));
    }
}

fn insert_optional_number(
    target: &mut serde_json::Map<String, Value>,
    field: &str,
    value: Option<&Value>,
) {
    if let Some(value) = value.and_then(Value::as_number) {
        target.insert(field.into(), Value::Number(value.clone()));
    }
}

fn emit_running_status(app: &AppHandle, run_id: &str, message: &str) {
    let _ = app.emit(
        "connector-status",
        json!({
            "runId": run_id,
            "status": { "type": "RUNNING", "message": message },
            "timestamp": chrono_timestamp(),
        }),
    );
}

fn emit_terminal_status(
    app: &AppHandle,
    response: &InstalledPdppConnectorRunResponse,
    export: Option<&Value>,
) {
    let successful = response.status == "succeeded";
    let data = successful.then_some(export).flatten();
    let requested = data
        .and_then(|value| value.get("requestedScopes"))
        .and_then(Value::as_array)
        .map_or(0, |scopes| scopes.len());
    let produced = data.map_or(0, |value| {
        value
            .get("requestedScopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|scope| value.get(*scope).is_some())
                    .count()
            })
            .unwrap_or(0)
    });
    let terminal = terminal_status(response);
    let _ = app.emit(
        "connector-status",
        json!({
            "runId": response.run_id,
            "status": {
                "type": terminal.status_type,
                "message": terminal.message,
                "outcome": terminal.outcome,
                "errorClass": terminal.error_class,
                "recordCount": response.record_count,
                "scopeSummary": {
                    "requested": requested,
                    "produced": produced,
                    "degraded": 0,
                    "omitted": requested.saturating_sub(produced),
                },
                "data": data,
            },
            "timestamp": chrono_timestamp(),
        }),
    );
}

/// Translate kernel outcomes into the pre-existing connector UI vocabulary.
/// Cancellation is an intentional stop, rather than an error. Timeout is a
/// failure with a distinct outcome so callers can decide whether to retry.
struct TerminalStatus<'a> {
    status_type: &'static str,
    outcome: &'static str,
    error_class: Option<&'static str>,
    message: &'a str,
}

fn terminal_status(response: &InstalledPdppConnectorRunResponse) -> TerminalStatus<'_> {
    match response.status.as_str() {
        "succeeded" => TerminalStatus {
            status_type: "COMPLETE",
            outcome: "success",
            error_class: None,
            message: "Collection completed successfully",
        },
        "cancelled" => TerminalStatus {
            status_type: "STOPPED",
            outcome: "cancelled",
            error_class: None,
            message: "Collection cancelled",
        },
        "timed_out" => TerminalStatus {
            status_type: "ERROR",
            outcome: "timed_out",
            error_class: Some("timeout"),
            message: response
                .failure
                .as_deref()
                .unwrap_or("PDPP connector exceeded its runtime timeout"),
        },
        _ => TerminalStatus {
            status_type: "ERROR",
            outcome: "failure",
            error_class: Some("runtime_error"),
            message: response
                .failure
                .as_deref()
                .unwrap_or("PDPP connector failed"),
        },
    }
}

fn emit_failed_terminal_status(app: &AppHandle, run_id: &str, error: &str) {
    let _ = app.emit(
        "connector-status",
        json!({
            "runId": run_id,
            "status": {
                "type": "ERROR",
                "message": error,
                "outcome": "failure",
                "errorClass": "runtime_error",
            },
            "timestamp": chrono_timestamp(),
        }),
    );
}

fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn required_hash<'a>(value: Option<&'a str>, field: &str) -> Result<&'a str, String> {
    let value = value.ok_or_else(|| format!("PDPP active install is missing {field}"))?;
    if !value.starts_with("sha256:") || value.len() != "sha256:".len() + 64 {
        return Err(format!(
            "PDPP active install {field} must be a sha256 digest"
        ));
    }
    Ok(value)
}

fn verify_file_hash(path: &Path, expected: Option<&str>, label: &str) -> Result<(), String> {
    let expected = expected.expect("caller must provide required PDPP file hash");
    let bytes = fs::read(path).map_err(|e| format!("Failed to hash {label}: {e}"))?;
    let actual = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    if actual != expected {
        return Err(format!(
            "{label} checksum mismatch: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn resolve_node_program() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|e| format!("Could not locate the DataConnect executable: {e}"))?;
    resolve_node_program_from(&executable, std::env::var_os("PATH").as_deref())
}

fn resolve_node_program_from(executable: &Path, path: Option<&OsStr>) -> Result<String, String> {
    let executable_dir = executable
        .parent()
        .ok_or("DataConnect executable has no parent directory")?;
    let bundled = executable_dir.join(BUNDLED_NODE_NAME);
    if bundled.exists() {
        if !bundled.is_file() {
            return Err(format!(
                "Bundled Node.js path is not a file: {}",
                bundled.display()
            ));
        }
        validate_node_program(&bundled)?;
        return Ok(bundled.to_string_lossy().into_owned());
    }

    let path = path
        .ok_or("Bundled Node.js is unavailable and PATH cannot resolve a development fallback")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if candidate.is_file() {
            validate_node_program(&candidate)?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("Bundled Node.js is unavailable and node was not found on PATH".into())
}

fn validate_node_program(candidate: &Path) -> Result<(), String> {
    let output = Command::new(candidate)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to inspect Node.js at {}: {e}", candidate.display()))?;
    if !output.status.success() {
        return Err(format!(
            "Node.js at {} failed its version check",
            candidate.display()
        ));
    }
    let version = String::from_utf8(output.stdout).map_err(|_| {
        format!(
            "Node.js at {} returned a non-UTF-8 version",
            candidate.display()
        )
    })?;
    validate_node_version(version.trim(), candidate)
}

fn validate_node_version(version: &str, candidate: &Path) -> Result<(), String> {
    let major = version
        .strip_prefix('v')
        .unwrap_or(version)
        .split('.')
        .next()
        .and_then(|major| major.parse::<u64>().ok())
        .ok_or_else(|| {
            format!(
                "Node.js at {} returned an invalid version: {version}",
                candidate.display()
            )
        })?;
    if major < MINIMUM_NODE_MAJOR {
        return Err(format!(
            "PDPP connectors require Node.js {MINIMUM_NODE_MAJOR} or newer; {} reports {version}",
            candidate.display()
        ));
    }
    Ok(())
}

fn to_response(
    run_id: String,
    connector_id: String,
    result: PdppRunResult,
    secrets: &[String],
) -> InstalledPdppConnectorRunResponse {
    let progress = sanitize_retained_events(result.events, secrets);
    let event_summary = PdppEventSummary {
        records: result.event_counts.records,
        checkpoint_updates: result.event_counts.checkpoint_updates,
        checkpoint_streams: result.checkpoints.len() as u64,
        progress: result.event_counts.progress,
        skip_results: result.event_counts.skip_results,
        detail_coverage: result.event_counts.detail_coverage,
        detail_gaps: result.event_counts.detail_gaps,
        detail_gaps_recovered: result.event_counts.detail_gaps_recovered,
        interactions: result.event_counts.interactions,
    };
    let failure = result.failure.or_else(|| {
        result
            .done
            .as_ref()
            .and_then(|done| done.error.as_ref())
            .map(|error| error.message.clone())
    });
    InstalledPdppConnectorRunResponse {
        run_id,
        connector_id,
        status: match result.status {
            PdppRunStatus::Succeeded => "succeeded",
            PdppRunStatus::Failed => "failed",
            PdppRunStatus::Cancelled => "cancelled",
            PdppRunStatus::TimedOut => "timed_out",
        }
        .into(),
        record_count: result.record_count,
        checkpoints: result.checkpoints,
        event_summary,
        progress,
        records_truncated: result.records_truncated,
        events_truncated: result.events_truncated,
        failure: failure.map(|failure| redact_secrets(&failure, secrets)),
        stderr_bytes: result.stderr.len(),
        stderr_truncated: result.stderr_truncated,
        exit_code: result.exit_code,
    }
}

fn sanitize_retained_events(
    events: Vec<PdppEvent>,
    secrets: &[String],
) -> Vec<SanitizedConnectorMessage> {
    let mut messages = Vec::new();
    for event in events {
        match event {
            PdppEvent::Progress(progress) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "PROGRESS".into(),
                    stream: progress.stream,
                    message: Some(redact_secrets(&progress.message, secrets)),
                });
            }
            PdppEvent::SkipResult(skip) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "SKIP_RESULT".into(),
                    stream: skip.stream,
                    message: skip
                        .message
                        .map(|message| redact_secrets(&message, secrets)),
                });
            }
            PdppEvent::Interaction(interaction) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "INTERACTION".into(),
                    stream: None,
                    message: Some(redact_secrets(&interaction.message, secrets)),
                });
            }
            PdppEvent::Record(_)
            | PdppEvent::State(_)
            | PdppEvent::DetailCoverage(_)
            | PdppEvent::DetailGap(_)
            | PdppEvent::DetailGapRecovered(_) => {}
        }
    }
    messages
}

fn redact_secrets(value: &str, secrets: &[String]) -> String {
    secrets.iter().fold(value.to_owned(), |redacted, secret| {
        if secret.is_empty() {
            redacted
        } else {
            redacted.replace(secret, "[REDACTED]")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // The production registry is process-global. Serialize the small set of
    // tests that intentionally exercise its lifecycle so cleanup cannot race
    // an unrelated registry assertion under Rust's parallel test runner.
    static RUN_REGISTRY_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn install_fixture(manifest: Value, script: &str) -> (TempDir, ActiveConnectorInstall) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("profile")).unwrap();
        fs::create_dir_all(temp.path().join("dist")).unwrap();
        fs::write(
            temp.path().join("profile/collection-profile.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(temp.path().join("dist/profile.cjs"), script).unwrap();
        let provenance = if manifest["connector_key"] == CHATGPT_CONNECTOR_KEY {
            json!({
                "external_runtime_packages": [
                    { "name": "p-queue", "version": "^9.3.3" },
                    { "name": "patchright", "version": "^1.61.1" }
                ]
            })
        } else {
            json!({})
        };
        let provenance_bytes = serde_json::to_vec_pretty(&provenance).unwrap();
        fs::write(temp.path().join("provenance.json"), &provenance_bytes).unwrap();
        let manifest_sha = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(serde_json::to_vec_pretty(&manifest).unwrap()))
        );
        let entrypoint_sha = format!("sha256:{}", hex::encode(Sha256::digest(script.as_bytes())));
        let provenance_sha = format!("sha256:{}", hex::encode(Sha256::digest(&provenance_bytes)));
        (
            temp,
            ActiveConnectorInstall {
                connector_id: "github-pdpp".into(),
                company: "GitHub".into(),
                version: "1.0.0".into(),
                root_path: String::new(),
                metadata_relative_path: "legacy.json".into(),
                script_relative_path: "legacy.js".into(),
                artifact_kind: Some(PDPP_ARTIFACT_KIND.into()),
                manifest_path: Some("profile/collection-profile.json".into()),
                entrypoint_path: Some("dist/profile.cjs".into()),
                entrypoint_sha256: Some(entrypoint_sha),
                manifest_sha256: Some(manifest_sha),
                provenance_path: Some("provenance.json".into()),
                provenance_sha256: Some(provenance_sha),
            },
        )
    }

    fn github_manifest() -> Value {
        json!({
            "connector_id": GITHUB_CONNECTOR_ID,
            "connector_key": GITHUB_CONNECTOR_KEY,
            "version": "1.0.0",
            "runtime_requirements": { "bindings": { "network": { "required": true } } },
            "streams": [
                {
                    "name": "repositories",
                    "schema": {
                        "type": "object",
                        "properties": { "id": { "type": "string" }, "source_created_at": { "type": "string" } },
                        "required": ["id"]
                    },
                    "consent_time_field": "source_created_at"
                }
            ]
        })
    }

    fn github_all_streams_manifest() -> Value {
        json!({
            "connector_id": GITHUB_CONNECTOR_ID,
            "connector_key": GITHUB_CONNECTOR_KEY,
            "version": "1.0.0",
            "runtime_requirements": { "bindings": { "network": { "required": true } } },
            "streams": [
                { "name": "user" },
                { "name": "user_stats" },
                { "name": "repositories" },
                { "name": "starred" },
                { "name": "issues" },
                { "name": "pull_requests" },
                { "name": "gists" }
            ]
        })
    }

    fn chatgpt_browser_manifest() -> Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/chatgpt-pdpp-browser.collection-profile.json"
        ))
        .unwrap()
    }

    fn chatgpt_artifact_root() -> Option<PathBuf> {
        std::env::var_os("PDPP_CHATGPT_ARTIFACT_ROOT").map(PathBuf::from)
    }

    fn sha256_for(path: &Path) -> String {
        format!("sha256:{}", hex::encode(Sha256::digest(fs::read(path).unwrap())))
    }

    fn unpacked_actual_chatgpt_install(
        artifact_root: &Path,
        root: &Path,
    ) -> ActiveConnectorInstall {
        let artifact_dir = artifact_root.join("artifacts/chatgpt-pdpp");
        let artifact = fs::read_dir(&artifact_dir)
            .expect("PDPP_CHATGPT_ARTIFACT_ROOT must contain artifacts/chatgpt-pdpp")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|extension| extension == "tgz"))
            .expect("PDPP_CHATGPT_ARTIFACT_ROOT must contain one chatgpt-pdpp tarball");
        let status = Command::new("tar")
            .args([
                "-xzf",
                artifact.to_str().unwrap(),
                "-C",
                root.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let version = serde_json::from_str::<Value>(
            &fs::read_to_string(root.join("profile/collection-profile.json")).unwrap(),
        )
        .unwrap()["version"]
            .as_str()
            .unwrap()
            .to_owned();
        ActiveConnectorInstall {
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            company: "OpenAI".into(),
            version,
            root_path: root.to_string_lossy().into_owned(),
            metadata_relative_path: "legacy.json".into(),
            script_relative_path: "legacy.js".into(),
            artifact_kind: Some(PDPP_ARTIFACT_KIND.into()),
            manifest_path: Some("profile/collection-profile.json".into()),
            entrypoint_path: Some("dist/collection-profile.mjs".into()),
            entrypoint_sha256: Some(sha256_for(&root.join("dist/collection-profile.mjs"))),
            manifest_sha256: Some(sha256_for(&root.join("profile/collection-profile.json"))),
            provenance_path: Some("provenance.json".into()),
            provenance_sha256: Some(sha256_for(&root.join("provenance.json"))),
        }
    }

    fn node_major(program: &Path) -> Option<u64> {
        let output = Command::new(program).arg("--version").output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout)
            .ok()?
            .trim()
            .trim_start_matches('v')
            .split('.')
            .next()?
            .parse()
            .ok()
    }

    fn optional_node_for_major(major: u64) -> Option<PathBuf> {
        let environment_name = format!("DATACONNECT_NODE_{major}");
        let configured = std::env::var_os(environment_name).map(PathBuf::from);
        let mut candidates = configured
            .into_iter()
            .chain(std::iter::once(PathBuf::from(format!("node{major}"))));
        candidates.find(|candidate| node_major(candidate.as_path()) == Some(major))
    }

    fn assert_actual_patchright_esm_import(root: &Path, node: &Path) {
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let bootstrap = runtime_root.join("connector-loader-bootstrap.mjs");
        let probe = r#"
const { default: PQueue } = await import("p-queue");
const { chromium } = await import("patchright");
if (typeof PQueue !== "function") throw new Error("p-queue default export is unavailable");
if (!chromium || typeof chromium.connectOverCDP !== "function") {
  throw new Error("patchright ESM chromium export is unavailable");
}
process.stdout.write("packaged-externals-ok\n");
"#;
        let positive = Command::new(node)
            .args([
                "--import",
                bootstrap.to_str().unwrap(),
                "--input-type=module",
                "-e",
                probe,
            ])
            .current_dir(root)
            .env_clear()
            .env("DATACONNECT_PDPP_RUNTIME_ROOT", &runtime_root)
            .output()
            .unwrap();
        assert!(
            positive.status.success(),
            "loader import failed: {}",
            String::from_utf8_lossy(&positive.stderr)
        );
        assert_eq!(positive.stdout, b"packaged-externals-ok\n");

        let negative = Command::new(node)
            .args(["--input-type=module", "-e", "await import('patchright')"])
            .current_dir(root)
            .env_clear()
            .output()
            .unwrap();
        assert!(!negative.status.success());
        assert!(
            String::from_utf8_lossy(&negative.stderr).contains("Cannot find package 'patchright'")
        );
    }

    fn success_script() -> &'static str {
        r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const start = JSON.parse(line);
  if (process.env.SHOULD_NOT_LEAK) {
    console.error('leaked secret');
    process.exit(2);
  }
  if (process.env.PDPP_CONNECTOR_NETWORK !== '1') {
    console.error('missing network binding');
    process.exit(3);
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.error('missing token');
    process.exit(4);
  }
  const stream = start.scope.streams[0].name;
  console.log(JSON.stringify({ type: 'RECORD', stream, key: 'repo-1', data: { id: 'repo-1' }, emitted_at: '2026-07-30T00:00:00Z' }));
  console.log(JSON.stringify({ type: 'STATE', stream, cursor: { cursor: 'next' } }));
  console.log(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }));
});
"#
    }

    fn pending_interaction_command() -> PdppConnectorCommand {
        PdppConnectorCommand {
            program: "node".into(),
            args: vec![
                "-e".into(),
                r#"
const readline = require('node:readline');
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'START') {
    emit({ type: 'INTERACTION', request_id: 'pending-request', kind: 'otp', message: 'Enter code', timeout_seconds: 60 });
  }
});
"#
                .into(),
            ],
            cwd: None,
            env: HashMap::new(),
            clear_env: false,
        }
    }

    fn start_pending_interaction_for_test(
        run_id: &'static str,
    ) -> (PdppRunControl, thread::JoinHandle<PdppRunResult>) {
        let control = register_run(run_id, "pending-interaction-test", "owner").unwrap();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let run_id_owned = run_id.to_owned();
        let on_interaction: crate::commands::pdpp_connector::PdppInteractionSink = Arc::new(
            move |_interaction: &crate::commands::pdpp_connector::PdppInteraction, responder| {
                PENDING_PDPP_INTERACTIONS
                    .lock()
                    .unwrap()
                    .insert((run_id_owned.clone(), "pending-request".into()), responder);
                ready_sender.send(()).unwrap();
                Ok(())
            },
        );
        let options = PdppRunOptions {
            control: control.clone(),
            max_retained_records: 1,
            on_interaction: Some(on_interaction),
            on_interaction_closed: Some(interaction_closed_sink_for_run(run_id.into())),
            ..Default::default()
        };
        let start = PdppStart::new(
            run_id,
            "incremental",
            json!({"streams":[{"name":"items"}]}),
            None,
        )
        .unwrap();
        let handle = thread::spawn(move || {
            supervise_pdpp_connector(&pending_interaction_command(), &start, &options).unwrap()
        });
        ready_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("pending interaction should register before the test continues");
        (control, handle)
    }

    fn request_with_token(token: &str) -> StartInstalledPdppConnectorRequest {
        StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["repositories".into()],
            connection_id: None,
            github_token: Some(token.into()),
            setup_secrets: None,
            timeout_seconds: Some(5),
        }
    }

    #[test]
    fn resolves_confined_pdpp_install_and_rejects_legacy_kind() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        assert_eq!(resolved.connector_id, "github-pdpp");
        install.artifact_kind = None;
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("not a PDPP"));
    }

    #[test]
    fn rejects_traversal_and_symlink_escape_paths() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.manifest_path = Some("../collection-profile.json".into());
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("within the artifact"));

        let external = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(external.path(), temp.path().join("profile/escaped.json"))
            .unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(
            external.path(),
            temp.path().join("profile/escaped.json"),
        )
        .unwrap();
        install.manifest_path = Some("profile/escaped.json".into());
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("escapes"));
    }

    #[test]
    fn rejects_manifest_entry_mismatch_and_missing_network_capability() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.connector_id = "not-github".into();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("does not match"));

        let no_network = json!({
            "connector_id": GITHUB_CONNECTOR_ID,
            "connector_key": GITHUB_CONNECTOR_KEY,
            "version": "1.0.0",
            "runtime_requirements": { "bindings": { } },
            "streams": [{ "name": "repositories" }]
        });
        let (temp, mut install) = install_fixture(no_network, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("network binding"));

        let mut wrong_version = github_manifest();
        wrong_version["version"] = json!("2.0.0");
        let (temp, mut install) = install_fixture(wrong_version, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("version does not match"));
    }

    #[test]
    fn rejects_a_browser_binding_for_the_network_only_github_host() {
        let manifest = json!({
            "connector_id": GITHUB_CONNECTOR_ID,
            "connector_key": GITHUB_CONNECTOR_KEY,
            "version": "1.0.0",
            "runtime_requirements": {
                "bindings": {
                    "network": { "required": true },
                    "browser": { "required": true }
                }
            },
            "streams": [{ "name": "repositories" }]
        });
        let (temp, mut install) = install_fixture(manifest, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("does not match"));
    }

    #[test]
    fn admits_the_actual_chatgpt_browser_capability_without_extending_start() {
        let manifest: PdppConnectorManifest =
            serde_json::from_value(chatgpt_browser_manifest()).unwrap();
        validate_manifest(CHATGPT_CONNECTOR_INSTALL_ID, "0.1.0", &manifest).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-browser-fixture".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("account-one".into()),
            github_token: None,
            setup_secrets: Some(HashMap::from([
                ("username".into(), "owner@example.com".into()),
                ("password".into(), "fixture-password".into()),
            ])),
            timeout_seconds: Some(5),
        };
        let start = build_start(&request, &manifest, None).unwrap();
        let serialized = serde_json::to_value(start).unwrap();
        assert!(serialized.get("bindings").is_none());
        assert!(serialized.get("browser").is_none());
    }

    #[test]
    fn chatgpt_static_secrets_are_transient_after_first_owner_setup() {
        let (temp, mut install) = install_fixture(chatgpt_browser_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.connector_id = CHATGPT_CONNECTOR_INSTALL_ID.into();
        install.version = "0.1.0".into();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let first_setup = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-first-setup".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("owner-a".into()),
            github_token: None,
            setup_secrets: Some(HashMap::from([
                ("username".into(), "owner@example.com".into()),
                ("password".into(), "not-persisted".into()),
            ])),
            timeout_seconds: Some(5),
        };
        let first = resolve_child_secrets_for_connection(&first_setup, &resolved, false).unwrap();
        assert_eq!(first.environment["CHATGPT_USERNAME"], "owner@example.com");
        assert_eq!(first.environment["CHATGPT_PASSWORD"], "not-persisted");

        let scheduled = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-scheduled".into(),
            setup_secrets: None,
            ..first_setup.clone()
        };
        let second = resolve_child_secrets_for_connection(&scheduled, &resolved, true).unwrap();
        assert!(second.environment.is_empty());
        assert!(second.values.is_empty());
        assert!(matches!(
            resolve_child_secrets_for_connection(&scheduled, &resolved, false),
            Err(error) if error.contains("first setup or explicit recovery")
        ));
    }

    #[test]
    fn failed_or_interrupted_chatgpt_setup_keeps_the_next_run_in_setup() {
        let (temp, mut install) = install_fixture(chatgpt_browser_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.connector_id = CHATGPT_CONNECTOR_INSTALL_ID.into();
        install.version = "0.1.0".into();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let credentialed = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-first-setup".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("owner-a".into()),
            github_token: None,
            setup_secrets: Some(HashMap::from([
                ("username".into(), "owner@example.com".into()),
                ("password".into(), "not-persisted".into()),
            ])),
            timeout_seconds: Some(5),
        };
        let retry_without_secrets = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-retry".into(),
            setup_secrets: None,
            ..credentialed.clone()
        };

        for status in [
            PdppRunStatus::Failed, // login/run error or browser launch failure
            PdppRunStatus::Cancelled,
            PdppRunStatus::TimedOut,
        ] {
            assert!(!should_mark_chatgpt_setup_complete(
                &resolved,
                &credentialed,
                &status
            ));
            assert!(matches!(
                resolve_child_secrets_for_connection(&retry_without_secrets, &resolved, false),
                Err(error) if error.contains("first setup or explicit recovery")
            ));
        }
        assert!(should_mark_chatgpt_setup_complete(
            &resolved,
            &credentialed,
            &PdppRunStatus::Succeeded
        ));
    }

    #[test]
    fn cancelling_a_pending_interaction_rejects_late_tauri_responses() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let run_id = "cancel-pending-interaction";
        let (_control, handle) = start_pending_interaction_for_test(run_id);

        cancel_run(run_id).unwrap();
        assert!(submit_installed_pdpp_interaction_response(
            run_id.into(),
            "pending-request".into(),
            "success".into(),
            Some(json!({"code":"late"})),
        )
        .unwrap_err()
        .contains("no longer pending"));
        assert_eq!(handle.join().unwrap().status, PdppRunStatus::Cancelled);
        unregister_run(run_id);
    }

    #[test]
    fn timed_out_interaction_close_callback_rejects_late_tauri_responses() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let run_id = "timeout-pending-interaction";
        let (control, handle) = start_pending_interaction_for_test(run_id);

        interaction_closed_sink_for_run(run_id.into())(run_id, "pending-request");
        assert!(submit_installed_pdpp_interaction_response(
            run_id.into(),
            "pending-request".into(),
            "success".into(),
            Some(json!({"code":"late"})),
        )
        .unwrap_err()
        .contains("no longer pending"));
        control.cancel();
        assert_eq!(handle.join().unwrap().status, PdppRunStatus::Cancelled);
        unregister_run(run_id);
    }

    #[test]
    fn chatgpt_fixture_tracks_configured_artifact_manifest_contract() {
        let Some(artifact_root) = chatgpt_artifact_root() else {
            return;
        };
        let actual = fs::read_to_string(
            artifact_root.join("connectors/chatgpt-pdpp/collection-profile.json"),
        )
        .unwrap();
        let actual: Value = serde_json::from_str(&actual).unwrap();
        let fixture = chatgpt_browser_manifest();
        assert_eq!(fixture["connector_id"], actual["connector_id"]);
        assert_eq!(
            fixture["runtime_requirements"]["bindings"],
            actual["runtime_requirements"]["bindings"]
        );
        assert_eq!(fixture["setup"]["modality"], actual["setup"]["modality"]);
        assert_eq!(
            fixture["setup"]["credential_capture"]["fields"],
            actual["setup"]["credential_capture"]["fields"]
        );
        assert_eq!(
            fixture["streams"]
                .as_array()
                .unwrap()
                .iter()
                .map(|stream| &stream["name"])
                .collect::<Vec<_>>(),
            actual["streams"]
                .as_array()
                .unwrap()
                .iter()
                .map(|stream| &stream["name"])
                .collect::<Vec<_>>(),
        );
    }

    #[test]
    fn packaged_runtime_matches_configured_artifact_requirements() {
        let Some(artifact_root) = chatgpt_artifact_root() else {
            return;
        };
        let artifact: Value = serde_json::from_str(
            &fs::read_to_string(artifact_root.join("connectors/chatgpt-pdpp/artifact.json"))
                .unwrap(),
        )
        .unwrap();
        let provenance: Value = serde_json::from_str(
            &fs::read_to_string(artifact_root.join("connectors/chatgpt-pdpp/provenance.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            artifact["build"]["external_packages"],
            provenance["external_runtime_packages"]
        );
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        assert_packaged_pdpp_runtime_files(&runtime_root);
        let generated_runtime_root = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("pdpp-runtime");
        assert_packaged_pdpp_runtime_files(&generated_runtime_root);
        for requirement in artifact["build"]["external_packages"].as_array().unwrap() {
            let name = requirement["name"].as_str().unwrap();
            let required = requirement["version"].as_str().unwrap();
            let metadata: NodePackageMetadata = serde_json::from_str(
                &fs::read_to_string(
                    runtime_root
                        .join("node_modules")
                        .join(name)
                        .join("package.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(satisfies_caret_requirement(&metadata.version, required));
        }
    }

    fn assert_packaged_pdpp_runtime_files(runtime_root: &Path) {
        for relative_path in [
            "connector-loader.mjs",
            "connector-loader-bootstrap.mjs",
            "node_modules/p-queue/package.json",
            "node_modules/p-queue/dist/index.js",
            "node_modules/patchright/package.json",
            "node_modules/patchright/index.mjs",
        ] {
            assert!(
                runtime_root.join(relative_path).is_file(),
                "packaged PDPP runtime is missing {relative_path} under {}",
                runtime_root.display()
            );
        }
    }

    fn create_minimal_pdpp_runtime_root(root: &Path) {
        for relative_path in [
            "connector-loader.mjs",
            "connector-loader-bootstrap.mjs",
            "node_modules/p-queue/package.json",
            "node_modules/patchright/package.json",
        ] {
            let path = root.join(relative_path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "{}").unwrap();
        }
    }

    #[test]
    fn runtime_root_prefers_explicit_tauri_resource_directory() {
        let temp = tempfile::tempdir().unwrap();
        let resource_runtime = temp.path().join("Resources").join("pdpp-runtime");
        create_minimal_pdpp_runtime_root(&resource_runtime);

        let resolved = resolve_pdpp_runtime_root(Some(&temp.path().join("Resources"))).unwrap();

        assert_eq!(resolved, fs::canonicalize(resource_runtime).unwrap());
    }

    #[test]
    fn actual_artifact_loader_uses_patchright_esm_chromium_export() {
        let Some(artifact_root) = chatgpt_artifact_root() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        unpacked_actual_chatgpt_install(&artifact_root, temp.path());

        // The configured Node is always verified. Exercise Node 22 and 23 as
        // well when CI or a developer has explicitly provided either binary.
        let configured = PathBuf::from(resolve_node_program().unwrap());
        assert_actual_patchright_esm_import(temp.path(), &configured);
        for major in [22, 23] {
            if let Some(node) = optional_node_for_major(major) {
                if node != configured {
                    assert_actual_patchright_esm_import(temp.path(), &node);
                }
            }
        }
    }

    #[test]
    fn unpacks_and_starts_the_configured_artifact_with_packaged_externals() {
        let Some(artifact_root) = chatgpt_artifact_root() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let install = unpacked_actual_chatgpt_install(&artifact_root, temp.path());
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "actual-chatgpt-artifact".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("actual-artifact-owner".into()),
            github_token: None,
            // A scheduled collection reuses its owner profile without replaying
            // the initial static-secret handoff.
            setup_secrets: None,
            timeout_seconds: Some(5),
        };
        let binding = PdppBrowserBinding {
            backend: "neko",
            cdp_http_url: "http://127.0.0.1:9".into(),
            lease_id: "actual-artifact-lease".into(),
            profile_key: "actual-artifact-profile".into(),
        };
        let secrets = resolve_child_secrets_for_connection(&request, &resolved, true).unwrap();
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let command = build_command(
            &resolved,
            &secrets,
            &CommandCustomization {
                max_retained_records: 1,
                ..Default::default()
            },
            Some(&binding),
            &runtime_root,
        )
        .unwrap();
        assert!(!command.env.contains_key("CHATGPT_USERNAME"));
        assert!(!command.env.contains_key("CHATGPT_PASSWORD"));
        assert_eq!(
            command.env["PDPP_CHATGPT_REMOTE_CDP_URL"],
            "http://127.0.0.1:9"
        );
        assert!(!command.env.contains_key("PDPP_BROWSER_SURFACE_REQUIRED"));
        assert!(command.clear_env);
        let loader_index = command
            .args
            .iter()
            .position(|argument| argument == "--import")
            .expect("Node 22 loader hook must be installed with --import");
        assert!(command.args[loader_index + 1].ends_with("connector-loader-bootstrap.mjs"));

        let mut without_loader = command.clone();
        without_loader.args.drain(loader_index..=loader_index + 1);
        without_loader.env.remove("DATACONNECT_PDPP_RUNTIME_ROOT");
        let negative = supervise_pdpp_connector(
            &without_loader,
            &build_start(&request, &resolved.manifest, None).unwrap(),
            &PdppRunOptions {
                timeout: Some(Duration::from_secs(5)),
                max_retained_records: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(negative.status, PdppRunStatus::Succeeded);
        assert!(negative.stderr.contains("Cannot find package 'p-queue'"));

        let mut result = supervise_pdpp_connector(
            &command,
            &build_start(&request, &resolved.manifest, None).unwrap(),
            &PdppRunOptions {
                timeout: Some(Duration::from_secs(5)),
                max_retained_records: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(result.status, PdppRunStatus::Succeeded);
        assert!(!result.stderr.contains("Cannot find package 'p-queue'"));
        assert!(!result.stderr.contains("Cannot find package 'patchright'"));
        assert!(result.stderr.contains("remote CDP attach start"));
        redact_browser_endpoint(&mut result, "http://127.0.0.1:9");
        assert!(!result.stderr.contains("http://127.0.0.1:9"));
        assert!(!result
            .failure
            .as_deref()
            .unwrap_or_default()
            .contains("http://127.0.0.1:9"));
    }

    #[test]
    fn projects_the_provisional_chatgpt_conversation_stream_without_schema_rewrite() {
        let (temp, mut install) = install_fixture(chatgpt_browser_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.connector_id = CHATGPT_CONNECTOR_INSTALL_ID.into();
        install.version = "0.1.0".into();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-projection".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("account-one".into()),
            github_token: None,
            setup_secrets: Some(HashMap::from([
                ("username".into(), "owner@example.com".into()),
                ("password".into(), "fixture-password".into()),
            ])),
            timeout_seconds: Some(5),
        };
        let state = PdppCollectionConnectionState {
            snapshot_by_stream: HashMap::from([(
                "conversations".into(),
                vec![PdppRecord {
                    stream: "conversations".into(),
                    key: json!("conversation-1"),
                    data: json!({ "id": "conversation-1", "upstream_field": "preserved" }),
                    emitted_at: "2026-07-31T00:00:00Z".into(),
                    op: None,
                }],
            )]),
            ..Default::default()
        };
        let export = build_export_data(&resolved, &request, &state, &[]).unwrap();
        assert_eq!(export["requestedScopes"], json!(["chatgpt.conversations"]));
        assert_eq!(
            export["chatgpt.conversations"]["conversations"][0]["upstream_field"],
            json!("preserved")
        );
    }

    #[test]
    fn allows_optional_future_bindings() {
        let manifest = json!({
            "connector_id": GITHUB_CONNECTOR_ID,
            "connector_key": GITHUB_CONNECTOR_KEY,
            "version": "1.0.0",
            "runtime_requirements": {
                "bindings": {
                    "network": { "required": true },
                    "browser": { "required": false }
                }
            },
            "streams": [{ "name": "repositories" }]
        });
        let (temp, mut install) = install_fixture(manifest, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install).is_ok());
    }

    #[test]
    fn rejects_entrypoint_checksum_mismatch() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.entrypoint_sha256 = Some(format!("sha256:{:064x}", 0));
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("entrypoint checksum mismatch"));
    }

    #[test]
    fn requires_pdpp_hashes_and_provenance_metadata() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.manifest_sha256 = None;
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("manifestSha256"));

        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.provenance_path = None;
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("provenancePath"));

        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        install.provenance_sha256 = None;
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("provenanceSha256"));
    }

    #[test]
    fn validates_request_bounds_before_spawning() {
        let mut request = request_with_token("token");
        request.run_id = "bad run id".into();
        assert!(validate_request(&request).unwrap_err().contains("runId"));

        let mut request = request_with_token("token");
        request.collection_mode = "streaming".into();
        assert!(validate_request(&request)
            .unwrap_err()
            .contains("collectionMode"));

        let mut request = request_with_token("token");
        request.timeout_seconds = Some(MAX_TIMEOUT_SECONDS + 1);
        assert!(validate_request(&request)
            .unwrap_err()
            .contains("timeoutSeconds"));
    }

    #[test]
    fn builds_requested_scope_and_rejects_unknown_stream() {
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["repositories".into()],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: None,
        };
        let manifest: PdppConnectorManifest = serde_json::from_value(github_manifest()).unwrap();
        let start = build_start(&request, &manifest, None).unwrap();
        assert_eq!(start.scope["streams"][0]["name"], "repositories");

        let mut bad = request;
        bad.streams = vec!["issues".into()];
        assert!(build_start(&bad, &manifest, None)
            .unwrap_err()
            .contains("not in the connector manifest"));
    }

    #[test]
    fn github_defaults_to_every_verified_manifest_stream() {
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec![],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: None,
        };
        let manifest: PdppConnectorManifest =
            serde_json::from_value(github_all_streams_manifest()).unwrap();

        let start = build_start(&request, &manifest, None).unwrap();

        assert_eq!(
            start.scope["streams"],
            json!([
                { "name": "user" },
                { "name": "user_stats" },
                { "name": "repositories" },
                { "name": "starred" },
                { "name": "issues" },
                { "name": "pull_requests" },
                { "name": "gists" }
            ])
        );
    }

    #[test]
    fn github_accepts_explicit_verified_streams_and_rejects_unknown_ones() {
        let mut request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["user_stats".into(), "pull_requests".into()],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: None,
        };
        let manifest: PdppConnectorManifest =
            serde_json::from_value(github_all_streams_manifest()).unwrap();

        let start = build_start(&request, &manifest, None).unwrap();
        assert_eq!(
            start.scope["streams"],
            json!([{ "name": "user_stats" }, { "name": "pull_requests" }])
        );

        request.streams = vec!["not_verified".into()];
        assert!(build_start(&request, &manifest, None)
            .unwrap_err()
            .contains("not in the connector manifest"));
    }

    #[test]
    fn incremental_start_uses_saved_checkpoint_while_full_refresh_starts_null() {
        let mut request = request_with_token("token");
        let saved = PdppCollectionConnectionState {
            checkpoints: HashMap::from([("repositories".into(), json!({ "cursor": "persisted" }))]),
            ..Default::default()
        };

        assert_eq!(
            persisted_start_state(&request, &saved),
            Some(json!({ "repositories": { "cursor": "persisted" } }))
        );
        request.collection_mode = "full_refresh".into();
        assert_eq!(persisted_start_state(&request, &saved), None);
    }

    #[test]
    fn active_run_registry_allows_independent_connections() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let connector_id = "github-pdpp-connection-isolation";
        let _first = register_run("connection-one", connector_id, "one").unwrap();
        let _second = register_run("connection-two", connector_id, "two").unwrap();
        assert!(register_run("connection-three", connector_id, "one").is_err());
        unregister_run("connection-one");
        unregister_run("connection-two");
    }

    #[test]
    fn full_refresh_keeps_skipped_streams_out_of_snapshot_reset() {
        let selected = vec!["repositories".into(), "starred".into()];
        let skipped = HashSet::from(["starred".into()]);
        assert_eq!(
            snapshot_reset_streams("full_refresh", &selected, &skipped, false),
            vec!["repositories"]
        );
        assert!(snapshot_reset_streams("incremental", &selected, &skipped, false).is_empty());
        assert!(snapshot_reset_streams("full_refresh", &selected, &skipped, true).is_empty());
        assert_eq!(
            checkpoints_for_commit(
                &HashMap::from([
                    ("repositories".into(), json!({ "cursor": "one" })),
                    ("starred".into(), json!({ "cursor": "two" })),
                ]),
                &skipped,
                false,
            ),
            HashMap::from([("repositories".into(), json!({ "cursor": "one" }))])
        );
        assert!(checkpoints_for_commit(
            &HashMap::from([("repositories".into(), json!({ "cursor": "one" }))]),
            &skipped,
            true,
        )
        .is_empty());
    }

    #[test]
    fn github_legacy_projections_preserve_all_selected_streams_losslessly() {
        let mut manifest = github_all_streams_manifest();
        manifest["display_name"] = json!("GitHub");
        let (temp, mut install) = install_fixture(manifest, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let records = HashMap::from([
            (
                "user".to_owned(),
                vec![PdppRecord {
                    stream: "user".into(),
                    key: json!("42"),
                    data: json!({
                        "id": "42", "login": "octocat", "name": "The Octocat",
                        "blog": "https://octo.example", "avatar_url": "https://img.example/octo.png",
                        "unexpected_api_field": "kept only in raw export"
                    }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
            (
                "repositories".to_owned(),
                vec![PdppRecord {
                    stream: "repositories".into(),
                    key: json!("42/repo"),
                    data: json!({
                        "id": "7", "name": "repo", "full_name": "octocat/repo",
                        "html_url": "https://github.com/octocat/repo", "description": null,
                        "language": "Rust", "stargazers_count": 4, "forks_count": 2,
                        "private": false, "topics": ["pdpp", 123], "updated_at": "2026-07-29T00:00:00Z",
                        "extra": "kept only in raw export"
                    }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: Some("upsert".into()),
                }],
            ),
            (
                "starred".to_owned(),
                vec![PdppRecord {
                    stream: "starred".into(),
                    key: json!("upstream/project"),
                    data: json!({
                        "id": "8", "full_name": "upstream/project", "html_url": null,
                        "description": "Useful", "language": null, "stargazers_count": 9
                    }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
            (
                "user_stats".to_owned(),
                vec![PdppRecord {
                    stream: "user_stats".into(),
                    key: json!("42"),
                    data: json!({ "id": "42", "observed_on": "2026-07-29" }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
            (
                "issues".to_owned(),
                vec![PdppRecord {
                    stream: "issues".into(),
                    key: json!("issue-1"),
                    data: json!({ "id": "issue-1" }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
            (
                "pull_requests".to_owned(),
                vec![PdppRecord {
                    stream: "pull_requests".into(),
                    key: json!("pull-request-2"),
                    data: json!({ "id": "pull-request-2" }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
            (
                "gists".to_owned(),
                vec![PdppRecord {
                    stream: "gists".into(),
                    key: json!("gist-3"),
                    data: json!({ "id": "gist-3" }),
                    emitted_at: "2026-07-30T00:00:00Z".into(),
                    op: None,
                }],
            ),
        ]);
        let collection_state = PdppCollectionConnectionState {
            snapshot_by_stream: records.clone(),
            raw_records_by_stream: records,
            ..Default::default()
        };
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec![],
            connection_id: Some("account-one".into()),
            github_token: None,
            setup_secrets: None,
            timeout_seconds: None,
        };

        let export = build_export_data(&resolved, &request, &collection_state, &[]).unwrap();
        assert_eq!(
            export["requestedScopes"],
            json!(["github.profile", "github.repositories", "github.starred"])
        );
        assert_eq!(
            export["github.profile"],
            json!({
                "username": "octocat",
                "profileUrl": "https://github.com/octocat",
                "fullName": "The Octocat",
                "website": "https://octo.example",
                "avatarUrl": "https://img.example/octo.png"
            })
        );
        assert_eq!(
            export["github.repositories"]["repositories"][0],
            json!({
                "name": "repo", "url": "https://github.com/octocat/repo", "language": "Rust",
                "stars": 4, "updatedAt": "2026-07-29T00:00:00Z", "forks": 2,
                "visibility": "public", "topics": ["pdpp"]
            })
        );
        assert_eq!(
            export["github.starred"]["starred"][0],
            json!({
                "fullName": "upstream/project", "url": "https://github.com/upstream/project",
                "description": "Useful", "stars": 9
            })
        );
        assert_eq!(
            export["pdpp.recordsByStream"]["repositories"][0]["data"]["extra"],
            "kept only in raw export"
        );
        assert_eq!(
            export["pdpp.recordsByStream"]["user_stats"][0]["data"]["observed_on"],
            "2026-07-29"
        );
        for stream in [
            "user",
            "user_stats",
            "repositories",
            "starred",
            "issues",
            "pull_requests",
            "gists",
        ] {
            assert_eq!(
                export["pdpp.recordsByStream"][stream]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        assert!(export.get("github.user_stats").is_none());
        assert_eq!(
            export["pdpp.provenance"],
            json!({
                "connector_key": GITHUB_CONNECTOR_KEY,
                "connector_id": GITHUB_CONNECTOR_ID,
                "manifest_version": "1.0.0",
                "manifest_sha256": resolved.manifest_sha256,
                "run_id": "run-1",
                "connection_id": "account-one",
            })
        );
        assert_eq!(export["exportSummary"]["count"], 7);
    }

    #[test]
    fn full_refresh_export_marks_an_empty_stream_authoritative_without_losing_history() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-full-refresh".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "full_refresh".into(),
            streams: vec!["repositories".into()],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: None,
        };
        let removed = PdppRecord {
            stream: "repositories".into(),
            key: json!("removed"),
            data: json!({
                "id": "removed", "full_name": "octocat/removed",
                "created_at": "2026-07-01T00:00:00Z",
                "pushed_at": "2026-07-01T00:00:00Z",
            }),
            emitted_at: "2026-07-30T00:00:00Z".into(),
            op: Some("upsert".into()),
        };
        let state = PdppCollectionConnectionState {
            raw_records_by_stream: HashMap::from([("repositories".into(), vec![removed])]),
            ..Default::default()
        };

        let export =
            build_export_data(&resolved, &request, &state, &["repositories".into()]).unwrap();

        assert_eq!(export["pdpp.recordsByStream"]["repositories"], json!([]));
        assert_eq!(
            export["pdpp.recordHistoryByStream"]["repositories"][0]["key"],
            json!("removed")
        );
        assert_eq!(
            export["pdpp.snapshot"]["collection_mode"],
            json!("full_refresh")
        );
        assert_eq!(
            export["pdpp.snapshot"]["reset_streams"],
            json!(["repositories"])
        );
        assert!(export["pdpp.snapshot"]["completed_at"].is_string());
    }

    #[test]
    fn scopes_environment_and_runs_synthetic_network_connector() {
        std::env::set_var("SHOULD_NOT_LEAK", "sentinel");
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = request_with_token("test-token");
        let start = build_start(&request, &resolved.manifest, None).unwrap();
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let command = build_command(
            &resolved,
            &resolve_child_secrets(&request, &resolved).unwrap(),
            &CommandCustomization::default(),
            None,
            &runtime_root,
        )
        .unwrap();
        assert!(command.clear_env);
        assert_eq!(command.cwd.as_deref(), Some(resolved.root.as_path()));
        let result = supervise_pdpp_connector(
            &command,
            &start,
            &PdppRunOptions {
                timeout: Some(Duration::from_secs(5)),
                scope_validators: validators_from_manifest(&resolved.manifest),
                max_retained_records: 8,
                ..Default::default()
            },
        )
        .unwrap();
        std::env::remove_var("SHOULD_NOT_LEAK");
        assert_eq!(result.status, PdppRunStatus::Succeeded);
        assert_eq!(result.record_count, 1);
        assert!(!result.stderr.contains("sentinel"));
    }

    #[test]
    fn public_response_redacts_secret_and_omits_raw_records_and_stderr() {
        let token = "ghp_secret_token";
        let script = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const start = JSON.parse(line);
  const stream = start.scope.streams[0].name;
  console.error(`stderr has ${process.env.GITHUB_TOKEN}`);
  console.log(JSON.stringify({ type: 'PROGRESS', stream, message: `progress has ${process.env.GITHUB_TOKEN}` }));
  console.log(JSON.stringify({ type: 'RECORD', stream, key: 'repo-1', data: { id: 'repo-1', secret: process.env.GITHUB_TOKEN }, emitted_at: '2026-07-30T00:00:00Z' }));
  console.log(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { message: `done has ${process.env.GITHUB_TOKEN}`, retryable: false } }));
  process.exit(1);
});
"#;
        let (temp, mut install) = install_fixture(github_manifest(), script);
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = request_with_token(token);
        let result = run_resolved_installed_pdpp_connector(
            &resolved,
            &request,
            CommandCustomization {
                node_imports: Vec::new(),
                max_retained_records: 4,
                ..Default::default()
            },
            &resolve_child_secrets(&request, &resolved).unwrap(),
        )
        .unwrap();
        assert!(result.stderr.contains(token));
        assert!(result
            .records
            .iter()
            .any(|record| record.data.to_string().contains(token)));
        let response = to_response(
            "run-1".into(),
            "github-pdpp".into(),
            result,
            &[token.into()],
        );
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains(token));
        assert!(!serialized.contains("repo-1"));
        assert!(serialized.contains("[REDACTED]"));
        assert_eq!(response.event_summary.records, 1);
        assert!(response.stderr_bytes > 0);
    }

    #[test]
    fn detects_a_credential_anywhere_in_a_record_before_local_export() {
        let secret = "ghp_never_write_this";
        assert!(value_contains_secret(
            &json!({ "nested": [{ "credential": secret }] }),
            secret
        ));
        let mut secret_key = serde_json::Map::new();
        secret_key.insert(secret.into(), json!("ordinary metadata"));
        assert!(value_contains_secret(&Value::Object(secret_key), secret));
        assert!(!value_contains_secret(
            &json!({ "safe": "public repository metadata" }),
            secret
        ));
    }

    #[test]
    fn test_only_node_import_customization_prepends_import() {
        let script = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const start = JSON.parse(line);
  const stream = start.scope.streams[0].name;
  if (!globalThis.__PDPP_MOCK_FETCH_INSTALLED) {
    console.error('missing mock import');
    process.exit(7);
  }
  console.log(JSON.stringify({ type: 'RECORD', stream, key: 'repo-1', data: { id: 'repo-1' }, emitted_at: '2026-07-30T00:00:00Z' }));
  console.log(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }));
});
"#;
        let (temp, mut install) = install_fixture(github_manifest(), script);
        fs::write(
            temp.path().join("mock-fetch.mjs"),
            "globalThis.__PDPP_MOCK_FETCH_INSTALLED = true;\n",
        )
        .unwrap();
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let result = run_resolved_installed_pdpp_connector_for_test(
            &resolved,
            &request_with_token("token"),
            vec![temp.path().join("mock-fetch.mjs")],
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::Succeeded);
        assert_eq!(result.records.len(), 1);
    }

    #[test]
    fn rejects_non_github_manifest_identity() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let manifest = json!({
            "connector_key": "not-github",
            "runtime_requirements": { "bindings": { "network": { "required": true } } },
            "streams": [{ "name": "repositories" }]
        });
        fs::write(
            temp.path().join("profile/collection-profile.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        install.connector_id = "not-github".into();
        install.manifest_sha256 = Some(format!(
            "sha256:{}",
            hex::encode(Sha256::digest(serde_json::to_vec_pretty(&manifest).unwrap()))
        ));
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("does not match"));
    }

    #[test]
    fn preserves_kernel_cancellation_and_timeout_for_installed_entrypoints() {
        let hanging = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', () => {});
setInterval(() => {}, 1000);
"#;
        let (temp, mut install) = install_fixture(github_manifest(), hanging);
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["repositories".into()],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: Some(1),
        };
        let result = supervise_pdpp_connector(
            &build_command(
                &resolved,
                &PdppChildSecrets::default(),
                &CommandCustomization::default(),
                None,
                &resolve_pdpp_runtime_root(None).unwrap(),
            )
            .unwrap(),
            &build_start(&request, &resolved.manifest, None).unwrap(),
            &PdppRunOptions {
                timeout: Some(Duration::from_millis(50)),
                scope_validators: validators_from_manifest(&resolved.manifest),
                max_retained_records: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::TimedOut);
    }

    #[test]
    fn active_run_registry_rejects_duplicates_and_stops_a_running_connector() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let run_id = "registered-cancellation";
        let connector_id = "github-pdpp-registry-cancellation";
        let control = register_run(run_id, connector_id, DEFAULT_CONNECTION_ID).unwrap();
        assert!(register_run(run_id, connector_id, DEFAULT_CONNECTION_ID)
            .unwrap_err()
            .contains("already active"));
        assert!(
            register_run("another-run-id", connector_id, DEFAULT_CONNECTION_ID)
                .unwrap_err()
                .contains("connector")
        );

        let hanging = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', () => {});
setInterval(() => {}, 1000);
"#;
        let (temp, mut install) = install_fixture(github_manifest(), hanging);
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: run_id.into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["repositories".into()],
            connection_id: None,
            github_token: None,
            setup_secrets: None,
            timeout_seconds: Some(30),
        };
        let handle = thread::spawn(move || {
            run_resolved_installed_pdpp_connector(
                &resolved,
                &request,
                CommandCustomization {
                    max_retained_records: 1,
                    control,
                    ..Default::default()
                },
                &PdppChildSecrets::default(),
            )
        });

        stop_installed_pdpp_connector_run(run_id.into()).unwrap();
        let result = handle.join().unwrap().unwrap();
        unregister_run(run_id);
        assert_eq!(result.status, PdppRunStatus::Cancelled);
        assert!(cancel_run(run_id).unwrap_err().contains("not active"));
    }

    #[test]
    fn app_cleanup_cancels_registered_runs_and_waits_for_unregistration() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let run_id = "cleanup-cancellation";
        let control = register_run(run_id, "github-pdpp-cleanup", DEFAULT_CONNECTION_ID).unwrap();
        let worker = thread::spawn(move || {
            while !control.is_cancelled() {
                thread::sleep(Duration::from_millis(1));
            }
            unregister_run(run_id);
        });

        cleanup_installed_pdpp_connector_runs();
        worker.join().unwrap();
        assert!(ACTIVE_PDPP_RUNS.lock().unwrap().is_empty());
    }

    #[test]
    fn registry_blocks_rapid_restart_until_the_cancelled_child_unregisters() {
        let _guard = RUN_REGISTRY_TEST_LOCK.lock().unwrap();
        let connector_id = "github-pdpp-rapid-restart";
        let first_run_id = "rapid-restart-first";
        let control = register_run(first_run_id, connector_id, DEFAULT_CONNECTION_ID).unwrap();
        control.cancel();

        let error =
            register_run("rapid-restart-second", connector_id, DEFAULT_CONNECTION_ID).unwrap_err();
        assert!(error.contains("already active"));
        assert!(error.contains(first_run_id));

        unregister_run(first_run_id);
        let _second =
            register_run("rapid-restart-second", connector_id, DEFAULT_CONNECTION_ID).unwrap();
        unregister_run("rapid-restart-second");
    }

    fn response_with_status(status: &str) -> InstalledPdppConnectorRunResponse {
        InstalledPdppConnectorRunResponse {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            status: status.into(),
            record_count: 0,
            checkpoints: HashMap::new(),
            event_summary: PdppEventSummary::default(),
            progress: Vec::new(),
            records_truncated: false,
            events_truncated: false,
            failure: Some("specific failure".into()),
            stderr_bytes: 0,
            stderr_truncated: false,
            exit_code: None,
        }
    }

    #[test]
    fn cancelled_terminal_status_is_stopped_not_an_error() {
        let cancelled = response_with_status("cancelled");
        let terminal = terminal_status(&cancelled);
        assert_eq!(terminal.status_type, "STOPPED");
        assert_eq!(terminal.outcome, "cancelled");
        assert_eq!(terminal.error_class, None);

        let timed_out_response = response_with_status("timed_out");
        let timed_out = terminal_status(&timed_out_response);
        assert_eq!(timed_out.status_type, "ERROR");
        assert_eq!(timed_out.outcome, "timed_out");
        assert_eq!(timed_out.error_class, Some("timeout"));

        let failed_response = response_with_status("failed");
        let failed = terminal_status(&failed_response);
        assert_eq!(failed.status_type, "ERROR");
        assert_eq!(failed.outcome, "failure");
        assert_eq!(failed.error_class, Some("runtime_error"));
    }

    #[test]
    fn validates_minimum_node_contract() {
        let node = Path::new("/example/node");
        validate_node_version("v22.0.0", node).unwrap();
        validate_node_version("25.1.0", node).unwrap();
        assert!(validate_node_version("v21.9.0", node)
            .unwrap_err()
            .contains("Node.js 22 or newer"));
        assert!(validate_node_version("not-a-version", node)
            .unwrap_err()
            .contains("invalid version"));
    }

    #[test]
    fn uses_path_node_only_when_bundled_node_is_absent() {
        let ambient_node = PathBuf::from(resolve_node_program().unwrap());
        let app_dir = tempfile::tempdir().unwrap();
        let fake_app = app_dir.path().join("dataconnect");
        fs::write(&fake_app, b"fixture app").unwrap();
        let path = std::env::join_paths([ambient_node.parent().unwrap()]).unwrap();

        let fallback = resolve_node_program_from(&fake_app, Some(&path)).unwrap();
        assert_eq!(Path::new(&fallback), ambient_node);

        fs::write(app_dir.path().join(BUNDLED_NODE_NAME), b"not node").unwrap();
        let error = resolve_node_program_from(&fake_app, Some(&path)).unwrap_err();
        assert!(error.contains("Failed to inspect Node.js"));
    }

    #[test]
    fn starts_connector_with_bundled_node_and_no_node_on_path() {
        let ambient_node = PathBuf::from(resolve_node_program().unwrap());
        let app_dir = tempfile::tempdir().unwrap();
        let fake_app = app_dir.path().join(if cfg!(windows) {
            "dataconnect.exe"
        } else {
            "dataconnect"
        });
        fs::write(&fake_app, b"fixture app").unwrap();
        let bundled_node = app_dir.path().join(BUNDLED_NODE_NAME);
        fs::copy(&ambient_node, &bundled_node).unwrap();

        let resolved_node =
            resolve_node_program_from(&fake_app, Some(OsStr::new(""))).unwrap();
        assert_eq!(Path::new(&resolved_node), bundled_node);

        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let request = request_with_token("test-token");
        let start = build_start(&request, &resolved.manifest, None).unwrap();
        let mut command = build_command(
            &resolved,
            &resolve_child_secrets(&request, &resolved).unwrap(),
            &CommandCustomization::default(),
            None,
            &runtime_root,
        )
        .unwrap();
        command.program = resolved_node;
        assert!(command.clear_env);
        assert!(!command.env.contains_key("PATH"));

        let result = supervise_pdpp_connector(
            &command,
            &start,
            &PdppRunOptions {
                timeout: Some(Duration::from_secs(5)),
                scope_validators: validators_from_manifest(&resolved.manifest),
                max_retained_records: 8,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.status, PdppRunStatus::Succeeded);
        assert_eq!(result.record_count, 1);
    }

    #[test]
    fn event_summary_counts_all_events_when_retained_messages_are_truncated() {
        let script = r#"
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const start = JSON.parse(line);
  const stream = start.scope.streams[0].name;
  for (let i = 0; i < 80; i++) {
    console.log(JSON.stringify({ type: 'PROGRESS', stream, message: `step ${i}` }));
  }
  console.log(JSON.stringify({ type: 'STATE', stream, cursor: { cursor: 'one' } }));
  console.log(JSON.stringify({ type: 'STATE', stream, cursor: { cursor: 'two' } }));
  console.log(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }));
});
"#;
        let (temp, mut install) = install_fixture(github_manifest(), script);
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = request_with_token("token");
        let result = run_resolved_installed_pdpp_connector(
            &resolved,
            &request,
            CommandCustomization {
                max_retained_records: 1,
                ..Default::default()
            },
            &resolve_child_secrets(&request, &resolved).unwrap(),
        )
        .unwrap();
        let secrets = resolve_child_secrets(&request, &resolved).unwrap();
        let response = to_response(
            request.run_id,
            resolved.connector_id,
            result,
            &secrets.values,
        );

        assert_eq!(response.event_summary.progress, 80);
        assert_eq!(response.event_summary.checkpoint_updates, 2);
        assert_eq!(response.event_summary.checkpoint_streams, 1);
        assert_eq!(response.progress.len(), 64);
        assert!(response.events_truncated);
    }

    #[test]
    #[ignore = "requires a cross-repo github-pdpp install and credential"]
    fn runs_external_installed_github_artifact_end_to_end() {
        let token = std::env::var("PDPP_E2E_GITHUB_TOKEN")
            .expect("PDPP_E2E_GITHUB_TOKEN must be set for the ignored E2E");
        let node_imports = std::env::var_os("PDPP_E2E_NODE_IMPORT")
            .map(PathBuf::from)
            .into_iter()
            .collect();
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let resolved =
            resolve_active_installed_pdpp_connector("github-pdpp", &runtime_root).unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "github-pdpp-cross-repo-e2e".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["user".into(), "repositories".into()],
            connection_id: None,
            github_token: Some(token.clone()),
            setup_secrets: None,
            timeout_seconds: Some(120),
        };
        let result =
            run_resolved_installed_pdpp_connector_for_test(&resolved, &request, node_imports)
                .unwrap();

        assert_eq!(
            result.status,
            PdppRunStatus::Succeeded,
            "{:?}",
            result.failure
        );
        assert!(result.record_count >= 2);
        assert!(result.records.iter().any(|record| record.stream == "user"));
        assert!(result
            .records
            .iter()
            .any(|record| record.stream == "repositories"));
        assert!(result.checkpoints.contains_key("user"));
        assert!(result.checkpoints.contains_key("repositories"));
        assert!(result
            .events
            .iter()
            .any(|event| matches!(event, PdppEvent::Progress(_))));
        assert!(result
            .events
            .iter()
            .any(|event| matches!(event, PdppEvent::DetailCoverage(_))));
        assert!(!result.stderr.contains(&token));
        eprintln!(
            "pdpp_e2e_summary records={} retained_records={} checkpoints={} progress={} detail_coverage={} stderr_bytes={} records_truncated={}",
            result.record_count,
            result.records.len(),
            result.checkpoints.len(),
            result
                .events
                .iter()
                .filter(|event| matches!(event, PdppEvent::Progress(_)))
                .count(),
            result
                .events
                .iter()
                .filter(|event| matches!(event, PdppEvent::DetailCoverage(_)))
                .count(),
            result.stderr.len(),
            result.records_truncated,
        );

        let response = to_response(
            request.run_id,
            resolved.connector_id,
            result,
            &[token.clone()],
        );
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains("\"data\""));
    }

    #[test]
    #[ignore = "requires a published ChatGPT PDPP artifact, local browser login, and explicit confirmation"]
    fn runs_external_installed_chatgpt_browser_artifact_end_to_end() {
        assert_eq!(
            std::env::var("PDPP_E2E_CHATGPT_CONFIRM").as_deref(),
            Ok("1"),
            "set PDPP_E2E_CHATGPT_CONFIRM=1 to allow the credentialed browser E2E"
        );
        let runtime_root = resolve_pdpp_runtime_root(None).unwrap();
        let resolved =
            resolve_active_installed_pdpp_connector(CHATGPT_CONNECTOR_INSTALL_ID, &runtime_root)
                .unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "chatgpt-pdpp-browser-e2e".into(),
            connector_id: CHATGPT_CONNECTOR_INSTALL_ID.into(),
            collection_mode: "incremental".into(),
            streams: vec!["conversations".into()],
            connection_id: Some("chatgpt-e2e-owner".into()),
            github_token: None,
            setup_secrets: Some(HashMap::from([
                (
                    "username".into(),
                    std::env::var("PDPP_E2E_CHATGPT_USERNAME")
                        .expect("PDPP_E2E_CHATGPT_USERNAME must be set"),
                ),
                (
                    "password".into(),
                    std::env::var("PDPP_E2E_CHATGPT_PASSWORD")
                        .expect("PDPP_E2E_CHATGPT_PASSWORD must be set"),
                ),
            ])),
            timeout_seconds: Some(300),
        };
        let result = run_resolved_installed_pdpp_connector(
            &resolved,
            &request,
            CommandCustomization {
                max_retained_records: 4,
                ..Default::default()
            },
            &resolve_child_secrets(&request, &resolved).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.status,
            PdppRunStatus::Succeeded,
            "{:?}",
            result.failure
        );
        assert!(result
            .events
            .iter()
            .any(|event| matches!(event, PdppEvent::Interaction(_))));
        assert!(result
            .records
            .iter()
            .any(|record| record.stream == "conversations"));
        assert!(!result.stderr.contains("chatgpt-e2e-owner"));
    }
}
