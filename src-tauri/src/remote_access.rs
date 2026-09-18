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
    /// Provider-specific options. Absent for every provider but ngrok, which
    /// keeps the four-field contract itself provider-neutral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ngrok: Option<crate::remote_access_providers::NgrokOptions>,
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

pub(crate) trait RemoteAccessProvider {
    fn inspect(&self) -> RemoteAccessInspection;

    fn start(
        &mut self,
        target: LoopbackTarget,
        credential_reference: CredentialReference,
        cancellation: CancellationToken,
    ) -> Result<RemoteAccessHandle, String>;

    fn stop(&mut self) -> Result<(), String>;
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
                Some("no private-overlay provider is bundled yet".to_string()),
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
}

pub(crate) fn off_remote_access_config() -> RemoteAccessConfig {
    RemoteAccessConfig {
        posture: RemoteAccessPosture::Off,
        provider: None,
        fields: ReachabilityFields::loopback(),
        ngrok: None,
    }
}

pub(crate) fn validate_remote_access_config(
    config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    if config.fields.bind_host != LOOPBACK_BIND_HOST {
        return Err("Remote access must keep PDPP_BIND_HOST at 127.0.0.1".to_string());
    }
    match config.posture {
        RemoteAccessPosture::Off => Ok(off_remote_access_config()),
        RemoteAccessPosture::MyDevicesOnly => {
            Err("My devices only is unavailable until a private-overlay provider is bundled".into())
        }
        RemoteAccessPosture::PublicUrl => {
            let provider = crate::remote_access_providers::resolve_public_url_provider(
                &config.posture,
                config.provider.as_deref(),
                config.ngrok.as_ref(),
            )?;

            // ngrok is assigned its origin by the edge at start, so the stored
            // config legitimately has no origin yet. The supervisor writes the
            // four fields from the discovered origin once the tunnel is up.
            if provider.discovers_own_origin() && config.fields.reference_origin.is_none() {
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

fn remote_access_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(REMOTE_ACCESS_CONFIG_FILE))
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
    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize remote-access configuration: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write remote-access configuration: {error}"))?;
    Ok(config)
}

/// The browser settings page uses this command as a capability probe. The
/// user-supplied provider needs no daemon, account, or provider secret.
#[tauri::command]
pub(crate) fn inspect_remote_access() -> RemoteAccessInspection {
    let provider = UserSuppliedOriginProvider::new(
        RemoteAccessContractConfig {
            provider_id: USER_SUPPLIED_ORIGIN_PROVIDER_ID.to_string(),
            posture: RemoteAccessPosture::PublicUrl,
            user_supplied_origin: Some("https://origin.invalid".to_string()),
            credential_reference: None,
        },
        KeychainCredentialResolver,
    )
    .expect("static user-supplied-origin provider configuration is valid");
    provider.inspect()
}

/// Report whether a provider credential is already in the keychain, so the
/// settings page can skip asking for a token it already holds. The credential
/// itself never crosses this boundary.
#[tauri::command]
pub(crate) fn inspect_remote_access_provider(provider_id: String) -> RemoteAccessInspection {
    validate_provider_id(&provider_id)
        .map(|()| {
            let stored = crate::owner_credential::load_provider_credential_reference(&provider_id)
                .ok()
                .flatten()
                .is_some_and(|reference| !reference.trim().is_empty());
            RemoteAccessInspection {
                availability: RemoteAccessAvailability::Available,
                authentication: if stored {
                    RemoteAccessAuthentication::Authenticated
                } else {
                    RemoteAccessAuthentication::MissingCredential
                },
                reason: if stored {
                    None
                } else {
                    Some(format!("{provider_id} needs a credential"))
                },
            }
        })
        .unwrap_or_else(|reason| RemoteAccessInspection {
            availability: RemoteAccessAvailability::Unavailable,
            authentication: RemoteAccessAuthentication::MissingCredential,
            reason: Some(reason),
        })
}

#[tauri::command]
pub(crate) fn get_remote_access_config(app: AppHandle) -> Result<RemoteAccessConfig, String> {
    load_remote_access_config(&app)
}

#[tauri::command]
pub(crate) async fn set_remote_access_config(
    app: AppHandle,
    config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    if !crate::unified::remote_access_configuration_supported() {
        return Err("Remote access requires the managed desktop stack".to_string());
    }
    let config = save_remote_access_config(&app, config)?;
    crate::unified::restart_after_remote_access_config(app).await?;
    Ok(config)
}

#[tauri::command]
pub(crate) async fn configure_remote_access(
    app: AppHandle,
    config: RemoteAccessConfig,
    owner_password: String,
    provider_credential: Option<String>,
) -> Result<RemoteAccessConfig, String> {
    if !crate::unified::remote_access_configuration_supported() {
        return Err("Remote access requires the managed desktop stack".to_string());
    }
    let config = validate_remote_access_config(config)?;
    if owner_password.trim().len() < 8 {
        return Err("Owner password must contain at least 8 characters".to_string());
    }

    // ngrok has no sign-in flow a desktop app can complete on the owner's
    // behalf, so the authtoken arrives as a one-time paste. Persist it in the
    // OS keychain here so the owner is never asked for it again, and so it
    // never reaches the remote-access configuration file.
    if let Some(credential) = provider_credential.as_deref() {
        let credential = credential.trim();
        if credential.is_empty() {
            return Err("Provider credential cannot be empty".to_string());
        }
        let provider_id = config
            .provider
            .as_deref()
            .ok_or_else(|| "A provider credential needs a provider".to_string())?;
        crate::owner_credential::store_provider_credential_reference(provider_id, credential)?;
    }

    crate::owner_credential::save_owner_credential(&app, &owner_password)?;
    let config = save_remote_access_config(&app, config)?;
    crate::unified::restart_after_remote_access_config(app).await?;
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
            ngrok: None,
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
            ngrok: None,
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
            ngrok: Some(NgrokOptions {
                endpoint_mode: NgrokEndpointModeConfig::TlsPassthrough,
                reserved_domain: None,
            }),
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
            ngrok: None,
        };
        assert!(validate_remote_access_config(config).is_err());
    }

    #[test]
    fn an_unknown_public_provider_is_still_refused() {
        let config = RemoteAccessConfig {
            posture: RemoteAccessPosture::PublicUrl,
            provider: Some("mystery_relay".to_string()),
            fields: ReachabilityFields::loopback(),
            ngrok: None,
        };
        assert!(validate_remote_access_config(config).is_err());
    }
}
