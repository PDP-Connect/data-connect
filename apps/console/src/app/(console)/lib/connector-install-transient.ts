// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface ResourceServerHttpErrorLike {
  readonly body?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
}

export function isTransientConnectorInstallCatalogError(err: unknown): boolean {
  const candidate = err as ResourceServerHttpErrorLike;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    candidate.path !== "/v1/owner/connector-install/catalog" ||
    candidate.status !== 500 ||
    typeof candidate.body !== "string"
  ) {
    return false;
  }
  return (
    candidate.body.includes("Another connector installation is in progress") ||
    candidate.body.includes("Another connector catalog refresh is in progress")
  );
}

const INSTALL_ROUTE_PREFIX = "/v1/owner/connector-install/";
/** Not found, method not allowed, not implemented: what a server without the route family answers. */
const ROUTE_UNAVAILABLE_STATUSES = new Set([404, 405, 501]);

/**
 * True when an install route answered the way a server that predates the
 * route family does, so the page can render without package facts instead of
 * failing. Auth failures and server errors are not "unavailable".
 */
export function isConnectorInstallRouteUnavailableError(err: unknown): boolean {
  const candidate = err as ResourceServerHttpErrorLike;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.path === "string" &&
    candidate.path.startsWith(INSTALL_ROUTE_PREFIX) &&
    typeof candidate.status === "number" &&
    ROUTE_UNAVAILABLE_STATUSES.has(candidate.status)
  );
}
