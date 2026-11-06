// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isBrowserBoundConnector } from "pdpp-reference-implementation/connection-setup-plan";
import type { ConnectorReadiness } from "./connector-readiness-contract.ts";

export interface BrowserConnectSupport {
  /** The connector uses the browser-session flow. A bound connector keeps the routes for repair. */
  readonly browserBound: boolean;
  /** The server says the owner can add an account now. */
  readonly canAddAccount: boolean;
}

/**
 * Pure mapping from the server's verdict. The verdict decides both fields.
 *
 * Stopgap for mixed versions only: a server that predates the readiness
 * endpoint (an older server next to a newer console) returns no verdict. That
 * server applies its own rule when the enrollment route is called, so the
 * console defers to it, and uses the bundled manifest to keep the routes
 * reachable (and the add action open) only for connectors it marks
 * browser-bound. Remove this branch, and the `isBrowserBoundConnector` import,
 * once no supported server predates the endpoint.
 */
export function browserConnectSupportFromReadiness(
  connectorId: string,
  readiness: ConnectorReadiness | null,
  serverPredatesReadiness = false
): BrowserConnectSupport {
  const deferToOlderServer = serverPredatesReadiness && isBrowserBoundConnector(connectorId);
  return {
    browserBound: readiness ? readiness.browserBound : deferToOlderServer,
    canAddAccount: readiness ? readiness.action === "connect" : deferToOlderServer,
  };
}
