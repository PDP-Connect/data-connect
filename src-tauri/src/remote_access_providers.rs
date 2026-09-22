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
use crate::remote_access_cloudflare::CLOUDFLARE_TUNNEL_PROVIDER_ID;
use crate::remote_access_ngrok::{NgrokEndpointMode, NGROK_PROVIDER_ID};
use serde::{Deserialize, Serialize};

/// Options the Cloudflare named-tunnel provider consumes. Kept out of the
/// seam's `ReachabilityFields` for the same reason `NgrokOptions` is: the
/// four-field contract stays provider-neutral.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct CloudflareTunnelOptions {
    /// The public hostname the owner already routed to this tunnel in the
    /// Cloudflare dashboard/API. Unlike ngrok's `reserved_domain`, this is
    /// never optional: a named tunnel with no routed hostname is not usable
    /// as a Public URL provider, so there is no "not yet configured" state
    /// to represent here the way ngrok's free-plan dev domain has.
    pub(crate) hostname: String,
}

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
    CloudflareTunnel(CloudflareTunnelOptions),
}

impl PublicUrlProvider {
    pub(crate) fn provider_id(&self) -> &'static str {
        match self {
            Self::UserSuppliedOrigin => USER_SUPPLIED_ORIGIN_PROVIDER_ID,
            Self::Ngrok(_) => NGROK_PROVIDER_ID,
            Self::CloudflareTunnel(_) => CLOUDFLARE_TUNNEL_PROVIDER_ID,
        }
    }

    /// The badge is never blank and never "unknown" for a selectable option.
    pub(crate) fn privacy(&self) -> RemoteAccessPrivacy {
        match self {
            // The owner runs the proxy, so no third party holds the plaintext.
            Self::UserSuppliedOrigin => RemoteAccessPrivacy::ProviderCannotReadPayload,
            Self::Ngrok(options) => options.endpoint_mode.privacy(),
            // Cloudflare terminates TLS at its edge for every named tunnel --
            // no passthrough mode exists the way ngrok offers one. Never
            // soften this: it must always disclose ProviderCanReadPayload.
            Self::CloudflareTunnel(_) => RemoteAccessPrivacy::ProviderCanReadPayload,
        }
    }

    /// This provider's durable-address capability, computed from stored
    /// config alone -- no running session or live provider instance exists
    /// yet at validation time (`resolve_public_url_provider` runs before any
    /// `RemoteAccessProvider` is constructed). Must answer the exact same
    /// question a live `NgrokProvider::durable_address()` would once
    /// started with the same options: both now call the shared
    /// `ngrok_durable_address_for_reserved_domain`, so there is one
    /// implementation, not two that can drift.
    ///
    /// `UserSuppliedOrigin` reports `NotApplicable` for the same reason
    /// `UserSuppliedOriginProvider::durable_address()` does (see that
    /// method's doc comment in `remote_access.rs`): the owner supplies the
    /// whole origin directly, so there is no addressing concept to report.
    pub(crate) fn durable_address(&self) -> crate::remote_access::DurableAddressState {
        match self {
            Self::UserSuppliedOrigin => crate::remote_access::DurableAddressState::NotApplicable,
            Self::Ngrok(options) => {
                crate::remote_access_ngrok::ngrok_durable_address_for_reserved_domain(
                    options.reserved_domain.as_deref(),
                )
            }
            Self::CloudflareTunnel(options) => {
                crate::remote_access_cloudflare::cloudflare_tunnel_durable_address(
                    &options.hostname,
                )
            }
        }
    }

    /// Whether `PDPP_REFERENCE_ORIGIN` should already be present in stored
    /// config (true) or must stay empty until a live session reports it
    /// (false) -- the single rule `validate_remote_access_config` applies,
    /// derived from this provider's own `durable_address()` rather than a
    /// separate, provider-kind-keyed concept. See
    /// `DurableAddressState::origin_is_knowable_from_config`'s doc comment
    /// for why the two concepts were merged into one.
    pub(crate) fn origin_is_knowable_from_config(&self) -> bool {
        self.durable_address().origin_is_knowable_from_config()
    }

    /// Who owns the mapping from the public origin to this computer's
    /// console. Knowing the public ADDRESS (`durable_address`) is a
    /// different question from knowing where that address LEADS: a
    /// Cloudflare hostname is known from config, yet the app cannot set its
    /// route.
    ///
    /// Answered from stored config alone, like every other method here. No
    /// variant needs a runtime answer: see the Cloudflare arm for the one
    /// case where the mode could differ.
    pub(crate) fn origin_binding(&self) -> crate::remote_access::OriginBinding {
        use crate::remote_access::OriginBinding;
        match self {
            // The owner's own reverse proxy decides where the origin leads.
            // Not a third variant: every consequence the owner sees is the
            // same as for a provider's control plane (the app cannot set it,
            // a changed console port breaks it, only a probe can confirm
            // it). The port pin is a separate setting, not a different
            // binding.
            Self::UserSuppliedOrigin => OriginBinding::OwnerMaintained {
                where_to_set: "the upstream (target) setting of your reverse proxy".to_string(),
            },
            // The SDK's forwarder is handed the loopback URL at listen time
            // and ngrok's edge sends the agent endpoint's traffic to it;
            // nothing on ngrok's side can redirect it elsewhere.
            Self::Ngrok(_) => OriginBinding::AppSupplied,
            // A dashboard-created tunnel is remotely managed, and its route
            // silently overrides the `--url` the adapter passes (seen on a
            // live tunnel on 2026-09-22: zero local config pushes, traffic
            // still going to a port from before a rebuild). A locally
            // managed tunnel would honor `--url`, but the token does not say
            // which kind it is, and finding out would need either
            // Cloudflare's management API (a new credential and network
            // dependency) or parsing cloudflared's log text (brittle across
            // versions). So this is a constant: it states what the app can
            // guarantee, and the origin-proof probe reports what is actually
            // true, including when `--url` happened to be honored.
            Self::CloudflareTunnel(_) => OriginBinding::OwnerMaintained {
                where_to_set: "the Service URL of this hostname's route, in the Cloudflare \
                               dashboard (Networks > Tunnels > this tunnel > Routes)"
                    .to_string(),
            },
        }
    }
}

