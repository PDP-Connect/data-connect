// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";

/** Test-only catalog entries for the add flow: one per kind of service. */
function entry(overrides: Partial<ConnectorCatalogEntry> & Pick<ConnectorCatalogEntry, "connectorKey" | "displayName">): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
    disposition: "browser_collector_manual",
    externalDocs: [],
    listingNote: null,
    modality: "browser_bound",
    nextStepKind: "enroll_browser_collector",
    ownerActionable: true,
    ownerActionMethod: null,
    ownerActionUrl: null,
    proofGate: null,
    publicTier: "supported",
    readiness: null,
    refreshPolicyRationale: null,
    registrationStatus: "registered",
    runbookPath: null,
    setupDescription: null,
    setupHelpText: null,
    setupModality: "browser_bound",
    supportState: "supported",
    ...overrides,
  };
}

export const amazon = entry({ connectorKey: "amazon", displayName: "Amazon", publicTier: "preview" });
export const chase = entry({ connectorKey: "chase", displayName: "Chase" });
export const ynab = entry({
  connectorKey: "ynab",
  displayName: "YNAB",
  disposition: "static_secret_connect",
  modality: "api_network",
  setupModality: "static_secret",
});
export const appleHealth = entry({
  connectorKey: "apple-health",
  displayName: "Apple Health",
  disposition: "manual_upload_connect",
  modality: "api_network",
  setupModality: "manual_or_upload",
});
export const claudeCode = entry({
  connectorKey: "claude-code",
  displayName: "Claude Code",
  disposition: "local_collector_enroll",
  modality: "local_collector",
  setupModality: "local_collector",
});
/** A browser sign-in service whose setup path the server does not offer (the "7 of 25"). */
export const whoop = entry({
  connectorKey: "whoop",
  displayName: "WHOOP",
  disposition: "browser_bound_runbook",
  ownerActionable: false,
  registrationStatus: undefined,
});

export const ALL_ENTRIES = [amazon, chase, ynab, appleHealth, claudeCode, whoop] as const;

const catalogRow = (key: string, digest = "sha256:aaaa") => ({
  bindings: {},
  connector_id: key,
  connector_key: key,
  digest,
  latest: true,
  version: "1.2.3",
});

/** A package the server lists and has not installed yet. */
export function notInstalled(key: string): ConnectorInstallLifecycle {
  return { catalog: catalogRow(key) as never, installed: null };
}

export function installed(key: string): ConnectorInstallLifecycle {
  return {
    catalog: catalogRow(key) as never,
    installed: { connector_id: key, digest: "sha256:aaaa", version: "1.2.3" } as never,
  };
}
