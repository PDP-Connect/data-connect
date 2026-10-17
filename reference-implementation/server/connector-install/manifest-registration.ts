// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerConnector } from "../auth.ts";
import { reconcileConnectorSearchIndexScopes } from "../search-index-reconcile.ts";

/**
 * Manifest registration for the OCI installer, split at the lock boundary.
 *
 * `registerManifest` runs inside the install file lock and the connector
 * lifecycle transaction. It persists the manifest and, in the same
 * transaction, marks the connector's search-index scopes dirty. Nothing in it
 * grows with the record count.
 *
 * `repairManifestDerivedState` runs after both locks are released. It
 * re-derives the record columns in bounded chunks, then reconciles the dirty
 * scopes in bounded chunks. When the process stops midway, the scopes stay
 * dirty and the maintenance sweep resumes them; committed chunks are kept.
 */
export const installedConnectorManifestRegistration = {
  registerManifest: (manifest: Record<string, unknown>): Promise<string> =>
    registerConnector(manifest, { markRetrievalScopesDirty: true, skipDerivedRepair: true }),
  repairManifestDerivedState: async (manifest: Record<string, unknown>): Promise<string> => {
    const connectorId = await registerConnector(manifest, {
      skipManifestPersistence: true,
      skipRetrievalBackfill: true,
    });
    await reconcileConnectorSearchIndexScopes(connectorId);
    return connectorId;
  },
};
