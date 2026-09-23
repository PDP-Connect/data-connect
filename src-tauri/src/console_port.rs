// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! The desktop console's stable loopback port.
//!
//! ## Why this exists
//!
//! Anything outside the app that points at the console -- a Cloudflare
//! dashboard route, an owner's reverse proxy, a bookmark -- needs a port that
//! does not change. Before this module the supervisor asked the OS for a new
//! ephemeral port on every app launch, and the only "keep the old port" hint
//! was held in memory, so a relaunch or rebuild moved the console. Seen live
//! on 2026-09-22: a dashboard-managed Cloudflare route kept pointing at the
//! old port and the public hostname answered 502 for hours.
//!
//! Prior art (Syncthing, LM Studio, Ollama, Jupyter): anything reached from
//! outside the machine uses a fixed or persisted port. This module follows
//! Syncthing: choose a port once, write it to disk, and reuse it on every
//! launch.
//!
//! ## The rules
//!
//! - An owner pin (`RemoteAccessConfig::console_port`) always wins, and a
//!   taken pin fails the start (`allocate_loopback_port`). Unchanged here.
//! - Otherwise the console asks for the persisted port. On first launch there
//!   is none, so it asks for `DEFAULT_CONSOLE_PORT`, or for a fresh port if
//!   that one is taken, and persists whatever it gets.
//! - If the persisted port is taken, the console still starts, on another
//!   port, but never silently: the caller logs a warning, shows an OS
//!   notification, and the console receives the stable port in
//!   `STABLE_PORT_ENV` so Settings can name both ports. The persisted value
//!   is NOT overwritten, so the next launch returns to it once it is free.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// First-launch default. The Docker image binds 7662 (AS) and 7663 (RS)
/// (`deploy/docker/Dockerfile`), so the desktop console takes the next port:
/// the product keeps one recognizable port range, and a desktop app and a
/// container on the same machine do not collide. 7664 is not in
/// `/etc/services` and sits below every OS ephemeral range, so an ephemeral
/// allocation (the RI's own ports) never takes it first.
pub(crate) const DEFAULT_CONSOLE_PORT: u16 = 7664;

/// Carries the port the owner relies on into the console process, next to
/// `PORT` (the port it actually has). They differ only when the stable port
/// was taken at launch; the console's Settings page reports that case.
pub(crate) const STABLE_PORT_ENV: &str = "DATACONNECT_CONSOLE_STABLE_PORT";

const CONSOLE_PORT_FILE: &str = "console-port.json";

#[derive(Debug, Deserialize, Serialize)]
struct PersistedConsolePort {
    port: u16,
}

/// Read the persisted port from `dir`. A missing file is a first launch. An
/// unreadable or invalid file is logged and treated the same way: the next
/// successful start rewrites it.
pub(crate) fn read_persisted_console_port(dir: &Path) -> Option<u16> {
    let path = dir.join(CONSOLE_PORT_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("Could not read the persisted console port at {path:?}: {error}");
            return None;
        }
    };
    match serde_json::from_str::<PersistedConsolePort>(&raw) {
        Ok(PersistedConsolePort { port }) if port != 0 => Some(port),
        Ok(_) => {
            log::warn!("Ignoring persisted console port 0 at {path:?}");
            None
        }
        Err(error) => {
            log::warn!("Ignoring an invalid persisted console port at {path:?}: {error}");
            None
        }
    }
}

pub(crate) fn write_persisted_console_port(dir: &Path, port: u16) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create the console port directory: {error}"))?;
    crate::atomic_write::write_json_atomically(
        &dir.join(CONSOLE_PORT_FILE),
        &PersistedConsolePort { port },
        "Failed to persist the console port",
    )
}

/// What to ask the supervisor for, decided before the console spawns.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ConsolePortPlan {
    /// The port the owner relies on: the pin, else the persisted port, else
    /// (first launch) the port chosen now.
    pub(crate) stable: u16,
    /// The hint for `Supervisor::start_on_port`. `None` asks for a fresh
    /// port. Ignored when a pin is set, because the pin travels as the
    /// spec's `requested_port` and wins over any hint.
    pub(crate) preferred: Option<u16>,
}

/// Choose the console's port.
///
/// `previous` is the port this app session's console had before a
/// stack-level restart (the in-memory origin). It is the second choice when
/// the stable port is taken, so a config-change restart during a collision
/// does not move an open window to a third port.
///
/// `is_free` and `fresh` are injected so the choice is testable without
/// binding real sockets.
pub(crate) fn plan_console_port(
    pinned: Option<u16>,
    persisted: Option<u16>,
    previous: Option<u16>,
    is_free: impl Fn(u16) -> bool,
    fresh: impl FnOnce() -> Option<u16>,
) -> ConsolePortPlan {
    if let Some(pin) = pinned {
        return ConsolePortPlan {
            stable: pin,
            preferred: None,
        };
    }
    let stable = match persisted {
        Some(port) => port,
        None if is_free(DEFAULT_CONSOLE_PORT) => DEFAULT_CONSOLE_PORT,
        // First launch with the default taken: pick the port now so the
        // console is told the same number that gets persisted. If even that
        // fails, the supervisor's own allocation decides and the console
        // reports the mismatch against the default.
        None => fresh().unwrap_or(DEFAULT_CONSOLE_PORT),
    };
    let preferred = if is_free(stable) {
        Some(stable)
    } else {
        previous.filter(|&port| port != stable && is_free(port))
    };
    ConsolePortPlan { stable, preferred }
}

