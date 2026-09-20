// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! ngrok's embedded remote-access provider.
//!
//! The adapter owns exactly one ngrok session and the tunnel created from it.
//! The supervisor owns retries and generation identity. The Personal Server
//! remains on loopback; this module only forwards to that loopback target and
//! reports the origin returned by ngrok.

use crate::remote_access::{
    CancellationToken, CredentialReference, DurableAddressState, LoopbackTarget,
    ReachabilityFields, RemoteAccessAuthentication, RemoteAccessAvailability,
    RemoteAccessContractConfig, RemoteAccessHandle, RemoteAccessInspection, RemoteAccessPosture,
    RemoteAccessPrivacy, RemoteAccessProvider,
};
use ngrok::config::ForwarderBuilder;
use ngrok::forwarder::Forwarder;
use ngrok::prelude::{EndpointInfo, TunnelCloser};
use ngrok::session::RpcError;
use ngrok::tunnel::{HttpTunnel, TcpTunnel, TlsTunnel};
use ngrok::Session;
use std::time::Duration;
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};
use url::Url;

pub(crate) const NGROK_PROVIDER_ID: &str = "ngrok";
const LOOPBACK_BIND_HOST: &str = "127.0.0.1";

const DEFAULT_FORWARD_SCHEME: &str = "http";
const TLS_PASSTHROUGH_FORWARD_SCHEME: &str = "tls";
const TCP_PASSTHROUGH_FORWARD_SCHEME: &str = "tcp";
const CANCELLATION_POLL: Duration = Duration::from_millis(20);

/// The endpoint profile determines both the ngrok edge behavior and the
/// disclosure that is returned to the supervisor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NgrokEndpointMode {
    /// HTTPS is terminated at the ngrok edge before forwarding plain HTTP.
    HttpsEdgeTermination,
    /// TLS is passed through the ngrok edge and terminated by the upstream.
    TlsPassthrough,
    /// Raw TCP is passed through the ngrok edge.
    TcpPassthrough,
}

