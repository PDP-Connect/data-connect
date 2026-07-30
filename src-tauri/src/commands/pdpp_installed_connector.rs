//! Host route for installed PDPP Collection Profile connector artifacts.
//!
//! This module is intentionally narrow: it resolves an active installed
//! `pdpp-collection-profile` artifact, validates the manifest-derived network
//! capability, then delegates process supervision to the PDPP connector kernel.

use super::connector_store::{get_active_connector_install, ActiveConnectorInstall};
use super::pdpp_connector::{
    supervise_pdpp_connector, PdppConnectorCommand, PdppEvent, PdppRecord, PdppRunControl,
    PdppRunOptions, PdppRunResult, PdppRunStatus, PdppScopeValidators, PdppStart,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PDPP_ARTIFACT_KIND: &str = "pdpp-collection-profile";
const DEFAULT_TIMEOUT_SECONDS: u64 = 120;
const MAX_TIMEOUT_SECONDS: u64 = 900;
const MAX_RUN_ID_BYTES: usize = 128;
const MINIMUM_NODE_MAJOR: u64 = 22;
const CLEANUP_WAIT: Duration = Duration::from_secs(2);
const GITHUB_DATA_CONNECT_UAT_STREAMS: [&str; 3] = ["user", "repositories", "starred"];

static ACTIVE_PDPP_RUNS: LazyLock<Mutex<HashMap<String, PdppRunControl>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
    pub state: Option<Value>,
    #[serde(default)]
    pub github_token: Option<String>,
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
}

#[derive(Debug, Deserialize)]
struct PdppConnectorManifest {
    connector_id: Option<String>,
    connector_key: Option<String>,
    display_name: Option<String>,
    version: Option<String>,
    runtime_requirements: Option<RuntimeRequirements>,
    streams: Vec<PdppManifestStream>,
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

/// The kernel validates every record before this accumulator sees it. Keeping
/// the complete stream here is intentionally distinct from the kernel's small
/// diagnostic retention buffers: the former is the user's export, the latter
/// is bounded operational evidence for the command response.
#[derive(Debug, Default)]
struct PdppExportAccumulator {
    records_by_stream: HashMap<String, Vec<PdppRecord>>,
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
    let control = register_run(&run_id)?;
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
    let resolved = resolve_active_installed_pdpp_connector(&request.connector_id)?;
    let credential = resolve_github_credential(&request, &resolved)?;
    let export_accumulator = Arc::new(Mutex::new(PdppExportAccumulator::default()));
    let sink = event_sink_for_run(
        app,
        request.run_id.clone(),
        export_accumulator.clone(),
        credential.clone(),
    );
    let result = run_resolved_installed_pdpp_connector(
        &resolved,
        &request,
        CommandCustomization {
            control,
            on_event: Some(sink),
            ..Default::default()
        },
        credential.as_deref(),
    )?;
    let export = if result.status == PdppRunStatus::Succeeded {
        Some(build_export_data(&resolved, &request, &export_accumulator)?)
    } else {
        None
    };
    Ok(InstalledPdppRunCompletion {
        response: to_response(
            request.run_id,
            resolved.connector_id,
            result,
            credential.as_deref(),
        ),
        export,
    })
}

fn run_resolved_installed_pdpp_connector(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    customization: CommandCustomization,
    github_credential: Option<&str>,
) -> Result<PdppRunResult, String> {
    validate_request(request)?;
    let start = build_start(request, &resolved.manifest)?;
    let command = build_command(resolved, github_credential, &customization)?;
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
        ..Default::default()
    };
    supervise_pdpp_connector(&command, &start, &options)
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
        request.github_token.as_deref(),
    )
}

fn register_run(run_id: &str) -> Result<PdppRunControl, String> {
    let mut runs = ACTIVE_PDPP_RUNS
        .lock()
        .map_err(|_| "PDPP run registry is unavailable")?;
    if runs.contains_key(run_id) {
        return Err(format!("PDPP runId {run_id} is already active"));
    }
    let control = PdppRunControl::default();
    runs.insert(run_id.to_owned(), control.clone());
    Ok(control)
}

fn unregister_run(run_id: &str) {
    if let Ok(mut runs) = ACTIVE_PDPP_RUNS.lock() {
        runs.remove(run_id);
    }
}

