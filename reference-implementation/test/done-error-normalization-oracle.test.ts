// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { boundConnectorErrorCode } from "../runtime/connector-gap-bounding.ts";
import { validateDoneError, validateDoneStatus } from "../runtime/done-validators.ts";

const REGEXP_1 = /invalid DONE\.error\.retryable/;
const REGEXP_2 = /succeeded runs must not include terminal error details/;
const REGEXP_3 = /expected object/;
const REGEXP_4 = /expected object/;
const REGEXP_6 = /invalid DONE\.error\.code/;
const REGEXP_7 = /invalid DONE\.error\.message/;
const REGEXP_8 = /invalid DONE\.error\.message/;
const INVALID_RECOVERY_HINT_MESSAGE_PATTERN = /invalid DONE\.error\.recovery_hint/;

test("validateDoneError returns null when successful DONE.error is absent", () => {
  assert.equal(validateDoneError("succeeded", undefined), null);
});

test("validateDoneError rejects terminal error details on succeeded DONE envelopes", () => {
  const result = validateDoneError("succeeded", { message: "failed anyway" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_2);
});

test("validateDoneError rejects non-object and array DONE.error inputs", () => {
  // Deliberately invalid inputs (a string, an array) to prove the fail-closed
  // "expected object" rejection path — validateDoneError's real param type is
  // narrower, so these are cast at the call site rather than the test's point
  // being weakened away.
  const nonObject = validateDoneError("failed", "failed" as unknown as { message: string });
  const array = validateDoneError("failed", [{ message: "failed" }] as unknown as { message: string });

  assert.ok(nonObject instanceof Error);
  assert.match(nonObject.message, REGEXP_3);
  assert.ok(array instanceof Error);
  assert.match(array.message, REGEXP_4);
});

test("validateDoneError accepts extra members and projects only portable error and hint fields", () => {
  const result = validateDoneError("failed", {
    detail: "ignored",
    message: "failed",
    recovery_hint: { action: "unknown", detail: "ignored" },
    retryable: false,
  });
  assert.deepEqual(result, { message: "failed", recovery_hint: { action: "unknown" }, retryable: false });
});

test("validateDoneError rejects invalid DONE.error.code strings", () => {
  const result = validateDoneError("failed", { code: "ProviderThrottle", message: "failed" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_6);
});

test("validateDoneError rejects empty or whitespace-only DONE.error.message values", () => {
  const empty = validateDoneError("failed", { message: "" });
  const whitespace = validateDoneError("failed", { message: "   " });

  assert.ok(empty instanceof Error);
  assert.match(empty.message, REGEXP_7);
  assert.ok(whitespace instanceof Error);
  assert.match(whitespace.message, REGEXP_8);
});

test("validateDoneError requires DONE.error.retryable to be boolean", () => {
  // "false" (a string) is deliberately the wrong type for `retryable`, to
  // prove the fail-closed rejection.
  const result = validateDoneError("failed", { message: "failed", retryable: "false" as unknown as boolean });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_1);
});

test("validateDoneError normalizes valid failed DONE.error details", () => {
  assert.deepEqual(
    validateDoneError("failed", { code: "provider_throttle_1", message: "  trimmed  ", retryable: true }),
    {
      code: "provider_throttle_1",
      message: "trimmed",
      retryable: true,
    }
  );
  assert.deepEqual(
    validateDoneError("failed", { code: "provider_throttle_1", message: "  trimmed  ", retryable: false }),
    {
      code: "provider_throttle_1",
      message: "trimmed",
      retryable: false,
    }
  );
});

test("validateDoneError accepts a closed-vocabulary recovery_hint distinct from code", () => {
  assert.deepEqual(
    validateDoneError("failed", {
      code: "session_expired",
      message: "failed",
      recovery_hint: "refresh_credentials",
      retryable: true,
    }),
    { code: "session_expired", message: "failed", recovery_hint: "refresh_credentials", retryable: true }
  );
  assert.deepEqual(
    validateDoneError("failed", {
      message: "failed",
      recovery_hint: { action: "manual_action_required", retryable: false },
      retryable: true,
    }),
    {
      message: "failed",
      recovery_hint: { action: "manual_action_required", retryable: false },
      retryable: true,
    }
  );
});

test("validateDoneError rejects an out-of-vocabulary recovery_hint", () => {
  const result = validateDoneError("failed", { message: "failed", recovery_hint: "made_up_action", retryable: true });
  assert.ok(result instanceof Error);
  assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
});

test("recovery_hint accepts portable suggestion shapes", () => {
  const bareAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: "retry_by_runtime",
    retryable: true,
  });
  assert.ok(!(bareAction instanceof Error));
  assert.equal(bareAction?.recovery_hint, "retry_by_runtime");

  const objectWithAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "refresh_credentials" },
    retryable: true,
  });
  assert.ok(!(objectWithAction instanceof Error));
  assert.deepEqual(objectWithAction?.recovery_hint, { action: "refresh_credentials" });

  const objectWithBoth = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
    retryable: true,
  });
  assert.ok(!(objectWithBoth instanceof Error));
  assert.deepEqual(objectWithBoth?.recovery_hint, { action: "retry_on_connector_upgrade", retryable: false });
  for (const invalid of [
    {},
    { retryable: true },
    { action: "made_up_action" },
    { action: "refresh_credentials", retryable: "false" },
  ]) {
    const result = validateDoneError("failed", { message: "failed", recovery_hint: invalid, retryable: true });
    assert.ok(result instanceof Error, `accepted invalid recovery_hint: ${JSON.stringify(invalid)}`);
    assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
  }
});

// Collection Profile §§5.5 and 5.8, data-connectors 9e70c433.
test("portable DONE rejects controller statuses and requires a failed error and retryable boolean", () => {
  assert.ok(validateDoneStatus("cancelled") instanceof Error);
  for (const error of [undefined, null, { message: "failed" }, { message: "failed", retryable: null }]) {
    assert.ok(validateDoneError("failed", error) instanceof Error, JSON.stringify(error));
  }
});

test("portable DONE accepts snake-case codes without an unspecified length limit", () => {
  const result = validateDoneError("failed", {
    code: `provider_${"failure_".repeat(12)}1`,
    message: "failed",
    retryable: false,
  });
  assert.ok(!(result instanceof Error));
  assert.equal(boundConnectorErrorCode("x"), "x");
  assert.equal(boundConnectorErrorCode(`provider_${"failure_".repeat(12)}1`), `provider_${"failure_".repeat(12)}1`);
});

test("portable recovery hint rejects explicit null retryable", () => {
  const result = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "unknown", retryable: null },
    retryable: false,
  });
  assert.ok(result instanceof Error);
});

test("DONE basis preserves declared same-run ids and rejects undeclared or unknown ids", () => {
  const error = { basis: ["o1"], message: "failed", retryable: false };
  const observations = { declared: true, ids: new Set(["o1"]) };
  assert.deepEqual(validateDoneError("failed", error, observations), error);
  assert.deepEqual(validateDoneError("failed", { ...error, basis: [] }, observations), { ...error, basis: [] });
  for (const basis of [null, "o1", [1], ["other_run"]]) {
    assert.ok(validateDoneError("failed", { ...error, basis }, observations) instanceof Error);
  }
  assert.ok(validateDoneError("failed", error) instanceof Error);
});

test("portable DONE optional code and recovery hint reject explicit null", () => {
  for (const optional of [{ code: null }, { recovery_hint: null }]) {
    assert.ok(validateDoneError("failed", { message: "failed", retryable: false, ...optional }) instanceof Error);
  }
});
