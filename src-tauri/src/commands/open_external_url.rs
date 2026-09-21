// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native handler for the console's "open this link in the system browser"
//! action.
//!
//! The console window is created with `WebviewUrl::External` at
//! `http://127.0.0.1:{port}` (`create_or_update_console_window` in
//! `../unified.rs`). Tauri never injects its `invoke()` bridge into an
//! `http://` origin, by design (Tauri Discussion #2650) -- no capability
//! grant changes that (PR #186 added `shell:allow-open` to
//! `src-tauri/capabilities/console.json` and it did not work: `__TAURI__`
//! and `invoke()` are simply absent in that window). So, same as autostart
//! (`desktop_settings.rs`) and remote-access
//! (`../remote_access.rs`/`spawn_remote_access_config_watcher`), opening a
//! link is an imperative action only this Rust process can perform, and it
//! reaches the console through a request/ack file under `PDPP_DATA_DIR`
//! (`app_data_dir().join(UNIFIED_DB_DIRECTORY)`, the same directory
//! `autostart.json` and `remote-access.json` live in) that
//! `server/routes/owner-open-external-url.ts` writes to and
//! `spawn_open_external_url_watcher` (in `../unified.rs`) polls and applies
//! with `open::that_detached`.
//!
//! Unlike autostart, there is no OS state to converge on -- each request is
//! a one-shot "open this URL" with no persisted "current" value -- so the
//! protocol is a queue of pending requests keyed by id, not a single desired
//! state. Applied requests are dropped after being processed (not kept
//! around), so this file never grows across a long-running session.
//!
//! Scheme validation happens on BOTH sides: the HTTP route rejects non-https
//! requests before ever writing them to disk (so a malformed queue entry
//! can't exist), and this module re-validates before calling
//! `open::that_detached` (so a hand-edited or otherwise-written queue file
//! can't smuggle a `file:`/`javascript:`/`data:` target past the OS opener).
//! Trust nothing that crosses a process boundary, even one this process
//! also writes to.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const OPEN_EXTERNAL_URL_QUEUE_FILE: &str = "open-external-url-queue.json";

