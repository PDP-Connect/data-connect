// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildOwnerConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { buildConnectorIconMap, catalogEntryIcon } from "../../lib/connector-icon-map.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";
import { buildConnectorInstallLifecycleByConnector, connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import { listConnectorManifests, listOwnerConnectorTemplates } from "../../lib/rs-client.ts";
import { getConnectorInstallSnapshot } from "../connector-updates-read.ts";
import { readInstalledSourceCatalog } from "./installed-source-catalog.ts";

export interface AddSourceCatalogRead {
  readonly catalog: readonly ConnectorCatalogEntry[];
  /** Set when the list is the server's kept copy; `fetchedAt` is null when there is no copy time. */
  readonly catalogNotFresh: { readonly fetchedAt: string | null } | null;
  readonly catalogTransientlyUnavailable: boolean;
  /** Number of accounts the person already has, by connector key. Empty when that read failed. */
  readonly existingConnectionCounts: Readonly<Record<string, number>>;
  /** Ids of those accounts, by connector key. Empty when that read failed. */
  readonly existingConnectionIds: Readonly<Record<string, readonly string[]>>;
  readonly lifecycleFor: (entry: ConnectorCatalogEntry) => ConnectorInstallLifecycle | null;
}

/**
 * One read of the facts the add flow needs: the catalog, the package state of
 * each entry and the accounts the person already has. Shared by the list and
 * the connect page so both judge "can this be connected" from the same facts.
 */
export async function readAddSourceCatalog({ withAccounts = true }: { withAccounts?: boolean } = {}): Promise<AddSourceCatalogRead> {
  // `null` snapshot means a reference server that predates the install routes.
  const [manifests, templates, installSnapshot] = await Promise.all([
    listConnectorManifests(),
    listOwnerConnectorTemplates(),
    getConnectorInstallSnapshot(),
  ]);
  const connectorIcons = await buildConnectorIconMap(manifests, templates);
  const catalog = buildOwnerConnectorCatalog(manifests, templates, installSnapshot?.catalog ?? []).map((entry) => ({
    ...entry,
    icon: catalogEntryIcon(entry, connectorIcons),
  }));
  const lifecycleByConnector = installSnapshot
    ? buildConnectorInstallLifecycleByConnector(installSnapshot.catalog, installSnapshot.status)
    : null;
  const existing = withAccounts
    ? await readInstalledSourceCatalog(catalog.map((entry) => entry.connectorKey)).catch(() => null)
    : null;
  return {
    catalog,
    catalogNotFresh: installSnapshot?.catalogNotFresh ?? null,
    catalogTransientlyUnavailable: installSnapshot?.catalogUnavailableReason !== undefined,
    existingConnectionCounts: Object.fromEntries(
      Object.entries(existing?.byConnector ?? {}).map(([key, links]) => [key, links.length])
    ),
    existingConnectionIds: Object.fromEntries(
      Object.entries(existing?.byConnector ?? {}).map(([key, links]) => [key, links.map((link) => link.connectionId)])
    ),
    lifecycleFor: (entry) =>
      lifecycleByConnector === null
        ? null
        : (lifecycleByConnector[connectorLookupKey(entry.connectorKey)] ?? { catalog: null, installed: null }),
  };
}

/** The entry for one service, matching the way the install catalog spells keys. */
export function findCatalogEntry(
  read: Pick<AddSourceCatalogRead, "catalog">,
  connectorKey: string
): ConnectorCatalogEntry | null {
  const wanted = connectorLookupKey(connectorKey);
  return read.catalog.find((entry) => connectorLookupKey(entry.connectorKey) === wanted) ?? null;
}
