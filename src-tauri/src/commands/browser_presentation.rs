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
/// Overrides the presentation the desktop host selects for its browsers;
/// see `select_policy`.
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
    HiddenNative,
    ExternallyOwned,
}

impl DisplayBackend {
    const ALL: [Self; 4] = [
        Self::InheritedHost,
        Self::PrivateXvfb,
        Self::HiddenNative,
        Self::ExternallyOwned,
    ];

    pub(crate) fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|backend| backend.as_str() == name)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InheritedHost => "inherited-host",
            Self::PrivateXvfb => "private-xvfb",
            Self::HiddenNative => "hidden-native",
            Self::ExternallyOwned => "externally-owned",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeVisibility {
    Normal,
    IsolatedDisplay,
    Concealed,
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

    /// Headed Chromium whose windows the owner does not see from launch: on
    /// a private virtual display on macOS, concealed on the owner's desktop
    /// on Windows. The owner reaches it through the companion; the host can
    /// reveal a concealed one.
    pub(crate) const HIDDEN_NATIVE: Self = Self {
        version: PRESENTATION_POLICY_VERSION,
        engine_mode: EngineMode::Headed,
        display_backend: DisplayBackend::HiddenNative,
        native_visibility: NativeVisibility::Concealed,
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
                return Some(
                    "a window on the inherited display is shown normally; hiding it needs display_backend hidden-native"
                        .into(),
                );
            }
            return None;
        }
        if self.display_backend == DisplayBackend::HiddenNative {
            if self.native_visibility != NativeVisibility::Concealed {
                return Some(
                    "display_backend hidden-native keeps the window on the owner's desktop concealed, so native_visibility must be concealed"
                        .into(),
                );
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

    /// The policy the desktop host executes on `backend`, if it executes
    /// one there at all.
    pub(crate) fn for_backend(backend: DisplayBackend) -> Option<Self> {
        match backend {
            DisplayBackend::PrivateXvfb => Some(Self::PRIVATE_XVFB),
            DisplayBackend::HiddenNative => Some(Self::HIDDEN_NATIVE),
            DisplayBackend::InheritedHost | DisplayBackend::ExternallyOwned => None,
        }
    }
}

/// What the desktop host asks of its own browsers. `installed` lists the
/// display backends whose software is present, most preferred first; the
/// first one that the host can execute becomes the default. An owner
/// override always wins: `desktop` keeps the legacy visible window, and a
/// named backend is selected even when it is not installed, so its launches
/// fail instead of showing a window. With no override, an absent backend
/// leaves the legacy visible window, as does the legacy
/// `PDPP_BROWSER_HEADLESS=1`. None means no policy is advertised and the
/// host launches exactly as before.
pub(crate) fn select_policy(
    display_override: Option<&str>,
    legacy_headless: bool,
    installed: &[DisplayBackend],
) -> Result<Option<PresentationPolicy>, String> {
    match display_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("desktop") => Ok(None),
        Some(name) => {
            let policy = DisplayBackend::from_name(name)
                .and_then(PresentationPolicy::for_backend)
                .ok_or_else(|| {
                    format!(
                        "{BROWSER_DISPLAY_ENV} must be desktop, private-xvfb or hidden-native, not {name:?}"
                    )
                })?;
            if legacy_headless && !policy.headless() {
                return Err(format!(
                    "{BROWSER_DISPLAY_ENV}={name} conflicts with PDPP_BROWSER_HEADLESS=1"
                ));
            }
            Ok(Some(policy))
        }
        None if legacy_headless => Ok(None),
        None => Ok(installed
            .iter()
            .find_map(|backend| PresentationPolicy::for_backend(*backend))),
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

    // A case that names one point of the version 1 enum space: an object with
    // exactly the six v1 fields, each holding a known value.
    fn enum_combination_key(policy: &serde_json::Value) -> Option<String> {
        const SPACES: [(&str, &[&str]); 5] = [
            (
                "display_backend",
                &[
                    "inherited-host",
                    "private-xvfb",
                    "hidden-native",
                    "externally-owned",
                ],
            ),
            ("engine_mode", &["headed", "headless"]),
            ("fallback", &["fail-closed"]),
            ("interaction_presentation", &["companion", "native"]),
            (
                "native_visibility",
                &["normal", "isolated-display", "concealed", "no-window"],
            ),
        ];
        let object = policy.as_object()?;
        if object.get("version") != Some(&json!(1)) || object.len() != SPACES.len() + 1 {
            return None;
        }
        let mut parts = Vec::new();
        for (field, values) in SPACES {
            let value = object.get(field)?.as_str()?;
            if !values.contains(&value) {
                return None;
            }
            parts.push(value);
        }
        Some(parts.join("/"))
    }

    #[test]
    fn shared_fixtures_cover_every_v1_enum_combination_exactly_once() {
        let mut expected = std::collections::BTreeSet::new();
        for display in [
            "inherited-host",
            "private-xvfb",
            "hidden-native",
            "externally-owned",
        ] {
            for engine in ["headed", "headless"] {
                for visibility in ["normal", "isolated-display", "concealed", "no-window"] {
                    for interaction in ["companion", "native"] {
                        expected.insert(format!(
                            "{display}/{engine}/fail-closed/{interaction}/{visibility}"
                        ));
                    }
                }
            }
        }
        assert_eq!(expected.len(), 64);
        let mut seen = std::collections::BTreeMap::<String, usize>::new();
        for case in fixture_cases() {
            if let Some(key) = enum_combination_key(&case["policy"]) {
                *seen.entry(key).or_default() += 1;
            }
        }
        assert_eq!(
            seen.keys().cloned().collect::<Vec<_>>(),
            expected.into_iter().collect::<Vec<_>>()
        );
        for (key, count) in seen {
            assert_eq!(count, 1, "combination {key} appears {count} times");
        }
    }

    #[test]
    fn shared_fixtures_give_the_same_verdict_as_the_typescript_parser() {
        let cases = fixture_cases();
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
    fn selection_prefers_the_first_installed_backend_and_honors_the_override() {
        let xvfb = [DisplayBackend::PrivateXvfb];
        assert_eq!(
            select_policy(None, false, &xvfb),
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        );
        // Automatic selection without an installed backend keeps the legacy
        // visible window; only an explicit request fails closed.
        assert_eq!(select_policy(None, false, &[]), Ok(None));
        assert_eq!(select_policy(None, true, &xvfb), Ok(None));
        assert_eq!(select_policy(Some("desktop"), false, &xvfb), Ok(None));
        assert_eq!(select_policy(Some(" "), false, &[]), Ok(None));
        // A backend the host has no policy for is not a default.
        assert_eq!(
            select_policy(None, false, &[DisplayBackend::InheritedHost]),
            Ok(None)
        );
        assert_eq!(
            select_policy(
                None,
                false,
                &[DisplayBackend::InheritedHost, DisplayBackend::PrivateXvfb]
            ),
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        );
        assert_eq!(
            select_policy(Some("private-xvfb"), false, &[]),
            Ok(Some(PresentationPolicy::PRIVATE_XVFB))
        );
        assert!(select_policy(Some("private-xvfb"), true, &xvfb).is_err());
        assert!(select_policy(Some("xvfb"), false, &xvfb).is_err());
        assert!(select_policy(Some("inherited-host"), false, &xvfb).is_err());
        assert!(select_policy(Some("externally-owned"), false, &xvfb).is_err());
    }
}
