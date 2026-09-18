// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Public URL provider selection.
//!
//! The seam in `remote_access` defines the lifecycle; the ngrok adapter in
//! `remote_access_ngrok` implements it. This module is the part that turns a
//! stored `RemoteAccessConfig` into the right adapter and, critically, decides
//! the payload-privacy answer shown at choice time.
//!
//! The privacy property is a function of the endpoint the owner picks, not of
//! the posture. `public_url` is payload-private behind an owner-run proxy and
//! payload-readable behind ngrok's terminating HTTPS edge, so a posture-keyed
//! badge would state the opposite of the truth for one of them.

use crate::remote_access::{
    RemoteAccessPosture, RemoteAccessPrivacy, USER_SUPPLIED_ORIGIN_PROVIDER_ID,
};
use crate::remote_access_ngrok::{NgrokEndpointMode, NGROK_PROVIDER_ID};
use serde::{Deserialize, Serialize};

/// Options that only the ngrok provider consumes. Kept out of the seam's
/// `ReachabilityFields` so the contract stays provider-neutral.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct NgrokOptions {
    pub(crate) endpoint_mode: NgrokEndpointModeConfig,
    /// A reserved domain the owner holds on a paid ngrok plan. `None` accepts
    /// ngrok's randomly assigned hostname.
    #[serde(default)]
    pub(crate) reserved_domain: Option<String>,
}

/// The serialized spelling of `NgrokEndpointMode`. The adapter's enum carries
/// no serde derives, and adding them there would couple the adapter's internals
/// to the on-disk format.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NgrokEndpointModeConfig {
    HttpsEdgeTermination,
    TlsPassthrough,
    TcpPassthrough,
}

impl From<NgrokEndpointModeConfig> for NgrokEndpointMode {
    fn from(value: NgrokEndpointModeConfig) -> Self {
        match value {
            NgrokEndpointModeConfig::HttpsEdgeTermination => Self::HttpsEdgeTermination,
            NgrokEndpointModeConfig::TlsPassthrough => Self::TlsPassthrough,
            NgrokEndpointModeConfig::TcpPassthrough => Self::TcpPassthrough,
        }
    }
}

impl NgrokEndpointModeConfig {
    /// The disclosure shown before the owner commits to a provider.
    ///
    /// Passthrough confidentiality is proven for ngrok 0.19.0 specifically:
    /// `session.rs` sets `passthrough_tls = opts.tls_termination.is_none()`,
    /// and the adapter never calls `termination()`. It is not a guarantee about
    /// other versions, and it does not hide connection metadata from ngrok.
    pub(crate) fn privacy(self) -> RemoteAccessPrivacy {
        match self {
            Self::HttpsEdgeTermination => RemoteAccessPrivacy::ProviderCanReadPayload,
            Self::TlsPassthrough | Self::TcpPassthrough => {
                RemoteAccessPrivacy::ProviderCannotReadPayload
            }
        }
    }
}

/// Every provider selectable under the Public URL posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PublicUrlProvider {
    UserSuppliedOrigin,
    Ngrok(NgrokOptions),
}

impl PublicUrlProvider {
    pub(crate) fn provider_id(&self) -> &'static str {
        match self {
            Self::UserSuppliedOrigin => USER_SUPPLIED_ORIGIN_PROVIDER_ID,
            Self::Ngrok(_) => NGROK_PROVIDER_ID,
        }
    }

    /// The badge is never blank and never "unknown" for a selectable option.
    pub(crate) fn privacy(&self) -> RemoteAccessPrivacy {
        match self {
            // The owner runs the proxy, so no third party holds the plaintext.
            Self::UserSuppliedOrigin => RemoteAccessPrivacy::ProviderCannotReadPayload,
            Self::Ngrok(options) => options.endpoint_mode.privacy(),
        }
    }

    /// ngrok discovers its own origin at start; a user-supplied proxy cannot.
    pub(crate) fn discovers_own_origin(&self) -> bool {
        matches!(self, Self::Ngrok(_))
    }
}

