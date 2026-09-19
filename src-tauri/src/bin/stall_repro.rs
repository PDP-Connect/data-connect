// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Throwaway repro binary for the 2026-09-18 freeze-proof investigation.
// Built only with `--features stall-repro`. See src/stall_repro.rs.

fn main() {
    dataconnect_lib::stall_repro::run();
}
