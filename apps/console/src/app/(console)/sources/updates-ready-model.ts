// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import type { ConnectorInstallSnapshot } from "../lib/connector-install-contract.ts";
import {
  buildConnectorInstallLifecycleByConnector,
  connectorInstallRowModel,
  connectorLookupKey,
} from "../lib/connector-install-presentation.ts";

export interface UpdatesReadyKind {
  connectorId: string;
  sourceNames: string[];
}

export interface UpdatesReadyModel {
  buttonLabel: "Update" | "Update both" | "Update all";
  kinds: UpdatesReadyKind[];
  /** True when the notice shows a count instead of the names. */
  counted: boolean;
  /** Every affected source by name, two of the same name told apart; one entry per source. */
  names: string[];
  namesText: string;
  seeChangesHref: string;
}

export interface UpdateResult {
  ok: boolean;
  sourceNames: readonly string[];
}

export type UpdatesReadyDemoScenario = "update-one" | "update-two" | "update-four" | "update-finished-one-failure";

function listNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * More names than this read as a count; the names are listed under "Show them"
 * in the notice. ("See what changes" opens the Add page, which lists services,
 * not the affected sources.)
 */
const MAX_NAMES_LISTED = 3;

function modelFromKinds(kinds: UpdatesReadyKind[]): UpdatesReadyModel | null {
  if (kinds.length === 0) return null;
  // One entry per source: two sources with the same name are still two.
  const names = kinds.flatMap((kind) => kind.sourceNames).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return null;
  return {
    buttonLabel: kinds.length === 1 ? "Update" : kinds.length === 2 ? "Update both" : "Update all",
    counted: names.length > MAX_NAMES_LISTED,
    kinds,
    names,
    namesText: names.length > MAX_NAMES_LISTED ? `${names.length} data sources` : listNames(names),
    seeChangesHref: kinds.length === 1
      ? `/sources/add?source_q=${encodeURIComponent(kinds[0]?.connectorId ?? "")}`
      : "/sources/add",
  };
}

/**
 * Tell sources that share a name apart: "Amazon · account 1", "Amazon · account 2".
 * A made-up name never equals a name the person gave or one already made up.
 */
function tellAccountsApart(kinds: UpdatesReadyKind[]): UpdatesReadyKind[] {
  const totals = new Map<string, number>();
  for (const name of kinds.flatMap((kind) => kind.sourceNames)) totals.set(name, (totals.get(name) ?? 0) + 1);
  const taken = new Set(totals.keys());
  const lastOrdinal = new Map<string, number>();
  return kinds.map((kind) => ({
    ...kind,
    sourceNames: kind.sourceNames.map((name) => {
      if ((totals.get(name) ?? 0) < 2) return name;
      let ordinal = lastOrdinal.get(name) ?? 0;
      let candidate: string;
      do {
        ordinal += 1;
        candidate = `${name} · account ${ordinal}`;
      } while (taken.has(candidate));
      lastOrdinal.set(name, ordinal);
      taken.add(candidate);
      return candidate;
    }),
  }));
}

/** "alpha" -> "Alpha"; "chase-bank" -> "Chase bank". Used when a source has no saved name. */
function serviceFallbackName(connectorKey: string): string {
  const words = (connectorKey.split("/").at(-1) ?? connectorKey).replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Data source";
}

