// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone repro/verification harness for the tao 0.35 Wayland CSD
//! titlebar bug that `dataconnect_lib::wayland_titlebar` works around.
//!
//! Not part of the shipped app. Built only behind the `stall-repro` feature
//! (shared with the other throwaway measurement binaries in this crate) via
//! the `titlebar_repro` bin target.
//!
//! Creates one real, decorated window (matching DataConnect's own defaults
//! -- no `decorations: false`, no `GDK_BACKEND` override), then performs the
//! hide-then-show cycle that triggers the bug (`unified.rs::setup()` hides
//! the main window at startup, then later re-shows it). It logs which
//! titlebar widget GTK holds afterwards, and logs `CloseRequested` if the
//! close button works. The window stays open so an external harness can
//! click it.
//!
//! Environment:
//! - `TITLEBAR_REPRO_WORKAROUND=0` skips the fix, to reproduce the bug.
//! - `TITLEBAR_REPRO_SKIP_HIDE=1` skips the hide/show cycle (control run).
//! - `TITLEBAR_REPRO_LIFETIME_SECS` sets how long the window stays open.
//!
//! The Wayland path only runs under a Wayland compositor. A headless one is
//! enough: `kwin_wayland --virtual` inside `dbus-run-session`, with clicks
//! sent through KWin's `org_kde_kwin_fake_input` protocol
//! (`KWIN_WAYLAND_NO_PERMISSION_CHECKS=1`). Under X11/Xvfb, tao installs no
//! header bar, so a clean run there proves nothing about this bug.

use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Logs which titlebar widget GTK holds after the re-show: tao's EventBox
/// (the bug's mechanism) or none (compositor/GTK default decorations).
fn report_titlebar(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::glib::object::ObjectExt;
        use gtk::prelude::{DisplayExtManual, GtkWindowExt, WidgetExt};
        let gtk_window = target.gtk_window().expect("gtk window");
        let titlebar = gtk_window
            .titlebar()
            .map(|widget| ObjectExt::type_(&widget).name().to_string());
        eprintln!(
            "[titlebar-repro] after re-show: backend_wayland={} decorated={} titlebar={:?}",
            gtk_window.display().backend().is_wayland(),
            gtk_window.is_decorated(),
            titlebar,
        );
    });
}

fn main() {
    eprintln!("[titlebar-repro] pid={}", std::process::id());
    eprintln!(
        "[titlebar-repro] GDK_BACKEND={:?} XDG_SESSION_TYPE={:?} DISPLAY={:?} WAYLAND_DISPLAY={:?}",
        std::env::var("GDK_BACKEND"),
        std::env::var("XDG_SESSION_TYPE"),
        std::env::var("DISPLAY"),
        std::env::var("WAYLAND_DISPLAY"),
    );

    // TITLEBAR_REPRO_WORKAROUND=0 runs without the app's fix, to reproduce the bug.
    let workaround = std::env::var("TITLEBAR_REPRO_WORKAROUND").as_deref() != Ok("0");
    eprintln!("[titlebar-repro] wayland_titlebar workaround={workaround}");
    let mut builder = tauri::Builder::default();
    if workaround {
        builder = builder.plugin(dataconnect_lib::wayland_titlebar::init());
    }
    let app = builder
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

        // TITLEBAR_REPRO_SKIP_HIDE=1 is the control run: same window, no hide/show.
        if std::env::var("TITLEBAR_REPRO_SKIP_HIDE").as_deref() == Ok("1") {
            std::thread::sleep(Duration::from_millis(1600));
            eprintln!("[titlebar-repro] control run: window never hidden");
        } else {
            std::thread::sleep(Duration::from_millis(800));
            eprintln!("[titlebar-repro] hiding window (t=800ms)");
            let _ = window.hide();

            std::thread::sleep(Duration::from_millis(800));
            eprintln!("[titlebar-repro] re-showing window (t=1600ms) -- this is the trigger shape");
            let _ = window.show();
            let _ = window.set_focus();
        }
        report_titlebar(&window);

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