/// Resolve the stored provider id plus options into a selectable provider.
pub(crate) fn resolve_public_url_provider(
    posture: &RemoteAccessPosture,
    provider_id: Option<&str>,
    ngrok: Option<&NgrokOptions>,
    cloudflare_tunnel: Option<&CloudflareTunnelOptions>,
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
        Some(CLOUDFLARE_TUNNEL_PROVIDER_ID) => {
            let options = cloudflare_tunnel
                .ok_or_else(|| "Cloudflare tunnel requires a hostname".to_string())?
                .clone();
            if options.hostname.trim().is_empty() {
                return Err("Cloudflare tunnel requires a hostname".to_string());
            }
            Ok(PublicUrlProvider::CloudflareTunnel(options))
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

    fn cloudflare_tunnel(hostname: &str) -> CloudflareTunnelOptions {
        CloudflareTunnelOptions {
            hostname: hostname.to_string(),
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
            PublicUrlProvider::CloudflareTunnel(cloudflare_tunnel("vault.example.com")),
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
            None,
        )
        .expect("resolved");
        assert_eq!(resolved.provider_id(), NGROK_PROVIDER_ID);
        // A configured domain IS a durable address the owner already told
        // us about -- the origin is knowable from config alone, unlike a
        // fresh random ngrok hostname, which only the live tunnel can
        // report. See `origin_is_knowable_from_config`'s doc comment: this
        // is the exact case that a hardcoded "ngrok always discovers its
        // own origin" rule got wrong.
        assert!(resolved.origin_is_knowable_from_config());
        assert!(matches!(
            resolved.durable_address(),
            crate::remote_access::DurableAddressState::Available { address }
                if address == "vault.ngrok.app"
        ));
    }

    #[test]
    fn resolves_ngrok_without_a_reserved_domain() {
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            Some(&ngrok(NgrokEndpointModeConfig::HttpsEdgeTermination, None)),
            None,
        )
        .expect("resolved");
        assert_eq!(resolved.provider_id(), NGROK_PROVIDER_ID);
        // No domain configured: the origin is only knowable once ngrok's
        // edge assigns one at tunnel start, same as before this fix.
        assert!(!resolved.origin_is_knowable_from_config());
        assert!(matches!(
            resolved.durable_address(),
            crate::remote_access::DurableAddressState::AuthInsufficient { .. }
        ));
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
            None,
        )
        .is_err());
    }

    #[test]
    fn refuses_ngrok_without_endpoint_options() {
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(NGROK_PROVIDER_ID),
            None,
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
            None,
        )
        .is_err());
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::Off,
            Some(NGROK_PROVIDER_ID),
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn resolves_cloudflare_tunnel_with_its_hostname() {
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(CLOUDFLARE_TUNNEL_PROVIDER_ID),
            None,
            Some(&cloudflare_tunnel("vault.example.com")),
        )
        .expect("resolved");
        assert_eq!(resolved.provider_id(), CLOUDFLARE_TUNNEL_PROVIDER_ID);
        // A named tunnel's hostname is always a durable address -- there is
        // no "not yet configured" state the way ngrok's free-plan dev
        // domain has, because the owner already routed it in Cloudflare's
        // dashboard/API before this provider can be selected at all.
        assert!(resolved.origin_is_knowable_from_config());
        assert!(matches!(
            resolved.durable_address(),
            crate::remote_access::DurableAddressState::Available { address }
                if address == "vault.example.com"
        ));
    }

    #[test]
    fn cloudflare_tunnel_privacy_always_discloses_that_the_provider_can_read_the_payload() {
        // Cloudflare terminates TLS at its edge for every named tunnel --
        // never soften this to "cannot read," unlike ngrok's passthrough
        // modes which genuinely can make that claim.
        let provider = PublicUrlProvider::CloudflareTunnel(cloudflare_tunnel("vault.example.com"));
        assert_eq!(
            provider.privacy(),
            RemoteAccessPrivacy::ProviderCanReadPayload
        );
    }

    #[test]
    fn refuses_cloudflare_tunnel_without_a_hostname() {
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(CLOUDFLARE_TUNNEL_PROVIDER_ID),
            None,
            None,
        )
        .is_err());
        assert!(resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(CLOUDFLARE_TUNNEL_PROVIDER_ID),
            None,
            Some(&cloudflare_tunnel("  ")),
        )
        .is_err());
    }

    #[test]
    fn origin_binding_is_answered_per_provider_and_only_ngrok_supplies_its_own() {
        use crate::remote_access::OriginBinding;
        let cases = [
            (PublicUrlProvider::UserSuppliedOrigin, false),
            (
                PublicUrlProvider::Ngrok(ngrok(
                    NgrokEndpointModeConfig::HttpsEdgeTermination,
                    None,
                )),
                true,
            ),
            (
                PublicUrlProvider::Ngrok(ngrok(NgrokEndpointModeConfig::TlsPassthrough, None)),
                true,
            ),
            (
                PublicUrlProvider::CloudflareTunnel(cloudflare_tunnel("vault.example.com")),
                false,
            ),
        ];
        for (provider, app_supplied) in cases {
            match provider.origin_binding() {
                OriginBinding::AppSupplied => assert!(app_supplied, "{provider:?}"),
                OriginBinding::OwnerMaintained { where_to_set } => {
                    assert!(!app_supplied, "{provider:?}");
                    // The owner-facing copy renders this verbatim as the
                    // place to act, so it can never be blank.
                    assert!(!where_to_set.trim().is_empty(), "{provider:?}");
                }
            }
        }
    }

    #[test]
    fn user_supplied_origin_reports_not_applicable_but_its_origin_is_always_knowable_from_config() {
        // The crack a single "does this provider discover its own origin"
        // boolean cannot express cleanly: user_supplied_origin has NO
        // durable-address concept at all (`NotApplicable`), yet its origin
        // is always present in config, exactly like a resolved ngrok
        // domain. `origin_is_knowable_from_config` is the derived answer
        // both cases need, even though `durable_address()` itself differs.
        let resolved = resolve_public_url_provider(
            &RemoteAccessPosture::PublicUrl,
            Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID),
            None,
            None,
        )
        .expect("resolved");
        assert_eq!(
            resolved.durable_address(),
            crate::remote_access::DurableAddressState::NotApplicable
        );
        assert!(resolved.origin_is_knowable_from_config());
        assert_eq!(
            resolved.privacy(),
            RemoteAccessPrivacy::ProviderCannotReadPayload
        );
    }
}