/// After the console started on `actual`: the port to write to disk, if any.
///
/// - A pin is persisted, so removing the pin later keeps the same port.
/// - A first launch persists whatever it got.
/// - A launch that could not get its persisted port writes nothing, so the
///   next launch tries the persisted port again.
pub(crate) fn port_to_persist(
    pinned: Option<u16>,
    persisted: Option<u16>,
    actual: u16,
) -> Option<u16> {
    match (pinned, persisted) {
        (Some(pin), _) if persisted != Some(pin) => Some(pin),
        (Some(_), _) => None,
        (None, None) => Some(actual),
        (None, Some(_)) => None,
    }
}

/// The owner-facing text for a console that could not keep its port. One
/// definition shared by the log line and the OS notification.
pub(crate) fn moved_port_message(stable: u16, actual: u16) -> String {
    format!(
        "Port {stable} was in use, so DataConnect started on port {actual}. Anything pointed at \
         port {stable}, such as a tunnel route or a proxy, cannot reach DataConnect until port \
         {stable} is free and DataConnect restarts. Settings > Remote access shows both ports."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_free(_: u16) -> bool {
        true
    }

    fn no_fresh() -> Option<u16> {
        panic!("fresh() must not be called here")
    }

    #[test]
    fn a_pin_wins_over_everything_and_leaves_the_hint_empty() {
        let plan = plan_console_port(Some(4310), Some(7664), Some(40000), all_free, no_fresh);
        assert_eq!(
            plan,
            ConsolePortPlan {
                stable: 4310,
                preferred: None
            }
        );
    }

    #[test]
    fn a_persisted_port_is_reused_across_launches() {
        // `previous` is None: this is a fresh app launch, the case the
        // in-memory hint could never cover.
        let plan = plan_console_port(None, Some(38739), None, all_free, no_fresh);
        assert_eq!(
            plan,
            ConsolePortPlan {
                stable: 38739,
                preferred: Some(38739)
            }
        );
    }

    #[test]
    fn a_first_launch_uses_the_default_port() {
        let plan = plan_console_port(None, None, None, all_free, no_fresh);
        assert_eq!(plan.stable, DEFAULT_CONSOLE_PORT);
        assert_eq!(plan.preferred, Some(DEFAULT_CONSOLE_PORT));
    }

    #[test]
    fn a_first_launch_with_the_default_taken_picks_a_port_once() {
        let plan = plan_console_port(
            None,
            None,
            None,
            |port| port != DEFAULT_CONSOLE_PORT,
            || Some(45123),
        );
        assert_eq!(
            plan,
            ConsolePortPlan {
                stable: 45123,
                preferred: Some(45123)
            }
        );
    }

    #[test]
    fn a_taken_persisted_port_keeps_the_stable_value_and_prefers_this_sessions_port() {
        let plan = plan_console_port(None, Some(7664), Some(41000), |port| port != 7664, no_fresh);
        assert_eq!(
            plan,
            ConsolePortPlan {
                stable: 7664,
                preferred: Some(41000)
            }
        );
    }

    #[test]
    fn a_taken_persisted_port_with_no_session_port_asks_for_a_fresh_one() {
        let plan = plan_console_port(None, Some(7664), None, |port| port != 7664, no_fresh);
        assert_eq!(
            plan,
            ConsolePortPlan {
                stable: 7664,
                preferred: None
            }
        );
    }

    #[test]
    fn persistence_keeps_the_stable_port_through_a_collision() {
        // First launch: persist what we got.
        assert_eq!(port_to_persist(None, None, 7664), Some(7664));
        // Normal launch: nothing to write.
        assert_eq!(port_to_persist(None, Some(7664), 7664), None);
        // Collision: the fallback is NOT persisted, so the next launch
        // returns to 7664.
        assert_eq!(port_to_persist(None, Some(7664), 41000), None);
        // A pin is adopted as the stable port, once.
        assert_eq!(port_to_persist(Some(38739), Some(7664), 38739), Some(38739));
        assert_eq!(port_to_persist(Some(38739), Some(38739), 38739), None);
    }

    #[test]
    fn the_persisted_port_round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_persisted_console_port(dir.path()), None);
        write_persisted_console_port(dir.path(), 38739).expect("write");
        assert_eq!(read_persisted_console_port(dir.path()), Some(38739));
    }

    #[test]
    fn an_invalid_persisted_file_reads_as_a_first_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(CONSOLE_PORT_FILE), "not json").expect("write");
        assert_eq!(read_persisted_console_port(dir.path()), None);
        fs::write(dir.path().join(CONSOLE_PORT_FILE), r#"{"port":0}"#).expect("write");
        assert_eq!(read_persisted_console_port(dir.path()), None);
    }

    #[test]
    fn the_moved_message_names_both_ports() {
        let message = moved_port_message(7664, 41000);
        assert!(message.contains("7664"), "{message}");
        assert!(message.contains("41000"), "{message}");
    }
}
