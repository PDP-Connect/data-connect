//! Pure validation and precedence for the desktop attach targets.

use serde::{Deserialize, Serialize};
use url::{Host, Url};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttachTarget {
    pub ri_origin: String,
    pub console_url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedAttach {
    pub ri_origin: Option<String>,
    pub console_url: Option<String>,
}

impl ResolvedAttach {
    pub fn is_attached(&self) -> bool {
        self.ri_origin.is_some() || self.console_url.is_some()
    }
}

pub fn resolve_attach_target(
    env_ri: Option<&str>,
    env_console: Option<&str>,
    saved: Option<&AttachTarget>,
) -> ResolvedAttach {
    fn resolve(env: Option<&str>, saved: Option<&str>) -> Option<String> {
        env.map(str::trim)
            .filter(|value| !value.is_empty())
            .or(saved)
            .map(str::to_owned)
    }

    ResolvedAttach {
        ri_origin: resolve(env_ri, saved.map(|target| target.ri_origin.as_str())),
        console_url: resolve(env_console, saved.map(|target| target.console_url.as_str())),
    }
}

pub fn validate_attach_target(ri: &str, console: &str) -> Result<AttachTarget, String> {
    Ok(AttachTarget {
        ri_origin: validate_origin(ri).map_err(|reason| format!("Reference server URL: {reason}"))?,
        console_url: validate_origin(console).map_err(|reason| format!("Console URL: {reason}"))?,
    })
}

fn validate_origin(value: &str) -> Result<String, &'static str> {
    let value = value.trim();
    let (_, raw_origin) = value.split_once("://").ok_or("expected an absolute HTTP(S) URL")?;
    let authority_end = raw_origin
        .find(|c: char| matches!(c, '/' | '?' | '#' | '\\'))
        .unwrap_or(raw_origin.len());
    let (authority, suffix) = raw_origin.split_at(authority_end);
    let url = Url::parse(value).map_err(|_| "expected an absolute HTTP(S) URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only HTTP and HTTPS are supported");
    }
    let host = url.host().ok_or("host is required")?;
    if authority.is_empty() {
        return Err("host is required");
    }
    if authority.contains('@') || !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed");
    }
    // Require the raw URL to be an origin as well: URL parsing can normalize paths.
    let origin_only = matches!(suffix, "" | "/");
    if !origin_only || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("paths, queries, and fragments are not allowed");
    }
    let loopback = match host {
        Host::Domain(name) => name == "localhost",
        Host::Ipv4(ip) => ip.octets() == [127, 0, 0, 1],
        Host::Ipv6(ip) => ip.is_loopback(),
    };
    if url.scheme() == "http" && !loopback {
        return Err("HTTPS is required for non-loopback hosts");
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> AttachTarget {
        AttachTarget {
            ri_origin: "https://saved-ri.example".into(),
            console_url: "https://saved-console.example".into(),
        }
    }

    #[test]
    fn env_values_override_saved_fields_independently() {
        let saved = saved();
        let both = resolve_attach_target(
            Some(" https://env-ri.example "),
            Some(" https://env-console.example "),
            Some(&saved),
        );
        assert_eq!(both.ri_origin.as_deref(), Some("https://env-ri.example"));
        assert_eq!(both.console_url.as_deref(), Some("https://env-console.example"));
        let mixed = resolve_attach_target(Some("https://env-ri.example"), None, Some(&saved));
        assert_eq!(mixed.ri_origin.as_deref(), Some("https://env-ri.example"));
        assert_eq!(mixed.console_url.as_deref(), Some("https://saved-console.example"));
    }

    #[test]
    fn blank_env_falls_back_and_either_field_enables_attach() {
        let saved = saved();
        let resolved = resolve_attach_target(Some(""), Some(" \t "), Some(&saved));
        assert_eq!(resolved.ri_origin.as_deref(), Some(saved.ri_origin.as_str()));
        assert_eq!(resolved.console_url.as_deref(), Some(saved.console_url.as_str()));
        assert!(resolve_attach_target(Some("http://localhost"), None, None).is_attached());
        assert!(resolve_attach_target(None, Some("http://localhost"), None).is_attached());
        assert!(!resolve_attach_target(None, None, None).is_attached());
        assert!(!resolve_attach_target(Some(" "), Some(""), None).is_attached());
    }

    #[test]
    fn normalizes_loopback_and_https_origins() {
        let local = validate_attach_target(" http://127.0.0.1:3000/ ", "http://localhost:3010/")
            .unwrap();
        assert_eq!(local.ri_origin, "http://127.0.0.1:3000");
        assert_eq!(local.console_url, "http://localhost:3010");
        let remote = validate_attach_target("https://example.org/", "http://[::1]:3010/")
            .unwrap();
        assert_eq!(remote.ri_origin, "https://example.org");
        assert_eq!(remote.console_url, "http://[::1]:3010");
    }

    #[test]
    fn rejects_non_origins_and_non_loopback_http_in_either_field() {
        for invalid in [
            "http://example.org",
            "ftp://x",
            "file:///x",
            "https://user:pw@example.org",
            "https://example.org/path",
            "https://example.org/?q=1",
            "https://example.org/#f",
            "",
        ] {
            assert!(validate_attach_target(invalid, "https://example.org").is_err());
            assert!(validate_attach_target("https://example.org", invalid).is_err());
        }
    }
}