impl NgrokEndpointMode {
    fn forwards_scheme(self) -> &'static str {
        match self {
            Self::HttpsEdgeTermination => DEFAULT_FORWARD_SCHEME,
            Self::TlsPassthrough => TLS_PASSTHROUGH_FORWARD_SCHEME,
            Self::TcpPassthrough => TCP_PASSTHROUGH_FORWARD_SCHEME,
        }
    }

    fn privacy(self) -> RemoteAccessPrivacy {
        match self {
            Self::HttpsEdgeTermination => RemoteAccessPrivacy::ProviderCanReadPayload,
            Self::TlsPassthrough | Self::TcpPassthrough => {
                RemoteAccessPrivacy::ProviderCannotReadPayload
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NgrokHealth {
    Stopped,
    Connected,
    ProviderDown,
}

enum NgrokTunnel {
    Http(Forwarder<HttpTunnel>),
    Tls(Forwarder<TlsTunnel>),
    Tcp(Forwarder<TcpTunnel>),
}

impl NgrokTunnel {
    fn url(&self) -> &str {
        match self {
            Self::Http(tunnel) => tunnel.url(),
            Self::Tls(tunnel) => tunnel.url(),
            Self::Tcp(tunnel) => tunnel.url(),
        }
    }

    fn is_forwarding_finished(&mut self) -> bool {
        match self {
            Self::Http(tunnel) => tunnel.join().is_finished(),
            Self::Tls(tunnel) => tunnel.join().is_finished(),
            Self::Tcp(tunnel) => tunnel.join().is_finished(),
        }
    }

    async fn close(&mut self) -> Result<(), RpcError> {
        match self {
            Self::Http(tunnel) => tunnel.close().await,
            Self::Tls(tunnel) => tunnel.close().await,
            Self::Tcp(tunnel) => tunnel.close().await,
        }
    }
}

struct OwnedNgrokResources {
    runtime: Runtime,
    session: Option<Session>,
    tunnel: Option<NgrokTunnel>,
}

impl OwnedNgrokResources {
    fn new() -> Result<Self, String> {
        RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .map(|runtime| Self {
                runtime,
                session: None,
                tunnel: None,
            })
            .map_err(|error| format!("could not create ngrok runtime: {error}"))
    }

    fn close(self) -> Result<(), String> {
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::spawn(move || self.close_on_runtime())
                .join()
                .map_err(|_| "ngrok shutdown thread panicked".to_string())?;
        }
        self.close_on_runtime()
    }

    fn close_on_runtime(mut self) -> Result<(), String> {
        let result = self.runtime.block_on(async {
            let tunnel_result = match self.tunnel.as_mut() {
                Some(tunnel) => tunnel.close().await.map_err(|error| error.to_string()),
                None => Ok(()),
            };
            let session_result = match self.session.as_mut() {
                Some(session) => session.close().await.map_err(|error| error.to_string()),
                None => Ok(()),
            };
            tunnel_result.and(session_result)
        });

        // Drop the SDK values while their runtime is still alive. This keeps
        // the SDK's asynchronous drop cleanup scoped to this adapter.
        self.tunnel.take();
        self.session.take();
        result
    }
}

/// The concrete ngrok provider. `R` is the existing keychain-backed resolver
/// from the provider seam; the adapter never reads a credential file or puts
/// the token in a log message.
pub(crate) struct NgrokProvider<R> {
    config: RemoteAccessContractConfig,
    credential_resolver: R,
    endpoint_mode: NgrokEndpointMode,
    reserved_domain: Option<String>,
    resources: Option<OwnedNgrokResources>,
}

impl<R> NgrokProvider<R> {
    pub(crate) fn new(
        config: RemoteAccessContractConfig,
        credential_resolver: R,
        endpoint_mode: NgrokEndpointMode,
    ) -> Result<Self, String> {
        Self::with_reserved_domain(config, credential_resolver, endpoint_mode, None)
    }

    /// Request a reserved domain the owner holds on a paid ngrok plan. `None`
    /// keeps ngrok's randomly assigned hostname, which the owner accepts.
    pub(crate) fn with_reserved_domain(
        config: RemoteAccessContractConfig,
        credential_resolver: R,
        endpoint_mode: NgrokEndpointMode,
        reserved_domain: Option<String>,
    ) -> Result<Self, String> {
        if config.provider_id != NGROK_PROVIDER_ID {
            return Err("ngrok provider received a different provider id".to_string());
        }
        if config.posture != RemoteAccessPosture::PublicUrl {
            return Err("ngrok requires the public_url remote-access posture".to_string());
        }
        if config.user_supplied_origin.is_some() {
            return Err("ngrok cannot use a user-supplied origin".to_string());
        }
        let reserved_domain = match reserved_domain {
            Some(domain) => Some(validate_reserved_domain(&domain, endpoint_mode)?),
            None => None,
        };

        Ok(Self {
            config,
            credential_resolver,
            endpoint_mode,
            reserved_domain,
            resources: None,
        })
    }

    /// Report the SDK-backed health state without treating a missing local
    /// session as a provider failure.
    pub(crate) fn health(&mut self) -> NgrokHealth {
        let Some(resources) = self.resources.as_mut() else {
            return NgrokHealth::Stopped;
        };
        health_from_state(
            resources.tunnel.is_some(),
            resources
                .tunnel
                .as_mut()
                .is_some_and(NgrokTunnel::is_forwarding_finished),
        )
    }

    /// Return and validate the origin assigned to the owned ngrok tunnel.
    pub(crate) fn discover_origin(&self) -> Result<Option<String>, String> {
        let Some(resources) = self.resources.as_ref() else {
            return Ok(None);
        };
        let origin = resources
            .tunnel
            .as_ref()
            .map(NgrokTunnel::url)
            .ok_or_else(|| "ngrok tunnel has no assigned origin".to_string())?;
        verify_discovered_origin(origin).map(Some)
    }

    /// Map the provider result to the four Personal Server reachability fields.
    /// ngrok connects to the Personal Server over loopback, so no forwarded
    /// proxy header is trusted by this adapter.
    pub(crate) fn reachability_fields(origin: &str) -> Result<ReachabilityFields, String> {
        let origin = verify_discovered_origin(origin)?;
        let host = Url::parse(&origin)
            .map_err(|error| format!("ngrok returned an invalid origin: {error}"))?
            .host_str()
            .ok_or_else(|| "ngrok origin has no host".to_string())?
            .to_string();
        Ok(ReachabilityFields {
            reference_origin: Some(origin),
            trusted_hosts: host,
            trusted_proxies: String::new(),
            bind_host: LOOPBACK_BIND_HOST.to_string(),
        })
    }

    fn stored_authtoken(&self, credential_reference: &CredentialReference) -> Result<String, String>
    where
        R: crate::remote_access::CredentialResolver,
    {
        let CredentialReference::Stored(provided) = credential_reference else {
            return Err("ngrok requires a stored authtoken".to_string());
        };
        if provided.trim().is_empty() {
            return Err("ngrok authtoken is empty".to_string());
        }

        let stored = self
            .credential_resolver
            .resolve(NGROK_PROVIDER_ID)
            .map_err(|_| "ngrok credential store could not be read".to_string())?
            .ok_or_else(|| "ngrok authtoken is missing".to_string())?;
        let CredentialReference::Stored(stored) = stored else {
            return Err("ngrok credential store returned no authtoken".to_string());
        };
        if stored != *provided {
            return Err("ngrok authtoken is stale".to_string());
        }
        Ok(provided.clone())
    }

    fn start_runtime(
        &mut self,
        target: LoopbackTarget,
        token: String,
        cancellation: CancellationToken,
    ) -> Result<String, String>
    where
        R: crate::remote_access::CredentialResolver,
    {
        if self.resources.is_some() {
            self.stop_owned()?;
        }

        let resources = OwnedNgrokResources::new()?;
        let mode = self.endpoint_mode;
        let domain = self.reserved_domain.clone();
        let result = if tokio::runtime::Handle::try_current().is_ok() {
            std::thread::spawn(move || {
                start_on_runtime(resources, target, mode, domain, token, cancellation)
            })
            .join()
            .map_err(|_| "ngrok start thread panicked".to_string())?
        } else {
            start_on_runtime(resources, target, mode, domain, token, cancellation)
        }?;

        let (resources, origin) = result;
        self.resources = Some(resources);
        Ok(origin)
    }

    fn stop_owned(&mut self) -> Result<(), String> {
        let Some(resources) = self.resources.take() else {
            return Ok(());
        };
        resources.close()
    }
}

impl<R> RemoteAccessProvider for NgrokProvider<R>
where
    R: crate::remote_access::CredentialResolver,
{
    fn inspect(&self) -> RemoteAccessInspection {
        let authentication = match self.credential_resolver.resolve(NGROK_PROVIDER_ID) {
            Ok(Some(CredentialReference::Stored(token))) if !token.trim().is_empty() => {
                RemoteAccessAuthentication::Authenticated
            }
            Ok(Some(_)) | Ok(None) | Err(_) => RemoteAccessAuthentication::MissingCredential,
        };
        let reason = match authentication {
            RemoteAccessAuthentication::Authenticated => None,
            _ => Some("ngrok authtoken is missing".to_string()),
        };
        RemoteAccessInspection {
            availability: RemoteAccessAvailability::Available,
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
            return Err("ngrok start was cancelled".to_string());
        }
        validate_loopback_target(&target)?;
        let token = self.stored_authtoken(&credential_reference)?;
        if cancellation.is_cancelled() {
            return Err("ngrok start was cancelled".to_string());
        }

        let origin = self.start_runtime(target, token, cancellation.clone())?;
        if cancellation.is_cancelled() {
            let _ = self.stop_owned();
            return Err("ngrok start was cancelled".to_string());
        }

        Ok(RemoteAccessHandle {
            provider_id: self.config.provider_id.clone(),
            origin,
            privacy: self.endpoint_mode.privacy(),
        })
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_owned()
    }

    fn durable_address(&self) -> DurableAddressState {
        ngrok_durable_address_for_reserved_domain(self.reserved_domain.as_deref())
    }
}

/// ngrok's free plan assigns exactly one persistent "Dev Domain" to every
/// account at account creation -- there is no "zero domains" state on free,
/// and no purchase is required (see the ngrok-free-plan research corpus
/// entries). That domain is real and stable; the gap is entirely that
/// nothing in this codebase could tell the owner it exists or ask them to
/// use it, so every restart minted a fresh random hostname instead of the
/// one their account already has.
///
/// No verified way exists to discover that hostname automatically: the
/// tunnel authtoken this app holds starts sessions but has no confirmed
/// discovery RPC for account-level resources, and ngrok's account-management
/// REST API (which does list domains) requires a SEPARATE API key, not the
/// tunnel authtoken -- confirmed the hard way against the real API, which
/// rejected the authtoken outright. Deliberately not guessed at: asking the
/// owner for a second credential (an API key) to look up a value they can
/// read off their own dashboard in five seconds would be worse UX than
/// asking for the value itself, so this reports `AuthInsufficient` with the
/// concrete next step rather than pretending to discover it. If a reserved
/// domain is already configured (the owner already pasted their dev domain,
/// or a paid custom domain), that IS the durable address and is reported as
/// `Available` -- discovery is the only unverified part, not the reuse of
/// what the owner already told us.
///
/// A free function, not a method on a live `NgrokProvider`, because
/// `PublicUrlProvider::durable_address()` (`remote_access_providers.rs`)
/// needs this exact same answer BEFORE a provider instance exists -- it
/// validates stored config, which has no running session to ask. Both call
/// sites now share one implementation instead of two copies that could
/// drift, which is what happened to the TypeScript mirror of this same
/// question before this fix (`validateNgrokConfig` in
/// remote-access-config.ts treated ngrok as always origin-unknown,
/// independent of whether a domain was configured).
pub(crate) fn ngrok_durable_address_for_reserved_domain(
    reserved_domain: Option<&str>,
) -> DurableAddressState {
    match reserved_domain {
        Some(domain) => DurableAddressState::Available {
            address: domain.to_string(),
        },
        None => DurableAddressState::AuthInsufficient {
            reason: "ngrok's free plan assigns one stable domain to your account, but this app cannot look it up automatically. Copy your domain from dashboard.ngrok.com/domains and paste it in Settings.".to_string(),
        },
    }
}

impl<R> Drop for NgrokProvider<R> {
    fn drop(&mut self) {
        let _ = self.stop_owned();
    }
}

fn start_on_runtime(
    mut resources: OwnedNgrokResources,
    target: LoopbackTarget,
    mode: NgrokEndpointMode,
    reserved_domain: Option<String>,
    token: String,
    cancellation: CancellationToken,
) -> Result<(OwnedNgrokResources, String), String> {
    let target_url = target_url(&target, mode)?;
    let result = resources.runtime.block_on(async move {
        let listen_cancellation = cancellation.clone();
        let session = connect_session(token, cancellation).await?;
        let tunnel = listen_and_forward(
            session.clone(),
            mode,
            reserved_domain,
            target_url,
            listen_cancellation,
        )
        .await;
        match tunnel {
            Ok(tunnel) => Ok((session, tunnel)),
            Err(error) => {
                let mut session = session;
                let _ = session.close().await;
                Err(error)
            }
        }
    });
    let (session, tunnel) = result?;
    resources.session = Some(session);
    resources.tunnel = Some(tunnel);
    let raw_origin = resources
        .tunnel
        .as_ref()
        .expect("ngrok tunnel was just stored")
        .url()
        .to_owned();
    let origin = match verify_discovered_origin(&raw_origin) {
        Ok(origin) => origin,
        Err(error) => {
            let _ = resources.close();
            return Err(error);
        }
    };
    Ok((resources, origin))
}

async fn connect_session(
    token: String,
    cancellation: CancellationToken,
) -> Result<Session, String> {
    let mut builder = Session::builder();
    builder.authtoken(token);
    let connect = builder.connect();
    tokio::pin!(connect);
    tokio::select! {
        result = &mut connect => result.map_err(|error| format!("ngrok session failed: {error}")),
        _ = wait_for_cancellation(cancellation) => Err("ngrok start was cancelled".to_string()),
    }
}

async fn wait_for_cancellation(cancellation: CancellationToken) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(CANCELLATION_POLL).await;
    }
}

