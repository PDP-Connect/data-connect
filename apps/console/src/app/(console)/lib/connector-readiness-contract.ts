// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire type and boundary parsing for the server's browser-setup readiness
 * verdict (`GET /v1/owner/connector-install/readiness`, and the
 * `connector_readiness` field on an owner connector template).
 *
 * The server computes the verdict from the selected artifact, the host and the
 * catalog. The console only reads it: it never derives readiness from a
 * connector key, a roster or a tier, and it never re-derives it from bindings.
 */

export const READINESS_ACTIONS = ["connect", "install", "repair", "configure", "retry", "unavailable"] as const;
export type ConnectorReadinessAction = (typeof READINESS_ACTIONS)[number];

export const READINESS_REASONS = [
  "runnable",
  "not_installed",
  "not_published",
  "catalog_unavailable",
  "artifact_invalid",
  "inspection_unavailable",
  "not_browser_bound",
  "not_implemented",
  "host_requirement_unmet",
] as const;
export type ConnectorReadinessReason = (typeof READINESS_REASONS)[number];

export interface ConnectorReadiness {
  readonly action: ConnectorReadinessAction;
  readonly browserBound: boolean;
  readonly connectorKey: string;
  /** Owner-readable cause for repair, configure and retry. Null otherwise. */
  readonly detail: string | null;
  readonly reason: ConnectorReadinessReason;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * One readiness record, or null when the value is not a well-formed verdict.
 * A malformed verdict must read as "no verdict" so that no action is offered
 * on a guess.
 */
export function parseConnectorReadiness(value: unknown): ConnectorReadiness | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !(
      isOneOf(READINESS_ACTIONS, record.action) &&
      isOneOf(READINESS_REASONS, record.reason) &&
      typeof record.browser_bound === "boolean" &&
      typeof record.connector_key === "string" &&
      record.connector_key !== ""
    )
  ) {
    return null;
  }
  return {
    action: record.action,
    browserBound: record.browser_bound,
    connectorKey: record.connector_key,
    detail: typeof record.detail === "string" && record.detail.trim() !== "" ? record.detail.trim() : null,
    reason: record.reason,
  };
}

export function parseConnectorReadinessResponse(payload: unknown): readonly ConnectorReadiness[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (record.object !== "connector_browser_enrollment_readiness" || !Array.isArray(record.data)) {
    return [];
  }
  return record.data.flatMap((item) => {
    const readiness = parseConnectorReadiness(item);
    return readiness ? [readiness] : [];
  });
}
