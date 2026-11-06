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

import { isValidRecoveryHintShape } from "./connector-gap-bounding.ts";
import { isObservationIdSyntax } from "./observations.ts";

type DoneStatus = "succeeded" | "failed" | "cancelled";

interface DoneErrorInput {
  code?: string | null;
  message?: string;
  recovery_hint?: unknown;
  retryable?: boolean | null;
  basis?: unknown;
  [key: string]: unknown;
}

export interface DoneError {
  code?: string;
  message: string;
  recovery_hint?: string | { action: string; retryable?: boolean };
  retryable: boolean | null;
  basis?: readonly string[];
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
  if ((doneMessage.status === "failed" || doneMessage.status === "cancelled") && exitCode === 0) {
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

export function validateDoneStatus(status: unknown, portable = false): Error | null {
  if (status === "succeeded" || status === "failed" || (!portable && status === "cancelled")) {
    return null;
  }
  return new Error(`Connector emitted invalid DONE status: ${status}`);
}

const DONE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What the run's protocol state lets a DONE error say. `strict` is the
 * Collection Profile 0.2.0 shape: a failed DONE carries an error and a boolean
 * `retryable`. The legacy default keeps the 0.1 shape.
 */
export interface DoneErrorContract {
  readonly strict: boolean;
  readonly observationDeclared: boolean;
  /** True when the connector emitted this OBSERVATION id earlier in the run. */
  readonly hasEmittedId: (id: string) => boolean;
}

const LEGACY_DONE_ERROR_CONTRACT: DoneErrorContract = {
  strict: false,
  observationDeclared: false,
  hasEmittedId: () => false,
};

export function validateDoneError(
  status: DoneStatus | unknown,
  error: DoneErrorInput | null | undefined,
  contract: DoneErrorContract = LEGACY_DONE_ERROR_CONTRACT
): DoneError | Error | null {
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (error == null) {
    if (contract.strict && status === "failed") {
      return new Error("Connector emitted invalid DONE: failed status requires DONE.error");
    }
    return null;
  }
  if (status === "succeeded") {
    return new Error("Connector emitted invalid DONE.error: succeeded runs must not include terminal error details");
  }
  if (typeof error !== "object" || Array.isArray(error)) {
    return new Error("Connector emitted invalid DONE.error: expected object");
  }
  const unsupportedFields = Object.keys(error).filter(
    (field) =>
      field !== "message" && field !== "retryable" && field !== "code" && field !== "recovery_hint" && field !== "basis"
  );
  if (unsupportedFields.length) {
    return new Error(`Connector emitted invalid DONE.error: unsupported fields ${unsupportedFields.join(", ")}`);
  }
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (error.code != null && (typeof error.code !== "string" || !DONE_ERROR_CODE_RE.test(error.code))) {
    return new Error("Connector emitted invalid DONE.error.code: expected bounded snake_case code");
  }
  if (typeof error.message !== "string" || !error.message.trim()) {
    return new Error("Connector emitted invalid DONE.error.message: expected non-empty string");
  }
  if (contract.strict && typeof error.retryable !== "boolean") {
    return new Error("Connector emitted invalid DONE.error.retryable: expected boolean");
  }
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (error.retryable != null && typeof error.retryable !== "boolean") {
    return new Error("Connector emitted invalid DONE.error.retryable: expected boolean");
  }
  if (!isValidRecoveryHintShape(error.recovery_hint)) {
    return new Error("Connector emitted invalid DONE.error.recovery_hint");
  }
  const basis = validateDoneBasis(error.basis, contract);
  if (basis instanceof Error) {
    return basis;
  }
  return {
    ...(error.code ? { code: error.code } : {}),
    message: error.message.trim(),
    // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
    ...(error.recovery_hint == null
      ? {}
      : { recovery_hint: error.recovery_hint as NonNullable<DoneError["recovery_hint"]> }),
    retryable: error.retryable ?? null,
    ...(basis === undefined ? {} : { basis }),
  };
}

/**
 * Section 5.8: `basis` is OPTIONAL, needs a declared OBSERVATION capability,
 * and cites only ids the connector emitted in this run. Invalid-but-emitted
 * ids count as emitted. Returns the ids, undefined when absent, or an Error.
 */
function validateDoneBasis(basis: unknown, contract: DoneErrorContract): readonly string[] | undefined | Error {
  if (basis === undefined) {
    return undefined;
  }
  if (!contract.observationDeclared) {
    return new Error("Connector emitted DONE.error.basis without declaring OBSERVATION");
  }
  if (!Array.isArray(basis)) {
    return new Error("Connector emitted invalid DONE.error.basis: expected array of observation ids");
  }
  for (const id of basis) {
    if (!(isObservationIdSyntax(id) && contract.hasEmittedId(id))) {
      return new Error("Connector emitted DONE.error.basis citing an OBSERVATION id it did not emit");
    }
  }
  // The emitted-id ledger bounds unique citations. Duplicate citations add no
  // diagnosis authority and need not expand the stored record.
  return [...new Set(basis)] as string[];
}
