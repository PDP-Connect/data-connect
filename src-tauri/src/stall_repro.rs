// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone repro harness for the "does a blocking OS-keychain call freeze
//! the GTK/tao main loop" investigation (2026-09-18 freeze-proof brief).
//!
//! Not part of the shipped app. Built only behind the `stall-repro` feature
//! via the `stall_repro` bin target. Two env vars select the scenario:
//!
//! - `STALL_REPRO_MODE`: `inline` (call the keychain function directly on
//!   the async task, matching the pre-#181 shape) or `spawn_blocking` (wrap
//!   it in `tokio::task::spawn_blocking`, matching `load_bootstrap_secrets`
//!   today).
//! - `STALL_REPRO_CREDENTIAL_PATH`: app-data-style fallback path passed to
//!   `owner_credential::load_or_create_owner_credential`. The harness talks
//!   to whatever OS keychain is reachable via the process's own
//!   `DBUS_SESSION_BUS_ADDRESS` -- point that at an isolated session bus
//!   before launching this binary. Never run it against a real login
//!   session's keyring.
//!
//! The watchdog thread posts a timestamped no-op to the main thread via
//! `AppHandle::run_on_main_thread` every 20ms and logs any tick whose
//! scheduled-to-executed delay exceeds 100ms. This is the same primitive
//! window-hover repaint depends on (tao's event-loop proxy), so a late tick
//! here is a direct measurement of the reported titlebar-unresponsive
//! symptom, not an inference from it.

use crate::owner_credential::load_or_create_owner_credential;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WATCHDOG_INTERVAL: Duration = Duration::from_millis(20);
const STALL_THRESHOLD: Duration = Duration::from_millis(100);
const KEYCHAIN_TASK_DELAY: Duration = Duration::from_millis(1500);

fn run_duration() -> Duration {
    std::env::var("STALL_REPRO_RUN_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(8))
}

pub fn run() {
    let mode = std::env::var("STALL_REPRO_MODE").unwrap_or_else(|_| "inline".to_string());
    let credential_path = std::env::var("STALL_REPRO_CREDENTIAL_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("stall-repro-owner-credential"));

    eprintln!(
        "[stall-repro] mode={mode} credential_path={} dbus={}",
        credential_path.display(),
        std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_else(|_| "<unset>".to_string())
    );

    let start = Instant::now();
    let stop = Arc::new(AtomicBool::new(false));
    let max_delay_ms = Arc::new(AtomicU64::new(0));

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build stall-repro tauri app");

    let _window = WebviewWindowBuilder::new(&app, "stall-repro", WebviewUrl::App("about:blank".into()))
        .title("stall-repro")
        .inner_size(400.0, 300.0)
        .visible(true)
        .build()
        .expect("failed to create stall-repro window");

    let handle = app.handle().clone();

    spawn_watchdog(handle.clone(), start, Arc::clone(&stop), Arc::clone(&max_delay_ms));
    spawn_keychain_task(handle.clone(), mode.clone(), credential_path, start);
    spawn_exit_timer(handle, start, Arc::clone(&stop));

    app.run(|_app, _event| {});
}

fn spawn_watchdog(
    handle: AppHandle,
    start: Instant,
    stop: Arc<AtomicBool>,
    max_delay_ms: Arc<AtomicU64>,
) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let scheduled_at = Instant::now();
            let handle_for_tick = handle.clone();
            let max_delay_for_tick = Arc::clone(&max_delay_ms);
            let post_result = handle.run_on_main_thread(move || {
                let delay = scheduled_at.elapsed();
                let _ = &handle_for_tick;
                if delay > STALL_THRESHOLD {
                    let delay_ms = delay.as_millis() as u64;
                    max_delay_for_tick.fetch_max(delay_ms, Ordering::Relaxed);
                    eprintln!(
                        "[stall-repro] WATCHDOG STALL t={:>6.3}s main-thread tick late by {}ms",
                        scheduled_at.duration_since(start).as_secs_f64(),
                        delay_ms
                    );
                }
            });
            if post_result.is_err() {
                break;
            }
            std::thread::sleep(WATCHDOG_INTERVAL);
        }
    });
}

fn spawn_keychain_task(handle: AppHandle, mode: String, credential_path: PathBuf, start: Instant) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(KEYCHAIN_TASK_DELAY).await;
        eprintln!(
            "[stall-repro] t={:>6.3}s keychain task starting (mode={mode})",
            start.elapsed().as_secs_f64()
        );
        let call_start = Instant::now();

        let result = match mode.as_str() {
            "spawn_blocking" => {
                let path_for_blocking = credential_path.clone();
                tokio::task::spawn_blocking(move || {
                    load_or_create_owner_credential(&path_for_blocking)
                })
                .await
                .map_err(|error| format!("join error: {error}"))
                .and_then(|inner| inner)
            }
            // Positive control: block the GTK/tao main thread directly via
            // run_on_main_thread, proving the watchdog can detect a real
            // stall (as opposed to "inline" simply never triggering one).
            "main_thread_block" => {
                let (tx, rx) = std::sync::mpsc::channel();
                let post_result = handle.run_on_main_thread(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    let _ = tx.send(());
                });
                if let Err(error) = post_result {
                    Err(format!("run_on_main_thread failed: {error}"))
                } else {
                    let _ = rx.recv();
                    Ok("main-thread-blocked".to_string())
                }
            }
            // "inline" (default): call directly on the async task, the
            // pre-#181 shape -- no spawn_blocking, runs on whichever Tokio
            // worker thread picked up this task.
            _ => load_or_create_owner_credential(&credential_path),
        };

        let elapsed = call_start.elapsed();
        match result {
            Ok(_credential) => eprintln!(
                "[stall-repro] t={:>6.3}s keychain call returned OK after {}ms",
                start.elapsed().as_secs_f64(),
                elapsed.as_millis()
            ),
            Err(error) => eprintln!(
                "[stall-repro] t={:>6.3}s keychain call returned ERROR after {}ms: {error}",
                start.elapsed().as_secs_f64(),
                elapsed.as_millis()
            ),
        }
        let _ = handle;
    });
}

fn spawn_exit_timer(handle: AppHandle, start: Instant, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        std::thread::sleep(run_duration());
        stop.store(true, Ordering::Relaxed);
        eprintln!(
            "[stall-repro] t={:>6.3}s run duration elapsed, exiting",
            start.elapsed().as_secs_f64()
        );
        handle.exit(0);
    });
}
