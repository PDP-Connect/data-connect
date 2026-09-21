// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
fn main() {
    stage_development_node_sidecar();
    stage_development_cloudflared_sidecar();
    tauri_build::build()
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

/// Tauri's `externalBin` resource copy (`tauri_build::build`) requires the
/// target-triple-qualified file to exist at build time, in every profile --
/// confirmed directly: both `cargo check` and `cargo check --release` fail
/// build.rs itself with "resource path ... doesn't exist" when it is
/// missing, there is no dev/debug exemption the way `pdpp-node`'s staging
/// has one. Unlike Node (a hard build-time requirement, so a system copy
/// always exists to hard-link from), a system `cloudflared` may genuinely be
/// absent on a dev machine -- that is the realistic first-run state this
/// whole feature exists to handle, not an edge case (see
/// `remote_access_cloudflare.rs`'s module doc comment) -- so this function
/// must always leave SOME file at the destination, real or a placeholder,
/// never skip and let `tauri_build::build()` fail the whole compile.
///
/// If `cloudflared` happens to be on `PATH`, stage a real dev-shaped sidecar
/// from it, so a local `cargo run` can exercise the bundled-sidecar spawn
/// path without running `scripts/stage-pdpp-cloudflared.mjs` first. If it is
/// not, write a placeholder marker file instead -- never a byte-for-byte
/// copy of anything spawnable. `unified.rs::resolve_cloudflared_binary` must
/// recognize this exact marker and treat it as "no bundled sidecar", falling
/// through to a system `cloudflared` (or an honest "not installed"), rather
/// than attempting to spawn it -- see `CLOUDFLARED_SIDECAR_PLACEHOLDER_MARKER`
/// there, which must stay byte-identical to `PLACEHOLDER_MARKER` below.
fn stage_development_cloudflared_sidecar() {
    std::fs::create_dir_all("binaries").expect("failed to create sidecar directory");

    // The LICENSE text is static and committed (unlike the binary, it never
    // needs downloading or verifying), so this is unconditional -- Tauri's
    // `binaries/pdpp-cloudflared-LICENSE` resource mapping requires the file
    // to exist at build time exactly like the binary does.
    let license_destination = std::path::PathBuf::from("binaries/pdpp-cloudflared-LICENSE");
    if !license_destination.is_file() {
        std::fs::copy("vendor-licenses/cloudflared-LICENSE", &license_destination)
            .expect("failed to stage cloudflared LICENSE");
    }

    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") { ".exe" } else { "" };
    let destination = std::path::PathBuf::from("binaries")
        .join(format!("pdpp-cloudflared-{target}{extension}"));
    if destination.is_file() {
        return;
    }
    let system_cloudflared = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| {
                directory.join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" })
            })
            .find(|candidate| candidate.is_file())
    });
    match system_cloudflared {
        Some(cloudflared) => stage_development_file(&cloudflared, &destination, "cloudflared sidecar"),
        None => {
            const PLACEHOLDER_MARKER: &[u8] = b"PDPP_CLOUDFLARED_SIDECAR_PLACEHOLDER\n\
                No cloudflared binary was available to stage at build time. This file exists only\n\
                so Tauri's externalBin resource copy has something to find; the runtime resolver\n\
                (unified.rs::resolve_cloudflared_binary) must recognize this exact marker and\n\
                never spawn it. Run scripts/stage-pdpp-cloudflared.mjs to replace it with a real\n\
                verified cloudflared binary.\n";
            std::fs::write(&destination, PLACEHOLDER_MARKER)
                .unwrap_or_else(|error| panic!("failed to write cloudflared sidecar placeholder: {error}"));
        }
    }
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
