// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
pub mod connector;
pub mod connector_store;
pub mod developer_connector_sources;
pub mod browser_surface_host;
#[cfg(desktop)]
pub mod desktop_settings;
pub mod download;
pub mod file_ops;
pub(crate) mod oci;
pub(crate) mod oci_catalog;
pub(crate) mod oci_verify;
pub(crate) mod open_external_url;
pub mod pdpp_browser;
pub mod pdpp_collection_state;
pub mod pdpp_connector;
pub mod pdpp_installed_connector;
pub mod pdpp_manual_import;
pub mod process_supervisor;
pub mod ref_server;
#[cfg(desktop)]
pub mod recovery_key;
pub mod ref_server_view;
pub mod server;
pub mod updates;

pub use connector::*;
pub use developer_connector_sources::*;
#[cfg(desktop)]
pub use desktop_settings::*;
pub use download::*;
pub use browser_surface_host::*;
pub use file_ops::*;
pub use pdpp_installed_connector::*;
pub use pdpp_manual_import::prepare_installed_pdpp_import;
pub use ref_server::*;
#[cfg(desktop)]
pub use recovery_key::*;
pub use ref_server_view::*;
pub use server::*;
pub use updates::*;

/// Thin `pub` shims over otherwise-`pub(crate)` closeToTray helpers, for use
/// only by the `winclose_repro` throwaway verification binary (built behind
/// the same `stall-repro` feature gate as `stall_repro.rs`), which lives in
/// a separate binary crate and so cannot see `pub(crate)` items directly.
/// Not part of the shipped app's public surface for anything else.
#[cfg(all(desktop, feature = "stall-repro"))]
pub mod test_support {
    pub fn read_close_to_tray_preference_for_test() -> bool {
        super::file_ops::read_close_to_tray_preference()
    }

    pub fn cached_close_to_tray_preference_for_test() -> bool {
        super::file_ops::cached_close_to_tray_preference()
    }

    pub fn init_close_to_tray_cache_for_test() {
        super::file_ops::init_close_to_tray_cache();
    }
}
