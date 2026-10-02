// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Throwaway repro/verification binary for the 2026-09-21 winclose-lifecycle
// task. Built only with `--features stall-repro`. See src/winclose_repro.rs.

fn main() {
    dataconnect_lib::winclose_repro::run();
}
