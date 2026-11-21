// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the connector configuration a run is allowed to collect against.
 *
 * This is the READ half of the propose/confirm spine in
 * `server/stores/connector-instance-config-store.ts`. Without it that store is
 * decoration: revisions accumulate, provenance is recorded, and no run ever
 * consults any of it.
 *
 * The invariant this module exists to hold:
 *
 *   A run resolves configuration ONLY from a revision the store reports as
 *   `active`. A `proposed` (unconfirmed) revision MUST NOT reach a run.
 *
 * That is not re-derived here. `getActiveRevision` already returns `null`
 * unless the current pointer names a revision whose status is literally
 * `active` (see the store's `getActiveRevision`: it reads the pointer, loads
 * that revision, and returns null for any other status). This module's job is
 * to be the single place that calls it on the run path and to fail CLOSED --
 * because the failure mode being defended against is not "config is missing"
 * but "an unconfirmed collection boundary silently widened what a run
 * collected."
 *
 * Fail-closed: invalid or unavailable authority rejects the resolver. Only a
 * successful lookup with no active revision selects manifest defaults. Neither
 * a lookup failure nor an invalid active configuration proves absence.
 *
 * Delivery: the resolved config becomes `START.connector_options`, the field
 * `packages/polyfill-connectors/src/connector-options.ts` has always read
 * first and no producer has ever written. Populating it lights up every
 * `readOptions` caller without touching a connector.
 *
 * Why not ride in on `START.state`, next to `$collection_scope`: `state` is
 * the durable CURSOR map. Connectors write it back via STATE messages and the
 * runtime commits it on success (`persistState`), so a config value parked
 * there could be echoed back into the connection's state row and outlive the
 * revision that authorized it. `connector_options` is read-only input by
 * construction -- there is no protocol message a connector can use to write it.
 */

import type { ConfigRevision, ConnectorInstanceConfigStore } from "./stores/connector-instance-config-store.ts";
import { getDefaultConnectorInstanceConfigStore } from "./stores/connector-instance-config-store.ts";

export interface ResolveRunConnectorOptionsInput {
  readonly connectorInstanceId: string | null | undefined;
  /**
   * Reported when a revision is applied, absent, or refused, or when a read
   * fails, so an operator can see WHY a run was blocked or collected against
   * defaults instead of guessing. Never receives config values -- only the
   * decision and its reason. Reporting is best effort: a callback that throws
   * cannot change the resolution or replace a typed refusal.
   */
  readonly onDecision?: (decision: RunConfigDecision) => void;
  /** Store seam; defaults to the backend-bound process store. */
  readonly store?: Pick<ConnectorInstanceConfigStore, "getActiveRevision">;
}

export interface RunConfigDecision {
  readonly connectorInstanceId: string;
  /** Present only when a revision was applied. */
  readonly optionKind?: ConfigRevision["optionKind"];
  readonly reason: "active_revision_applied" | "invalid_active_config" | "no_active_revision" | "store_unreadable";
  /** Present only when a revision was applied. */
  readonly revision?: number;
}

export type RunConfigBlockedReason = "missing_instance_identity" | "store_unreadable" | "invalid_active_config";

export class RunConfigBlockedError extends Error {
  readonly code = "connector_run_config_blocked";

  readonly reason: RunConfigBlockedReason;

  constructor(reason: RunConfigBlockedReason) {
    super("Connector run configuration could not be confirmed.");
    this.name = "RunConfigBlockedError";
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Reporting must not decide the outcome: a throwing callback would otherwise
// replace the typed refusal (or turn a lookup result into an unrelated error).
function report(onDecision: ResolveRunConnectorOptionsInput["onDecision"], decision: RunConfigDecision): void {
  try {
    onDecision?.(decision);
  } catch {
    // Best effort only; the resolution below is already decided.
  }
}

/**
 * The connector options for this run, or `null` when there is no owner-active
 * configuration to apply.
 *
 * `null` and `{}` are deliberately different: `null` means "no revision is
 * active, use manifest defaults", while an empty active revision means "the
 * owner confirmed an empty config." Collapsing them would make a confirmed
 * empty allowlist indistinguishable from never having configured anything.
 *
 * Rejects with `RunConfigBlockedError` -- never `null` -- when the lookup
 * fails, the active config is malformed, or the instance identity is missing.
 * The refusal does not depend on `onDecision`.
 */
export async function resolveRunConnectorOptions(
  input: ResolveRunConnectorOptionsInput
): Promise<Record<string, unknown> | null> {
  const { connectorInstanceId, onDecision } = input;
  if (typeof connectorInstanceId !== "string" || connectorInstanceId.trim().length === 0) {
    throw new RunConfigBlockedError("missing_instance_identity");
  }
  let active: ConfigRevision | null;
  try {
    const store = input.store ?? getDefaultConnectorInstanceConfigStore();
    active = await store.getActiveRevision(connectorInstanceId);
  } catch {
    report(onDecision, { connectorInstanceId, reason: "store_unreadable" });
    throw new RunConfigBlockedError("store_unreadable");
  }
  if (active === null) {
    // Covers both "never configured" and "the only revision is still
    // proposed" -- getActiveRevision returns null for any non-active status.
    report(onDecision, { connectorInstanceId, reason: "no_active_revision" });
    return null;
  }
  if (!isPlainObject(active.config)) {
    // A revision whose persisted config is not an object cannot be handed to
    // readOptions. Refuse it rather than coercing it into something shaped.
    report(onDecision, { connectorInstanceId, reason: "invalid_active_config" });
    throw new RunConfigBlockedError("invalid_active_config");
  }
  report(onDecision, {
    connectorInstanceId,
    optionKind: active.optionKind,
    reason: "active_revision_applied",
    revision: active.revision,
  });
  return active.config;
}
