// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorReadiness } from "./connector-readiness-contract.ts";

/**
 * Owner-facing text for a readiness verdict that blocks setup, or null when the
 * verdict needs no explanation of its own: `connect` needs none, and `install`
 * is the package column's own Install action. The text is fixed per reason: the
 * server's `detail` is diagnostic and is never shown to the owner.
 */
export function readinessBlockNote(readiness: ConnectorReadiness | null | undefined): string | null {
  if (!readiness) {
    return null;
  }
  switch (readiness.reason) {
    case "artifact_invalid":
      return "The installed connector package failed verification. Reinstall it to repair it.";
    case "host_requirement_unmet":
      return "This server is not set up to run this connector yet.";
    case "inspection_unavailable":
      return "The installed connector could not be checked just now. Retry in a moment.";
    case "catalog_unavailable":
      return "The connector catalog could not be reached, so this connector's availability is unknown. Retry in a moment.";
    case "not_published":
      return "This connector is not published, and no local source or installed package provides it.";
    case "not_browser_bound":
    case "not_installed":
    case "runnable":
      return null;
  }
}