async fn listen_and_forward(
    session: Session,
    mode: NgrokEndpointMode,
    reserved_domain: Option<String>,
    target: Url,
    cancellation: CancellationToken,
) -> Result<NgrokTunnel, String> {
    let listen = async move {
        match mode {
            NgrokEndpointMode::HttpsEdgeTermination => {
                let mut endpoint = session.http_endpoint();
                // ngrok 0.19's `domain()` requests a reserved domain. Omitting
                // it leaves the hostname to ngrok.
                if let Some(domain) = reserved_domain.as_deref() {
                    endpoint.domain(domain);
                }
                endpoint
                    .listen_and_forward(target)
                    .await
                    .map(NgrokTunnel::Http)
                    .map_err(|error| format!("ngrok HTTPS endpoint failed: {error}"))
            }
            NgrokEndpointMode::TlsPassthrough => {
                // Deliberately omit `termination()`: ngrok 0.19 emits no
                // TLSTermination option, then marks the connection PassthroughTLS.
                let mut endpoint = session.tls_endpoint();
                if let Some(domain) = reserved_domain.as_deref() {
                    endpoint.domain(domain);
                }
                endpoint
                    .listen_and_forward(target)
                    .await
                    .map(NgrokTunnel::Tls)
                    .map_err(|error| format!("ngrok TLS endpoint failed: {error}"))
            }
            // `TcpTunnelBuilder` has no domain concept in ngrok 0.19; it
            // reserves an address, not a hostname. `with_reserved_domain`
            // refuses the combination before reaching this point.
            NgrokEndpointMode::TcpPassthrough => session
                .tcp_endpoint()
                .listen_and_forward(target)
                .await
                .map(NgrokTunnel::Tcp)
                .map_err(|error| format!("ngrok TCP endpoint failed: {error}")),
        }
    };
    tokio::pin!(listen);
    tokio::select! {
        result = &mut listen => result,
        _ = wait_for_cancellation(cancellation) => Err("ngrok start was cancelled".to_string()),
    }
}

