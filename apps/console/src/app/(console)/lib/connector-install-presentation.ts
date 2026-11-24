// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import type { CatalogPublicTier, ConnectorCatalogEntry } from "./connection-catalog.ts";
import {
  ConnectorInstallContractError,
  type ConnectorInstallCatalogEntry,
  type ConnectorInstallStatus,
} from "./connector-install-contract.ts";

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
  readonly connectorKey: string;
  readonly hostBlockReason: string | null;
  readonly installedDigest: string | null;
  readonly installedDigestFull: string | null;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly tier: CatalogPublicTier;
}

/**
 * Matches a manifest's `connector_key` (this app's internal convention,
 * which allows underscores -- e.g. `apple_contacts`) against the OCI
 * catalog's own key spelling (GHCR repository names, which use hyphens --
 * e.g. `apple-contacts`). `canonicalConnectorKey` alone does not bridge this:
 * it only strips a registry URL prefix, so a manifest/catalog pair that
 * differs solely by separator silently misses the Map lookup below and
 * reports a real, published connector as "not_listed". Normalizing both
 * spellings to hyphen is scoped to this lookup. If two catalog keys
 * normalize alike, `selectCatalogTarget` offers no target for either rather
 * than guessing. It does not touch
 * `canonicalConnectorKey` itself, which many other call sites rely on for
 * unrelated comparisons against manifest-spelled literals.
 */
export function connectorLookupKey(value: string): string {
  return canonicalConnectorKey(value.trim()).replaceAll("_", "-");
}

function displayBindingName(binding: string): string {
  return binding.replaceAll(/[_-]+/g, " ");
}

/**
 * Why a binding stops Install, from an explicit availability claim. A binding
 * as the manifest declares it (`{ required: boolean }`) makes no claim and does
 * not block. A claim that is present but unreadable (`available` is neither
 * `true` nor `false`) blocks: the signal gates an action, so it fails closed.
 */
function explicitBindingBlockReason(bindings: Readonly<Record<string, unknown>>): string | null {
  const reasons: string[] = [];
  for (const [binding, value] of Object.entries(bindings)) {
    const name = displayBindingName(binding);
    if (value === false) {
      reasons.push(`${name} is unavailable on this host.`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("available" in value)) {
      continue;
    }
    const availability = value as { available?: unknown; reason?: unknown };
    if (availability.available === true) {
      continue;
    }
    if (availability.available !== false) {
      reasons.push(`${name} availability could not be read.`);
      continue;
    }
    reasons.push(
      typeof availability.reason === "string" && availability.reason.trim()
        ? availability.reason.trim()
        : `${name} is unavailable on this host.`
    );
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
}

function targetDigest(lifecycle: ConnectorInstallLifecycle): string | null {
  const candidate = lifecycle.catalog;
  return candidate?.latest === true ? candidate.digest : null;
}

function tierFor(entry: ConnectorCatalogEntry, lifecycle: ConnectorInstallLifecycle): CatalogPublicTier {
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

/**
 * The one catalog row that can be offered for a connector, or null when the
 * rows are ambiguous: two connectors whose keys differ only by separator, or
 * two latest rows with different digests. Offering whichever arrived last
 * would install a package the owner was not shown, so no target is offered.
 */
function selectCatalogTarget(
  connectorKey: string,
  rows: readonly ConnectorInstallCatalogEntry[]
): ConnectorInstallCatalogEntry | null {
  const spellings = new Set(rows.map((row) => canonicalConnectorKey(row.connector_key.trim())));
  const latest = rows.filter((row) => row.latest);
  if (spellings.size > 1 || new Set(latest.map((row) => row.digest)).size > 1) {
    console.warn(`connector install catalog: ambiguous package entries for "${connectorKey}"; no install target offered`);
    return null;
  }
  return latest.at(-1) ?? rows[0] ?? null;
}

export function buildConnectorInstallLifecycleByConnector(
  catalog: readonly ConnectorInstallCatalogEntry[],
  status: readonly ConnectorInstallStatus[]
): Readonly<Record<string, ConnectorInstallLifecycle>> {
  const keyByIdentity = new Map<string, string>();
  const rowsByConnector = new Map<string, ConnectorInstallCatalogEntry[]>();
  for (const catalogEntry of catalog) {
    const connectorKey = connectorLookupKey(catalogEntry.connector_key);
    rowsByConnector.set(connectorKey, [...(rowsByConnector.get(connectorKey) ?? []), catalogEntry]);
    for (const identity of [catalogEntry.connector_key, catalogEntry.connector_id, catalogEntry.catalog_connector_id]) {
      if (identity) {
        keyByIdentity.set(connectorLookupKey(identity), connectorKey);
      }
    }
  }

  const lifecycleByConnector = new Map<string, ConnectorInstallLifecycle>();
  for (const [connectorKey, rows] of rowsByConnector) {
    lifecycleByConnector.set(connectorKey, { catalog: selectCatalogTarget(connectorKey, rows), installed: null });
  }
  for (const installed of status) {
    const installedIdentity = connectorLookupKey(installed.connector_id);
    const connectorKey = keyByIdentity.get(installedIdentity) ?? installedIdentity;
    const previous = lifecycleByConnector.get(connectorKey);
    // Two installed packages for one connector is a server inconsistency:
    // offering Update against whichever row came last could replace the wrong one.
    if (previous?.installed) {
      throw new ConnectorInstallContractError(
        `connector install status: more than one installed package maps to "${connectorKey}"; installed state is unknown.`
      );
    }
    lifecycleByConnector.set(connectorKey, {
      catalog: previous?.catalog ?? null,
      installed,
    });
  }
  return Object.fromEntries(lifecycleByConnector);
}

/**
 * True when the owner can neither install nor set up this connector here: the
 * package catalog has no artifact for it, no package is installed, and the
 * reference has not registered it. `null` lifecycle means the install route is
 * not available on this server, so there is no package fact to act on.
 */
export function isUninstallableCatalogEntry(
  entry: ConnectorCatalogEntry,
  lifecycle: ConnectorInstallLifecycle | null
): boolean {
  return lifecycle !== null && !lifecycle.catalog && !lifecycle.installed && entry.registrationStatus !== "registered";
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
  // this connector, so there is nothing to install. A registered connector in
  // this state came with the app; an unregistered one is hidden from the
  // Add data list (see `isUninstallableCatalogEntry`).
  let activationLabel = entry.registrationStatus === "registered" ? "Included" : "Not available in this app";
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
    connectorKey: entry.connectorKey,
    hostBlockReason,
    installedDigest: shortConnectorDigest(installed?.digest ?? null),
    installedDigestFull: installed?.digest ?? null,
    installedVersion: installed?.version ?? null,
    targetVersion: target?.latest === true ? target.version : null,
    tier: tierFor(entry, lifecycle),
  };
}
