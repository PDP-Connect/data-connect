// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native remote-access provider seam.
//!
//! Provider adapters own reachability and provider credentials. The unified
//! supervisor owns the loopback sidecars and passes the four reachability
//! fields to the Personal Server.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};

pub(crate) const USER_SUPPLIED_ORIGIN_PROVIDER_ID: &str = "user_supplied_origin";
const REMOTE_ACCESS_CONFIG_FILE: &str = "remote-access.json";
const LOOPBACK_BIND_HOST: &str = "127.0.0.1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteAccessPosture {
    Off,
    MyDevicesOnly,
    PublicUrl,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct ReachabilityFields {
    #[serde(rename = "PDPP_REFERENCE_ORIGIN")]
    pub(crate) reference_origin: Option<String>,
    #[serde(rename = "PDPP_TRUSTED_HOSTS")]
    pub(crate) trusted_hosts: String,
    #[serde(rename = "PDPP_TRUSTED_PROXIES")]
    pub(crate) trusted_proxies: String,
    #[serde(rename = "PDPP_BIND_HOST")]
    pub(crate) bind_host: String,
}

impl ReachabilityFields {
    pub(crate) fn loopback() -> Self {
        Self {
            bind_host: LOOPBACK_BIND_HOST.to_string(),
            ..Self::default()
        }
    }

    pub(crate) fn environment(&self) -> BTreeMap<OsString, OsString> {
        BTreeMap::from([
            (
                OsString::from("PDPP_REFERENCE_ORIGIN"),
                OsString::from(self.reference_origin.as_deref().unwrap_or_default()),
            ),
            (
                OsString::from("PDPP_TRUSTED_HOSTS"),
                OsString::from(&self.trusted_hosts),
            ),
            (
                OsString::from("PDPP_TRUSTED_PROXIES"),
                OsString::from(&self.trusted_proxies),
            ),
            (
                OsString::from("PDPP_BIND_HOST"),
                OsString::from(&self.bind_host),
            ),
        ])
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct RemoteAccessConfig {
    pub(crate) posture: RemoteAccessPosture,
    pub(crate) provider: Option<String>,
    pub(crate) fields: ReachabilityFields,
    /// The port an owner-run reverse proxy must target, pinned so it survives
    /// restarts instead of chasing the supervisor's per-launch ephemeral
    /// allocation. Only meaningful for `user_supplied_origin` (the only
    /// provider a self-hoster's own proxy points at); other providers ignore
    /// it. `None` keeps today's dynamic-port behavior. This is a supervisor
    /// launch parameter, not a PLATFORM-OWNED env var like PORT/AS_PORT/
    /// RS_PORT (see `reference-implementation/README.md`, "Config
    /// precedence") -- it never goes through the config-store precedence
    /// resolver; the desktop supervisor reads it from this same
    /// remote-access.json and passes it as the console's `PORT` env at
    /// spawn time, exactly how every other reachability field here already
    /// flows into the child environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) console_port: Option<u16>,
    /// Provider-specific options. Absent for every provider but ngrok and
    /// the Cloudflare named tunnel, which keeps the four-field contract
    /// itself provider-neutral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ngrok: Option<crate::remote_access_providers::NgrokOptions>,
    /// The Cloudflare named-tunnel provider's hostname -- see
    /// `remote_access_cloudflare.rs`'s module doc comment for why this is a
    /// distinct provider from Quick Tunnels (which this app deliberately
    /// does not support: no SSE, testing-only per Cloudflare's own docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cloudflare_tunnel: Option<crate::remote_access_providers::CloudflareTunnelOptions>,
    /// The detected LAN address for the `MyDevicesOnly` posture -- see
    /// `detect_lan_host()`. Never owner-typed (DHCP makes it unstable across
    /// restarts), always re-detected at validation time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) my_devices_only: Option<MyDevicesOnlyOptions>,
    /// The ngrok authtoken, sealed by the reference server's
    /// `createCredentialCipherFromEnv()` under the SAME
    /// `PDPP_CREDENTIAL_ENCRYPTION_KEY` this process generated
    /// (`owner_credential::load_or_create_credential_encryption_key`). Present
    /// only for the brief window between the owner submitting a new ngrok
    /// authtoken over HTTP (`owner-remote-access.ts`) and
    /// `unified::spawn_remote_access_config_watcher` decrypting it
    /// (`sealed_credential::open_sealed_credential`) into the OS keychain and
    /// writing this field back to `None`. See that watcher for the full
    /// handoff sequence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ngrok_authtoken_sealed: Option<String>,
    /// The Cloudflare named-tunnel token, sealed the same way and for the
    /// same reason as `ngrok_authtoken_sealed` above -- see that field's
    /// doc comment for the full handoff sequence, which applies unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cloudflare_tunnel_token_sealed: Option<String>,
    /// Set by `start_managed_stack` when the selected provider's tunnel
    /// failed to start (for example ngrok's `ERR_NGROK_312`, TLS endpoints
    /// on a free plan). The stack keeps running without a public origin in
    /// this case rather than aborting startup; this field is how the console
    /// learns that happened instead of showing an unconditional "waiting"
    /// state forever. Cleared on the next successful tunnel start, and
    /// cleared immediately whenever the owner changes posture or provider
    /// (see `off_remote_access_config` / the console's save path), so a
    /// stale failure from a since-abandoned provider never lingers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tunnel_error: Option<String>,
    /// When the public origin was last PROVED reachable, and by what.
    ///
    /// `tunnel_error: None` above only ever meant "the last start call
    /// returned Ok". It never expired, so a tunnel that died minutes later
    /// kept reporting healthy forever -- the canonical dishonest-status
    /// case: "the tunnel is up" logged while it forwarded zero bytes.
    ///
    /// This field is the opposite shape: an OBSERVATION carrying the time
    /// it was made, so a consumer can tell "verified 20 seconds ago" from
    /// "nobody has checked since startup". Absent means exactly the latter
    /// -- unverified -- and must never be read as healthy. See
    /// `unified::origin_is_verified_reachable` for the point-of-use rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) origin_verified: Option<OriginVerification>,
}

/// A single, timestamped reachability observation for the public origin.
///
/// Deliberately not a bool: every claim carries when it was checked and
/// which origin it was taken against, so a stale reading can decay to
/// "unknown" at the point of use instead of silently reading as healthy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct OriginVerification {
    /// The origin that was probed, so a reading is never attributed to a
    /// hostname it was not taken against (a free-plan ngrok tunnel mints a
    /// new one on every restart).
    pub(crate) origin: String,
    /// Unix seconds when the probe ran.
    pub(crate) checked_at: u64,
    /// Whether the origin answered as a live tunnel at that moment.
    pub(crate) reachable: bool,
}

/// Options the `MyDevicesOnly` posture consumes: no provider, no vendor, no
/// daemon -- just this machine's own LAN address. See `detect_lan_host()`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct MyDevicesOnlyOptions {
    pub(crate) lan_host: String,
}

