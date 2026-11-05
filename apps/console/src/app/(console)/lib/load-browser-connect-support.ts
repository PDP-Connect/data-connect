// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type BrowserConnectSupport, browserConnectSupportFromReadiness } from "./browser-connect-readiness.ts";
import { getConnectorReadiness } from "./connector-install-client.ts";
import { ResourceServerHttpError } from "./owner-token.ts";

/**
 * Browser-session support for the routes under `/connect/browser-session`.
 * Whether an account can be added is the server's verdict
 * (`/v1/owner/connector-install/readiness`), the same one the enrollment route
 * enforces. The console computes nothing from bindings, tiers or key lists. If
 * the verdict cannot be fetched, no new account can be added. A 404 means the
 * server predates the endpoint; that server enforces on its own.
 */
export async function loadBrowserConnectSupport(connectorId: string): Promise<BrowserConnectSupport> {
  let serverPredatesReadiness = false;
  const readiness = await getConnectorReadiness(connectorId).catch((error: unknown) => {
    serverPredatesReadiness = error instanceof ResourceServerHttpError && error.status === 404;
    return null;
  });
  return browserConnectSupportFromReadiness(connectorId, readiness, serverPredatesReadiness);
}
