// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type BindingSource, type BrowserConnectSupport, browserConnectSupport } from "./browser-connect-support.ts";
import { listConnectorInstallStatus } from "./connector-install-client.ts";
import { listConnectorManifests } from "./rs-client.ts";

/**
 * Browser-session support for the routes under `/connect/browser-session`.
 * Binding sources are installed packages and local manifests; both carry the
 * connector's own `runtime_requirements.bindings`.
 */
export async function loadBrowserConnectSupport(connectorId: string): Promise<BrowserConnectSupport> {
  const [installed, manifests] = await Promise.all([
    listConnectorInstallStatus().catch(() => []),
    listConnectorManifests().catch(() => []),
  ]);
  const sources: BindingSource[] = [
    ...installed.map((entry) => ({ bindings: entry.bindings, connector_id: entry.connector_id })),
    ...manifests.map((manifest) => ({
      bindings: manifest.runtime_requirements?.bindings,
      connector_id: manifest.connector_id,
      connector_key: manifest.connector_key,
    })),
  ];
  return browserConnectSupport(connectorId, sources);
}
