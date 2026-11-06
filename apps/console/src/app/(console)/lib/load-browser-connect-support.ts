// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isBrowserBoundConnector } from "pdpp-reference-implementation/connection-setup-plan";
import { type BindingSource, type BrowserConnectSupport, browserConnectSupport } from "./browser-connect-support.ts";
import { listOwnerConnectorTemplates } from "./rs-client.ts";

/**
 * Browser-session support for the routes under `/connect/browser-session`.
 * Binding sources are installed packages and local manifests. A connector whose
 * bundled manifest is browser-bound keeps the routes for repair of an existing
 * connection, even when no package or manifest is readable.
 */
export async function loadBrowserConnectSupport(connectorId: string): Promise<BrowserConnectSupport> {
  const templates = await listOwnerConnectorTemplates().catch(() => []);
  const sources: BindingSource[] = templates.map((template) => {
    let bindings: BindingSource["bindings"] = null;
    if (template.browser_enrollment_artifact?.status === "verified") {
      bindings = template.browser_enrollment_artifact.manifest.runtime_requirements?.bindings;
    } else if (template.connector_modality === "browser_bound") {
      bindings = { browser: {} };
    }
    return {
      bindings,
      browser_enrollment_artifact: template.browser_enrollment_artifact ?? { status: "none" },
      connector_id: template.connector_id ?? "",
      connector_key: template.connector_key,
    };
  });
  const support = browserConnectSupport(connectorId, sources);
  return { ...support, browserBound: support.browserBound || isBrowserBoundConnector(connectorId) };
}
