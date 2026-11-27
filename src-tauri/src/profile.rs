// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Build-time test profile.
//!
//! A build made with `DATACONNECT_BUILD_PROFILE=<name>` moves the whole
//! process into `<real home>/.dataconnect-profiles/<name>/` (HOME and the XDG
//! base directories) and into its own keychain namespace, before any code
//! reads either. The profile is a compile-time constant of the binary: no
//! runtime flag, environment variable or config file turns it off, so a
//! profile build cannot touch the owner's installed DataConnect state even by
//! accident. A build without the variable is unchanged.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// Longest profile name accepted.
const MAX_PROFILE_LEN: usize = 32;

/// Directory under the real home that holds every profile's root.
const PROFILES_DIR: &str = ".dataconnect-profiles";

/// Fixed when the binary is compiled; `None` for a normal build.
const BUILD_PROFILE: Option<&str> = option_env!("DATACONNECT_BUILD_PROFILE");

// An invalid value fails the build, not the first run.
const _: () = assert!(
    match BUILD_PROFILE {
        Some(name) => is_valid_name(name),
        None => true,
    },
    "DATACONNECT_BUILD_PROFILE must match [a-z0-9-]+ and be at most 32 bytes"
);

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// `[a-z0-9-]+`, at most [`MAX_PROFILE_LEN`] bytes, no leading `-`.
pub(crate) const fn is_valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_PROFILE_LEN || bytes[0] == b'-' {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
            return false;
        }
        index += 1;
    }
    true
}

/// The profile this binary was built with.
pub(crate) fn current() -> Option<&'static str> {
    BUILD_PROFILE
}

/// The profile's root directory. `None` for a normal build, and before
/// [`enter`] has run.
pub(crate) fn root() -> Option<&'static Path> {
    ROOT.get().map(PathBuf::as_path)
}

/// Keychain service name: `base` unchanged without a profile,
/// `<base>.<profile>` with one.
pub(crate) fn keyring_service(base: &str) -> String {
    keyring_service_for(base, current())
}

/// An identifier that must not be shared with the installed app (a tray id,
/// which names a file in the user's runtime directory): `base` unchanged
/// without a profile, `<base>.<profile>` with one.
pub(crate) fn scoped_id(base: &str) -> String {
    keyring_service_for(base, current())
}

fn keyring_service_for(base: &str, profile: Option<&str>) -> String {
    match profile {
        Some(profile) => format!("{base}.{profile}"),
        None => base.to_string(),
    }
}

/// A window or tray name with the profile appended: `DataConnect (name)`.
pub(crate) fn decorate(name: &str) -> String {
    decorate_for(name, current())
}

fn decorate_for(name: &str, profile: Option<&str>) -> String {
    match profile {
        Some(profile) => format!("{name} ({profile})"),
        None => name.to_string(),
    }
}

/// The profile root under the real home.
pub(crate) fn profile_root(real_home: &Path, profile: &str) -> PathBuf {
    real_home.join(PROFILES_DIR).join(profile)
}

/// The environment a profile process runs with. Pure: it reads no state.
pub(crate) fn profile_env(real_home: &Path, profile: &str) -> Vec<(&'static str, PathBuf)> {
    let home = profile_root(real_home, profile).join("home");
    vec![
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_DATA_HOME", home.join(".local").join("share")),
        ("XDG_CACHE_HOME", home.join(".cache")),
        ("XDG_STATE_HOME", home.join(".local").join("state")),
        ("HOME", home),
    ]
}

/// The real home, given the current `HOME`. A process that restarts itself
/// (attach and detach do) inherits the profile's HOME, so `home` may already
/// be `<real home>/.dataconnect-profiles/<profile>/home`; the real home is then
/// three levels up. Without this the restarted process would nest a second
/// profile root inside the first and lose its saved state.
pub(crate) fn real_home_from(home: &Path, profile: &str) -> PathBuf {
    let already_entered = home.parent().and_then(Path::parent).and_then(Path::parent);
    match already_entered {
        Some(real_home) if profile_root(real_home, profile).join("home") == home => {
            real_home.to_path_buf()
        }
        _ => home.to_path_buf(),
    }
}

/// `path` must be inside `root` with no `..` component.
pub(crate) fn check_inside(label: &str, path: &Path, root: &Path) -> Result<(), String> {
    let escapes = path.components().any(|part| part == Component::ParentDir);
    if path.starts_with(root) && !escapes {
        Ok(())
    } else {
        Err(format!(
            "profile self-check failed: {label} is {} (outside {})",
            path.display(),
            root.display()
        ))
    }
}

