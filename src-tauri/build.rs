// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
fn main() {
    stage_development_node_sidecar();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows_attributes()))
        .expect("failed to run the Tauri build script");
}

/// Tauri embeds its Windows application manifest as a resource of the app
/// binary only. Test binaries then load without the Common Controls v6
/// dependency it declares and die at startup with
/// STATUS_ENTRYPOINT_NOT_FOUND. Embedding the same manifest through the
/// linker gives it to every binary this crate links, tests included.
fn windows_attributes() -> tauri_build::WindowsAttributes {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return tauri_build::WindowsAttributes::new();
    }
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}

fn stage_development_node_sidecar() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let destination =
        std::path::PathBuf::from("binaries").join(format!("pdpp-node-{target}{extension}"));
    let license_destination = std::path::PathBuf::from("binaries/pdpp-node-LICENSE");
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let Some(license) = [
        node.parent().map(|path| path.join("LICENSE")),
        node.parent().map(|path| path.join("../LICENSE")),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate.is_file()) else {
        return;
    };
    std::fs::create_dir_all("binaries").expect("failed to create development sidecar directory");
    stage_development_file(&node, &destination, "Node.js sidecar");
    stage_development_file(&license, &license_destination, "Node.js license");
}

fn stage_development_file(source: &std::path::Path, destination: &std::path::Path, label: &str) {
    if destination.is_file() {
        return;
    }
    if std::fs::hard_link(source, destination).is_err() {
        std::fs::copy(source, destination)
            .unwrap_or_else(|error| panic!("failed to stage development {label}: {error}"));
    }
}
