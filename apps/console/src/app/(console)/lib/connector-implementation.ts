// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-facing reading of "this server has no implementation to run this
 * connector". Since catalog connectors run only from verified installs, a
 * connection whose connector was never installed cannot sync at all: the
 * reference refuses the run with `connector_not_installed`, and its summary
 * row reports `connector_implementation.state: "not_installed"` before any
 * run is attempted.
 *
 * Pure and JSX-free so the detail page, the Sources list, and the Sync button
 * render the same tested copy.
 */

import type { ForwardDispositionSummary } from "./connection-evidence.ts";
import type { RefConnectorImplementation } from "./ref-client.ts";

/** The reference error code for a run refused because nothing can run it. */
export const CONNECTOR_NOT_INSTALLED_CODE = "connector_not_installed";

/**
 * True only when the reference positively says the connector is not
 * installed. Absent evidence (older reference, local-device connection, a
 * failed lookup) never reads as "not installed".
 */
export function isConnectorNotInstalled(
  summary: { readonly connector_implementation?: RefConnectorImplementation | null } | null | undefined
): boolean {
  return summary?.connector_implementation?.state === "not_installed";
}

/**
 * The bare connector key the owner install route accepts. Prefers the key the
 * reference named; falls back to the connection's own connector id.
 */
export function connectorInstallKey(
  summary: { readonly connector_id: string; readonly connector_implementation?: RefConnectorImplementation | null },
): string {
  return summary.connector_implementation?.connector_id || summary.connector_id;
}

/** Lead sentence for a connection whose connector is not installed. */
export function connectorNotInstalledCopy(displayName: string): string {
  return `${displayName} isn't installed on this server yet, so it can't sync.`;
}

/** What installing does, said once beside the action. */
export function connectorInstallExplainer(displayName: string): string {
  return `Installing adds the latest signed ${displayName} connector from the catalog. It does not delete records you already collected.`;
}

export function connectorInstallActionLabel(displayName: string): string {
  return `Install ${displayName}`;
}

/** An install failure, said plainly with the server's reason. */
export function connectorInstallFailureCopy(displayName: string, reason: string): string {
  const trimmed = reason.trim();
  return trimmed
    ? `Couldn't install ${displayName}: ${trimmed.replace(/\.$/, "")}.`
    : `Couldn't install ${displayName}. Try again, or check the server logs.`;
}

/**
 * Replaces the reference's per-stream "Next run" disposition while the
 * connector is not installed. The reference computes its disposition from
 * coverage and freshness alone, so it can say "refresh due (needs you)" for a
 * connection no run can serve; the real blocker is the missing install.
 */
export const CONNECTOR_NOT_INSTALLED_DISPOSITION: ForwardDispositionSummary = {
  label: "blocked, connector not installed",
  // The install prompt on the page is the owner action; a "(needs you)" cue
  // beside every stream would repeat it and point at nothing actionable there.
  ownerActionNeeded: false,
  title:
    "No run can start until this connector is installed on this server. Install it from the notice at the top of the page. Records already collected stay valid.",
  tone: "warning",
  value: "connector_not_installed",
};

export function dispositionForInstallState(
  disposition: ForwardDispositionSummary | null,
  connectorNotInstalled: boolean
): ForwardDispositionSummary | null {
  return connectorNotInstalled ? CONNECTOR_NOT_INSTALLED_DISPOSITION : disposition;
}

export interface RunNowRejection {
  readonly code: string | null;
  readonly connectorId: string | null;
}

/**
 * Read the machine fields of a reference error envelope
 * (`{ error: { code, connector_id, message } }`). Anything else yields nulls,
 * so callers fall back to the message.
 */
export function parseRunNowRejection(body: unknown): RunNowRejection {
  const error =
    body && typeof body === "object" && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { code: null, connectorId: null };
  }
  const { code, connector_id: connectorId } = error as { code?: unknown; connector_id?: unknown };
  return {
    code: typeof code === "string" && code ? code : null,
    connectorId: typeof connectorId === "string" && connectorId ? connectorId : null,
  };
}

/**
 * The same machine fields, read off an error thrown by the run-start client
 * (`RunNowRejectedError` in `operator-runs.ts`). Duck-typed so a caller need
 * not import the server-only client to branch on the code.
 */
export function runNowRejectionFromError(err: unknown): RunNowRejection {
  if (!err || typeof err !== "object") {
    return { code: null, connectorId: null };
  }
  const { code, connectorId } = err as { code?: unknown; connectorId?: unknown };
  return {
    code: typeof code === "string" && code ? code : null,
    connectorId: typeof connectorId === "string" && connectorId ? connectorId : null,
  };
}
