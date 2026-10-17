// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { normalizeConnectorManifestForStorage, registerConnector } from "../auth.ts";
import { runRecordDerivedRepairRound } from "../record-derived-repair.ts";
import { reconcileConnectorSearchIndexScopes } from "../search-index-reconcile.ts";

/**
 * Manifest registration for the OCI installer, split at the lock boundary.
 *
 * `registerManifest` runs inside the install file lock and the connector
 * lifecycle transaction. It persists the manifest and, in the same
 * transaction, queues the derived repair: record-column re-derivation per
 * (connection, stream) and dirty search-index scopes. Nothing in it grows
 * with the record count.
 *
 * `repairManifestDerivedState` runs after both locks are released. It works
 * through that queue in bounded chunks. When the process stops midway, the
 * queue keeps the rest and the maintenance sweep resumes it.
 */
export const installedConnectorManifestRegistration = {
  registerManifest: (manifest: Record<string, unknown>): Promise<string> =>
    registerConnector(manifest, { queueDerivedRepair: true, skipDerivedRepair: true }),
  repairManifestDerivedState: async (manifest: Record<string, unknown>): Promise<string> => {
    const { connectorId } = normalizeConnectorManifestForStorage(manifest);
    const columns = await runRecordDerivedRepairRound({ connectorId });
    await reconcileConnectorSearchIndexScopes(connectorId);
    if (columns.failed > 0) {
      throw new Error(
        `Record column repair failed for ${String(columns.failed)} stream(s) of ${connectorId}; they stay queued and the maintenance sweep retries them.`
      );
    }
    return connectorId;
  },
};
