// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Browser presentation policy, version 1: how a connector browser is
// presented, decided before any browser process starts. The wire form is
// shared with the reference implementation
// (`reference-implementation/runtime/browser-presentation-policy.ts`). Both
// parsers read the same conformance cases in
// `browser-presentation-policy.fixtures.json` and must agree on every one.

use serde::{Deserialize, Serialize};

pub(crate) const PRESENTATION_POLICY_VERSION: u64 = 1;
/// Overrides the presentation the desktop host selects for its browsers:
/// `desktop` keeps the legacy visible window, `private-xvfb` requires the
/// private display and fails launches when it is unavailable.
pub(crate) const BROWSER_DISPLAY_ENV: &str = "DATACONNECT_BROWSER_DISPLAY";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EngineMode {
    Headed,
    Headless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DisplayBackend {
    InheritedHost,
    PrivateXvfb,
    ExternallyOwned,
}

impl DisplayBackend {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InheritedHost => "inherited-host",
            Self::PrivateXvfb => "private-xvfb",
            Self::ExternallyOwned => "externally-owned",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeVisibility {
    Normal,
    IsolatedDisplay,
    NoWindow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum InteractionPresentation {
    Companion,
    Native,
}

/// v1 has no continuation onto the owner's desktop: a display failure fails
/// the launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Fallback {
    FailClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PresentationPolicy {
    pub version: u64,
    pub engine_mode: EngineMode,
    pub display_backend: DisplayBackend,
    pub native_visibility: NativeVisibility,
    pub interaction_presentation: InteractionPresentation,
    pub fallback: Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyError {
    /// `invalid_shape`, `unsupported_version` or `invalid_combination`, the
    /// same codes the TypeScript parser uses.
    pub code: &'static str,
    pub message: String,
}

impl PolicyError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl PresentationPolicy {
    /// Headed Chromium on a private display that only the host can reach. The
    /// owner sees and operates the browser through the companion.
    pub(crate) const PRIVATE_XVFB: Self = Self {
        version: PRESENTATION_POLICY_VERSION,
        engine_mode: EngineMode::Headed,
        display_backend: DisplayBackend::PrivateXvfb,
        native_visibility: NativeVisibility::IsolatedDisplay,
        interaction_presentation: InteractionPresentation::Companion,
        fallback: Fallback::FailClosed,
    };

    /// Parse and validate a policy value. The version is checked first, so a
    /// newer policy with fields v1 does not know is reported as an
    /// unsupported version rather than a malformed v1 policy.
    pub(crate) fn parse(value: &serde_json::Value) -> Result<Self, PolicyError> {
        let object = value.as_object().ok_or_else(|| {
            PolicyError::new("invalid_shape", "presentation policy must be a JSON object")
        })?;
        let version = object
            .get("version")
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| {
                PolicyError::new(
                    "invalid_shape",
                    "presentation policy version must be a number",
                )
            })?;
        if version != PRESENTATION_POLICY_VERSION as f64 {
            return Err(PolicyError::new(
                "unsupported_version",
                format!(
                    "presentation policy version {version} is not supported; expected {PRESENTATION_POLICY_VERSION}"
                ),
            ));
        }
        // JSON `1.0` is version 1 in TypeScript too; normalize it for serde.
        let mut object = object.clone();
        object.insert("version".into(), PRESENTATION_POLICY_VERSION.into());
        let policy: Self = serde_json::from_value(serde_json::Value::Object(object))
            .map_err(|error| PolicyError::new("invalid_shape", error.to_string()))?;
        if let Some(conflict) = policy.conflict() {
            return Err(PolicyError::new("invalid_combination", conflict));
        }
        Ok(policy)
    }

    /// The combination rules. Keep them in step with
    /// `presentationPolicyConflict` in the TypeScript parser.
    fn conflict(&self) -> Option<String> {
        if self.engine_mode == EngineMode::Headless {
            if self.display_backend != DisplayBackend::InheritedHost {
                return Some(
                    "a headless browser needs no display, so display_backend must be inherited-host"
                        .into(),
                );
            }
            if self.native_visibility != NativeVisibility::NoWindow {
                return Some(
                    "a headless browser has no native window, so native_visibility must be no-window"
                        .into(),
                );
            }
            if self.interaction_presentation != InteractionPresentation::Companion {
                return Some("a headless browser can only be reached through the companion".into());
            }
            return None;
        }
        if self.native_visibility == NativeVisibility::NoWindow {
            return Some("a headed browser always has a native window".into());
        }
        if self.display_backend == DisplayBackend::InheritedHost {
            if self.native_visibility != NativeVisibility::Normal {
                return Some("v1 has no adapter that hides a window on the owner's desktop".into());
            }
            return None;
        }
        if self.native_visibility != NativeVisibility::IsolatedDisplay {
            return Some(format!(
                "display_backend {} renders on an isolated display",
                self.display_backend.as_str()
            ));
        }
        if self.interaction_presentation != InteractionPresentation::Companion {
            return Some(
                "the owner cannot see an isolated display, so interaction must use the companion"
                    .into(),
            );
        }
        None
    }

    pub(crate) fn headless(&self) -> bool {
        self.engine_mode == EngineMode::Headless
    }
}

/// What the desktop host asks of its own browsers when the owner has not
/// overridden it. Only Linux has a private display backend in v1; it is
/// selected when the backend reports it can start. Everywhere else, and when
/// the legacy `PDPP_BROWSER_HEADLESS=1` is set, the host advertises no
/// policy and launches exactly as before.
pub(crate) fn deployment_policy(
    display_override: Option<&str>,
    legacy_headless: bool,
    private_xvfb_available: bool,
) -> Result<Option<PresentationPolicy>, String> {
    match display_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("desktop") => Ok(None),
        Some("private-xvfb") => {
            if legacy_headless {
                return Err(format!(
                    "{BROWSER_DISPLAY_ENV}=private-xvfb conflicts with PDPP_BROWSER_HEADLESS=1"
                ));
            }
            // Selected even when Xvfb is missing: the launch then fails with
            // browser_display_unavailable instead of showing a window.
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        }
        Some(other) => Err(format!(
            "{BROWSER_DISPLAY_ENV} must be desktop or private-xvfb, not {other:?}"
        )),
        None if legacy_headless || !private_xvfb_available => Ok(None),
        None => Ok(Some(PresentationPolicy::PRIVATE_XVFB)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_cases() -> Vec<serde_json::Value> {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../reference-implementation/runtime/browser-presentation-policy.fixtures.json"
        ))
        .expect("shared presentation policy fixtures are JSON");
        fixtures["cases"]
            .as_array()
            .expect("fixtures have cases")
            .clone()
    }

    #[test]
    fn shared_fixtures_give_the_same_verdict_as_the_typescript_parser() {
        let cases = fixture_cases();
        assert!(cases.len() >= 20, "fixture file lost its cases");
        for case in cases {
            let name = case["name"].as_str().expect("case name");
            let result = PresentationPolicy::parse(&case["policy"]);
            match case["error"].as_str() {
                None => {
                    let policy = result
                        .unwrap_or_else(|error| panic!("{name}: expected valid, got {error:?}"));
                    // A valid policy round-trips to the same wire value.
                    assert_eq!(
                        serde_json::to_value(policy).expect("serialize"),
                        case["policy"],
                        "{name}"
                    );
                }
                Some(code) => {
                    let error = result.expect_err(name);
                    assert_eq!(error.code, code, "{name}: {}", error.message);
                }
            }
        }
    }

    #[test]
    fn version_one_written_as_a_float_is_version_one() {
        let mut value = serde_json::to_value(PresentationPolicy::PRIVATE_XVFB).expect("serialize");
        value["version"] = json!(1.0);
        assert_eq!(
            PresentationPolicy::parse(&value),
            Ok(PresentationPolicy::PRIVATE_XVFB)
        );
    }

    #[test]
    fn the_desktop_policy_prefers_private_xvfb_on_linux_and_keeps_legacy_otherwise() {
        assert_eq!(
            deployment_policy(None, false, true),
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        );
        assert_eq!(deployment_policy(None, false, false), Ok(None));
        assert_eq!(deployment_policy(None, true, true), Ok(None));
        assert_eq!(deployment_policy(Some("desktop"), false, true), Ok(None));
        assert_eq!(deployment_policy(Some(" "), false, false), Ok(None));
        // An explicit request is honored even without Xvfb, so the launch
        // fails visibly instead of falling back to the owner's desktop.
        assert_eq!(
            deployment_policy(Some("private-xvfb"), false, false),
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        );
        assert!(deployment_policy(Some("private-xvfb"), true, true).is_err());
        assert!(deployment_policy(Some("xvfb"), false, true).is_err());
    }
}