/// A profile build must carry its own Tauri identifier (`<id>.<profile>`):
/// the identifier names the single-instance lock, the window-state file and
/// the data directory, so the owner's installed app must never share it.
pub(crate) fn check_identifier(profile: &str, identifier: &str) -> Result<(), String> {
    if identifier.ends_with(&format!(".{profile}")) {
        Ok(())
    } else {
        Err(format!(
            "profile self-check failed: app identifier is {identifier}, which does not end in .{profile}; \
             build the profile with TAURI_CONFIG setting identifier to dev.dataconnect.{profile}"
        ))
    }
}

/// The path set the self-check covers, as seen through `dirs`.
fn resolved_paths() -> Vec<(&'static str, Option<PathBuf>)> {
    vec![
        ("home directory", dirs::home_dir()),
        ("data directory", dirs::data_dir()),
        ("config directory", dirs::config_dir()),
        ("cache directory", dirs::cache_dir()),
    ]
}

/// Exit when a profile build runs under an identifier without the profile suffix.
pub(crate) fn require_identifier(identifier: &str) {
    let Some(profile) = current() else { return };
    if let Err(message) = check_identifier(profile, identifier) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// Exit with the offending path when `path` is outside the profile root.
/// Used for the Tauri app data directory, which only exists in setup.
pub(crate) fn require_inside_root(label: &str, path: &Path) {
    let Some(root) = root() else { return };
    if let Err(message) = check_inside(label, path, root) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// Enter the profile, if the binary has one. Call first thing in `main`,
/// before the Tauri builder and before any thread starts: changing the
/// environment is unsound once other threads exist.
pub fn enter() {
    let Some(profile) = current() else { return };
    enter_profile(profile);
}

#[cfg(not(unix))]
fn enter_profile(profile: &str) {
    eprintln!("DataConnect test profile \"{profile}\" is supported on Unix only");
    std::process::exit(2);
}

#[cfg(unix)]
fn enter_profile(profile: &str) {
    use std::os::unix::fs::DirBuilderExt;

    let Some(current_home) = dirs::home_dir() else {
        eprintln!("profile {profile}: cannot resolve the real home directory");
        std::process::exit(1);
    };
    let real_home = real_home_from(&current_home, profile);
    let root = profile_root(&real_home, profile);
    let env = profile_env(&real_home, profile);
    for (_, directory) in &env {
        let created = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory);
        if let Err(error) = created {
            eprintln!(
                "profile {profile}: cannot create {}: {error}",
                directory.display()
            );
            std::process::exit(1);
        }
    }
    for (name, value) in &env {
        std::env::set_var(name, value);
    }
    for (label, path) in resolved_paths() {
        let verdict = match path {
            Some(path) => check_inside(label, &path, &root),
            None => Err(format!(
                "profile self-check failed: {label} did not resolve"
            )),
        };
        if let Err(message) = verdict {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
    let _ = ROOT.set(root.clone());
    eprintln!("profile {profile}: root={}", root.display());
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_restarted_profile_process_finds_the_same_root() {
        let real = Path::new("/home/owner");
        let entered = profile_root(real, "attach-test").join("home");
        assert_eq!(real_home_from(&entered, "attach-test"), real);
        assert_eq!(real_home_from(real, "attach-test"), real);
        // another profile's home is not mistaken for this one's
        let other = profile_root(real, "other").join("home");
        assert_eq!(real_home_from(&other, "attach-test"), other);
    }

    #[test]
    fn a_profile_build_needs_its_own_identifier() {
        assert!(check_identifier("attach-test", "dev.dataconnect.attach-test").is_ok());
        assert!(check_identifier("attach-test", "dev.dataconnect").is_err());
        assert!(check_identifier("attach-test", "dev.dataconnect.other").is_err());
    }

    use super::*;

    #[test]
    fn profile_env_moves_home_and_every_xdg_base_under_the_profile_root() {
        let env = profile_env(Path::new("/home/owner"), "attach-test");
        let home = "/home/owner/.dataconnect-profiles/attach-test/home";
        let expected = [
            ("XDG_CONFIG_HOME", format!("{home}/.config")),
            ("XDG_DATA_HOME", format!("{home}/.local/share")),
            ("XDG_CACHE_HOME", format!("{home}/.cache")),
            ("XDG_STATE_HOME", format!("{home}/.local/state")),
            ("HOME", home.to_string()),
        ];
        assert_eq!(env.len(), expected.len());
        for (name, path) in expected {
            let found = env.iter().find(|(key, _)| *key == name).expect(name);
            assert_eq!(found.1, PathBuf::from(path), "{name}");
        }
    }

    #[test]
    fn profile_env_leaves_session_and_display_variables_alone() {
        let env = profile_env(Path::new("/home/owner"), "x");
        for name in [
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
            "WAYLAND_DISPLAY",
        ] {
            assert!(env.iter().all(|(key, _)| *key != name), "{name}");
        }
    }

    #[test]
    fn profile_names_are_lowercase_alphanumeric_and_hyphen_only() {
        for good in ["a", "attach-test", "t3", "0-9", &"a".repeat(32)] {
            assert!(is_valid_name(good), "{good}");
        }
        for bad in [
            "",
            "-lead",
            "Upper",
            "has space",
            "under_score",
            "dot.dot",
            "../escape",
            "a/b",
            "é",
            &"a".repeat(33),
        ] {
            assert!(!is_valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn keyring_service_is_unchanged_without_a_profile() {
        assert_eq!(
            keyring_service_for("com.vana.dataconnect", None),
            "com.vana.dataconnect"
        );
    }

    #[test]
    fn keyring_service_gets_the_profile_suffix() {
        assert_eq!(
            keyring_service_for("com.vana.dataconnect", Some("attach-test")),
            "com.vana.dataconnect.attach-test"
        );
    }

    #[test]
    fn names_get_the_profile_only_when_one_is_set() {
        assert_eq!(decorate_for("DataConnect", None), "DataConnect");
        assert_eq!(
            decorate_for("DataConnect", Some("attach-test")),
            "DataConnect (attach-test)"
        );
    }

    #[test]
    fn self_check_accepts_paths_inside_the_root() {
        let root = profile_root(Path::new("/home/owner"), "p");
        assert!(check_inside("data", &root.join("home/.local/share"), &root).is_ok());
    }

    #[test]
    fn self_check_rejects_a_path_outside_the_root() {
        let root = profile_root(Path::new("/home/owner"), "p");
        for outside in [
            "/home/owner/.local/share",
            "/home/owner/.dataconnect-profiles/other/home",
            "/home/owner/.dataconnect-profiles/pp/home",
            "/home/owner/.dataconnect-profiles/p/../other",
        ] {
            let error =
                check_inside("data directory", Path::new(outside), &root).expect_err(outside);
            assert!(error.contains(outside), "{error}");
        }
    }

    /// Every keychain entry must take its service name from
    /// `profile::keyring_service`, so a profile build cannot read or write
    /// the owner's entries. A bare string literal (or constant) as the first
    /// argument fails this.
    #[test]
    fn every_keyring_entry_goes_through_the_profile_service_name() {
        let needle = ["keyring::Entry", "::new("].concat();
        let mut sources = Vec::new();
        collect_sources(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut sources,
        );
        let mut sites = 0;
        for path in sources {
            let text = std::fs::read_to_string(&path).expect("read source");
            for (offset, _) in text.match_indices(&needle) {
                sites += 1;
                let argument = text[offset + needle.len()..]
                    .split(',')
                    .next()
                    .unwrap_or_default();
                assert!(
                    argument.contains("keyring_service"),
                    "{}: keyring entry service is `{}`, not profile::keyring_service",
                    path.display(),
                    argument.trim()
                );
            }
        }
        assert!(
            sites >= 3,
            "expected the known keyring call sites, found {sites}"
        );
    }

    /// Run alone, in a profile build:
    /// `DATACONNECT_BUILD_PROFILE=zz cargo test --lib enter_moves -- --ignored`.
    /// It points HOME at a temp directory first, so the owner's home is never
    /// involved.
    #[cfg(unix)]
    #[test]
    #[ignore = "mutates the process environment; needs DATACONNECT_BUILD_PROFILE"]
    fn enter_moves_home_and_xdg_into_the_profile_root() {
        use std::os::unix::fs::PermissionsExt;
        let name = current().expect("build with DATACONNECT_BUILD_PROFILE");
        let fake_home = tempfile::tempdir().expect("tempdir");
        std::env::set_var("HOME", fake_home.path());
        let runtime = std::env::var_os("XDG_RUNTIME_DIR");
        enter();
        let root = root().expect("root set");
        assert_eq!(root, profile_root(fake_home.path(), name));
        assert_eq!(dirs::home_dir().expect("home"), root.join("home"));
        assert_eq!(
            dirs::data_dir().expect("data"),
            root.join("home/.local/share")
        );
        assert_eq!(dirs::cache_dir().expect("cache"), root.join("home/.cache"));
        assert_eq!(std::env::var_os("XDG_RUNTIME_DIR"), runtime);
        let mode = std::fs::metadata(root.join("home/.config"))
            .expect("config dir")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    fn collect_sources(directory: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                collect_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
}
