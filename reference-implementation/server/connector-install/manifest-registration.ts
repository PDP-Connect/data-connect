// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerConnector } from "../auth.ts";
import { canonicalConnectorKeyFromManifest } from "../connector-key.ts";
import { pinnedLocalCollectorManifest } from "../local-collector-profiles.ts";
import { runRecordDerivedRepairRound } from "../record-derived-repair.ts";
import { reconcileConnectorSearchIndexScopes } from "../search-index-reconcile.ts";
import type { InstalledManifestProvenance } from "./index.ts";

/**
 * Manifest registration for the OCI installer, split at the lock boundary.
 *
 * A connector the local collector runs on the owner's device keeps its pinned
 * profile: the device executes that release, so a catalog install of the same
 * key must not replace the manifest the server validates its uploads against.
 * Both functions below act on the pinned profile for such a connector.
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
function effectiveManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const connectorId = manifest.connector_id;
  return (typeof connectorId === "string" ? pinnedLocalCollectorManifest(connectorId) : null) ?? manifest;
}

export const installedConnectorManifestRegistration = {
  registerManifest: (manifest: Record<string, unknown>, provenance?: InstalledManifestProvenance): Promise<string> => {
    const effective = effectiveManifest(manifest);
    return registerConnector(effective, {
      queueDerivedRepair: true,
      replaceAcceptedDigest: true,
      skipDerivedRepair: true,
      verifiedSourceDeclaration: effective === manifest && provenance?.sourceDeclarationVerified === true,
    });
  },
  repairManifestDerivedState: async (manifest: Record<string, unknown>): Promise<string> => {
    const effective = effectiveManifest(manifest);
    const connectorId = canonicalConnectorKeyFromManifest(effective) ?? effective.connector_id;
    if (typeof connectorId !== "string") throw new Error("Connector manifest has no key for derived repair");
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
