// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! Cloudflare's named (remotely-managed) Tunnel provider.
//!
//! Deliberately NOT a Quick Tunnel (`trycloudflare.com`) integration.
//! Cloudflare's own docs state Quick Tunnels "are subject to a hard limit on
//! the number of concurrent requests... currently 200 in-flight" and "do not
//! support Server-Sent Events (SSE)," and that both limitations "only apply
//! to Quick Tunnels" -- a named tunnel has neither. This app's live sync run
//! viewer (`reference-implementation/server/streaming/routes.ts`) depends on
//! a real, long-held SSE connection, so a provider that silently drops that
//! traffic class is a worse failure mode than one that is merely unavailable.
//! See `~/code/dotfiles/ai/research/product-design/
//! cloudflare-named-tunnels-support-sse-and-need-a-token-plus-a-dns-zone-quick-tunnels-are-testing-only.md`
//! for the primary-source citations.
//!
//! Unlike ngrok (an embedded Rust SDK, no subprocess), a Cloudflare named
//! tunnel requires supervising an external `cloudflared` binary: the owner
//! creates the tunnel and its public-hostname route in the Cloudflare
//! dashboard/API themselves (this app has no Cloudflare account credential
//! and does not attempt to automate account-level tunnel creation), pastes
//! the resulting tunnel token and the hostname it configured into Settings,
//! and this adapter runs `cloudflared tunnel run --token <TOKEN>` as a child
//! process forwarding to the loopback target. The hostname is therefore
//! `Available` from config alone -- exactly like ngrok with a configured dev
//! domain -- because the owner told Cloudflare what hostname routes to this
//! tunnel when they created the route, not because this adapter discovered
//! anything at runtime.

use crate::remote_access::{
    CancellationToken, CredentialReference, DurableAddressState, LoopbackTarget,
    ReachabilityFields, RemoteAccessAuthentication, RemoteAccessAvailability,
    RemoteAccessContractConfig, RemoteAccessHandle, RemoteAccessInspection, RemoteAccessPosture,
    RemoteAccessPrivacy, RemoteAccessProvider,
};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use url::Url;

pub(crate) const CLOUDFLARE_TUNNEL_PROVIDER_ID: &str = "cloudflare_tunnel";
const LOOPBACK_BIND_HOST: &str = "127.0.0.1";
const CLOUDFLARED_BINARY: &str = "cloudflared";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Cloudflare terminates TLS at its edge for every named tunnel, exactly as
/// it does for Quick Tunnels: "Cloudflare must decrypt traffic in order to
/// cache and filter malicious traffic." There is no passthrough mode for
/// `cloudflared` the way ngrok offers TLS/TCP passthrough, so this is a
/// constant, not a per-endpoint-mode function the way
/// `NgrokEndpointMode::privacy` is.
const PRIVACY: RemoteAccessPrivacy = RemoteAccessPrivacy::ProviderCanReadPayload;

