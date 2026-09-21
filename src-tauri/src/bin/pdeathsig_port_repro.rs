// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Throwaway measurement binary for the 2026-09-21 winclose-lifecycle task's
// port-release-timing question. Built only with `--features stall-repro`.
// See src/pdeathsig_port_repro.rs.

fn main() {
    dataconnect_lib::pdeathsig_port_repro::run();
}