fn target_url(target: &LoopbackTarget, mode: NgrokEndpointMode) -> Result<Url, String> {
    Url::parse(&format!(
        "{}://{}:{}",
        mode.forwards_scheme(),
        target.host,
        target.port
    ))
    .map_err(|error| format!("invalid ngrok loopback target: {error}"))
}

fn validate_loopback_target(target: &LoopbackTarget) -> Result<(), String> {
    if target.port == 0 {
        return Err("ngrok loopback target port cannot be zero".to_string());
    }
    if !matches!(
        target.host.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    ) {
        return Err("ngrok loopback target must be localhost".to_string());
    }
    Ok(())
}

/// A reserved domain is a bare hostname. ngrok 0.19's `domain()` takes a host,
/// so a URL, port, or path here would be sent verbatim and rejected by the edge
/// with a far less obvious error.
fn validate_reserved_domain(domain: &str, mode: NgrokEndpointMode) -> Result<String, String> {
    if matches!(mode, NgrokEndpointMode::TcpPassthrough) {
        return Err("ngrok TCP endpoints reserve an address, not a domain".to_string());
    }
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        return Err("ngrok reserved domain cannot be empty".to_string());
    }
    if domain.contains(['/', ':', '?', '#', '@', ' ']) {
        return Err("ngrok reserved domain must be a bare hostname".to_string());
    }
    if !domain.contains('.') {
        return Err("ngrok reserved domain must be fully qualified".to_string());
    }
    if domain.split('.').any(|label| {
        label.is_empty()
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err("ngrok reserved domain has an invalid label".to_string());
    }
    Ok(domain)
}