/// Schemes the OS opener is allowed to receive. `https:` covers every real
/// call site (provider setup pages, docs, npm package pages); `http:` is
/// deliberately excluded -- every current external link in the console is
/// `https:`, and admitting `http:` would let a request also reach loopback
/// services (the reference server's own `http://127.0.0.1:{port}` origin,
/// or anything else listening on localhost) that `open::that_detached`
/// would happily hand to the OS opener same as any other URL. `file:`,
/// `javascript:`, `data:`, and anything else never reach the opener.
const ALLOWED_SCHEMES: &[&str] = &["https"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenExternalUrlRequest {
    pub(crate) id: u64,
    pub(crate) url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenExternalUrlQueue {
    pub(crate) pending: Vec<OpenExternalUrlRequest>,
}

/// Validate a URL against `ALLOWED_SCHEMES` using the same `url` crate the
/// rest of this codebase already depends on, rather than a hand-rolled
/// prefix check -- `url::Url::parse` rejects malformed input outright and
/// normalizes the scheme before comparison (e.g. ` HTTPS:` or mixed case
/// cannot slip past a naive `starts_with`).
pub(crate) fn validate_external_url(candidate: &str) -> Result<(), String> {
    let parsed = url::Url::parse(candidate)
        .map_err(|error| format!("Not a valid URL: {error}"))?;
    if !ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        return Err(format!(
            "URL scheme {:?} is not allowed; only {ALLOWED_SCHEMES:?} may be opened",
            parsed.scheme()
        ));
    }
    Ok(())
}

pub(crate) fn open_external_url_queue_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(OPEN_EXTERNAL_URL_QUEUE_FILE)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

pub(crate) fn load_open_external_url_queue(path: &Path) -> Result<OpenExternalUrlQueue, String> {
    if !path.exists() {
        return Ok(OpenExternalUrlQueue::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read open-external-url queue: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse open-external-url queue: {error}"))
}

pub(crate) fn save_open_external_url_queue(
    path: &Path,
    queue: &OpenExternalUrlQueue,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create open-external-url queue directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(queue)
        .map_err(|error| format!("Failed to serialize open-external-url queue: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Failed to write open-external-url queue: {error}"))
}

/// Pure core of the watcher tick: given the current queue and an "open"
/// effect as a closure, open every pending request and return the set of
/// ids that were actually processed (opened, or refused for a bad scheme --
/// either way, done with). Kept separate from the `AppHandle`-driven polling
/// loop in `../unified.rs` so it can run under a unit test without a real
/// Tauri runtime or a real OS opener, mirroring
/// `desktop_settings::apply_autostart_desired_state`.
///
/// Returns only the processed ids, NOT a replacement queue -- the watcher
/// (`tick_open_external_url_watcher` in `../unified.rs`) re-reads the queue
/// file immediately before writing and removes just these ids from whatever
/// is on disk at that moment. `server/open-external-url-store.ts::enqueue`
/// does an unlocked read-modify-write on the same file from the Node
/// process, so a naive "read once, process, write back
/// OpenExternalUrlQueue::default()" here could silently clobber a request
/// Node appended in the gap between this function's read and the watcher's
/// write -- the owner's click would just do nothing, no error, no log.
/// Removing only the ids this call actually consumed keeps that race from
/// losing data even though neither side takes a file lock.
pub(crate) fn apply_pending_open_external_url_requests<O>(
    queue: &OpenExternalUrlQueue,
    mut open: O,
) -> Vec<u64>
where
    O: FnMut(&str) -> Result<(), String>,
{
    let mut processed = Vec::with_capacity(queue.pending.len());
    for request in &queue.pending {
        match validate_external_url(&request.url) {
            Ok(()) => {
                if let Err(error) = open(&request.url) {
                    log::error!("Failed to open external link {}: {error}", request.url);
                }
            }
            Err(error) => {
                log::error!(
                    "Refusing to open queued external link {} (id {}): {error}",
                    request.url,
                    request.id
                );
            }
        }
        processed.push(request.id);
    }
    processed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validate_external_url_accepts_https() {
        assert!(validate_external_url("https://example.com/path").is_ok());
    }

    #[test]
    fn validate_external_url_rejects_http() {
        assert!(validate_external_url("http://example.com").is_err());
    }

    #[test]
    fn validate_external_url_rejects_file_scheme() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn validate_external_url_rejects_javascript_scheme() {
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_external_url_rejects_data_scheme() {
        assert!(validate_external_url("data:text/html,<script>alert(1)</script>").is_err());
    }

    #[test]
    fn validate_external_url_rejects_malformed_input() {
        assert!(validate_external_url("not a url").is_err());
    }

    #[test]
    fn validate_external_url_is_case_insensitive_on_scheme() {
        assert!(validate_external_url("HTTPS://example.com").is_ok());
    }

    #[test]
    fn apply_pending_requests_opens_every_valid_entry_and_reports_all_ids_processed() {
        let mut opened = Vec::new();
        let queue = OpenExternalUrlQueue {
            pending: vec![
                OpenExternalUrlRequest { id: 1, url: "https://a.example".into() },
                OpenExternalUrlRequest { id: 2, url: "https://b.example".into() },
            ],
        };
        let processed = apply_pending_open_external_url_requests(&queue, |url| {
            opened.push(url.to_string());
            Ok(())
        });
        assert_eq!(opened, vec!["https://a.example", "https://b.example"]);
        assert_eq!(processed, vec![1, 2]);
    }

    #[test]
    fn apply_pending_requests_refuses_a_non_https_entry_without_opening_it_but_still_reports_it_processed() {
        let mut opened = Vec::new();
        let queue = OpenExternalUrlQueue {
            pending: vec![OpenExternalUrlRequest { id: 1, url: "file:///etc/passwd".into() }],
        };
        let processed = apply_pending_open_external_url_requests(&queue, |url| {
            opened.push(url.to_string());
            Ok(())
        });
        assert!(opened.is_empty(), "a file: URL must never reach the OS opener");
        assert_eq!(processed, vec![1], "a refused entry is still done with, not retried forever");
    }

    #[test]
    fn apply_pending_requests_continues_past_a_refused_entry() {
        let mut opened = Vec::new();
        let queue = OpenExternalUrlQueue {
            pending: vec![
                OpenExternalUrlRequest { id: 1, url: "javascript:alert(1)".into() },
                OpenExternalUrlRequest { id: 2, url: "https://ok.example".into() },
            ],
        };
        let processed = apply_pending_open_external_url_requests(&queue, |url| {
            opened.push(url.to_string());
            Ok(())
        });
        assert_eq!(opened, vec!["https://ok.example"]);
        assert_eq!(processed, vec![1, 2]);
    }

    #[test]
    fn queue_file_round_trips_through_save_and_load() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("open-external-url-queue.json");
        let queue = OpenExternalUrlQueue {
            pending: vec![OpenExternalUrlRequest { id: 7, url: "https://example.com".into() }],
        };

        save_open_external_url_queue(&path, &queue).expect("save should succeed");
        let loaded = load_open_external_url_queue(&path).expect("load should succeed");

        assert_eq!(loaded.pending.len(), 1);
        assert_eq!(loaded.pending[0].id, 7);
    }

    #[test]
    fn a_missing_queue_file_loads_as_empty() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("open-external-url-queue.json");

        let loaded = load_open_external_url_queue(&path).expect("load should succeed");

        assert!(loaded.pending.is_empty());
    }

    /// Regression test for the cross-process race an independent review
    /// flagged: `server/open-external-url-store.ts::enqueue` does an
    /// unlocked read-modify-write on this same file from the Node side. If
    /// the watcher tick (`tick_open_external_url_watcher` in `../unified.rs`)
    /// blindly wrote back whatever queue it started the tick with -- or
    /// worse, an unconditional empty queue, as the earlier version of this
    /// function did -- a request Node appended after this function's `open`
    /// closures ran but before the watcher's write would be silently lost:
    /// no error, no log, the owner's click just does nothing. This test
    /// exercises the exact re-read-before-write pattern the watcher now
    /// uses: apply against a snapshot, but remove only the processed ids
    /// from a LATER read that already contains a request appended during
    /// processing.
    #[test]
    fn removing_only_processed_ids_from_a_later_read_preserves_a_request_enqueued_mid_tick() {
        let snapshot = OpenExternalUrlQueue {
            pending: vec![OpenExternalUrlRequest { id: 1, url: "https://a.example".into() }],
        };
        let processed = apply_pending_open_external_url_requests(&snapshot, |_| Ok(()));
        assert_eq!(processed, vec![1]);

        // Simulate Node's enqueue() landing a new request (id 2) on disk
        // during the window between the watcher's initial read and its
        // write -- the exact race the review flagged.
        let queue_on_disk_now = OpenExternalUrlQueue {
            pending: vec![
                OpenExternalUrlRequest { id: 1, url: "https://a.example".into() },
                OpenExternalUrlRequest { id: 2, url: "https://b.example".into() },
            ],
        };

        let remaining: Vec<OpenExternalUrlRequest> = queue_on_disk_now
            .pending
            .into_iter()
            .filter(|request| !processed.contains(&request.id))
            .collect();

        assert_eq!(
            remaining.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![2],
            "the request enqueued mid-tick must survive the write, not be silently dropped"
        );
    }
}