fn cancel_run(run_id: &str) -> Result<(), String> {
    let control = ACTIVE_PDPP_RUNS
        .lock()
        .map_err(|_| "PDPP run registry is unavailable")?
        .get(run_id)
        .cloned()
        .ok_or_else(|| format!("PDPP runId {run_id} is not active"))?;
    control.cancel();
    Ok(())
}

#[tauri::command]
pub fn stop_installed_pdpp_connector_run(run_id: String) -> Result<(), String> {
    validate_run_id(&run_id)?;
    cancel_run(&run_id)
}

pub fn cleanup_installed_pdpp_connector_runs() {
    let controls = ACTIVE_PDPP_RUNS
        .lock()
        .map(|runs| runs.values().cloned().collect::<Vec<_>>())
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

fn resolve_active_installed_pdpp_connector(
    connector_id: &str,
) -> Result<ResolvedInstalledPdppConnector, String> {
    let install = get_active_connector_install(connector_id)
        .ok_or_else(|| format!("PDPP connector {connector_id} is not installed"))?;
    resolve_installed_pdpp_connector(&install)
}

fn resolve_installed_pdpp_connector(
    install: &ActiveConnectorInstall,
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
    verify_file_hash(
        &manifest_path,
        Some(required_hash(
            install.manifest_sha256.as_deref(),
            "manifestSha256",
        )?),
        "PDPP manifest",
    )?;
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
    validate_manifest(&install.connector_id, &manifest)?;
    Ok(ResolvedInstalledPdppConnector {
        connector_id: install.connector_id.clone(),
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

fn validate_manifest(connector_id: &str, manifest: &PdppConnectorManifest) -> Result<(), String> {
    if manifest.streams.is_empty() {
        return Err("PDPP connector manifest must declare at least one stream".into());
    }
    let expected_manifest_key = connector_id.strip_suffix("-pdpp").unwrap_or(connector_id);
    let declared_id_matches = manifest.connector_key.as_deref() == Some(expected_manifest_key)
        || manifest.connector_id.as_deref() == Some(connector_id);
    if !declared_id_matches {
        return Err(format!(
            "PDPP connector manifest does not match active install id {connector_id}"
        ));
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
        if binding != "network" && requirement.required.unwrap_or(false) {
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

fn build_start(
    request: &StartInstalledPdppConnectorRequest,
    manifest: &PdppConnectorManifest,
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
    if manifest.connector_key.as_deref() == Some("github")
        && selected
            .iter()
            .any(|stream| !GITHUB_DATA_CONNECT_UAT_STREAMS.contains(&stream.as_str()))
    {
        return Err(
            "DataConnect's current GitHub storage projection supports user, repositories, and starred only"
                .into(),
        );
    }
    let scope = json!({
        "streams": selected.into_iter().map(|name| json!({ "name": name })).collect::<Vec<_>>()
    });
    PdppStart::new(
        &request.run_id,
        &request.collection_mode,
        scope,
        request.state.clone(),
        json!({ "network": { "enabled": true } }),
    )
}

fn selected_streams(
    request: &StartInstalledPdppConnectorRequest,
    manifest: &PdppConnectorManifest,
) -> Vec<String> {
    if !request.streams.is_empty() {
        return request.streams.clone();
    }
    if manifest.connector_key.as_deref() == Some("github") {
        return GITHUB_DATA_CONNECT_UAT_STREAMS
            .iter()
            .map(|stream| (*stream).to_owned())
            .collect();
    }
    manifest
        .streams
        .iter()
        .map(|stream| stream.name.clone())
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

fn resolve_github_credential(
    request: &StartInstalledPdppConnectorRequest,
    resolved: &ResolvedInstalledPdppConnector,
) -> Result<Option<String>, String> {
    let manifest_key = resolved.manifest.connector_key.as_deref().unwrap_or("");
    if manifest_key != "github" {
        if request.github_token.is_some() {
            return Err("githubToken can only be passed to the GitHub PDPP connector".into());
        }
        return Ok(None);
    }

    if let Some(token) = request
        .github_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        return Ok(Some(token.to_owned()));
    }

    // A local desktop UAT may use a shell-provided credential, but release
    // builds cannot silently acquire one. It is only read into the scoped
    // child-process environment and never enters the response or export.
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("PDPP_E2E_GITHUB_TOKEN") {
        if !token.is_empty() {
            return Ok(Some(token));
        }
    }

    Err(
        "GitHub PDPP connector requires githubToken (or PDPP_E2E_GITHUB_TOKEN in a debug build)"
            .into(),
    )
}

fn build_command(
    resolved: &ResolvedInstalledPdppConnector,
    github_credential: Option<&str>,
    customization: &CommandCustomization,
) -> Result<PdppConnectorCommand, String> {
    let mut env = HashMap::new();
    if let Some(token) = github_credential {
        let manifest_key = resolved.manifest.connector_key.as_deref().unwrap_or("");
        if manifest_key != "github" {
            return Err("githubToken can only be passed to the GitHub PDPP connector".into());
        }
        env.insert("GITHUB_TOKEN".into(), token.to_owned());
        env.insert("GITHUB_PERSONAL_ACCESS_TOKEN".into(), token.to_owned());
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
    args.push(resolved.entrypoint_path.to_string_lossy().into_owned());
    Ok(PdppConnectorCommand {
        program: resolve_node_program()?,
        args,
        cwd: Some(resolved.root.clone()),
        env,
        clear_env: true,
    })
}

fn event_sink_for_run(
    app: AppHandle,
    run_id: String,
    export_accumulator: Arc<Mutex<PdppExportAccumulator>>,
    secret: Option<String>,
) -> super::pdpp_connector::PdppEventSink {
    Arc::new(move |event| match event {
        PdppEvent::Record(record) => {
            if secret.as_deref().is_some_and(|credential| {
                value_contains_secret(&record.key, credential)
                    || value_contains_secret(&record.data, credential)
            }) {
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
            emit_running_status(
                &app,
                &run_id,
                &redact_secret(&progress.message, secret.as_deref()),
            );
            Ok(())
        }
        // States and detail envelopes are already reflected in the sanitized
        // command response. They are deliberately not copied to the export:
        // the export is the full validated data stream, keyed by scope.
        PdppEvent::State(_)
        | PdppEvent::SkipResult(_)
        | PdppEvent::DetailCoverage(_)
        | PdppEvent::DetailGap(_)
        | PdppEvent::DetailGapRecovered(_)
        | PdppEvent::Interaction(_) => Ok(()),
    })
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
            .values()
            .any(|value| value_contains_secret(value, secret)),
        _ => false,
    }
}

fn build_export_data(
    resolved: &ResolvedInstalledPdppConnector,
    request: &StartInstalledPdppConnectorRequest,
    export_accumulator: &Arc<Mutex<PdppExportAccumulator>>,
) -> Result<Value, String> {
    let connector_key = resolved
        .manifest
        .connector_key
        .as_deref()
        .unwrap_or(&resolved.connector_id);
    if connector_key != "github" {
        return Err(
            "DataConnect does not yet have a storage projection for this PDPP connector".into(),
        );
    }
    let selected_streams = selected_streams(request, &resolved.manifest);
    let records_by_stream = export_accumulator
        .lock()
        .map_err(|_| "PDPP export accumulator is unavailable")?
        .records_by_stream
        .clone();
    let mut stream_counts = serde_json::Map::new();
    let mut record_count = 0usize;
    let mut projected_scopes = serde_json::Map::new();

    for stream in &selected_streams {
        let records = records_by_stream.get(stream).cloned().unwrap_or_default();
        record_count += records.len();
        stream_counts.insert(stream.clone(), json!(records.len()));
        let (scope, value) = match stream.as_str() {
            // The Personal Server's existing GitHub schemas deliberately use
            // these shapes. This is a DataConnect storage projection, not a
            // claim that the PDPP connector only supports three streams.
            "user" => ("github.profile", project_github_profile(&records)?),
            "repositories" => (
                "github.repositories",
                project_github_repositories(&records)?,
            ),
            "starred" => ("github.starred", project_github_starred(&records)?),
            unsupported => {
                return Err(format!(
                    "DataConnect does not have a GitHub storage projection for PDPP stream {unsupported}"
                ));
            }
        };
        projected_scopes.insert(scope.to_owned(), value);
    }

    let timestamp = chrono::Utc::now().to_rfc3339();
    let requested_scopes = projected_scopes.keys().cloned().collect::<Vec<_>>();
    let mut export = projected_scopes;
    // This is not a serving scope (see METADATA_KEYS in
    // personalServerIngest.ts). It preserves the complete, validated PDPP
    // envelopes on local disk even where the current Personal Server's legacy
    // GitHub schemas require a deliberately lossy projection.
    export.insert(
        "pdpp.recordsByStream".into(),
        serde_json::to_value(&records_by_stream)
            .map_err(|error| format!("Failed to serialize raw PDPP export: {error}"))?,
    );
    export.insert("requestedScopes".into(), json!(requested_scopes));
    export.insert("timestamp".into(), json!(timestamp));
    export.insert("exportedAt".into(), json!(timestamp));
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
                "pdppStorageProjection": "github-v1",
                "pdppStreamRecords": stream_counts,
            }
        }),
    );
    export.insert("errors".into(), json!([]));
    Ok(Value::Object(export))
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
    let status_type = if successful { "COMPLETE" } else { "ERROR" };
    let message = if successful {
        "Collection completed successfully"
    } else {
        response
            .failure
            .as_deref()
            .unwrap_or("PDPP connector failed")
    };
    let _ = app.emit(
        "connector-status",
        json!({
            "runId": response.run_id,
            "status": {
                "type": status_type,
                "message": message,
                "outcome": if successful { "success" } else { "failure" },
                "errorClass": if successful { Value::Null } else { json!("runtime_error") },
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
    let actual = format!("sha256:{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!(
            "{label} checksum mismatch: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn resolve_node_program() -> Result<String, String> {
    let path = std::env::var_os("PATH").ok_or("PATH is unavailable; cannot resolve node")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if candidate.is_file() {
            validate_node_program(&candidate)?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("node executable was not found on PATH".into())
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
    secret: Option<&str>,
) -> InstalledPdppConnectorRunResponse {
    let progress = sanitize_retained_events(result.events, secret);
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
        failure: failure.map(|failure| redact_secret(&failure, secret)),
        stderr_bytes: result.stderr.len(),
        stderr_truncated: result.stderr_truncated,
        exit_code: result.exit_code,
    }
}

fn sanitize_retained_events(
    events: Vec<PdppEvent>,
    secret: Option<&str>,
) -> Vec<SanitizedConnectorMessage> {
    let mut messages = Vec::new();
    for event in events {
        match event {
            PdppEvent::Progress(progress) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "PROGRESS".into(),
                    stream: progress.stream,
                    message: Some(redact_secret(&progress.message, secret)),
                });
            }
            PdppEvent::SkipResult(skip) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "SKIP_RESULT".into(),
                    stream: skip.stream,
                    message: skip.message.map(|message| redact_secret(&message, secret)),
                });
            }
            PdppEvent::Interaction(interaction) => {
                messages.push(SanitizedConnectorMessage {
                    message_type: "INTERACTION".into(),
                    stream: None,
                    message: Some(redact_secret(&interaction.message, secret)),
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

fn redact_secret(value: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => value.replace(secret, "[REDACTED]"),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
        fs::write(temp.path().join("provenance.json"), "{}").unwrap();
        let manifest_sha = format!(
            "sha256:{:x}",
            Sha256::digest(&serde_json::to_vec_pretty(&manifest).unwrap())
        );
        let entrypoint_sha = format!("sha256:{:x}", Sha256::digest(script.as_bytes()));
        let provenance_sha = format!("sha256:{:x}", Sha256::digest(b"{}"));
        (
            temp,
            ActiveConnectorInstall {
                connector_id: "github".into(),
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
            "connector_id": "https://registry.pdpp.org/connectors/github",
            "connector_key": "github",
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

    fn request_with_token(token: &str) -> StartInstalledPdppConnectorRequest {
        StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["repositories".into()],
            state: None,
            github_token: Some(token.into()),
            timeout_seconds: Some(5),
        }
    }

    #[test]
    fn resolves_confined_pdpp_install_and_rejects_legacy_kind() {
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        assert_eq!(resolved.connector_id, "github");
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
            "connector_key": "github",
            "runtime_requirements": { "bindings": { } },
            "streams": [{ "name": "repositories" }]
        });
        let (temp, mut install) = install_fixture(no_network, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("network binding"));
    }

    #[test]
    fn rejects_unsupported_browser_binding_for_network_only_host() {
        let manifest = json!({
            "connector_key": "github",
            "runtime_requirements": {
                "bindings": {
                    "network": { "required": true },
                    "browser_automation": { "required": true }
                }
            },
            "streams": [{ "name": "repositories" }]
        });
        let (temp, mut install) = install_fixture(manifest, success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        assert!(resolve_installed_pdpp_connector(&install)
            .unwrap_err()
            .contains("unsupported binding"));
    }

    #[test]
    fn allows_optional_future_bindings() {
        let manifest = json!({
            "connector_key": "github",
            "runtime_requirements": {
                "bindings": {
                    "network": { "required": true },
                    "browser_automation": { "required": false }
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
            state: None,
            github_token: None,
            timeout_seconds: None,
        };
        let manifest: PdppConnectorManifest = serde_json::from_value(github_manifest()).unwrap();
        let start = build_start(&request, &manifest).unwrap();
        assert_eq!(start.scope["streams"][0]["name"], "repositories");

        let mut bad = request;
        bad.streams = vec!["issues".into()];
        assert!(build_start(&bad, &manifest)
            .unwrap_err()
            .contains("not in the connector manifest"));
    }

    #[test]
    fn github_storage_projection_is_strict_while_raw_selected_streams_stay_lossless_locally() {
        let manifest = json!({
            "connector_key": "github",
            "display_name": "GitHub",
            "version": "0.5.0",
            "runtime_requirements": { "bindings": { "network": { "required": true } } },
            "streams": [
                { "name": "user" },
                { "name": "repositories" },
                { "name": "starred" }
            ]
        });
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
        ]);
        let accumulator = Arc::new(Mutex::new(PdppExportAccumulator {
            records_by_stream: records,
        }));
        let request = StartInstalledPdppConnectorRequest {
            run_id: "run-1".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["user".into(), "repositories".into(), "starred".into()],
            state: None,
            github_token: None,
            timeout_seconds: None,
        };

        let export = build_export_data(&resolved, &request, &accumulator).unwrap();
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
        assert_eq!(export["exportSummary"]["count"], 3);
    }

    #[test]
    fn scopes_environment_and_runs_synthetic_network_connector() {
        std::env::set_var("SHOULD_NOT_LEAK", "sentinel");
        let (temp, mut install) = install_fixture(github_manifest(), success_script());
        install.root_path = temp.path().to_string_lossy().into_owned();
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let request = request_with_token("test-token");
        let start = build_start(&request, &resolved.manifest).unwrap();
        let command = build_command(
            &resolved,
            request.github_token.as_deref(),
            &CommandCustomization::default(),
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
            request.github_token.as_deref(),
        )
        .unwrap();
        assert!(result.stderr.contains(token));
        assert!(result
            .records
            .iter()
            .any(|record| record.data.to_string().contains(token)));
        let response = to_response("run-1".into(), "github-pdpp".into(), result, Some(token));
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
    fn rejects_github_token_for_non_github_manifest() {
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
            "sha256:{:x}",
            Sha256::digest(&serde_json::to_vec_pretty(&manifest).unwrap())
        ));
        let resolved = resolve_installed_pdpp_connector(&install).unwrap();
        let err =
            build_command(&resolved, Some("secret"), &CommandCustomization::default()).unwrap_err();
        assert!(err.contains("GitHub PDPP connector"));
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
            state: None,
            github_token: None,
            timeout_seconds: Some(1),
        };
        let result = supervise_pdpp_connector(
            &build_command(&resolved, None, &CommandCustomization::default()).unwrap(),
            &build_start(&request, &resolved.manifest).unwrap(),
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
        let run_id = "registered-cancellation";
        let control = register_run(run_id).unwrap();
        assert!(register_run(run_id).unwrap_err().contains("already active"));

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
            state: None,
            github_token: None,
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
                None,
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
        let run_id = "cleanup-cancellation";
        let control = register_run(run_id).unwrap();
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
            request.github_token.as_deref(),
        )
        .unwrap();
        let response = to_response(
            request.run_id,
            resolved.connector_id,
            result,
            request.github_token.as_deref(),
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
        let resolved = resolve_active_installed_pdpp_connector("github-pdpp").unwrap();
        let request = StartInstalledPdppConnectorRequest {
            run_id: "github-pdpp-cross-repo-e2e".into(),
            connector_id: "github-pdpp".into(),
            collection_mode: "incremental".into(),
            streams: vec!["user".into(), "repositories".into()],
            state: None,
            github_token: Some(token.clone()),
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

        let response = to_response(request.run_id, resolved.connector_id, result, Some(&token));
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains("\"data\""));
    }
}
