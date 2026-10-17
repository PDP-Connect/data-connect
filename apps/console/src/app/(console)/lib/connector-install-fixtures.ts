// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const digest = (hex: string): string => `sha256:${hex.repeat(64).slice(0, 64)}`;

export const CONNECTOR_INSTALL_FIXTURE_DIGESTS = {
  githubCurrent: digest("a"),
  githubInstalled: digest("b"),
  imessageInstalled: digest("c"),
  shared: digest("d"),
} as const;

export const connectorInstallCatalogFixture = {
  data: [
    {
      bindings: { network: { available: true } },
      catalog_connector_id: "https://registry.pdpp.dev/connectors/github",
      connector_id: "github",
      connector_key: "github",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubInstalled,
      display_name: "GitHub",
      latest: false,
      published_at: "2026-08-01T00:00:00.000Z",
      setup_modality: "provider_authorization",
      tier: "supported",
      version: "1.0.0",
    },
    {
      bindings: { network: { available: true } },
      catalog_connector_id: "https://registry.pdpp.dev/connectors/github",
      connector_id: "github",
      connector_key: "github",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubCurrent,
      display_name: "GitHub",
      latest: true,
      published_at: "2026-09-01T00:00:00.000Z",
      setup_modality: "provider_authorization",
      tier: "supported",
      version: "1.1.0",
    },
    {
      bindings: {
        filesystem: {
          available: false,
          reason: "Install the local collector on this host.",
        },
      },
      connector_id: "signal",
      connector_key: "signal",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      display_name: "Signal",
      latest: true,
      setup_modality: "local_collector",
      tier: "preview",
      version: "0.4.0",
    },
    {
      bindings: {},
      connector_id: "imessage",
      connector_key: "imessage",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      latest: true,
      tier: "development",
      version: "0.2.0",
    },
  ],
  object: "connector_install_catalog",
} as const;

export const connectorInstallStatusFixture = {
  data: [
    {
      activated_at: "2026-09-10T00:00:00.000Z",
      bindings: { network: { available: true } },
      config_digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      connector_id: "github",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubInstalled,
      entrypoint_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      manifest_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      provenance_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      registry: "ghcr.io",
      repository: "pdp-connect/connector/github",
      tier: "supported",
      version: "1.0.0",
    },
    {
      activated_at: "2026-09-11T00:00:00.000Z",
      bindings: {
        filesystem: {
          available: false,
          reason: "The collector is not paired.",
        },
      },
      config_digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      connector_id: "imessage",
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.imessageInstalled,
      entrypoint_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      manifest_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      provenance_sha256: CONNECTOR_INSTALL_FIXTURE_DIGESTS.shared,
      registry: "ghcr.io",
      repository: "pdp-connect/connector/imessage",
      tier: "development",
      version: "0.1.0",
    },
  ],
  object: "connector_install_status",
} as const;
