// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone repro/verification harness for the `CloseRequested` handler's
//! disk-I/O question (2026-09-21 winclose-lifecycle brief).
//!
//! Not part of the shipped app. Built only behind the `stall-repro` feature
//! (shared with `stall_repro.rs`, same purpose: throwaway measurement
//! binaries) via the `winclose_repro` bin target.
//!
//! Builds one real window, wires a `CloseRequested` handler, and closes the
//! window programmatically after a short delay. One env var selects which
//! handler shape to install:
//!
//! - `WINCLOSE_REPRO_MODE=old` -- the pre-fix shape: calls
//!   `crate::commands::read_close_to_tray_preference()` inline on the
//!   window-event thread, which does a blocking `fs::read_to_string` of
//!   `~/.dataconnect/config.json` via `read_app_config_sync`.
//! - `WINCLOSE_REPRO_MODE=new` (default) -- the shipped fix: calls
//!   `crate::commands::cached_close_to_tray_preference()`, a pure
//!   `AtomicBool` read with no I/O, seeded once at startup via
//!   `init_close_to_tray_cache()` exactly as `unified::setup()` does.
//!
//! Prints a PID line on stderr immediately at startup so an external
//! `strace -f -tt -T -p <pid>` can attach before the close event fires, and
//! prints a marker line immediately before and after invoking the handler
//! body so the strace log can be sliced to exactly that window.

use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn close_delay() -> Duration {
    std::env::var("WINCLOSE_REPRO_DELAY_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(500))
}

pub fn run() {
    let mode = std::env::var("WINCLOSE_REPRO_MODE").unwrap_or_else(|_| "new".to_string());
    eprintln!("[winclose-repro] pid={} mode={mode}", std::process::id());

    // Mirror unified::setup(): seed the cache once, synchronously, before
    // any window can receive a close event. In "old" mode this seed still
    // happens (it's harmless either way) but the handler below
    // deliberately ignores it and re-reads the file inline instead, to
    // reproduce the pre-fix code path exactly.
    crate::test_support::init_close_to_tray_cache_for_test();

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build winclose-repro tauri app");

    let window = WebviewWindowBuilder::new(
        &app,
        "winclose-repro",
        WebviewUrl::App("about:blank".into()),
    )
    .title("winclose-repro")
    .inner_size(400.0, 300.0)
    .visible(true)
    .build()
    .expect("failed to create winclose-repro window");

    let window_for_close = window.clone();
    let mode_for_handler = mode.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let started = std::time::Instant::now();
            eprintln!("[winclose-repro] CloseRequested handler: BEGIN");
            let should_hide = if mode_for_handler == "old" {
                // Pre-fix shape: blocking fs::read_to_string on the
                // window-event thread.
                crate::test_support::read_close_to_tray_preference_for_test()
            } else {
                // Shipped fix: pure in-memory read.
                crate::test_support::cached_close_to_tray_preference_for_test()
            };
            if should_hide {
                api.prevent_close();
                let _ = window_for_close.hide();
            }
            // Internal Instant timing, not external shell timestamps --
            // an external `date` piped around this process's stdout is
            // dominated by pipe/process scheduling noise (measured: ~500ms
            // of shell-side jitter around a handler that is actually
            // microseconds), so it cannot distinguish a real block from
            // shell overhead. This measures only the handler body itself,
            // on the same thread, with no cross-process noise.
            eprintln!(
                "[winclose-repro] CloseRequested handler: END elapsed_micros={}",
                started.elapsed().as_micros()
            );
        }
    });

    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(close_delay());
        eprintln!("[winclose-repro] requesting programmatic close");
        if let Some(window) = handle.get_webview_window("winclose-repro") {
            let _ = window.close();
        }
        // Give the handler a moment to run and be observed, then exit.
        std::thread::sleep(Duration::from_millis(500));
        eprintln!("[winclose-repro] exiting");
        handle.exit(0);
    });

    app.run(|_app, _event| {});
}
