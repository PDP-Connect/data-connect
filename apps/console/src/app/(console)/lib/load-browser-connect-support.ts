// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { canonicalConnectorKey, isBrowserBoundConnector } from "pdpp-reference-implementation/connection-setup-plan";
import { type BindingSource, type BrowserConnectSupport, browserConnectSupport } from "./browser-connect-support.ts";
import { listConnectorInstallCatalog, listConnectorInstallStatus } from "./connector-install-client.ts";
import { listConnectorManifests } from "./rs-client.ts";

/**
 * Browser-session support for the routes under `/connect/browser-session`.
 * Binding sources are installed packages and local manifests. A connector whose
 * bundled manifest is browser-bound keeps the routes for repair of an existing
 * connection, even when no package or manifest is readable.
 */
export async function loadBrowserConnectSupport(connectorId: string): Promise<BrowserConnectSupport> {
  const [installed, manifests, catalog] = await Promise.all([
    listConnectorInstallStatus().catch(() => []),
    listConnectorManifests().catch(() => []),
    // A catalog read failure is "not published", never "available": the
    // server already serves its last verified copy before a read fails.
    listConnectorInstallCatalog().catch(() => []),
  ]);
  const key = canonicalConnectorKey(connectorId);
  const catalogPublished = catalog.some((entry) => canonicalConnectorKey(entry.connector_key) === key);
  // A catalog entry also carries the runtime bindings a connector installed
  // later will have, so it is a binding source in its own right.
  const catalogSources: BindingSource[] = catalog.map((entry) => ({
    bindings: entry.bindings,
    connector_id: entry.connector_id,
    connector_key: entry.connector_key,
  }));
  const sources: BindingSource[] = [
    ...catalogSources,
    ...installed.map((entry) => ({ bindings: entry.bindings, connector_id: entry.connector_id })),
    ...manifests.map((manifest) => ({
      bindings: manifest.runtime_requirements?.bindings,
      connector_id: manifest.connector_id,
      connector_key: manifest.connector_key,
    })),
  ];
  const support = browserConnectSupport(connectorId, sources, catalogPublished);
  return { ...support, browserBound: support.browserBound || isBrowserBoundConnector(connectorId) };
}
