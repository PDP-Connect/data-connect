// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";
import { connectorLookupKey, isUninstallableCatalogEntry } from "../../lib/connector-install-presentation.ts";
import { sourceSetupAction, sourceSetupCardModel } from "../../lib/source-setup-presentation.ts";

/**
 * The list on `/sources/add` (design "Page 1"). One row per service a person
 * can connect on this install, A to Z. A service the server says cannot be
 * connected is not a row; it only answers a search that names it.
 */
export interface AddSourceRow {
  /** True when the person already has an account of this service. */
  readonly added: boolean;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly href: string;
  readonly icon: ConnectorIconLike | null | undefined;
}

export interface AddSourceListModel {
  /** Names of services that exist here but cannot be connected. Used only by search. */
  readonly notAddable: readonly string[];
  readonly rows: readonly AddSourceRow[];
}

export interface AddSourceListInput {
  readonly catalog: readonly ConnectorCatalogEntry[];
  readonly catalogTransientlyUnavailable: boolean;
  readonly existingConnectionCounts: Readonly<Record<string, number>>;
  /** `null` means the server has no install routes: no package facts exist. */
  readonly lifecycleFor: (entry: ConnectorCatalogEntry) => ConnectorInstallLifecycle | null;
}

export function addSourceHref(connectorKey: string): string {
  return `/sources/add/${encodeURIComponent(connectorKey)}`;
}

/**
 * Whether the server lets a person connect this service here. Both facts must
 * hold: the setup path exists for the entry's kind and tier, and the install
 * state does not block it (no package to get, or a host that cannot run it).
 */
export function isConnectableEntry(
  entry: ConnectorCatalogEntry,
  lifecycle: ConnectorInstallLifecycle | null,
  catalogTransientlyUnavailable: boolean
): boolean {
  if (sourceSetupAction(entry) === null) {
    return false;
  }
  if (!catalogTransientlyUnavailable && isUninstallableCatalogEntry(entry, lifecycle)) {
    return false;
  }
  return !sourceSetupCardModel(entry, lifecycle, catalogTransientlyUnavailable).unavailable;
}

function compareByName(a: { displayName: string }, b: { displayName: string }): number {
  return a.displayName.localeCompare(b.displayName);
}

export function buildAddSourceList(input: AddSourceListInput): AddSourceListModel {
  const rows: AddSourceRow[] = [];
  const notAddable: string[] = [];
  const seen = new Set<string>();
  for (const entry of input.catalog) {
    const identity = connectorLookupKey(entry.connectorKey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (isConnectableEntry(entry, input.lifecycleFor(entry), input.catalogTransientlyUnavailable)) {
      rows.push({
        added: (input.existingConnectionCounts[entry.connectorKey] ?? 0) > 0,
        connectorKey: entry.connectorKey,
        displayName: entry.displayName,
        href: addSourceHref(entry.connectorKey),
        icon: entry.icon,
      });
    } else {
      notAddable.push(entry.displayName);
    }
  }
  rows.sort(compareByName);
  notAddable.sort((a, b) => a.localeCompare(b));
  return { notAddable, rows };
}

export type AddSourceSearchResult =
  | { readonly kind: "rows"; readonly rows: readonly AddSourceRow[] }
  | { readonly kind: "cannot-add"; readonly name: string }
  | { readonly kind: "no-match"; readonly query: string };

function matches(name: string, needle: string): boolean {
  return name.toLowerCase().includes(needle);
}

export function searchAddSourceList(model: AddSourceListModel, query: string): AddSourceSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { kind: "rows", rows: model.rows };
  }
  const rows = model.rows.filter((row) => matches(row.displayName, needle));
  if (rows.length > 0) {
    return { kind: "rows", rows };
  }
  const blocked = model.notAddable.find((name) => matches(name, needle));
  if (blocked) {
    return { kind: "cannot-add", name: blocked };
  }
  return { kind: "no-match", query: query.trim() };
}

export const ADD_SOURCE_COPY = {
  heading: "Add a data source",
  loadFailed: "The list of services didn't load. Check that this computer is online.",
  lead: "Pick a service. DataConnect copies your data from it to this computer.",
  retry: "Try again",
  searchPlaceholder: "Search for a service",
} as const;

export function cannotAddCopy(name: string): string {
  return `${name} can't be added yet.`;
}

export function noMatchCopy(query: string): string {
  return `Nothing matches "${query}".`;
}