/// True for an RFC1918 IPv4 address, IPv4 link-local, or an IPv6 ULA/
/// link-local address -- never loopback or `0.0.0.0`. Mirrors the TS
/// `isPrivateLanHost` in `reference-implementation/server/remote-access-config.ts`
/// exactly (same four IPv4 ranges, same IPv6 prefix checks).
pub(crate) fn is_private_lan_host(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            first == 10
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && second == 168)
                || (first == 169 && second == 254)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            let first = segments[0];
            (0xfc00..=0xfdff).contains(&first) || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Detect this machine's own LAN IPv4 address for the `MyDevicesOnly`
/// posture -- never owner-typed, since DHCP makes it unstable across
/// restarts. No LAN-detection crate is added for this: connecting a UDP
/// socket to a public address (never sending anything) and reading
/// `local_addr()` is the portable way to learn the outbound-facing local
/// address without a new dependency or platform-specific interface
/// enumeration. The target address (a Cloudflare resolver) is never
/// contacted -- `connect` on a UDP socket only selects a local route, no
/// packet leaves the machine.
///
/// Returns `None` when no such route exists (no network connection) or the
/// resolved local address is not actually private -- callers must treat
/// both as "posture unavailable" and never fall back to a public or
/// loopback address.
pub(crate) fn detect_lan_host() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    is_private_lan_host(address).then_some(address)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteAccessContractConfig {
    pub(crate) provider_id: String,
    pub(crate) posture: RemoteAccessPosture,
    pub(crate) user_supplied_origin: Option<String>,
    pub(crate) credential_reference: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LoopbackTarget {
    pub(crate) host: String,
    pub(crate) port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CredentialReference {
    NotRequired,
    Stored(String),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteAccessAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteAccessAuthentication {
    NotRequired,
    Authenticated,
    MissingCredential,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct RemoteAccessInspection {
    pub(crate) availability: RemoteAccessAvailability,
    pub(crate) authentication: RemoteAccessAuthentication,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteAccessPrivacy {
    ProviderCannotReadPayload,
    ProviderCanReadPayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteAccessHandle {
    pub(crate) provider_id: String,
    pub(crate) origin: String,
    pub(crate) privacy: RemoteAccessPrivacy,
}

pub(crate) trait CredentialResolver {
    fn resolve(&self, provider_id: &str) -> Result<Option<CredentialReference>, String>;
}

pub(crate) struct KeychainCredentialResolver;

impl CredentialResolver for KeychainCredentialResolver {
    fn resolve(&self, provider_id: &str) -> Result<Option<CredentialReference>, String> {
        crate::owner_credential::load_provider_credential_reference(provider_id)
            .map(|reference| reference.map(CredentialReference::Stored))
    }
}

/// Whether a provider offers a durable public address -- one that survives a
/// tunnel/session restart -- and if so, what state that address is in right
/// now. Not every provider has this concept at all: `user_supplied_origin`
/// has no discovery step because the owner supplies the whole origin
/// directly, so it reports `NotApplicable` rather than being forced through
/// states that don't apply to it. This is the check for whether the shape
/// below is honest rather than ngrok-specific: a provider with nothing to
/// discover must be able to say so in one line, not implement four unused
/// branches.
///
/// Every variant is kept even though only a subset renders real UI today
/// (see `DurableAddressState`'s call sites in `unified.rs`/the console) --
/// `Provisionable` and `NotProvisionable` describe a real ngrok product
/// state (a free account with zero domains) that does not currently occur
/// in practice (every free-plan account is assigned one dev domain at
/// account creation), but keeping them in the enum costs nothing and
/// documents the shape a provider that DOES need on-demand provisioning
/// (or a future ngrok plan change) would use, without inventing new API
/// surface later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DurableAddressState {
    /// This provider has no addressing concept of its own -- the caller
    /// supplies the full origin directly (`user_supplied_origin`).
    NotApplicable,
    /// Exactly one durable address exists and was discovered.
    Available { address: String },
    /// More than one durable address exists; the owner must choose --
    /// never silently pick one.
    AvailableMultiple { addresses: Vec<String> },
    /// None exists yet, but one could be created given the credential held.
    /// Not currently reachable for any shipped provider -- see the enum's
    /// doc comment.
    Provisionable,
    /// None exists and none can be created from here. `reason` and
    /// `action_url` must together give the owner a concrete next step.
    /// Not currently reachable for any shipped provider -- see the enum's
    /// doc comment.
    NotProvisionable {
        reason: String,
        action_url: Option<String>,
    },
    /// A previously discovered/stored address no longer exists on the
    /// provider's side (deleted, plan downgraded, expired).
    Revoked { previous_address: String },
    /// The held credential can start tunnels/sessions but lacks the scope
    /// to query or manage addresses. ngrok's tunnel authtoken is exactly
    /// this case: it starts tunnels but has no discovery RPC for the
    /// account's assigned dev domain (a separate ngrok API key would, but
    /// asking the owner for a second credential to look up a value they can
    /// read off their own dashboard in five seconds is worse UX than asking
    /// for the value itself -- see `NgrokProvider::durable_address`).
    AuthInsufficient { reason: String },
    /// The discovery call itself failed (network, rate limit, provider API
    /// down) -- distinct from "no address exists."
    DiscoveryUnreachable { reason: String },
}

impl DurableAddressState {
    /// The single rule `validate_remote_access_config` uses to decide
    /// whether `PDPP_REFERENCE_ORIGIN` is required in the stored config
    /// (this state) or must stay empty until a live session reports it
    /// (the opposite): true for every state where a concrete origin is
    /// already resolvable from config alone -- `NotApplicable`
    /// (`user_supplied_origin`: the owner supplies the whole origin, so it
    /// is always "known up front" even though there is no discovery
    /// concept at all) and `Available`/`AvailableMultiple` (a durable
    /// address already exists, whether or not the owner has picked one of
    /// several yet -- once picked, it belongs in config the same way
    /// `Available` does). False for every state describing origin
    /// discovery that has not (yet, or ever, from here) resolved to a
    /// value: `Provisionable`, `NotProvisionable`, `Revoked`,
    /// `AuthInsufficient`, `DiscoveryUnreachable` -- these all mean the
    /// provider itself must report the origin once a session starts,
    /// exactly ngrok's shape with no dev domain configured.
    ///
    /// This replaces a prior design where origin-timing was a SEPARATE,
    /// ngrok-specific concept (`PublicUrlProvider::discovers_own_origin`,
    /// hardcoded per provider kind) living alongside `durable_address()`
    /// without being derived from it -- confirmed live, 2026-09-19: the
    /// TypeScript mirror of that separate concept
    /// (`validateNgrokConfig` in remote-access-config.ts) went stale the
    /// moment a dev domain made ngrok's origin knowable up front, because
    /// nothing forced the two concepts to agree. A future provider (a
    /// Cloudflare named tunnel, Tailscale Funnel) only has to implement
    /// `durable_address()` honestly; origin timing then falls out of this
    /// one method for free, in both the Rust and TypeScript validators (see
    /// `originIsKnowableFromConfig` in
    /// reference-implementation/server/remote-access-config.ts, the
    /// TypeScript mirror of this exact match).
    pub(crate) fn origin_is_knowable_from_config(&self) -> bool {
        matches!(
            self,
            Self::NotApplicable | Self::Available { .. } | Self::AvailableMultiple { .. }
        )
    }
}

pub(crate) trait RemoteAccessProvider {
    fn inspect(&self) -> RemoteAccessInspection;

    fn start(
        &mut self,
        target: LoopbackTarget,
        credential_reference: CredentialReference,
        cancellation: CancellationToken,
    ) -> Result<RemoteAccessHandle, String>;

    fn stop(&mut self) -> Result<(), String>;

    /// Describe this provider's durable-address capability given the
    /// credential it already holds. Read-only -- never provisions anything.
    /// `NotApplicable` is the correct, non-error answer for a provider with
    /// no addressing concept (see `user_supplied_origin`).
    fn durable_address(&self) -> DurableAddressState;

    /// Explicitly provision a new durable address. Only meaningful when
    /// `durable_address()` returns `Provisionable`, which no shipped
    /// provider currently returns (see that variant's doc comment) --
    /// deliberately left unimplemented rather than guessed at.
    fn provision_durable_address(&mut self) -> Result<String, String> {
        Err("this provider cannot provision a durable address".to_string())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderState {
    Stopped,
    Running(RemoteAccessHandle),
}

pub(crate) struct UserSuppliedOriginProvider<R> {
    config: RemoteAccessContractConfig,
    credential_resolver: R,
    state: ProviderState,
}

impl<R: CredentialResolver> UserSuppliedOriginProvider<R> {
    pub(crate) fn new(
        config: RemoteAccessContractConfig,
        credential_resolver: R,
    ) -> Result<Self, String> {
        validate_provider_id(&config.provider_id)?;
        if let Some(origin) = config.user_supplied_origin.as_deref() {
            validate_origin(origin)?;
        }
        if let Some(reference) = config.credential_reference.as_deref() {
            validate_credential_reference(reference)?;
        }

        Ok(Self {
            config,
            credential_resolver,
            state: ProviderState::Stopped,
        })
    }
}

impl<R: CredentialResolver> RemoteAccessProvider for UserSuppliedOriginProvider<R> {
    fn inspect(&self) -> RemoteAccessInspection {
        let (availability, reason) = match self.config.posture {
            RemoteAccessPosture::Off => (
                RemoteAccessAvailability::Unavailable,
                Some("remote access is off".to_string()),
            ),
            RemoteAccessPosture::MyDevicesOnly => (
                RemoteAccessAvailability::Unavailable,
                Some("my_devices_only has no user_supplied_origin provider to inspect".to_string()),
            ),
            RemoteAccessPosture::PublicUrl => match self.config.user_supplied_origin {
                Some(_) => (RemoteAccessAvailability::Available, None),
                None => (
                    RemoteAccessAvailability::Unavailable,
                    Some("user-supplied origin is missing".to_string()),
                ),
            },
        };

        // The owner-supplied proxy does not receive the Personal Server's TLS
        // key, so it has no provider credential or account requirement.
        let authentication = match self.config.credential_reference.as_deref() {
            Some(expected) => match self.credential_resolver.resolve(&self.config.provider_id) {
                Ok(Some(CredentialReference::Stored(actual))) if actual == expected => {
                    RemoteAccessAuthentication::Authenticated
                }
                Ok(Some(_)) | Ok(None) | Err(_) => RemoteAccessAuthentication::MissingCredential,
            },
            None => RemoteAccessAuthentication::NotRequired,
        };

        RemoteAccessInspection {
            availability,
            authentication,
            reason,
        }
    }

    fn start(
        &mut self,
        target: LoopbackTarget,
        credential_reference: CredentialReference,
        cancellation: CancellationToken,
    ) -> Result<RemoteAccessHandle, String> {
        if cancellation.is_cancelled() {
            return Err("Remote access start was cancelled".to_string());
        }
        validate_loopback_target(&target)?;

        match (&self.config.credential_reference, credential_reference) {
            (Some(expected), CredentialReference::Stored(actual)) if expected == &actual => {}
            (Some(_), _) => return Err("Provider credential reference did not match".to_string()),
            (None, CredentialReference::NotRequired) => {}
            (None, CredentialReference::Stored(_)) => {
                return Err("Provider does not accept a credential reference".to_string())
            }
        }

        let inspection = self.inspect();
        if inspection.availability != RemoteAccessAvailability::Available {
            return Err(inspection
                .reason
                .unwrap_or_else(|| "remote access provider is unavailable".to_string()));
        }
        if inspection.authentication == RemoteAccessAuthentication::MissingCredential {
            return Err("Provider credential reference is missing".to_string());
        }
        if cancellation.is_cancelled() {
            return Err("Remote access start was cancelled".to_string());
        }

        let origin = self
            .config
            .user_supplied_origin
            .clone()
            .ok_or_else(|| "user-supplied origin is missing".to_string())?;
        let handle = RemoteAccessHandle {
            provider_id: self.config.provider_id.clone(),
            origin,
            privacy: RemoteAccessPrivacy::ProviderCannotReadPayload,
        };
        self.state = ProviderState::Running(handle.clone());
        Ok(handle)
    }

    fn stop(&mut self) -> Result<(), String> {
        self.state = ProviderState::Stopped;
        Ok(())
    }

    fn durable_address(&self) -> DurableAddressState {
        // The owner supplies the whole origin directly, every time -- there
        // is nothing for this provider to discover, provision, or lose. See
        // `DurableAddressState`'s doc comment: this is the honesty check
        // for the abstraction, and the correct answer is one line, no
        // forced branches.
        DurableAddressState::NotApplicable
    }
}

pub(crate) fn off_remote_access_config() -> RemoteAccessConfig {
    RemoteAccessConfig {
        posture: RemoteAccessPosture::Off,
        provider: None,
        fields: ReachabilityFields::loopback(),
        console_port: None,
        ngrok: None,
        cloudflare_tunnel: None,
        my_devices_only: None,
        ngrok_authtoken_sealed: None,
        cloudflare_tunnel_token_sealed: None,
        tunnel_error: None,
    }
}

/// Validate the `MyDevicesOnly` posture: re-detect the LAN host rather than
/// trusting whatever `config.my_devices_only` carried in (mirrors the TS
/// route handler's `detectLanHost()` override in `owner-remote-access.ts`),
/// so a stale or tampered value on disk can never persist. The owner
/// password stays mandatory -- `resolveOwnerExposurePosture`
/// (`reference-implementation/server/owner-exposure-posture.ts`) already
/// fails closed for any non-loopback bind host, and this posture's bind
/// host is never loopback once accepted.
fn validate_my_devices_only_config(
    config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    let lan_host = detect_lan_host()
        .ok_or_else(|| "My devices only requires a detected LAN network interface".to_string())?;
    Ok(my_devices_only_config_for_host(config.console_port, lan_host))
}

/// The pure half of `validate_my_devices_only_config`: given an already-
/// resolved (and already-verified-private) LAN address, build the
/// `RemoteAccessConfig` to persist. Split out so tests can exercise this
/// without a real network interface for `detect_lan_host()` to find.
fn my_devices_only_config_for_host(
    console_port: Option<u16>,
    lan_host: IpAddr,
) -> RemoteAccessConfig {
    let host = lan_host.to_string();
    let origin = match console_port {
        Some(port) => format!("http://{host}:{port}"),
        None => format!("http://{host}"),
    };
    RemoteAccessConfig {
        posture: RemoteAccessPosture::MyDevicesOnly,
        provider: None,
        fields: ReachabilityFields {
            reference_origin: Some(origin),
            trusted_hosts: host.clone(),
            trusted_proxies: String::new(),
            bind_host: host.clone(),
        },
        console_port,
        ngrok: None,
        cloudflare_tunnel: None,
        my_devices_only: Some(MyDevicesOnlyOptions { lan_host: host }),
        ngrok_authtoken_sealed: None,
        cloudflare_tunnel_token_sealed: None,
        tunnel_error: None,
        // Remote access is off: no origin, so no reachability claim. Cleared
        // alongside `tunnel_error` so a stale "reachable" reading from a
        // since-abandoned provider never lingers in the UI.
        origin_verified: None,
    }
}

pub(crate) fn validate_remote_access_config(
    config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    if config.console_port == Some(0) {
        return Err("Pinned console port cannot be zero".to_string());
    }
    match config.posture {
        RemoteAccessPosture::Off => {
            if config.fields.bind_host != LOOPBACK_BIND_HOST {
                return Err("Remote access must keep PDPP_BIND_HOST at 127.0.0.1".to_string());
            }
            Ok(off_remote_access_config())
        }
        RemoteAccessPosture::MyDevicesOnly => validate_my_devices_only_config(config),
        RemoteAccessPosture::PublicUrl => {
            if config.fields.bind_host != LOOPBACK_BIND_HOST {
                return Err("Remote access must keep PDPP_BIND_HOST at 127.0.0.1".to_string());
            }
            let provider = crate::remote_access_providers::resolve_public_url_provider(
                &config.posture,
                config.provider.as_deref(),
                config.ngrok.as_ref(),
                config.cloudflare_tunnel.as_ref(),
            )?;

            // Origin timing is derived from the provider's OWN
            // durable_address() (`origin_is_knowable_from_config`), not a
            // separate hardcoded-per-provider concept: ngrok with no
            // configured domain reports origin-unknown here, same as before,
            // but ngrok WITH a configured dev/reserved domain -- or
            // user_supplied_origin, which always supplies the whole origin
            // directly -- correctly falls through to normal origin
            // validation below instead of being forced empty.
            if !provider.origin_is_knowable_from_config()
                && config.fields.reference_origin.is_none()
            {
                if !config.fields.trusted_hosts.trim().is_empty() {
                    return Err(
                        "PDPP_TRUSTED_HOSTS must be empty until the provider reports an origin"
                            .to_string(),
                    );
                }
                return Ok(config);
            }

            let origin = config
                .fields
                .reference_origin
                .as_deref()
                .ok_or_else(|| "Public URL requires PDPP_REFERENCE_ORIGIN".to_string())?;
            validate_origin(origin)?;
            let trusted_hosts = config.fields.trusted_hosts.trim();
            let parsed_origin = reqwest::Url::parse(origin)
                .map_err(|error| format!("Invalid PDPP_REFERENCE_ORIGIN: {error}"))?;
            let host = parsed_origin
                .host_str()
                .ok_or_else(|| "PDPP_REFERENCE_ORIGIN has no host".to_string())?;
            if trusted_hosts != host {
                return Err("PDPP_TRUSTED_HOSTS must contain the origin host".to_string());
            }
            Ok(config)
        }
    }
}

/// Resolve the persisted config path under the SAME directory the reference
/// server is given as `PDPP_DATA_DIR` (see `unified.rs::ri_environment`), so
/// the desktop supervisor and the reference server's owner-authenticated
/// remote-access routes (`server/routes/owner-remote-access.ts`) read and
/// write one persisted config, never two.
fn remote_access_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join(crate::unified::UNIFIED_DB_DIRECTORY)
                .join(REMOTE_ACCESS_CONFIG_FILE)
        })
        .map_err(|error| format!("Failed to resolve DataConnect app-data directory: {error}"))
}

pub(crate) fn load_remote_access_config(app: &AppHandle) -> Result<RemoteAccessConfig, String> {
    let path = remote_access_config_path(app)?;
    if !path.exists() {
        return Ok(off_remote_access_config());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read remote-access configuration: {error}"))?;
    let config = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse remote-access configuration: {error}"))?;
    validate_remote_access_config(config)
}

pub(crate) fn save_remote_access_config(
    app: &AppHandle,
    config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    let config = validate_remote_access_config(config)?;
    let path = remote_access_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create remote-access configuration directory: {error}")
        })?;
    }
    crate::atomic_write::write_json_atomically(
        &path,
        &config,
        "Failed to write remote-access configuration",
    )?;
    Ok(config)
}

fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider id cannot be empty".to_string());
    }
    if !provider_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "Provider id must contain only ASCII letters, digits, dots, dashes, or underscores"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_origin(origin: &str) -> Result<(), String> {
    let origin = origin.trim();
    let url = reqwest::Url::parse(origin).map_err(|error| format!("Invalid origin: {error}"))?;
    if url.scheme() != "https" {
        return Err("Remote access origin must use HTTPS".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Origin must include a host and no embedded credentials".to_string());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Origin must not include a path, query, or fragment".to_string());
    }
    if is_loopback_host(url.host_str().unwrap_or_default()) {
        return Err("Remote access origin must not be loopback".to_string());
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    normalized == "localhost"
        || normalized.ends_with(".local")
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_loopback_target(target: &LoopbackTarget) -> Result<(), String> {
    if target.port == 0 {
        return Err("Loopback target port cannot be zero".to_string());
    }
    if !matches!(
        target.host.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    ) {
        return Err("Loopback target must be localhost".to_string());
    }
    Ok(())
}

fn validate_credential_reference(reference: &str) -> Result<(), String> {
    if reference.trim().is_empty() {
        return Err("Credential reference cannot be empty".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug)]
    struct StaticResolver {
        reference: Option<CredentialReference>,
    }

    impl CredentialResolver for StaticResolver {
        fn resolve(&self, _provider_id: &str) -> Result<Option<CredentialReference>, String> {
            Ok(self.reference.clone())
        }
    }

    fn config(posture: RemoteAccessPosture) -> RemoteAccessContractConfig {
        RemoteAccessContractConfig {
            provider_id: USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string(),
            posture,
            user_supplied_origin: Some("https://example.vana.test".to_string()),
            credential_reference: None,
        }
    }

    fn target() -> LoopbackTarget {
        LoopbackTarget {
            host: "127.0.0.1".to_string(),
            port: 4310,
        }
    }

    #[test]
    fn is_private_lan_host_accepts_rfc1918_and_link_local_only() {
        for address in ["10.0.0.5", "172.16.4.1", "172.31.255.255", "192.168.1.20", "169.254.1.1"] {
            assert!(
                is_private_lan_host(address.parse().unwrap()),
                "{address} should be a private LAN host"
            );
        }
    }

    #[test]
    fn is_private_lan_host_rejects_loopback_and_public_addresses() {
        for address in ["127.0.0.1", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "0.0.0.0"] {
            assert!(
                !is_private_lan_host(address.parse().unwrap()),
                "{address} must not be treated as a private LAN host"
            );
        }
    }

    #[test]
    fn is_private_lan_host_accepts_ipv6_ula_and_link_local_only() {
        assert!(is_private_lan_host("fd00::1".parse().unwrap()));
        assert!(is_private_lan_host("fe80::1".parse().unwrap()));
        assert!(!is_private_lan_host("::1".parse().unwrap()));
        assert!(!is_private_lan_host("2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn my_devices_only_config_derives_origin_and_bind_host_from_the_detected_address() {
        let lan_host: IpAddr = "192.168.1.42".parse().unwrap();
        let built = my_devices_only_config_for_host(Some(4310), lan_host);
        assert_eq!(built.posture, RemoteAccessPosture::MyDevicesOnly);
        assert_eq!(built.provider, None);
        assert_eq!(
            built.fields.reference_origin,
            Some("http://192.168.1.42:4310".to_string())
        );
        assert_eq!(built.fields.trusted_hosts, "192.168.1.42");
        assert_eq!(built.fields.bind_host, "192.168.1.42");
        assert_eq!(
            built.my_devices_only,
            Some(MyDevicesOnlyOptions {
                lan_host: "192.168.1.42".to_string()
            })
        );
    }

    #[test]
    fn my_devices_only_config_without_a_pinned_port_omits_it_from_the_origin() {
        let lan_host: IpAddr = "10.0.0.7".parse().unwrap();
        let built = my_devices_only_config_for_host(None, lan_host);
        assert_eq!(
            built.fields.reference_origin,
            Some("http://10.0.0.7".to_string())
        );
    }

    #[test]
    fn off_and_public_url_still_require_exact_loopback_bind_host() {
        let mut off = off_remote_access_config();
        off.fields.bind_host = "192.168.1.5".to_string();
        assert!(validate_remote_access_config(off).is_err());

        let mut public_url = ngrok_config(None, "", None);
        public_url.fields.bind_host = "192.168.1.5".to_string();
        assert!(validate_remote_access_config(public_url).is_err());
    }

    #[test]
    fn validates_https_user_supplied_origin() {
        let mut invalid = config(RemoteAccessPosture::PublicUrl);
        invalid.user_supplied_origin = Some("http://example.vana.test".to_string());
        assert!(
            UserSuppliedOriginProvider::new(invalid, StaticResolver { reference: None },).is_err()
        );
    }

    #[test]
    fn inspect_reports_available_without_provider_authentication() {
        let provider = UserSuppliedOriginProvider::new(
            config(RemoteAccessPosture::PublicUrl),
            StaticResolver { reference: None },
        )
        .expect("provider");

        assert_eq!(
            provider.inspect(),
            RemoteAccessInspection {
                availability: RemoteAccessAvailability::Available,
                authentication: RemoteAccessAuthentication::NotRequired,
                reason: None,
            }
        );
    }

    #[test]
    fn durable_address_is_not_applicable_because_the_owner_supplies_the_whole_origin() {
        // The honesty check for DurableAddressState: a provider with no
        // addressing concept of its own must report exactly one variant,
        // not be forced through discover/provision/revoke branches that
        // don't apply to it.
        let provider = UserSuppliedOriginProvider::new(
            config(RemoteAccessPosture::PublicUrl),
            StaticResolver { reference: None },
        )
        .expect("provider");

        assert_eq!(provider.durable_address(), DurableAddressState::NotApplicable);
    }

    fn ngrok_config(
        origin: Option<&str>,
        trusted_hosts: &str,
        reserved_domain: Option<&str>,
    ) -> RemoteAccessConfig {
        RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(crate::remote_access_ngrok::NGROK_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: origin.map(str::to_string),
                trusted_hosts: trusted_hosts.to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: None,
            ngrok: Some(crate::remote_access_providers::NgrokOptions {
                endpoint_mode:
                    crate::remote_access_providers::NgrokEndpointModeConfig::HttpsEdgeTermination,
                reserved_domain: reserved_domain.map(str::to_string),
            }),
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        }
    }

    /// The three addressing cases the origin-timing rule
    /// (`DurableAddressState::origin_is_knowable_from_config`) must express
    /// correctly, verified directly against the public validator rather than
    /// the derived boolean alone -- this is what actually broke live,
    /// 2026-09-19, and what must never regress again.
    #[test]
    fn origin_addressing_case_user_supplied_origin_always_requires_its_origin() {
        // NotApplicable, but the origin is always present and required --
        // this is the provider whose behavior a naive
        // "durable_address means origin known" rule would get backwards.
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: Some("https://vault.example.com".to_string()),
                trusted_hosts: "vault.example.com".to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        let validated = validate_remote_access_config(config.clone()).expect("valid");
        assert_eq!(validated.fields.reference_origin, config.fields.reference_origin);

        // No origin at all is REJECTED, not silently accepted as "waiting
        // for discovery" -- user_supplied_origin has no discovery step.
        let missing_origin = RemoteAccessConfig {
            fields: ReachabilityFields {
                reference_origin: None,
                trusted_hosts: String::new(),
                ..config.fields.clone()
            },
            ..config
        };
        assert!(validate_remote_access_config(missing_origin).is_err());
    }

    #[test]
    fn origin_addressing_case_ngrok_with_a_configured_domain_requires_its_origin_up_front() {
        // Available: the durable address is already known, so the origin
        // may (and, once discovered, will) be populated in config up
        // front -- this is the exact case that regressed live: a prior
        // validator unconditionally rejected any non-empty origin for
        // ngrok, which broke the moment a dev domain made the origin
        // knowable before the tunnel ever started.
        let with_origin = ngrok_config(
            Some("https://moderately-worthy-tetra.ngrok-free.app"),
            "moderately-worthy-tetra.ngrok-free.app",
            Some("moderately-worthy-tetra.ngrok-free.app"),
        );
        let validated = validate_remote_access_config(with_origin).expect("valid");
        assert_eq!(
            validated.fields.reference_origin.as_deref(),
            Some("https://moderately-worthy-tetra.ngrok-free.app")
        );

        // Trusted hosts that do not match the origin's own host are still
        // rejected -- a configured domain does not bypass the normal
        // origin/host consistency check.
        let mismatched = ngrok_config(
            Some("https://moderately-worthy-tetra.ngrok-free.app"),
            "some-other-host.example.com",
            Some("moderately-worthy-tetra.ngrok-free.app"),
        );
        assert!(validate_remote_access_config(mismatched).is_err());
    }

    #[test]
    fn origin_addressing_case_ngrok_without_a_configured_domain_requires_an_empty_origin_until_the_session_reports(
    ) {
        // AuthInsufficient: no durable address is known, so the origin must
        // stay empty until the live tunnel reports one -- unchanged
        // behavior from before this fix, verified so the fix does not
        // silently break the random-hostname path while fixing the
        // dev-domain path.
        let empty = ngrok_config(None, "", None);
        let validated = validate_remote_access_config(empty).expect("valid");
        assert_eq!(validated.fields.reference_origin, None);

        let premature_trusted_hosts = ngrok_config(None, "some-host.ngrok-free.app", None);
        assert!(validate_remote_access_config(premature_trusted_hosts).is_err());
    }

    #[test]
    fn start_returns_origin_and_payload_private_handle() {
        let mut provider = UserSuppliedOriginProvider::new(
            config(RemoteAccessPosture::PublicUrl),
            StaticResolver { reference: None },
        )
        .expect("provider");

        let handle = provider
            .start(
                target(),
                CredentialReference::NotRequired,
                CancellationToken::new(),
            )
            .expect("started");

        assert_eq!(handle.origin, "https://example.vana.test");
        assert_eq!(
            handle.privacy,
            RemoteAccessPrivacy::ProviderCannotReadPayload
        );
        assert_eq!(provider.state, ProviderState::Running(handle));
    }

    #[test]
    fn start_observes_cancellation_before_state_transition() {
        let mut provider = UserSuppliedOriginProvider::new(
            config(RemoteAccessPosture::PublicUrl),
            StaticResolver { reference: None },
        )
        .expect("provider");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(provider
            .start(target(), CredentialReference::NotRequired, cancellation)
            .is_err());
        assert_eq!(provider.state, ProviderState::Stopped);
    }

    #[test]
    fn inspect_requires_the_configured_credential_reference() {
        let mut configured = config(RemoteAccessPosture::PublicUrl);
        configured.credential_reference = Some("slot".to_string());
        let provider = UserSuppliedOriginProvider::new(
            configured.clone(),
            StaticResolver {
                reference: Some(CredentialReference::Stored("other-slot".to_string())),
            },
        )
        .expect("provider");
        assert_eq!(
            provider.inspect().authentication,
            RemoteAccessAuthentication::MissingCredential
        );

        let provider = UserSuppliedOriginProvider::new(
            configured,
            StaticResolver {
                reference: Some(CredentialReference::Stored("slot".to_string())),
            },
        )
        .expect("provider");
        assert_eq!(
            provider.inspect().authentication,
            RemoteAccessAuthentication::Authenticated
        );
    }

    #[test]
    fn stop_transitions_running_provider_to_stopped() {
        let mut provider = UserSuppliedOriginProvider::new(
            config(RemoteAccessPosture::PublicUrl),
            StaticResolver { reference: None },
        )
        .expect("provider");
        provider
            .start(
                target(),
                CredentialReference::NotRequired,
                CancellationToken::new(),
            )
            .expect("started");
        provider.stop().expect("stopped");
        assert_eq!(provider.state, ProviderState::Stopped);
    }

    #[test]
    fn remote_access_config_always_exports_four_loopback_fields() {
        let fields = ReachabilityFields::loopback();
        let environment = fields.environment();
        assert_eq!(environment.len(), 4);
        assert_eq!(
            environment.get(&OsString::from("PDPP_BIND_HOST")).unwrap(),
            "127.0.0.1"
        );
        assert_eq!(
            environment
                .get(&OsString::from("PDPP_REFERENCE_ORIGIN"))
                .unwrap(),
            ""
        );
    }

    #[test]
    fn serializes_the_contract_fields_with_their_process_environment_names() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: Some("https://vault.example".to_string()),
                trusted_hosts: "vault.example".to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        let serialized = serde_json::to_value(config).expect("serialized remote access config");
        assert_eq!(serialized["posture"], "public_url");
        assert_eq!(
            serialized["fields"]["PDPP_REFERENCE_ORIGIN"],
            "https://vault.example"
        );
        assert_eq!(serialized["fields"]["PDPP_TRUSTED_HOSTS"], "vault.example");
        assert_eq!(serialized["fields"]["PDPP_TRUSTED_PROXIES"], "");
        assert_eq!(serialized["fields"]["PDPP_BIND_HOST"], "127.0.0.1");
    }

    #[test]
    fn public_config_requires_matching_trusted_host() {
        let mut config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: Some("https://vault.example".to_string()),
                trusted_hosts: "other.example".to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        assert!(validate_remote_access_config(config.clone()).is_err());
        config.fields.trusted_hosts = "vault.example".to_string();
        assert!(validate_remote_access_config(config).is_ok());
    }

    #[test]
    fn ngrok_public_config_is_accepted_before_the_edge_assigns_an_origin() {
        use crate::remote_access_providers::{NgrokEndpointModeConfig, NgrokOptions};

        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some("ngrok".to_string()),
            fields: ReachabilityFields::loopback(),
            console_port: None,
            ngrok: Some(NgrokOptions {
                endpoint_mode: NgrokEndpointModeConfig::TlsPassthrough,
                reserved_domain: None,
            }),
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        let validated = validate_remote_access_config(config).expect("ngrok config is valid");
        // The origin stays empty until the adapter reports the assigned URL.
        assert_eq!(validated.fields.reference_origin, None);
        assert_eq!(validated.fields.bind_host, LOOPBACK_BIND_HOST);
    }

    #[test]
    fn ngrok_public_config_requires_endpoint_options() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some("ngrok".to_string()),
            fields: ReachabilityFields::loopback(),
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        assert!(validate_remote_access_config(config).is_err());
    }

    #[test]
    fn an_unknown_public_provider_is_still_refused() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some("mystery_relay".to_string()),
            fields: ReachabilityFields::loopback(),
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        assert!(validate_remote_access_config(config).is_err());
    }

    #[test]
    fn tunnel_error_survives_validation_while_the_origin_is_still_pending() {
        use crate::remote_access_providers::{NgrokEndpointModeConfig, NgrokOptions};

        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some("ngrok".to_string()),
            fields: ReachabilityFields::loopback(),
            console_port: None,
            ngrok: Some(NgrokOptions {
                endpoint_mode: NgrokEndpointModeConfig::TlsPassthrough,
                reserved_domain: None,
            }),
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: Some("ngrok TLS endpoint failed: ERR_NGROK_312".to_string()),
            origin_verified: None,
        };
        let validated = validate_remote_access_config(config).expect("ngrok config is valid");
        assert_eq!(
            validated.tunnel_error.as_deref(),
            Some("ngrok TLS endpoint failed: ERR_NGROK_312")
        );
    }

    #[test]
    fn turning_remote_access_off_drops_a_stale_tunnel_error() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::Off,
            provider: Some("ngrok".to_string()),
            fields: ReachabilityFields::loopback(),
            console_port: None,
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: Some("a failure from a since-abandoned provider".to_string()),
            origin_verified: None,
        };
        let validated = validate_remote_access_config(config).expect("off config is valid");
        assert_eq!(validated.tunnel_error, None);
    }

    #[test]
    fn tunnel_error_is_omitted_from_json_when_absent() {
        let config = off_remote_access_config();
        let serialized = serde_json::to_value(config).expect("serialized remote access config");
        assert!(!serialized.as_object().unwrap().contains_key("tunnel_error"));
    }

    #[test]
    fn a_zero_pinned_console_port_is_rejected() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: Some("https://vault.example".to_string()),
                trusted_hosts: "vault.example".to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: Some(0),
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        assert!(validate_remote_access_config(config).is_err());
    }

    #[test]
    fn a_pinned_console_port_survives_validation_and_round_trips() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some(USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string()),
            fields: ReachabilityFields {
                reference_origin: Some("https://vault.example".to_string()),
                trusted_hosts: "vault.example".to_string(),
                trusted_proxies: String::new(),
                bind_host: LOOPBACK_BIND_HOST.to_string(),
            },
            console_port: Some(4310),
            ngrok: None,
            cloudflare_tunnel: None,
            my_devices_only: None,
            ngrok_authtoken_sealed: None,
            cloudflare_tunnel_token_sealed: None,
            tunnel_error: None,
            origin_verified: None,
        };
        let validated =
            validate_remote_access_config(config).expect("pinned port config is valid");
        assert_eq!(validated.console_port, Some(4310));

        let serialized = serde_json::to_value(&validated).expect("serialized");
        assert_eq!(serialized["console_port"], 4310);
        let round_tripped: RemoteAccessConfig =
            serde_json::from_value(serialized).expect("deserialized");
        assert_eq!(round_tripped.console_port, Some(4310));
    }
}
