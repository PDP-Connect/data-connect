// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existingSourcesByConnectorCatalog } from "../components/existing-sources-by-connector.ts";
import { getConnectorInstallSnapshot } from "../lib/connector-install-client.ts";

/** These reads also power the Add page's install and existing-source view. */
export { existingSourcesByConnectorCatalog, getConnectorInstallSnapshot };

/**
 * How long the optional updates read may wait for the package catalog. The
 * catalog comes from a remote registry; offline or with a slow registry it can
 * take tens of seconds, and the page stream stays open until this read ends.
 */
export const UPDATES_READ_DEADLINE_MS = 3000;

export function withinDeadline<T>(read: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The package catalog did not answer within ${deadlineMs} ms.`)),
      deadlineMs
    );
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

/** Keep package state and the full kind-to-data-source map in one isolated read. */
export async function readConnectorUpdates({ deadlineMs = UPDATES_READ_DEADLINE_MS }: { deadlineMs?: number } = {}) {
  const snapshot = await withinDeadline(getConnectorInstallSnapshot(), deadlineMs);
  const connectorIds = snapshot
    ? [
        ...new Set(
          [
            ...snapshot.catalog.flatMap((entry) => [
              entry.connector_id,
              entry.connector_key,
              entry.catalog_connector_id,
            ]),
            ...snapshot.status.map((entry) => entry.connector_id),
          ].filter((value): value is string => Boolean(value))
        ),
      ]
    : [];
  const existingSources = await existingSourcesByConnectorCatalog(connectorIds);
  return { existingSources, snapshot };
}
