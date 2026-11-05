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
 * Pure mapping from the server's verdict. A missing verdict permits no new
 * account, except from a server that predates the readiness endpoint (an older
 * server next to a newer console): that server applies its own rule when the
 * enrollment route is called, so the console defers to it instead of blocking
 * every browser connector.
 */
export function browserConnectSupportFromReadiness(
  connectorId: string,
  readiness: ConnectorReadiness | null,
  serverPredatesReadiness = false
): BrowserConnectSupport {
  return {
    // A connector the bundled manifest marks browser-bound keeps the routes for
    // repair of an existing connection, even when the verdict is unavailable.
    browserBound: readiness?.browserBound === true || isBrowserBoundConnector(connectorId),
    canAddAccount: readiness ? readiness.action === "connect" : serverPredatesReadiness,
  };
}
