// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Standalone, throwaway measurement harness for the "how quickly does a
//! PDEATHSIG-killed child's listening port become reusable" question
//! (2026-09-21 winclose-lifecycle brief, part 2 verification). Not part of
//! the shipped app. Built only behind the `stall-repro` feature, same as
//! `stall_repro.rs`/`winclose_repro.rs`.
//!
//! Spawns a real supervised Node HTTP server (through the production
//! `Supervisor`/`spawn_process` code path, so PDEATHSIG is armed exactly as
//! it is for a real sidecar), prints its PID and bound port on stdout, then
//! blocks forever so an external harness can `kill -9` this process and
//! observe port-release timing with `ss`/`bind()` from outside.

use crate::commands::process_supervisor::{
    EnvironmentSpec, EventSink, ProcessLifecycleEvent, ProcessSpec, Readiness, RestartPolicy,
    StopPolicy, Supervisor,
};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, event: ProcessLifecycleEvent) {
        eprintln!("[pdeathsig-port-repro] event: {event:?}");
    }
}

fn node_program() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("node executable in PATH")
}

pub fn run() {
    let script_path = std::env::var("PDEATHSIG_PORT_REPRO_SCRIPT")
        .expect("PDEATHSIG_PORT_REPRO_SCRIPT must point to a script that prints LISTENING <port>");

    let spec = ProcessSpec {
        label: "pdeathsig-port-repro".to_string(),
        program: node_program(),
        args: vec![OsString::from(script_path)],
        cwd: None,
        env: EnvironmentSpec::cleared(BTreeMap::new()),
        readiness: Readiness::StdoutMarker {
            marker: "LISTENING".to_string(),
            deadline: Duration::from_secs(5),
        },
        restart: RestartPolicy::Never,
        process_group: true,
        stop: StopPolicy {
            grace: Duration::from_millis(300),
            escalate: Duration::from_secs(1),
            total: Duration::from_secs(2),
        },
        requested_port: None,
    };

    eprintln!(
        "[pdeathsig-port-repro] pid={} starting supervisor",
        std::process::id()
    );
    let handle = Supervisor::new(spec, NoopSink)
        .start()
        .expect("supervisor should start");
    std::mem::forget(handle);
    eprintln!("[pdeathsig-port-repro] ready, sleeping forever -- kill -9 this pid externally");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