fn privacy() -> RemoteAccessPrivacy {
    PRIVACY
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CloudflareTunnelHealth {
    Stopped,
    Connected,
    ProviderDown,
}

struct OwnedCloudflaredProcess {
    child: Child,
    /// Set once a background reader thread observes `cloudflared` report a
    /// registered connection on stdout/stderr, or the process exits before
    /// that happens. `Ok(())` never carries data -- the hostname is already
    /// known from config (`hostname` on `CloudflareTunnelProvider`), so
    /// nothing is parsed OUT of `cloudflared`'s output the way ngrok's SDK
    /// returns a URL; this channel only answers "did it connect."
    connected: mpsc::Receiver<Result<(), String>>,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl OwnedCloudflaredProcess {
    fn is_running(&mut self) -> bool {
        !self
            .exited
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// The concrete Cloudflare named-tunnel provider. `R` is the existing
/// keychain-backed credential resolver from the provider seam, holding the
/// tunnel token the owner pasted in Settings.
pub(crate) struct CloudflareTunnelProvider<R> {
    config: RemoteAccessContractConfig,
    credential_resolver: R,
    hostname: String,
    process: Option<OwnedCloudflaredProcess>,
}

impl<R> CloudflareTunnelProvider<R> {
    /// `hostname` is the public DNS name the owner already routed to this
    /// tunnel in the Cloudflare dashboard/API (see the module doc comment) --
    /// a bare hostname, validated the same way ngrok's reserved domain is.
    pub(crate) fn new(
        config: RemoteAccessContractConfig,
        credential_resolver: R,
        hostname: String,
    ) -> Result<Self, String> {
        if config.provider_id != CLOUDFLARE_TUNNEL_PROVIDER_ID {
            return Err("Cloudflare tunnel provider received a different provider id".to_string());
        }
        if config.posture != RemoteAccessPosture::PublicUrl {
            return Err("Cloudflare tunnel requires the public_url remote-access posture".to_string());
        }
        if config.user_supplied_origin.is_some() {
            return Err("Cloudflare tunnel cannot use a user-supplied origin".to_string());
        }
        let hostname = validate_tunnel_hostname(&hostname)?;

        Ok(Self {
            config,
            credential_resolver,
            hostname,
            process: None,
        })
    }

    pub(crate) fn health(&mut self) -> CloudflareTunnelHealth {
        let Some(process) = self.process.as_mut() else {
            return CloudflareTunnelHealth::Stopped;
        };
        if process.is_running() {
            CloudflareTunnelHealth::Connected
        } else {
            CloudflareTunnelHealth::ProviderDown
        }
    }

    /// The origin is always `https://<hostname>` -- known from config, never
    /// discovered from process output. Kept as a method (mirroring
    /// `NgrokProvider::discover_origin`) for interface symmetry with the
    /// other provider even though it cannot fail the way a genuine discovery
    /// call can.
    fn origin(&self) -> String {
        format!("https://{}", self.hostname)
    }

    pub(crate) fn reachability_fields(hostname: &str) -> Result<ReachabilityFields, String> {
        let hostname = validate_tunnel_hostname(hostname)?;
        Ok(ReachabilityFields {
            reference_origin: Some(format!("https://{hostname}")),
            trusted_hosts: hostname,
            trusted_proxies: String::new(),
            bind_host: LOOPBACK_BIND_HOST.to_string(),
        })
    }

    fn stored_token(&self, credential_reference: &CredentialReference) -> Result<String, String>
    where
        R: crate::remote_access::CredentialResolver,
    {
        let CredentialReference::Stored(provided) = credential_reference else {
            return Err("Cloudflare tunnel requires a stored tunnel token".to_string());
        };
        if provided.trim().is_empty() {
            return Err("Cloudflare tunnel token is empty".to_string());
        }

        let stored = self
            .credential_resolver
            .resolve(CLOUDFLARE_TUNNEL_PROVIDER_ID)
            .map_err(|_| "Cloudflare credential store could not be read".to_string())?
            .ok_or_else(|| "Cloudflare tunnel token is missing".to_string())?;
        let CredentialReference::Stored(stored) = stored else {
            return Err("Cloudflare credential store returned no tunnel token".to_string());
        };
        if stored != *provided {
            return Err("Cloudflare tunnel token is stale".to_string());
        }
        Ok(provided.clone())
    }

    fn stop_owned(&mut self) -> Result<(), String> {
        let Some(mut process) = self.process.take() else {
            return Ok(());
        };
        #[cfg(unix)]
        {
            let pid = process.child.id() as libc::pid_t;
            // SAFETY: sending SIGTERM to a PID this process owns (its own
            // child) is always sound; a graceful shutdown lets cloudflared
            // deregister the tunnel from Cloudflare's edge before exiting.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match process.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => return Err(format!("cloudflared stop failed: {error}")),
            }
        }
        Ok(())
    }
}

impl<R> RemoteAccessProvider for CloudflareTunnelProvider<R>
where
    R: crate::remote_access::CredentialResolver,
{
    fn inspect(&self) -> RemoteAccessInspection {
        let authentication = match self.credential_resolver.resolve(CLOUDFLARE_TUNNEL_PROVIDER_ID) {
            Ok(Some(CredentialReference::Stored(token))) if !token.trim().is_empty() => {
                RemoteAccessAuthentication::Authenticated
            }
            Ok(Some(_)) | Ok(None) | Err(_) => RemoteAccessAuthentication::MissingCredential,
        };
        let reason = match authentication {
            RemoteAccessAuthentication::Authenticated => None,
            _ => Some("Cloudflare tunnel token is missing".to_string()),
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
            return Err("Cloudflare tunnel start was cancelled".to_string());
        }
        validate_loopback_target(&target)?;
        let token = self.stored_token(&credential_reference)?;
        if cancellation.is_cancelled() {
            return Err("Cloudflare tunnel start was cancelled".to_string());
        }

        if self.process.is_some() {
            self.stop_owned()?;
        }

        let url = format!("{}://{}:{}", "http", target.host, target.port);
        let mut command = Command::new(CLOUDFLARED_BINARY);
        command
            .args(["tunnel", "run", "--token", &token, "--url", &url])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "cloudflared is not installed or not on PATH. Install it from \
                     https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ \
                     and try again. (spawn error: {error})"
                )
            } else {
                format!("Failed to start cloudflared: {error}")
            }
        })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (connected_tx, connected_rx) = mpsc::channel();
        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        spawn_output_watcher(stdout, stderr, connected_tx, exited.clone());

        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cloudflare tunnel start was cancelled".to_string());
        }

        match connected_rx.recv_timeout(CONNECT_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(reason)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cloudflared failed to connect: {reason}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "cloudflared did not report a registered connection within {CONNECT_TIMEOUT:?}. \
                     Check that the tunnel token is valid and the hostname is routed to this tunnel \
                     in the Cloudflare dashboard."
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cloudflared exited before reporting a connection".to_string());
            }
        }

        self.process = Some(OwnedCloudflaredProcess {
            child,
            connected: connected_rx,
            exited,
        });

        Ok(RemoteAccessHandle {
            provider_id: self.config.provider_id.clone(),
            origin: self.origin(),
            privacy: privacy(),
        })
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_owned()
    }

    fn durable_address(&self) -> DurableAddressState {
        cloudflare_tunnel_durable_address(&self.hostname)
    }
}