/** Build ready updates using the same install lifecycle rules as the Add page. */
export function buildUpdatesReadyModel(
  snapshot: ConnectorInstallSnapshot | null,
  sourcesByConnector: Readonly<Record<string, readonly { displayName: string }[]>>
): UpdatesReadyModel | null {
  if (!snapshot) return null;

  const lifecycles = Object.values(buildConnectorInstallLifecycleByConnector(snapshot.catalog, snapshot.status));
  const kindsByLifecycle = new Map<string, UpdatesReadyKind>();

  for (const [sourceConnectorId, sources] of Object.entries(sourcesByConnector)) {
    const identity = connectorLookupKey(sourceConnectorId);
    const match = lifecycles.find((lifecycle) => {
      const candidates = [
        lifecycle.catalog?.connector_id,
        lifecycle.catalog?.connector_key,
        lifecycle.catalog?.catalog_connector_id,
        lifecycle.installed?.connector_id,
      ];
      return candidates.some((candidate) => candidate && connectorLookupKey(candidate) === identity);
    });
    if (!match) continue;
    const catalog = match.catalog;
    const installed = match.installed;
    if (!catalog || !installed || !catalog.latest || catalog.digest === installed.digest) continue;

    const row = connectorInstallRowModel(
      {
        connectorKey: catalog.connector_key,
        publicTier: catalog.tier ?? installed.tier ?? "supported",
        registrationStatus: "registered",
      } as ConnectorCatalogEntry,
      match
    );
    if (row.action?.kind !== "update") continue;

    // Count rows, not labels: a source with no saved name is still a source.
    const fallbackName = serviceFallbackName(catalog.connector_key);
    const sourceNames = sources.map((source) => source.displayName.trim() || fallbackName);
    if (sourceNames.length === 0) continue;
    const lifecycleKey = catalog.connector_key;
    const existing = kindsByLifecycle.get(lifecycleKey);
    if (existing) existing.sourceNames.push(...sourceNames);
    else kindsByLifecycle.set(lifecycleKey, { connectorId: row.connectorId, sourceNames });
  }

  const kinds = [...kindsByLifecycle.values()].map((kind) => ({
    ...kind,
    sourceNames: [...kind.sourceNames].sort((a, b) => a.localeCompare(b)),
  }));
  return modelFromKinds(tellAccountsApart(kinds.sort((a, b) => {
    const firstA = a.sourceNames[0] ?? "";
    const firstB = b.sourceNames[0] ?? "";
    return firstA.localeCompare(firstB);
  })));
}

export interface ConnectorUpdatesRead {
  existingSources: {
    byConnector: Readonly<Record<string, readonly { displayName: string }[]>>;
    truncated: boolean;
  };
  snapshot: ConnectorInstallSnapshot | null;
}

/**
 * The list never waits on, or fails with, the update read: a rejected read, a
 * thrown read or a partial kind map all become "no update line".
 */
export function readUpdatesReadySafely(read: () => Promise<ConnectorUpdatesRead>): Promise<UpdatesReadyModel | null> {
  try {
    return read()
      .then(({ existingSources, snapshot }) =>
        existingSources.truncated ? null : buildUpdatesReadyModel(snapshot, existingSources.byConnector)
      )
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function formatUpdateResult(results: readonly UpdateResult[]): string {
  const successes = results.filter((result) => result.ok).flatMap((result) => result.sourceNames);
  const failures = results.filter((result) => !result.ok).flatMap((result) => result.sourceNames);
  const parts: string[] = [];
  if (successes.length > 0) {
    parts.push(`Updated ${successes.length === 1 ? "data source" : "data sources"} ${listNames(successes)}.`);
  }
  if (failures.length > 0) {
    parts.push(`Could not update ${failures.length === 1 ? "data source" : "data sources"} ${listNames(failures)}.`);
  }
  return parts.join(" ");
}

export function isUpdatesReadyDemoScenario(value: string): value is UpdatesReadyDemoScenario {
  return value === "update-one" || value === "update-two" || value === "update-four" || value === "update-finished-one-failure";
}

export function buildUpdatesReadyDemo(scenario: UpdatesReadyDemoScenario): {
  initialResult: string | null;
  model: UpdatesReadyModel;
} {
  const demoKinds: UpdatesReadyKind[] = [
    { connectorId: "calendar", sourceNames: ["Calendar"] },
    { connectorId: "email", sourceNames: ["Email"] },
    { connectorId: "photos", sourceNames: ["Photos"] },
    { connectorId: "notes", sourceNames: ["Notes"] },
  ];
  const count = scenario === "update-one" ? 1 : scenario === "update-two" || scenario === "update-finished-one-failure" ? 2 : 4;
  const model = modelFromKinds(demoKinds.slice(0, count));
  if (!model) throw new Error("An updates demo needs at least one kind.");
  return {
    initialResult: scenario === "update-finished-one-failure"
      ? formatUpdateResult([
          { ok: true, sourceNames: ["Calendar"] },
          { ok: false, sourceNames: ["Email"] },
        ])
      : null,
    model,
  };
}
