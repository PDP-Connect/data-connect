// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone repro/verification harness for the tao 0.35.3 Wayland CSD
//! titlebar-overlay bug (waspflow/tao-0.37-titlebar-fix-0921).
//!
//! Not part of the shipped app. Built only behind the `stall-repro` feature
//! (shared with the other throwaway measurement binaries in this crate) via
//! the `titlebar_repro` bin target.
//!
//! Creates one real, decorated window (matching DataConnect's own defaults
//! -- no `decorations: false`, no `GDK_BACKEND` override), then performs the
//! exact hide-then-show cycle the original investigation identified as the
//! bug's trigger shape (`unified.rs::setup()` hides the main window at
//! startup, then later re-shows it). The window is left open afterward so
//! an external harness (xwininfo/xev/xdotool/a human) can probe titlebar
//! hit-testing.
//!
//! Honest scope note: this binary cannot exercise tao's Wayland-only CSD
//! code path (`window.display().backend().is_wayland()`) when run under
//! X11/Xvfb -- that check is false under X11 by construction, so a clean
//! run here proves the patched build creates/hides/shows a window without
//! regressing, NOT that the Wayland-specific bug is fixed. Confirming the
//! bug's mechanism is fixed requires either a genuine Wayland session (none
//! available in this sandbox -- no weston/sway/cage found) or a source-level
//! read of tao's own code (done separately: tao 0.37.0 removed
//! `wayland/header.rs` entirely and gated the replacement EventBox behind
//! `!attributes.decorations`, so DataConnect's own decorated windows never
//! hit that path on Wayland either).

use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn main() {
    eprintln!("[titlebar-repro] pid={}", std::process::id());
    eprintln!(
        "[titlebar-repro] GDK_BACKEND={:?} XDG_SESSION_TYPE={:?} DISPLAY={:?} WAYLAND_DISPLAY={:?}",
        std::env::var("GDK_BACKEND"),
        std::env::var("XDG_SESSION_TYPE"),
        std::env::var("DISPLAY"),
        std::env::var("WAYLAND_DISPLAY"),
    );

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build titlebar-repro tauri app");

    let window = WebviewWindowBuilder::new(
        &app,
        "titlebar-repro",
        WebviewUrl::App("about:blank".into()),
    )
    .title("titlebar-repro")
    .inner_size(400.0, 300.0)
    .decorations(true)
    .visible(true)
    .build()
    .expect("failed to create titlebar-repro window");

    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { .. } = event {
            eprintln!("[titlebar-repro] CloseRequested received");
        }
    });

    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let window = handle
            .get_webview_window("titlebar-repro")
            .expect("window must exist");

        std::thread::sleep(Duration::from_millis(800));
        eprintln!("[titlebar-repro] hiding window (t=800ms)");
        let _ = window.hide();

        std::thread::sleep(Duration::from_millis(800));
        eprintln!("[titlebar-repro] re-showing window (t=1600ms) -- this is the trigger shape");
        let _ = window.show();
        let _ = window.set_focus();

        eprintln!(
            "[titlebar-repro] window re-shown, staying open for external probing (xwininfo/xev/xdotool/manual click)"
        );
        // Stay open long enough for an external harness to attach and probe
        // titlebar hit-testing (xwininfo -root -tree, xev on the window id,
        // synthetic clicks, or a human under a real compositor).
        std::thread::sleep(Duration::from_secs(
            std::env::var("TITLEBAR_REPRO_LIFETIME_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
        ));
        eprintln!("[titlebar-repro] lifetime elapsed, exiting");
        handle.exit(0);
    });

    app.run(|_app, _event| {});
}