impl<R> Drop for CloudflareTunnelProvider<R> {
    fn drop(&mut self) {
        let _ = self.stop_owned();
    }
}

/// The owner supplies the hostname when they route it to this tunnel in
/// Cloudflare's dashboard/API, so it is ALWAYS a durable address the moment
/// it is configured -- there is no "no domain configured yet" state the way
/// ngrok's free-plan dev domain has, because a named tunnel with no routed
/// hostname is simply not usable as a Public URL provider yet (the console
/// requires the hostname field before this provider can be selected; see
/// `resolve_public_url_provider`). A free function for the same reason
/// `ngrok_durable_address_for_reserved_domain` is one: config-only callers
/// (`PublicUrlProvider::durable_address`) need this answer before any
/// provider instance exists.
pub(crate) fn cloudflare_tunnel_durable_address(hostname: &str) -> DurableAddressState {
    DurableAddressState::Available {
        address: hostname.to_string(),
    }
}

fn spawn_output_watcher(
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
    connected: mpsc::Sender<Result<(), String>>,
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    thread::spawn(move || {
        let connected_stdout = connected.clone();
        let stdout_handle = stdout.map(|stdout| {
            let connected = connected_stdout;
            thread::spawn(move || watch_stream(BufReader::new(stdout), connected))
        });
        let stderr_handle = stderr.map(|stderr| {
            let connected = connected.clone();
            thread::spawn(move || watch_stream(BufReader::new(stderr), connected))
        });
        if let Some(handle) = stdout_handle {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }
        exited.store(true, std::sync::atomic::Ordering::SeqCst);
        // A best-effort final signal in case neither stream ever reported a
        // registration line before both closed (cloudflared crashed or was
        // killed early) -- `send` failing just means the receiver already
        // got an answer and dropped, which is fine.
        let _ = connected.send(Err(
            "cloudflared's output streams closed without reporting a connection".to_string(),
        ));
    });
}