fn verify_discovered_origin(origin: &str) -> Result<String, String> {
    let parsed =
        Url::parse(origin).map_err(|error| format!("ngrok returned an invalid origin: {error}"))?;
    if !matches!(parsed.scheme(), "https" | "tls" | "tcp") {
        return Err("ngrok returned an unsupported origin scheme".to_string());
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("ngrok origin must include a host and no credentials".to_string());
    }
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err("ngrok origin must not include a path, query, or fragment".to_string());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn health_from_state(has_tunnel: bool, forwarding_finished: bool) -> NgrokHealth {
    match (has_tunnel, forwarding_finished) {
        (false, _) => NgrokHealth::Stopped,
        (true, true) => NgrokHealth::ProviderDown,
        (true, false) => NgrokHealth::Connected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_access::CredentialResolver;

    #[derive(Clone)]
    struct StaticResolver {
        value: Result<Option<CredentialReference>, String>,
    }

    impl CredentialResolver for StaticResolver {
        fn resolve(&self, _provider_id: &str) -> Result<Option<CredentialReference>, String> {
            self.value.clone()
        }
    }

    fn config() -> RemoteAccessContractConfig {
        RemoteAccessContractConfig {
            provider_id: NGROK_PROVIDER_ID.to_string(),
            posture: RemoteAccessPosture::PublicUrl,
            user_supplied_origin: None,
            credential_reference: None,
        }
    }

    fn target() -> LoopbackTarget {
        LoopbackTarget {
            host: "127.0.0.1".to_string(),
            port: 4310,
        }
    }

    fn provider(value: &str) -> NgrokProvider<StaticResolver> {
        NgrokProvider::new(
            config(),
            StaticResolver {
                value: Ok(Some(CredentialReference::Stored(value.to_string()))),
            },
            NgrokEndpointMode::HttpsEdgeTermination,
        )
        .expect("provider")
    }

    #[test]
    fn durable_address_is_available_when_a_domain_is_already_configured() {
        // A free-plan owner who pasted their dev domain (or a paid-plan
        // owner with a custom domain) already has a durable address --
        // this is a stable hostname across restarts, the exact thing the
        // brief requires a test for.
        let provider = NgrokProvider::with_reserved_domain(
            config(),
            StaticResolver {
                value: Ok(Some(CredentialReference::Stored("token".to_string()))),
            },
            NgrokEndpointMode::HttpsEdgeTermination,
            Some("moderately-worthy-tetra.ngrok-free.app".to_string()),
        )
        .expect("provider");

        assert_eq!(
            provider.durable_address(),
            DurableAddressState::Available {
                address: "moderately-worthy-tetra.ngrok-free.app".to_string(),
            }
        );
    }

    #[test]
    fn durable_address_is_auth_insufficient_without_a_configured_domain() {
        // No verified discovery path exists for the tunnel-authtoken-only
        // session (see this method's doc comment): the honest answer is
        // "can't check," with a concrete next step, never a guess at
        // `Available` and never a silent fallback that reintroduces
        // hostname churn.
        let provider = provider("stored-authtoken");
        match provider.durable_address() {
            DurableAddressState::AuthInsufficient { reason } => {
                assert!(reason.contains("dashboard.ngrok.com/domains"));
            }
            other => panic!("expected AuthInsufficient, got {other:?}"),
        }
    }

    #[test]
    fn login_uses_the_keychain_value_without_exposing_it_in_diagnostics() {
        let provider = provider("stored-authtoken");
        assert_eq!(
            provider.inspect().authentication,
            RemoteAccessAuthentication::Authenticated
        );
        assert!(!format!("{:?}", provider.inspect()).contains("stored-authtoken"));
    }

    #[test]
    fn cancellation_is_rejected_before_any_owned_resource_is_created() {
        let mut provider = provider("stored-authtoken");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = provider.start(
            target(),
            CredentialReference::Stored("stored-authtoken".into()),
            cancellation,
        );
        assert!(result.is_err());
        assert_eq!(provider.health(), NgrokHealth::Stopped);
    }

    #[test]
    fn stale_credential_is_rejected_before_connecting() {
        let provider = provider("fresh-authtoken");
        let result =
            provider.stored_authtoken(&CredentialReference::Stored("stale-authtoken".into()));
        assert_eq!(result.unwrap_err(), "ngrok authtoken is stale");
    }

    #[test]
    fn endpoint_modes_map_to_their_declared_privacy() {
        assert_eq!(
            NgrokEndpointMode::HttpsEdgeTermination.privacy(),
            RemoteAccessPrivacy::ProviderCanReadPayload
        );
        assert_eq!(
            NgrokEndpointMode::TlsPassthrough.privacy(),
            RemoteAccessPrivacy::ProviderCannotReadPayload
        );
        assert_eq!(
            NgrokEndpointMode::TcpPassthrough.privacy(),
            RemoteAccessPrivacy::ProviderCannotReadPayload
        );
    }

    #[test]
    fn origin_verification_accepts_real_endpoint_origins_only() {
        assert_eq!(
            verify_discovered_origin("https://abc.ngrok.app/").unwrap(),
            "https://abc.ngrok.app"
        );
        assert_eq!(
            verify_discovered_origin("tls://0.tcp.ngrok.io:443").unwrap(),
            "tls://0.tcp.ngrok.io:443"
        );
        assert!(verify_discovered_origin("https://abc.ngrok.app/path").is_err());
        assert!(verify_discovered_origin("http://abc.ngrok.app").is_err());
    }

    #[test]
    fn origin_maps_to_all_four_personal_server_fields() {
        let fields = NgrokProvider::<StaticResolver>::reachability_fields("https://abc.ngrok.app/")
            .expect("fields");
        assert_eq!(
            fields.reference_origin.as_deref(),
            Some("https://abc.ngrok.app")
        );
        assert_eq!(fields.trusted_hosts, "abc.ngrok.app");
        assert!(fields.trusted_proxies.is_empty());
        assert_eq!(fields.bind_host, "127.0.0.1");
    }

    #[test]
    fn target_url_keeps_tls_and_tcp_passthrough_byte_oriented() {
        assert_eq!(
            target_url(&target(), NgrokEndpointMode::TlsPassthrough)
                .unwrap()
                .scheme(),
            "tls"
        );
        assert_eq!(
            target_url(&target(), NgrokEndpointMode::TcpPassthrough)
                .unwrap()
                .scheme(),
            "tcp"
        );
    }

    #[test]
    fn restart_and_stop_are_limited_to_owned_resources() {
        let mut provider = provider("stored-authtoken");
        assert_eq!(provider.health(), NgrokHealth::Stopped);
        assert_eq!(provider.discover_origin().unwrap(), None);
        provider.stop().expect("idempotent stop");
        assert_eq!(provider.health(), NgrokHealth::Stopped);
    }

    #[test]
    fn provider_down_is_reported_when_the_owned_forwarder_finishes() {
        assert_eq!(health_from_state(true, true), NgrokHealth::ProviderDown);
        assert_eq!(health_from_state(true, false), NgrokHealth::Connected);
        assert_eq!(health_from_state(false, false), NgrokHealth::Stopped);
    }

    #[test]
    fn a_reserved_domain_is_optional_and_normalized() {
        let provider = NgrokProvider::with_reserved_domain(
            config(),
            StaticResolver {
                value: Ok(Some(CredentialReference::Stored("token".to_string()))),
            },
            NgrokEndpointMode::HttpsEdgeTermination,
            Some("  Vault.NGROK.app ".to_string()),
        )
        .expect("provider");
        assert_eq!(provider.reserved_domain.as_deref(), Some("vault.ngrok.app"));

        // Omitting the domain keeps ngrok's randomly assigned hostname.
        let random = NgrokProvider::with_reserved_domain(
            config(),
            StaticResolver {
                value: Ok(Some(CredentialReference::Stored("token".to_string()))),
            },
            NgrokEndpointMode::HttpsEdgeTermination,
            None,
        )
        .expect("provider");
        assert_eq!(random.reserved_domain, None);
    }

    #[test]
    fn a_reserved_domain_must_be_a_bare_hostname() {
        for invalid in [
            "https://vault.ngrok.app",
            "vault.ngrok.app:443",
            "vault.ngrok.app/mcp",
            "vault",
            "-vault.ngrok.app",
            "vault..ngrok.app",
            "  ",
        ] {
            assert!(
                validate_reserved_domain(invalid, NgrokEndpointMode::HttpsEdgeTermination).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn tcp_endpoints_refuse_a_reserved_domain() {
        // ngrok 0.19's TcpTunnelBuilder exposes remote_addr, not domain.
        assert!(
            validate_reserved_domain("vault.ngrok.app", NgrokEndpointMode::TcpPassthrough).is_err()
        );
    }
}