/// Resolve the stored provider id plus options into a selectable provider.
pub(crate) fn resolve_public_url_provider(
    posture: &RemoteAccessPosture,
    provider_id: Option<&str>,
    ngrok: Option<&NgrokOptions>,
) -> Result<PublicUrlProvider, String> {
    if !matches!(posture, RemoteAccessPosture::PublicUrl) {
        return Err("Provider selection requires the public_url posture".to_string());
    }
    match provider_id {
        Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID) => Ok(PublicUrlProvider::UserSuppliedOrigin),
        Some(NGROK_PROVIDER_ID) => {
            let options = ngrok
                .ok_or_else(|| "ngrok requires an endpoint mode".to_string())?
                .clone();
            if matches!(
                options.endpoint_mode,
                NgrokEndpointModeConfig::TcpPassthrough
            ) && options.reserved_domain.is_some()
            {
                return Err("ngrok TCP endpoints reserve an address, not a domain".to_string());
            }
            Ok(PublicUrlProvider::Ngrok(options))
        }
        Some(other) => Err(format!("Unknown remote-access provider: {other}")),
        None => Err("Public URL requires a provider".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ngrok(mode: NgrokEndpointModeConfig, domain: Option<&str>) -> NgrokOptions {
        NgrokOptions {
            endpoint_mode: mode,
            reserved_domain: domain.map(str::to_string),
        }
    }

    #[test]
    fn edge_termination_is_disclosed_as_provider_readable() {
        let provider =
            PublicUrlProvider::Ngrok(ngrok(NgrokEndpointModeConfig::HttpsEdgeTermination, None));
        assert_eq!(
            provider.privacy(),
            RemoteAccessPrivacy::ProviderCanReadPayload
        );
    }

    #[test]
    fn passthrough_is_disclosed_as_provider_unreadable() {
        for mode in [
            NgrokEndpointModeConfig::TlsPassthrough,
            NgrokEndpointModeConfig::TcpPassthrough,
        ] {
            assert_eq!(
                PublicUrlProvider::Ngrok(ngrok(mode, None)).privacy(),
                RemoteAccessPrivacy::ProviderCannotReadPayload,
                "{mode:?}"
            );
        }
    }

    #[test]
    fn every_selectable_provider_states_a_privacy_answer() {
        // The seam has exactly two privacy values and no unknown variant, so
        // this asserts the property stays total as providers are added.
        let providers = [
            PublicUrlProvider::UserSuppliedOrigin,
            PublicUrlProvider::Ngrok(ngrok(NgrokEndpointModeConfig::HttpsEdgeTermination, None)),
            PublicUrlProvider::Ngrok(ngrok(NgrokEndpointModeConfig::TlsPassthrough, None)),
        ];
        for provider in providers {
            assert!(matches!(
                provider.privacy(),
                RemoteAccessPrivacy::ProviderCanReadPayload
                    | RemoteAccessPrivacy::ProviderCannotReadPayload
            ));
        }
    }

    #[test]
    fn resolves_ngrok_with_an_optional_reserved_domain() {
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            Some(&ngrok(
                NgrokEndpointModeConfig::HttpsEdgeTermination,
                Some("vault.ngrok.app"),
            )),
        )
        .expect("resolved");
        assert_eq!(resolved.provider_id(), NGROK_PROVIDER_ID);
        assert!(resolved.discovers_own_origin());
    }

    #[test]
    fn resolves_ngrok_without_a_reserved_domain() {
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            Some(&ngrok(NgrokEndpointModeConfig::HttpsEdgeTermination, None)),
        )
        .expect("resolved");
        assert_eq!(resolved.provider_id(), NGROK_PROVIDER_ID);
    }

    #[test]
    fn refuses_a_reserved_domain_on_a_tcp_endpoint() {
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            Some(&ngrok(
                NgrokEndpointModeConfig::TcpPassthrough,
                Some("vault.ngrok.app")
            )),
        )
        .is_err());
    }

    #[test]
    fn refuses_ngrok_without_endpoint_options() {
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            None,
        )
        .is_err());
    }

    #[test]
    fn refuses_an_unknown_provider_and_a_non_public_posture() {
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some("mystery_relay"),
            None,
        )
        .is_err());
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::Off,
            Some(NGROK_PROVIDER_ID),
            None,
        )
        .is_err());
    }

    #[test]
    fn user_supplied_origin_does_not_discover_its_own_origin() {
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID),
            None,
        )
        .expect("resolved");
        assert!(!resolved.discovers_own_origin());
        assert_eq!(
            resolved.privacy(),
            RemoteAccessPrivacy::ProviderCannotReadPayload
        );
    }
}