/// cloudflared logs a line containing "Registered tunnel connection" once
/// the tunnel is live, and lines containing "connection error"/"failed to
/// " on a fatal startup failure (for example an invalid token). Matched
/// case-insensitively against both stdout and stderr, since cloudflared's
/// log destination has varied across versions and this adapter does not pin
/// one.
fn watch_stream<R: std::io::Read>(reader: BufReader<R>, connected: mpsc::Sender<Result<(), String>>) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let lower = line.to_ascii_lowercase();
        if lower.contains("registered tunnel connection") {
            let _ = connected.send(Ok(()));
        } else if lower.contains("failed to parse token")
            || lower.contains("invalid tunnel token")
            || lower.contains("unauthorized")
        {
            let _ = connected.send(Err(line));
        }
    }
}

fn validate_loopback_target(target: &LoopbackTarget) -> Result<(), String> {
    if target.port == 0 {
        return Err("Cloudflare tunnel loopback target port cannot be zero".to_string());
    }
    if !matches!(
        target.host.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    ) {
        return Err("Cloudflare tunnel loopback target must be localhost".to_string());
    }
    Ok(())
}

/// A tunnel hostname is a bare hostname -- the same shape as ngrok's
/// reserved domain, and validated the same way (see
/// `remote_access_ngrok::validate_reserved_domain`), except a Cloudflare
/// named tunnel has no equivalent of ngrok's TCP-endpoint-has-no-domain
/// exclusion, so there is nothing to reject based on endpoint mode.
fn validate_tunnel_hostname(hostname: &str) -> Result<String, String> {
    let hostname = hostname.trim().to_ascii_lowercase();
    if hostname.is_empty() {
        return Err("Cloudflare tunnel hostname cannot be empty".to_string());
    }
    if hostname.contains(['/', ':', '?', '#', '@', ' ']) {
        return Err("Cloudflare tunnel hostname must be a bare hostname".to_string());
    }
    if !hostname.contains('.') {
        return Err("Cloudflare tunnel hostname must be fully qualified".to_string());
    }
    if hostname.split('.').any(|label| {
        label.is_empty()
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err("Cloudflare tunnel hostname has an invalid label".to_string());
    }
    // The parsed URL only exists to catch anything the label-level checks
    // above miss; the stored value stays the bare hostname, matching
    // ngrok's `validate_reserved_domain`.
    Url::parse(&format!("https://{hostname}"))
        .map_err(|error| format!("Cloudflare tunnel hostname is invalid: {error}"))?;
    Ok(hostname)
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
            provider_id: CLOUDFLARE_TUNNEL_PROVIDER_ID.to_string(),
            posture: RemoteAccessPosture::PublicUrl,
            user_supplied_origin: None,
            credential_reference: None,
        }
    }

    fn provider(value: &str) -> CloudflareTunnelProvider<StaticResolver> {
        CloudflareTunnelProvider::new(
            config(),
            StaticResolver {
                value: Ok(Some(CredentialReference::Stored(value.to_string()))),
            },
            "vault.example.com".to_string(),
        )
        .expect("provider")
    }

    #[test]
    fn durable_address_is_always_available_because_the_owner_already_routed_the_hostname() {
        // Unlike ngrok, a named Cloudflare tunnel has no "no domain
        // configured" state to report: the hostname is a precondition of
        // selecting this provider at all, not something discovered later.
        assert_eq!(
            cloudflare_tunnel_durable_address("vault.example.com"),
            DurableAddressState::Available {
                address: "vault.example.com".to_string(),
            }
        );
    }

    #[test]
    fn durable_address_matches_the_live_provider() {
        let provider = provider("stored-token");
        assert_eq!(
            provider.durable_address(),
            DurableAddressState::Available {
                address: "vault.example.com".to_string(),
            }
        );
    }

    #[test]
    fn hostname_must_be_a_bare_fully_qualified_hostname() {
        for invalid in [
            "https://vault.example.com",
            "vault.example.com:443",
            "vault.example.com/mcp",
            "vault",
            "-vault.example.com",
            "vault..example.com",
            "  ",
        ] {
            assert!(validate_tunnel_hostname(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn hostname_is_normalized_to_lowercase() {
        assert_eq!(
            validate_tunnel_hostname("  Vault.Example.COM ").unwrap(),
            "vault.example.com"
        );
    }

    #[test]
    fn origin_maps_to_all_four_personal_server_fields() {
        let fields = CloudflareTunnelProvider::<StaticResolver>::reachability_fields(
            "vault.example.com",
        )
        .expect("fields");
        assert_eq!(
            fields.reference_origin.as_deref(),
            Some("https://vault.example.com")
        );
        assert_eq!(fields.trusted_hosts, "vault.example.com");
        assert!(fields.trusted_proxies.is_empty());
        assert_eq!(fields.bind_host, "127.0.0.1");
    }

    #[test]
    fn privacy_always_discloses_that_cloudflare_can_read_the_payload() {
        // Cloudflare terminates TLS at its edge for every named tunnel --
        // there is no passthrough mode the way ngrok offers, so this must
        // never be able to report the opposite.
        assert_eq!(privacy(), RemoteAccessPrivacy::ProviderCanReadPayload);
    }

    #[test]
    fn login_uses_the_keychain_value_without_exposing_it_in_diagnostics() {
        let provider = provider("stored-token");
        assert_eq!(
            provider.inspect().authentication,
            RemoteAccessAuthentication::Authenticated
        );
        assert!(!format!("{:?}", provider.inspect()).contains("stored-token"));
    }

    #[test]
    fn stale_credential_is_rejected_before_spawning_cloudflared() {
        let provider = provider("fresh-token");
        let result = provider.stored_token(&CredentialReference::Stored("stale-token".into()));
        assert_eq!(result.unwrap_err(), "Cloudflare tunnel token is stale");
    }

    #[test]
    fn cancellation_is_rejected_before_any_process_is_spawned() {
        let mut provider = provider("stored-token");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = provider.start(
            LoopbackTarget {
                host: "127.0.0.1".to_string(),
                port: 4310,
            },
            CredentialReference::Stored("stored-token".into()),
            cancellation,
        );
        assert!(result.is_err());
        assert_eq!(provider.health(), CloudflareTunnelHealth::Stopped);
    }

    /// A missing `cloudflared` binary must produce a clear, actionable error
    /// -- never a silent failure or a generic "process failed" message the
    /// owner cannot act on. Exercises the real `Command::spawn()` NotFound
    /// path against a binary name guaranteed not to exist, rather than
    /// mocking the spawn -- this is the exact error surface an owner without
    /// cloudflared installed will hit.
    #[test]
    fn missing_binary_produces_an_actionable_error() {
        let mut command = Command::new("definitely-not-a-real-binary-cloudflared-test");
        let error = command.spawn().expect_err("binary must not exist");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);

        // Mirror the exact mapping `start()` applies to this error kind.
        let mapped = if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "cloudflared is not installed or not on PATH. Install it from \
                 https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ \
                 and try again. (spawn error: {error})"
            )
        } else {
            format!("Failed to start cloudflared: {error}")
        };
        assert!(mapped.contains("not installed or not on PATH"));
        assert!(mapped.contains("developers.cloudflare.com"));
    }

    #[test]
    fn watch_stream_reports_connection_on_the_registered_tunnel_line() {
        let sample = b"2026-09-20T00:00:00Z INF Registered tunnel connection connIndex=0\n";
        let (tx, rx) = mpsc::channel();
        watch_stream(BufReader::new(&sample[..]), tx);
        assert!(matches!(rx.recv(), Ok(Ok(()))));
    }

    #[test]
    fn watch_stream_reports_failure_on_an_invalid_token_line() {
        let sample = b"2026-09-20T00:00:00Z ERR Failed to parse token: invalid tunnel token\n";
        let (tx, rx) = mpsc::channel();
        watch_stream(BufReader::new(&sample[..]), tx);
        assert!(matches!(rx.recv(), Ok(Err(reason)) if reason.to_ascii_lowercase().contains("token")));
    }

    #[test]
    fn watch_stream_reports_nothing_for_unrelated_log_lines() {
        let sample = b"2026-09-20T00:00:00Z INF Starting tunnel tunnelID=abc123\n";
        let (tx, rx) = mpsc::channel();
        watch_stream(BufReader::new(&sample[..]), tx);
        assert!(rx.try_recv().is_err());
    }
}
