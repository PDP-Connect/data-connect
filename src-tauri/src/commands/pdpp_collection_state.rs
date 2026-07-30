//! Durable state for installed PDPP Collection Profile runs.
//!
//! Checkpoints, the current snapshot, and raw record history share one atomic
//! commit. A crash can therefore cause a later replay, but can never advance a
//! checkpoint past data that was not durably recorded.

use super::connector_store::get_dataconnect_dir;
use super::pdpp_connector::{PdppRecord, PdppRunStatus};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub const DEFAULT_CONNECTION_ID: &str = "default";

static COLLECTION_STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdppCollectionConnectionState {
    pub checkpoints: HashMap<String, Value>,
    pub snapshot_by_stream: HashMap<String, Vec<PdppRecord>>,
    pub raw_records_by_stream: HashMap<String, Vec<PdppRecord>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdppCollectionStateFile {
    version: u8,
    connectors: HashMap<String, HashMap<String, PdppCollectionConnectionState>>,
}

pub fn collection_state_path() -> Result<PathBuf, String> {
    Ok(get_dataconnect_dir()
        .ok_or("Could not determine DataConnect directory for PDPP collection state")?
        .join("pdpp-collection-state.json"))
}

pub fn load_connection_state(
    connector_id: &str,
    connection_id: &str,
) -> Result<PdppCollectionConnectionState, String> {
    load_connection_state_at(&collection_state_path()?, connector_id, connection_id)
}

pub fn load_connection_state_at(
    path: &Path,
    connector_id: &str,
    connection_id: &str,
) -> Result<PdppCollectionConnectionState, String> {
    let _guard = COLLECTION_STATE_LOCK
        .lock()
        .map_err(|_| "PDPP collection state lock is unavailable")?;
    Ok(read_state_file(path)?
        .connectors
        .get(connector_id)
        .and_then(|connections| connections.get(connection_id))
        .cloned()
        .unwrap_or_default())
}

/// Commit a terminal run only when the validated protocol result succeeded.
/// Failed, cancelled, and timed-out runs return without touching durable state.
pub fn commit_terminal_run(
    status: &PdppRunStatus,
    connector_id: &str,
    connection_id: &str,
    collection_mode: &str,
    selected_streams: &[String],
    records_by_stream: &HashMap<String, Vec<PdppRecord>>,
    checkpoints: &HashMap<String, Value>,
) -> Result<Option<PdppCollectionConnectionState>, String> {
    commit_terminal_run_at(
        &collection_state_path()?,
        status,
        connector_id,
        connection_id,
        collection_mode,
        selected_streams,
        records_by_stream,
        checkpoints,
    )
}

pub fn commit_terminal_run_at(
    path: &Path,
    status: &PdppRunStatus,
    connector_id: &str,
    connection_id: &str,
    collection_mode: &str,
    selected_streams: &[String],
    records_by_stream: &HashMap<String, Vec<PdppRecord>>,
    checkpoints: &HashMap<String, Value>,
) -> Result<Option<PdppCollectionConnectionState>, String> {
    if *status != PdppRunStatus::Succeeded {
        return Ok(None);
    }
    commit_succeeded_run_at(
        path,
        connector_id,
        connection_id,
        collection_mode,
        selected_streams,
        records_by_stream,
        checkpoints,
    )
    .map(Some)
}

pub fn commit_succeeded_run_at(
    path: &Path,
    connector_id: &str,
    connection_id: &str,
    collection_mode: &str,
    selected_streams: &[String],
    records_by_stream: &HashMap<String, Vec<PdppRecord>>,
    checkpoints: &HashMap<String, Value>,
) -> Result<PdppCollectionConnectionState, String> {
    let _guard = COLLECTION_STATE_LOCK
        .lock()
        .map_err(|_| "PDPP collection state lock is unavailable")?;
    let _file_lock = lock_state_file(path)?;
    let mut file = read_state_file(path)?;
    let connection = file
        .connectors
        .entry(connector_id.to_owned())
        .or_default()
        .entry(connection_id.to_owned())
        .or_default();

    *connection = stage_succeeded_run(
        connection,
        collection_mode,
        selected_streams,
        records_by_stream,
        checkpoints,
    )?;
    let committed = connection.clone();
    file.version = 1;
    write_state_file_atomically(path, &file)?;
    Ok(committed)
}

pub fn stage_succeeded_run(
    current: &PdppCollectionConnectionState,
    collection_mode: &str,
    selected_streams: &[String],
    records_by_stream: &HashMap<String, Vec<PdppRecord>>,
    checkpoints: &HashMap<String, Value>,
) -> Result<PdppCollectionConnectionState, String> {
    let mut next = current.clone();
    if collection_mode == "full_refresh" {
        for stream in selected_streams {
            next.snapshot_by_stream.remove(stream);
        }
    }
    for (stream, records) in records_by_stream {
        let snapshot = next.snapshot_by_stream.entry(stream.clone()).or_default();
        let history = next
            .raw_records_by_stream
            .entry(stream.clone())
            .or_default();
        for record in records {
            let key = canonical_record_key(&record.key)?;
            history.push(record.clone());
            snapshot.retain(|existing| {
                canonical_record_key(&existing.key)
                    .map(|existing_key| existing_key != key)
                    .unwrap_or(false)
            });
            if record.op.as_deref() != Some("delete") {
                snapshot.push(record.clone());
            }
        }
    }
    next.checkpoints.extend(checkpoints.clone());
    Ok(next)
}

fn canonical_record_key(key: &Value) -> Result<String, String> {
    if let Some(key) = key.as_str() {
        Ok(key.to_owned())
    } else if key
        .as_array()
        .is_some_and(|parts| !parts.is_empty() && parts.iter().all(Value::is_string))
    {
        serde_json::to_string(key).map_err(|error| error.to_string())
    } else {
        Err("PDPP RECORD key must be a string or non-empty string array".into())
    }
}

fn read_state_file(path: &Path) -> Result<PdppCollectionStateFile, String> {
    if !path.exists() {
        return Ok(PdppCollectionStateFile::default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read PDPP collection state: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse PDPP collection state: {error}"))
}

fn lock_state_file(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or("PDPP collection state path has no parent directory")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create PDPP collection state directory: {error}"))?;
    let lock_path = path.with_extension("lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open PDPP collection state lock: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("Failed to lock PDPP collection state: {error}"))?;
    #[cfg(test)]
    pause_test_worker_after_lock();
    Ok(lock)
}

fn write_state_file_atomically(path: &Path, state: &PdppCollectionStateFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("PDPP collection state path has no parent directory")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create PDPP collection state directory: {error}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        format!("Failed to create PDPP collection state temporary file: {error}")
    })?;
    let contents = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to serialize PDPP collection state: {error}"))?;
    temp.write_all(&contents)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| format!("Failed to write PDPP collection state: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("Failed to replace PDPP collection state: {}", error.error))?;
    sync_parent_directory(parent);
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) {
    let _ = File::open(path).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_parent_directory(_: &Path) {}

#[cfg(test)]
fn pause_test_worker_after_lock() {
    let Ok(ready_path) = std::env::var("PDPP_COLLECTION_STATE_TEST_LOCK_READY") else {
        return;
    };
    let _ = fs::write(ready_path, "locked");
    std::thread::sleep(std::time::Duration::from_millis(250));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn record(key: &str, op: Option<&str>, value: &str) -> PdppRecord {
        PdppRecord {
            stream: "repositories".into(),
            key: json!(key),
            data: json!({ "id": key, "value": value }),
            emitted_at: "2026-07-30T00:00:00Z".into(),
            op: op.map(str::to_owned),
        }
    }

    #[test]
    fn process_commit_worker() {
        let (Ok(path), Ok(connection)) = (
            std::env::var("PDPP_COLLECTION_STATE_TEST_WORKER_PATH"),
            std::env::var("PDPP_COLLECTION_STATE_TEST_WORKER_CONNECTION"),
        ) else {
            return;
        };
        commit_succeeded_run_at(
            Path::new(&path),
            "github-pdpp",
            &connection,
            "incremental",
            &["repositories".into()],
            &HashMap::new(),
            &HashMap::from([("repositories".into(), json!({ "cursor": connection }))]),
        )
        .unwrap();
    }

    #[test]
    fn persists_connections_independently_and_reloads_checkpoints() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let records = HashMap::from([("repositories".into(), vec![record("one", None, "first")])]);
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            "connection-a",
            "incremental",
            &["repositories".into()],
            &records,
            &HashMap::from([("repositories".into(), json!({ "cursor": "a" }))]),
        )
        .unwrap();
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            "connection-b",
            "incremental",
            &["repositories".into()],
            &HashMap::new(),
            &HashMap::from([("repositories".into(), json!({ "cursor": "b" }))]),
        )
        .unwrap();

        assert_eq!(
            load_connection_state_at(&path, "github-pdpp", "connection-a")
                .unwrap()
                .checkpoints,
            HashMap::from([("repositories".into(), json!({ "cursor": "a" }))])
        );
        assert_eq!(
            load_connection_state_at(&path, "github-pdpp", "connection-b")
                .unwrap()
                .checkpoints,
            HashMap::from([("repositories".into(), json!({ "cursor": "b" }))])
        );
    }

    #[test]
    fn successful_checkpoint_is_durable_with_its_records_and_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let records = HashMap::from([(
            "repositories".into(),
            vec![record("one", Some("upsert"), "first")],
        )]);
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "incremental",
            &["repositories".into()],
            &records,
            &HashMap::from([("repositories".into(), json!({ "cursor": "one" }))]),
        )
        .unwrap();

        let persisted =
            load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID).unwrap();
        assert_eq!(
            persisted.checkpoints["repositories"],
            json!({ "cursor": "one" })
        );
        assert_eq!(persisted.raw_records_by_stream["repositories"].len(), 1);
        assert_eq!(persisted.snapshot_by_stream["repositories"].len(), 1);
    }

    #[test]
    fn preserves_history_while_delete_and_resurrection_update_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let selected = vec!["repositories".into()];
        for event in [
            record("one", Some("upsert"), "first"),
            record("one", Some("delete"), "ignored"),
            record("one", Some("upsert"), "second"),
        ] {
            commit_succeeded_run_at(
                &path,
                "github-pdpp",
                DEFAULT_CONNECTION_ID,
                "incremental",
                &selected,
                &HashMap::from([("repositories".into(), vec![event])]),
                &HashMap::new(),
            )
            .unwrap();
        }
        let state = load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID).unwrap();
        assert_eq!(state.raw_records_by_stream["repositories"].len(), 3);
        assert_eq!(state.snapshot_by_stream["repositories"].len(), 1);
        assert_eq!(
            state.snapshot_by_stream["repositories"][0].data["value"],
            "second"
        );
    }

    #[test]
    fn successful_full_refresh_replaces_current_snapshot_but_keeps_lossless_history() {
        let current = PdppCollectionConnectionState {
            snapshot_by_stream: HashMap::from([(
                "repositories".into(),
                vec![record("removed", Some("upsert"), "old")],
            )]),
            raw_records_by_stream: HashMap::from([(
                "repositories".into(),
                vec![record("removed", Some("upsert"), "old")],
            )]),
            ..Default::default()
        };
        let next = stage_succeeded_run(
            &current,
            "full_refresh",
            &["repositories".into()],
            &HashMap::from([(
                "repositories".into(),
                vec![record("present", Some("upsert"), "new")],
            )]),
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(next.snapshot_by_stream["repositories"].len(), 1);
        assert_eq!(
            next.snapshot_by_stream["repositories"][0].key,
            json!("present")
        );
        assert_eq!(next.raw_records_by_stream["repositories"].len(), 2);
        assert_eq!(
            next.raw_records_by_stream["repositories"][0].key,
            json!("removed")
        );
        assert_eq!(
            next.raw_records_by_stream["repositories"][1].key,
            json!("present")
        );
    }

    #[test]
    fn successful_incremental_run_never_removes_prior_snapshot_records() {
        let current = PdppCollectionConnectionState {
            snapshot_by_stream: HashMap::from([(
                "repositories".into(),
                vec![record("first", Some("upsert"), "old")],
            )]),
            raw_records_by_stream: HashMap::from([(
                "repositories".into(),
                vec![record("first", Some("upsert"), "old")],
            )]),
            ..Default::default()
        };
        let next = stage_succeeded_run(
            &current,
            "incremental",
            &["repositories".into()],
            &HashMap::from([(
                "repositories".into(),
                vec![record("second", Some("upsert"), "new")],
            )]),
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(next.snapshot_by_stream["repositories"].len(), 2);
        assert_eq!(next.raw_records_by_stream["repositories"].len(), 2);
    }

    #[test]
    fn full_refresh_does_not_erase_checkpoint_when_no_state_is_emitted() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let selected = vec!["repositories".into()];
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "incremental",
            &selected,
            &HashMap::new(),
            &HashMap::from([("repositories".into(), json!({ "cursor": "before" }))]),
        )
        .unwrap();
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "full_refresh",
            &selected,
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID)
                .unwrap()
                .checkpoints["repositories"],
            json!({ "cursor": "before" })
        );
    }

    #[test]
    fn full_refresh_preserves_a_skipped_stream_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let selected = vec!["repositories".into()];
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "incremental",
            &selected,
            &HashMap::from([("repositories".into(), vec![record("one", None, "first")])]),
            &HashMap::new(),
        )
        .unwrap();

        // A successful SKIP_RESULT means this stream was not a complete full
        // snapshot, so the host passes no reset stream for it.
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "full_refresh",
            &[],
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID)
                .unwrap()
                .snapshot_by_stream["repositories"][0]
                .data["value"],
            "first"
        );
    }

    #[test]
    fn crash_before_atomic_commit_keeps_prior_records_and_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let selected = vec!["repositories".into()];
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "incremental",
            &selected,
            &HashMap::from([("repositories".into(), vec![record("old", None, "old")])]),
            &HashMap::from([("repositories".into(), json!({ "cursor": "old" }))]),
        )
        .unwrap();

        let previous =
            load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID).unwrap();
        let staged = stage_succeeded_run(
            &previous,
            "incremental",
            &selected,
            &HashMap::from([("repositories".into(), vec![record("new", None, "new")])]),
            &HashMap::from([("repositories".into(), json!({ "cursor": "new" }))]),
        )
        .unwrap();
        assert_eq!(
            staged.checkpoints["repositories"],
            json!({ "cursor": "new" })
        );

        let after_crash =
            load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID).unwrap();
        assert_eq!(
            after_crash.checkpoints["repositories"],
            json!({ "cursor": "old" })
        );
        assert_eq!(after_crash.raw_records_by_stream["repositories"].len(), 1);
    }

    #[test]
    fn failed_and_cancelled_runs_do_not_commit_records_or_checkpoints() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let selected = vec!["repositories".into()];
        let prior = HashMap::from([("repositories".into(), json!({ "cursor": "prior" }))]);
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            DEFAULT_CONNECTION_ID,
            "incremental",
            &selected,
            &HashMap::new(),
            &prior,
        )
        .unwrap();
        for status in [
            PdppRunStatus::Failed,
            PdppRunStatus::Cancelled,
            PdppRunStatus::TimedOut,
        ] {
            assert!(commit_terminal_run_at(
                &path,
                &status,
                "github-pdpp",
                DEFAULT_CONNECTION_ID,
                "incremental",
                &selected,
                &HashMap::from([("repositories".into(), vec![record("new", None, "new")])]),
                &HashMap::from([("repositories".into(), json!({ "cursor": "new" }))]),
            )
            .unwrap()
            .is_none());
        }
        let state = load_connection_state_at(&path, "github-pdpp", DEFAULT_CONNECTION_ID).unwrap();
        assert_eq!(state.checkpoints, prior);
        assert!(state.raw_records_by_stream.is_empty());
    }

    #[test]
    fn serializes_concurrent_commits_without_losing_connections() {
        let temp = tempfile::tempdir().unwrap();
        let path = Arc::new(temp.path().join("state.json"));
        let workers = (0..8)
            .map(|index| {
                let path = path.clone();
                thread::spawn(move || {
                    let connection = format!("connection-{index}");
                    commit_succeeded_run_at(
                        &path,
                        "github-pdpp",
                        &connection,
                        "incremental",
                        &["repositories".into()],
                        &HashMap::new(),
                        &HashMap::from([("repositories".into(), json!({ "cursor": index }))]),
                    )
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }
        for index in 0..8 {
            assert_eq!(
                load_connection_state_at(&path, "github-pdpp", &format!("connection-{index}"))
                    .unwrap()
                    .checkpoints["repositories"],
                json!({ "cursor": index })
            );
        }
    }

    #[test]
    fn serializes_commits_from_separate_processes_without_losing_updates() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let ready_path = temp.path().join("worker-ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::pdpp_collection_state::tests::process_commit_worker",
                "--nocapture",
            ])
            .env("PDPP_COLLECTION_STATE_TEST_WORKER_PATH", &path)
            .env("PDPP_COLLECTION_STATE_TEST_WORKER_CONNECTION", "worker")
            .env("PDPP_COLLECTION_STATE_TEST_LOCK_READY", &ready_path)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            ready_path.exists(),
            "worker did not acquire the state-file lock"
        );

        let started = Instant::now();
        commit_succeeded_run_at(
            &path,
            "github-pdpp",
            "parent",
            "incremental",
            &["repositories".into()],
            &HashMap::new(),
            &HashMap::from([("repositories".into(), json!({ "cursor": "parent" }))]),
        )
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(child.wait().unwrap().success());
        for connection in ["parent", "worker"] {
            assert!(load_connection_state_at(&path, "github-pdpp", connection)
                .unwrap()
                .checkpoints
                .contains_key("repositories"));
        }
    }
}
