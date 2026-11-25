// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existingSourcesByConnectorCatalog } from "../components/existing-sources-by-connector.ts";
import { getConnectorInstallSnapshot } from "../lib/connector-install-client.ts";

/** These reads also power the Add page's install and existing-source view. */
export { existingSourcesByConnectorCatalog, getConnectorInstallSnapshot };

/** Keep package state and the full kind-to-data-source map in one isolated read. */
export async function readConnectorUpdates() {
  const snapshot = await getConnectorInstallSnapshot();
  const connectorIds = snapshot
    ? [...new Set([
        ...snapshot.catalog.flatMap((entry) => [entry.connector_id, entry.connector_key, entry.catalog_connector_id]),
        ...snapshot.status.map((entry) => entry.connector_id),
      ].filter((value): value is string => Boolean(value)))]
    : [];
  const existingSources = await existingSourcesByConnectorCatalog(connectorIds);
  return { existingSources, snapshot };
}
