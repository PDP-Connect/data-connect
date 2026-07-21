// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dataconnect_lib::run();
}
