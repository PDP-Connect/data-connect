// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hands Wayland window decorations back to the compositor.
//!
//! tao 0.35 (the version stable tauri 2.x pulls) installs a GTK HeaderBar,
//! wrapped in an EventBox with `set_above_child(true)`, as the titlebar of
//! every window on Wayland (tao-0.35.3 `src/platform_impl/linux/wayland/header.rs`).
//! After a window is hidden and shown again, that EventBox takes the
//! titlebar input and the close button stops working (tao#1046, tao#1122,
//! tauri-apps/tauri#13440). Removing the custom titlebar gives the window
//! GTK's default decorations -- the compositor's own where it offers them.
//! tao 0.36+ does the same for decorated windows: it installs no titlebar.
//!
//! RETIRE WHEN the stable tauri 2.x line depends on a tauri-runtime-wry whose
//! `tao` requirement is `>= 0.36` (as of 2026-09-22 the newest stable
//! tauri-runtime-wry is 2.11.4, which requires tao `^0.35.0`; check
//! https://index.crates.io/ta/ur/tauri-runtime-wry). With that tao this
//! plugin finds no titlebar and does nothing, so delete it and its `gtk`
//! dependency in Cargo.toml.

use gtk::prelude::GtkWindowExt;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Window};

/// Removes tao's Wayland header bar from every window the app creates.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wayland-titlebar")
        .on_window_ready(|window| {
            // GTK objects are main-thread only; windows built from a command
            // become ready on a worker thread.
            let target = window.clone();
            let scheduled = window.run_on_main_thread(move || {
                if remove_tao_header_bar(&target) {
                    log::info!(
                        "Removed tao's Wayland header bar from window {}",
                        target.label()
                    );
                }
            });
            if let Err(error) = scheduled {
                log::warn!("Could not schedule the Wayland titlebar fix: {error}");
            }
        })
        .build()
}

/// Returns true when a header bar was removed.
pub fn remove_tao_header_bar<R: Runtime>(window: &Window<R>) -> bool {
    let Ok(gtk_window) = window.gtk_window() else {
        return false;
    };
    // X11 windows and tao 0.36+ decorated windows have no titlebar widget.
    // Undecorated windows keep theirs: tao 0.36+ uses an empty one there to
    // stop the compositor from drawing decorations.
    if !gtk_window.is_decorated() || gtk_window.titlebar().is_none() {
        return false;
    }
    // On a window that is already visible, GTK logs "gtk_window_set_titlebar()
    // called on a realized window" and re-realizes it. The warning is harmless.
    gtk_window.set_titlebar(Option::<&gtk::Widget>::None);
    true
}
