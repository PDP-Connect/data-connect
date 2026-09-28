// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import type { ConnectorCatalogEntry, PublicConnectorTier } from "./connection-catalog.ts";
import type { ConnectorInstallCatalogEntry, ConnectorInstallStatus } from "./connector-install-contract.ts";

export interface ConnectorInstallLifecycle {
  readonly catalog: ConnectorInstallCatalogEntry | null;
  readonly installed: ConnectorInstallStatus | null;
}

export type ConnectorInstallActivationState =
  | "active"
  | "not_installed"
  | "not_listed"
  | "repair_required"
  | "update_available";

export interface ConnectorInstallAction {
  readonly digest: string;
  readonly kind: "install" | "update";
  readonly version: string;
}

export interface ConnectorInstallRowModel {
  readonly action: ConnectorInstallAction | null;
  readonly activationLabel: string;
  readonly activationReason: string | null;
  readonly activationState: ConnectorInstallActivationState;
  readonly operatorInstruction: string | null;
  readonly connectorId: string;
  readonly hostBlockReason: string | null;
  readonly installedDigest: string | null;
  readonly installedDigestFull: string | null;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly tier: PublicConnectorTier;
}

/**
 * Matches a manifest's `connector_key` (this app's internal convention,
 * which allows underscores -- e.g. `apple_contacts`) against the OCI
 * catalog's own key spelling (GHCR repository names, which use hyphens --
 * e.g. `apple-contacts`). `canonicalConnectorKey` alone does not bridge this:
 * it only strips a registry URL prefix, so a manifest/catalog pair that
 * differs solely by separator silently misses the Map lookup below and
 * reports a real, published connector as "not_listed". Underscore and
 * hyphen are the only separators either side uses, so normalizing both to
 * hyphen is a safe, narrow fix scoped to this lookup -- it does not touch
 * `canonicalConnectorKey` itself, which many other call sites rely on for
 * unrelated comparisons against manifest-spelled literals.
 */
export function connectorLookupKey(value: string): string {
  return canonicalConnectorKey(value.trim()).replaceAll("_", "-");
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
  const keyByIdentity = new Map<string, string>();
  for (const catalogEntry of catalog) {
    const connectorKey = connectorLookupKey(catalogEntry.connector_key);
    for (const identity of [catalogEntry.connector_key, catalogEntry.connector_id, catalogEntry.catalog_connector_id]) {
      if (identity) {
        keyByIdentity.set(connectorLookupKey(identity), connectorKey);
      }
    }
  }

  const lifecycleByConnector = new Map<string, ConnectorInstallLifecycle>();
  for (const catalogEntry of catalog) {
    const connectorKey = connectorLookupKey(catalogEntry.connector_key);
    const previous = lifecycleByConnector.get(connectorKey);
    if (!previous || catalogEntry.latest || !previous.catalog) {
      lifecycleByConnector.set(connectorKey, {
        catalog: catalogEntry,
        installed: previous?.installed ?? null,
      });
    }
  }
  for (const installed of status) {
    const installedIdentity = connectorLookupKey(installed.connector_id);
    const connectorKey = keyByIdentity.get(installedIdentity) ?? installedIdentity;
    const previous = lifecycleByConnector.get(connectorKey);
    lifecycleByConnector.set(connectorKey, {
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
  // "not_listed" means the OCI catalog has never carried an artifact for
  // this connector, so there is nothing to install and no action this owner
  // can take — part of the shared "not available yet" family with the
  // scaffold ("Not built yet") and development-hidden states.
  let activationLabel = "Not packaged yet";
  let action: ConnectorInstallAction | null = null;

  if (installed) {
    if (installed.activation_state === "repair_required") {
      activationState = "repair_required";
      activationLabel = "Repair required";
    } else {
      activationState = digest && installed.digest !== digest ? "update_available" : "active";
      activationLabel = activationState === "update_available" ? "Update available" : "Active";
    }
  } else if (target) {
    activationState = "not_installed";
    activationLabel = "Not installed";
  }

  if (digest && !hostBlockReason && !installed) {
    action = { digest, kind: "install", version: target?.version ?? "" };
  } else if (digest && !hostBlockReason && installed?.activation_state === "active" && installed.digest !== digest) {
    action = { digest, kind: "update", version: target?.version ?? "" };
  }

  return {
    activationLabel,
    activationReason: installed?.repair_reason ?? null,
    activationState,
    action,
    connectorId: target?.connector_id ?? installed?.connector_id ?? entry.connectorKey,
    hostBlockReason,
    installedDigest: shortConnectorDigest(installed?.digest ?? null),
    installedDigestFull: installed?.digest ?? null,
    installedVersion: installed?.version ?? null,
    operatorInstruction:
      installed?.activation_state === "repair_required"
        ? "Operator repair is required. Follow the connector install recovery runbook on the server host."
        : null,
    targetVersion: target?.latest === true ? target.version : null,
    tier: tierFor(entry, lifecycle),
  };
}

export function connectorInstallTierLabel(tier: PublicConnectorTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}
