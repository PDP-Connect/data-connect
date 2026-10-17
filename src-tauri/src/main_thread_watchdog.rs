// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Main-thread responsiveness watchdog.
//!
//! Measures the GTK/tao main-loop stall the owner reported (titlebar hover
//! not reacting, then recovering) directly instead of inferring it. A
//! background thread posts a timestamped no-op to the main thread via
//! `AppHandle::run_on_main_thread` on a fixed interval -- the same
//! main-thread-marshaling primitive window ops like hover repaint and
//! `set_title` depend on (tao's event-loop proxy) -- and logs any tick whose
//! scheduled-to-executed delay exceeds a threshold, with the duration.
//!
//! Off by default. Enable with `DATACONNECT_MAIN_THREAD_WATCHDOG=1`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const DEFAULT_INTERVAL: Duration = Duration::from_millis(50);
const DEFAULT_STALL_THRESHOLD: Duration = Duration::from_millis(150);

pub(crate) fn is_enabled() -> bool {
    std::env::var("DATACONNECT_MAIN_THREAD_WATCHDOG")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Spawn the watchdog thread. Runs for the lifetime of the process; there is
/// no shutdown handle because the thread is daemon-like (harmless to leak at
/// process exit, same as other background threads this app already spawns).
pub(crate) fn spawn(app: AppHandle) {
    let interval = env_duration_ms("DATACONNECT_MAIN_THREAD_WATCHDOG_INTERVAL_MS")
        .unwrap_or(DEFAULT_INTERVAL);
    let threshold = env_duration_ms("DATACONNECT_MAIN_THREAD_WATCHDOG_THRESHOLD_MS")
        .unwrap_or(DEFAULT_STALL_THRESHOLD);

    log::info!(
        "Main-thread watchdog enabled: interval_ms={} threshold_ms={}",
        interval.as_millis(),
        threshold.as_millis()
    );

    let stopped = Arc::new(AtomicBool::new(false));
    std::thread::Builder::new()
        .name("main-thread-watchdog".to_string())
        .spawn(move || loop {
            if stopped.load(Ordering::Relaxed) {
                return;
            }
            let scheduled_at = Instant::now();
            let post_result = app.run_on_main_thread(move || {
                let delay = scheduled_at.elapsed();
                if delay > threshold {
                    log::warn!(
                        "Main-thread watchdog: tick late by {}ms (threshold {}ms) -- the UI was unresponsive for at least this long",
                        delay.as_millis(),
                        threshold.as_millis()
                    );
                }
            });
            if post_result.is_err() {
                // The app is shutting down (event loop gone); stop quietly.
                return;
            }
            std::thread::sleep(interval);
        })
        .expect("failed to spawn main-thread-watchdog thread");
}

fn env_duration_ms(name: &str) -> Option<Duration> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
}
