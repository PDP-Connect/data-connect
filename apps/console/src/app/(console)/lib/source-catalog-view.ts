// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry, PublicConnectorTier } from "./connection-catalog.ts";
import { sourceSetupRowIsUnavailable } from "./source-setup-presentation.ts";

/**
 * The Add-a-source catalog as the owner sees it: what they already have,
 * what they can add, and what cannot be added yet. Everything here is pure so
 * the search box, sort and filters can run in the browser over the catalog
 * the page already loaded, with no server round trip.
 */

export type CatalogSort = "maturity" | "name";
export type CatalogMaturityFilter = "all" | PublicConnectorTier;

export interface CatalogViewOptions {
  readonly maturity: CatalogMaturityFilter;
  /** Keys of connectors the owner already has at least one source for. */
  readonly ownedKeys: ReadonlySet<string>;
  readonly query: string;
  readonly sort: CatalogSort;
  /** Keys of connectors whose installed package has an update waiting. */
  readonly updateKeys: ReadonlySet<string>;
  /** Hide entries with no setup path on this device. */
  readonly worksHereOnly: boolean;
}

export interface CatalogView {
  /** Not owned, no setup path here yet; each states why on its row. */
  readonly unavailable: ConnectorCatalogEntry[];
  /** Not owned, with a setup path here. */
  readonly addable: ConnectorCatalogEntry[];
  /** Owned connectors, updates first. */
  readonly yours: ConnectorCatalogEntry[];
}

// Supported first only when the owner asks for it: this order is an explicit
// sort choice, never the default, so a connector the owner names is not buried
// because it is still in preview.
const MATURITY_ORDER: Record<PublicConnectorTier, number> = { development: 2, preview: 1, supported: 0 };

export function entryMatchesQuery(entry: ConnectorCatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [entry.displayName, entry.connectorKey, entry.disposition, entry.setupModality, entry.supportState]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function byName(a: ConnectorCatalogEntry, b: ConnectorCatalogEntry): number {
  return a.displayName.localeCompare(b.displayName);
}

function compareFor(sort: CatalogSort): (a: ConnectorCatalogEntry, b: ConnectorCatalogEntry) => number {
  if (sort === "maturity") {
    return (a, b) => MATURITY_ORDER[a.publicTier] - MATURITY_ORDER[b.publicTier] || byName(a, b);
  }
  return byName;
}

export function buildCatalogView(catalog: readonly ConnectorCatalogEntry[], options: CatalogViewOptions): CatalogView {
  const matching = catalog.filter((entry) => entryMatchesQuery(entry, options.query));
  const compare = compareFor(options.sort);

  // Sort and filters describe the "Add a source" list; the sources the owner
  // already has are always shown in full, updates first, so a filter can
  // never hide a source that needs attention.
  const yours = matching
    .filter((entry) => options.ownedKeys.has(entry.connectorKey))
    .sort((a, b) => {
      const aUpdate = options.updateKeys.has(a.connectorKey) ? 0 : 1;
      const bUpdate = options.updateKeys.has(b.connectorKey) ? 0 : 1;
      return aUpdate - bUpdate || byName(a, b);
    });

  const candidates = matching
    .filter((entry) => !options.ownedKeys.has(entry.connectorKey))
    .filter((entry) => options.maturity === "all" || entry.publicTier === options.maturity)
    .sort(compare);

  const addable = candidates.filter((entry) => !sourceSetupRowIsUnavailable(entry));
  const unavailable = options.worksHereOnly ? [] : candidates.filter((entry) => sourceSetupRowIsUnavailable(entry));
  return { addable, unavailable, yours };
}

/**
 * The search URL for a query: the current location with `source_q` set (or
 * removed when empty). Used with `history.replaceState` so a copied link
 * reopens the same search without the page ever reloading.
 */
export function searchUrlFor(currentHref: string, query: string): string {
  const url = new URL(currentHref);
  const trimmed = query.trim();
  if (trimmed) {
    url.searchParams.set("source_q", trimmed);
  } else {
    url.searchParams.delete("source_q");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
