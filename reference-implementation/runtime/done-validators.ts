// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DONE-message validators for the connector runtime.
//
// When a connector emits its terminal DONE envelope, the runtime cross-checks
// it against observed reality: the child's exit code must agree with the
// declared status, the reported records_emitted must match what the runtime
// counted, the status must be a known terminal value, and any error block must
// be well-shaped. Each validator returns an Error to raise (or, for
// validateDoneError, the normalized error object) or null when the field is
// acceptable.
//
// Extracted from runtime/index.js: pure shape/consistency checks with no
// runtime state, secret handling, or grant/scope enforcement.

import { CONNECTOR_ERROR_CODE_RE, isValidRecoveryHintShape } from "./connector-gap-bounding.ts";

type DoneStatus = "succeeded" | "failed";

interface DoneErrorInput {
  code?: string | null;
  message?: string;
  recovery_hint?: unknown;
  retryable?: boolean | null;
  [key: string]: unknown;
}

interface DoneError {
  basis?: string[];
  code?: string;
  message: string;
  recovery_hint?: string | { action: string; retryable?: boolean };
  retryable: boolean;
}

interface DoneMessage {
  error?: DoneErrorInput;
  records_emitted?: number;
  status: DoneStatus;
  [key: string]: unknown;
}

export function validateDoneExitCode(doneMessage: DoneMessage | null | undefined, exitCode: number): Error | null {
  if (!doneMessage) {
    return null;
  }
  if (doneMessage.status === "succeeded" && exitCode !== 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: succeeded`);
  }
  if (doneMessage.status === "failed" && exitCode === 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: ${doneMessage.status}`);
  }
  return null;
}

export function validateDoneRecordsEmitted(
  doneMessage: DoneMessage | null | undefined,
  observedRecordsEmitted: number
): Error | null {
  if (!doneMessage) {
    return null;
  }
  if (!Number.isInteger(doneMessage.records_emitted) || (doneMessage.records_emitted ?? -1) < 0) {
    return new Error(`Connector emitted invalid DONE.records_emitted: ${doneMessage.records_emitted}`);
  }
  if (doneMessage.records_emitted !== observedRecordsEmitted) {
    return new Error(
      `Connector reported records_emitted ${doneMessage.records_emitted} but runtime observed ${observedRecordsEmitted}`
    );
  }
  return null;
}

export function validateDoneStatus(status: unknown): Error | null {
  if (status === "succeeded" || status === "failed") {
    return null;
  }
  return new Error(`Connector emitted invalid DONE status: ${status}`);
}

function validateDoneBasis(
  basis: unknown,
  observations: { declared: boolean; ids: ReadonlySet<string> }
): Error | null {
  if (basis === undefined) {
    return null;
  }
  if (!observations.declared) {
    return new Error("Connector emitted invalid DONE.error.basis: OBSERVATION capability is not declared");
  }
  if (!Array.isArray(basis) || basis.some((id) => typeof id !== "string" || !observations.ids.has(id))) {
    return new Error("Connector emitted invalid DONE.error.basis: expected OBSERVATION ids emitted in this run");
  }
  return null;
}

export function validateDoneError(
  status: DoneStatus | unknown,
  error: DoneErrorInput | null | undefined,
  observations: { declared: boolean; ids: ReadonlySet<string> } = { declared: false, ids: new Set() }
): DoneError | Error | null {
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (error == null) {
    return status === "failed"
      ? new Error("Connector emitted invalid DONE.error: failed runs require error details")
      : null;
  }
  if (status === "succeeded") {
    return new Error("Connector emitted invalid DONE.error: succeeded runs must not include terminal error details");
  }
  if (typeof error !== "object" || Array.isArray(error)) {
    return new Error("Connector emitted invalid DONE.error: expected object");
  }
  if (error.code !== undefined && (typeof error.code !== "string" || !CONNECTOR_ERROR_CODE_RE.test(error.code))) {
    return new Error("Connector emitted invalid DONE.error.code: expected snake_case code");
  }
  if (typeof error.message !== "string" || !error.message.trim()) {
    return new Error("Connector emitted invalid DONE.error.message: expected non-empty string");
  }
  if (typeof error.retryable !== "boolean") {
    return new Error("Connector emitted invalid DONE.error.retryable: expected boolean");
  }
  if (!isValidRecoveryHintShape(error.recovery_hint)) {
    return new Error("Connector emitted invalid DONE.error.recovery_hint");
  }
  const invalidBasis = validateDoneBasis(error.basis, observations);
  if (invalidBasis) {
    return invalidBasis;
  }
  const hint = error.recovery_hint as DoneError["recovery_hint"];
  const recoveryHint =
    typeof hint === "object"
      ? { action: hint.action, ...(hint.retryable === undefined ? {} : { retryable: hint.retryable }) }
      : hint;
  return {
    ...(error.code ? { code: error.code } : {}),
    message: error.message.trim(),
    ...(recoveryHint === undefined ? {} : { recovery_hint: recoveryHint }),
    retryable: error.retryable,
    ...(error.basis === undefined ? {} : { basis: error.basis as string[] }),
  };
}
