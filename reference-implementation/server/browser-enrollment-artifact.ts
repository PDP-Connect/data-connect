// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { normalizeConnectorManifestForStorage, retainedStorageContext } from "./auth.ts";
import type { BrowserEnrollmentArtifact, ConnectorManifestLike } from "./connection-setup-plan.ts";
import { canonicalActivationManifestRevision } from "./connector-install/activation-authority.ts";
import type { ConnectorInstallRecord, ConnectorInstallService } from "./connector-install/index.ts";
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
  type LocalConnectorSourceStore,
} from "./connector-install/local-source.ts";

function matchingManifest(
  candidate: Record<string, unknown>,
  registered: ConnectorManifestLike
): Record<string, unknown> | null {
  const { storedManifest } = normalizeConnectorManifestForStorage(candidate, retainedStorageContext(registered));
  return canonicalActivationManifestRevision(storedManifest) ===
    canonicalActivationManifestRevision(registered as Record<string, unknown>)
    ? storedManifest
    : null;
}

/** Resolve host-validated selected bytes; a registration is never executable evidence.
 * Local selection takes precedence, including invalid selection (no fallback).
 */
export function createBrowserEnrollmentArtifactResolver(
  service: Pick<ConnectorInstallService, "status" | "inspect">,
  localStore: LocalConnectorSourceStore = createFileLocalConnectorSourceStore()
): (key: string, registered: ConnectorManifestLike) => Promise<BrowserEnrollmentArtifact> {
  return async (key, registered) => {
    try {
      const local = await inspectActiveLocalConnectorSource(localStore, key);
      if (local.status === "invalid") {
        return { status: "invalid" };
      }
      if (local.status === "active") {
        const manifest = matchingManifest(local.record.manifest, registered);
        return manifest ? { manifest, status: "verified", trust: "developer-local-unsigned" } : { status: "invalid" };
      }
      // status() returns only artifacts whose recorded manifest, executable and
      // provenance bytes still verify. It does not return failed installations.
      let record: ConnectorInstallRecord | null | undefined;
      if (service.inspect) {
        const inspected = await service.inspect(key);
        if (inspected.status === "invalid") {
          return { status: "invalid" };
        }
        record = inspected.status === "active" ? inspected.record : null;
      } else {
        record = (await service.status()).find((entry) => entry.connectorId === key);
      }
      if (!record) {
        return { status: "none" };
      }
      const manifest = matchingManifest(record.manifest, registered);
      if (!manifest) {
        return { status: "invalid" };
      }
      return { manifest, status: "verified", trust: "signed-installed" };
    } catch {
      return { status: "invalid" };
    }
  };
}
