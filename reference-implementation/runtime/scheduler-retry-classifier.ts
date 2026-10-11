// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorError, TerminalGrantFailureReason, TerminalReason } from "./scheduler-domain-types.ts";

export type {
  TerminalNonGrantReason,
  TerminalReason,
} from "./scheduler-domain-types.ts";

// ─── Retry classifier ────────────────────────────────────────────────────────

interface RunConnectorError {
  readonly checkpoint_summary?: Record<string, unknown> | null;
  readonly connector_error?: ConnectorError | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly message?: string;
  readonly records_emitted?: number;
  readonly reported_records_emitted?: number | null;
  readonly response_status?: number;
  readonly run_id?: string | null;
  readonly runtime_retryable?: boolean | null;
  readonly terminal_reason?: TerminalReason | null;
  readonly trace_id?: string | null;
}

function isRetryableHttpStatus(status: unknown): boolean {
  if (!Number.isInteger(status)) {
    return true;
  }
  const code = status as number;
  if (code >= 400 && code < 500 && code !== 429) {
    return false;
  }
  return true;
}

function hasRetryableRunFailureKnownGap(gaps: readonly Record<string, unknown>[] | null | undefined): boolean {
  for (const gap of gaps ?? []) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    if (gap.kind !== "run_failed") {
      continue;
    }
    const recoveryHint = gap.recovery_hint;
    if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
      continue;
    }
    if (
      (recoveryHint as { action?: unknown }).action === "retry_by_runtime" &&
      (recoveryHint as { retryable?: unknown }).retryable === true
    ) {
      return true;
    }
  }
  return false;
}

const NON_RETRYABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "authentication_error",
  "connector_protocol_violation",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "permission_error",
  "run_timed_out",
]);

const NON_RETRYABLE_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set<TerminalReason>([
  "authentication_error",
  "connector_reported_cancelled",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "owner_cancel_forced",
  "owner_cancelled",
  "permission_error",
]);

function hasRetryableRunFailureContext(err: RunConnectorError | null | undefined): err is RunConnectorError {
  return Boolean(err) && !runRequiresOwnerAuthRepair(err);
}

function runRequiresOwnerAuthRepair(err: RunConnectorError | null | undefined): boolean {
  // The runtime alone creates this gap after a cancelled or timed-out
  // interaction response (index.ts::recordInteractionRecoveryGap).
  // It proves unfinished owner input, not a rejected provider credential.
  // Connector text and recovery hints never establish either fact.
  return (err?.known_gaps ?? []).some(
    (gap) =>
      gap?.kind === "interaction_required" &&
      (gap.reason === "interaction_cancelled" || gap.reason === "interaction_timeout")
  );
}

function shouldRetryRunFailure(err: RunConnectorError | null | undefined): boolean {
  if (!err) {
    return false;
  }
  if (!isRetryableHttpStatus(err.response_status)) {
    return false;
  }
  if (err.failure_reason && NON_RETRYABLE_FAILURE_REASONS.has(err.failure_reason)) {
    return false;
  }
  if (err.terminal_reason && NON_RETRYABLE_TERMINAL_REASONS.has(err.terminal_reason)) {
    return false;
  }
  // A connector-declared non-retryable error remains authoritative even if a
  // future adapter accidentally also supplies a runtime transport hint.
  if (err.connector_error?.retryable === false) {
    return false;
  }
  if (!hasRetryableRunFailureContext(err)) {
    return false;
  }
  // A connector's affirmative verdict is only safe after the owner-auth gate
  // above: an unsettled runtime interaction must not restart the same run.
  if (err.connector_error?.retryable === true) {
    return true;
  }
  // This is a runtime-derived verdict from a safe, structured Node/undici
  // cause code. It is more precise than the message/gap heuristics below and
  // is set only when a connector DID NOT report its own terminal error.
  if (typeof err.runtime_retryable === "boolean") {
    return err.runtime_retryable;
  }
  if (hasRetryableRunFailureKnownGap(err.known_gaps)) {
    return true;
  }
  return true;
}

const TERMINAL_GRANT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
]);

function isTerminalGrantFailure(reason: string | null | undefined): reason is TerminalGrantFailureReason {
  return reason !== null && reason !== undefined && TERMINAL_GRANT_FAILURE_REASONS.has(reason);
}

export type { RunConnectorError };
export {
  hasRetryableRunFailureKnownGap,
  isRetryableHttpStatus,
  isTerminalGrantFailure,
  NON_RETRYABLE_FAILURE_REASONS,
  NON_RETRYABLE_TERMINAL_REASONS,
  runRequiresOwnerAuthRepair,
  shouldRetryRunFailure,
  TERMINAL_GRANT_FAILURE_REASONS,
};
