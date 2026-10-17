// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerConnector } from "../auth.ts"

/**
 * Manifest registration for the OCI installer, split at the lock boundary.
 *
 * `registerManifest` runs inside the install file lock and the connector
 * lifecycle transaction, so it persists the manifest only. The derived repair
 * walks every record the connector already has, one transaction per record on
 * Postgres, so the installer runs it after both locks are released.
 */
export const installedConnectorManifestRegistration = {
  registerManifest: (manifest: Record<string, unknown>): Promise<string> =>
    registerConnector(manifest, { skipDerivedRepair: true }),
  repairManifestDerivedState: (manifest: Record<string, unknown>): Promise<string> =>
    registerConnector(manifest, { skipManifestPersistence: true }),
}
