// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry, PublicConnectorTier } from "./connection-catalog.ts";
import type { ConnectorInstallCatalogEntry, ConnectorInstallStatus } from "./connector-install-contract.ts";

export interface ConnectorInstallLifecycle {
  readonly catalog: ConnectorInstallCatalogEntry | null;
  readonly installed: ConnectorInstallStatus | null;
}

export type ConnectorInstallActivationState = "active" | "not_installed" | "not_listed" | "update_available";

export interface ConnectorInstallAction {
  readonly digest: string;
  readonly kind: "install" | "update";
  readonly version: string;
}

export interface ConnectorInstallRowModel {
  readonly action: ConnectorInstallAction | null;
  readonly activationLabel: string;
  readonly activationState: ConnectorInstallActivationState;
  readonly connectorId: string;
  readonly hostBlockReason: string | null;
  readonly installedDigest: string | null;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly tier: PublicConnectorTier;
}

function displayBindingName(binding: string): string {
  return binding.replaceAll(/[_-]+/g, " ");
}

function explicitBindingBlockReason(bindings: Readonly<Record<string, unknown>>): string | null {
  for (const [binding, value] of Object.entries(bindings)) {
    if (value === false) {
      return `${displayBindingName(binding)} is unavailable on this host.`;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const availability = value as { available?: unknown; reason?: unknown };
    if (availability.available !== false) {
      continue;
    }
    if (typeof availability.reason === "string" && availability.reason.trim()) {
      return availability.reason.trim();
    }
    return `${displayBindingName(binding)} is unavailable on this host.`;
  }
  return null;
}

function targetDigest(lifecycle: ConnectorInstallLifecycle): string | null {
  const candidate = lifecycle.catalog;
  return candidate?.latest === true ? candidate.digest : null;
}

function tierFor(entry: ConnectorCatalogEntry, lifecycle: ConnectorInstallLifecycle): PublicConnectorTier {
  return lifecycle.catalog?.tier ?? lifecycle.installed?.tier ?? entry.publicTier;
}

export function shortConnectorDigest(digest: string | null): string | null {
  if (!digest) {
    return null;
  }
  const [algorithm, hash] = digest.split(":", 2);
  if (!(algorithm && hash)) {
    return digest;
  }
  return `${algorithm}:${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function buildConnectorInstallLifecycleByConnector(
  catalog: readonly ConnectorInstallCatalogEntry[],
  status: readonly ConnectorInstallStatus[]
): Readonly<Record<string, ConnectorInstallLifecycle>> {
  const lifecycleByConnector = new Map<string, ConnectorInstallLifecycle>();
  for (const catalogEntry of catalog) {
    const previous = lifecycleByConnector.get(catalogEntry.connector_id);
    if (!previous || catalogEntry.latest || !previous.catalog) {
      lifecycleByConnector.set(catalogEntry.connector_id, {
        catalog: catalogEntry,
        installed: previous?.installed ?? null,
      });
    }
  }
  for (const installed of status) {
    const previous = lifecycleByConnector.get(installed.connector_id);
    lifecycleByConnector.set(installed.connector_id, {
      catalog: previous?.catalog ?? null,
      installed,
    });
  }
  return Object.fromEntries(lifecycleByConnector);
}

export function connectorInstallRowModel(
  entry: ConnectorCatalogEntry,
  lifecycle: ConnectorInstallLifecycle
): ConnectorInstallRowModel {
  const { catalog: target, installed } = lifecycle;
  const digest = targetDigest(lifecycle);
  const hostBlockReason = explicitBindingBlockReason(target?.bindings ?? installed?.bindings ?? {});
  let activationState: ConnectorInstallActivationState = "not_listed";
  let activationLabel = "No published package";
  let action: ConnectorInstallAction | null = null;

  if (installed) {
    activationState = digest && installed.digest !== digest ? "update_available" : "active";
    activationLabel = activationState === "update_available" ? "Update available" : "Active";
  } else if (target) {
    activationState = "not_installed";
    activationLabel = "Not installed";
  }

  if (digest && !hostBlockReason && !installed) {
    action = { digest, kind: "install", version: target?.version ?? "" };
  } else if (digest && !hostBlockReason && installed && installed.digest !== digest) {
    action = { digest, kind: "update", version: target?.version ?? "" };
  }

  return {
    activationLabel,
    activationState,
    action,
    connectorId: target?.connector_id ?? installed?.connector_id ?? entry.connectorKey,
    hostBlockReason,
    installedDigest: shortConnectorDigest(installed?.digest ?? null),
    installedVersion: installed?.version ?? null,
    targetVersion: target?.latest === true ? target.version : null,
    tier: tierFor(entry, lifecycle),
  };
}

export function connectorInstallTierLabel(tier: PublicConnectorTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}
