// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateDoneError } from "../runtime/done-validators.ts";

const REGEXP_1 = /invalid DONE\.error\.retryable/;
const REGEXP_2 = /succeeded runs must not include terminal error details/;
const REGEXP_3 = /expected object/;
const REGEXP_4 = /expected object/;
const REGEXP_5 = /unsupported fields detail/;
const REGEXP_6 = /invalid DONE\.error\.code/;
const REGEXP_7 = /invalid DONE\.error\.message/;
const REGEXP_8 = /invalid DONE\.error\.message/;
const INVALID_RECOVERY_HINT_MESSAGE_PATTERN = /invalid DONE\.error\.recovery_hint/;

test("validateDoneError returns null when DONE.error is absent", () => {
  assert.equal(validateDoneError("failed", null), null);
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

test("validateDoneError rejects unsupported fields and names the field", () => {
  const result = validateDoneError("failed", { detail: "too much", message: "failed" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_5);
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

test("validateDoneError requires DONE.error.retryable to be boolean when present", () => {
  // "false" (a string) is deliberately the wrong type for `retryable`, to
  // prove the fail-closed rejection.
  const result = validateDoneError("failed", { message: "failed", retryable: "false" as unknown as boolean });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_1);
});

test("validateDoneError normalizes valid failed DONE.error details", () => {
  assert.deepEqual(validateDoneError("failed", { code: "provider_throttle_1", message: "  trimmed  " }), {
    code: "provider_throttle_1",
    message: "trimmed",
    retryable: null,
  });
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
    validateDoneError("failed", { code: "session_expired", message: "failed", recovery_hint: "refresh_credentials" }),
    { code: "session_expired", message: "failed", recovery_hint: "refresh_credentials", retryable: null }
  );
  assert.deepEqual(
    validateDoneError("failed", {
      message: "failed",
      recovery_hint: { action: "manual_action_required", retryable: false },
    }),
    { message: "failed", recovery_hint: { action: "manual_action_required", retryable: false }, retryable: null }
  );
});

test("validateDoneError rejects an out-of-vocabulary recovery_hint", () => {
  const result = validateDoneError("failed", { message: "failed", recovery_hint: "made_up_action" });
  assert.ok(result instanceof Error);
  assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
});

test("recovery_hint accepts only actionable shapes", () => {
  const bareAction = validateDoneError("failed", { message: "failed", recovery_hint: "retry_by_runtime" });
  assert.ok(!(bareAction instanceof Error));
  assert.equal(bareAction?.recovery_hint, "retry_by_runtime");

  const objectWithAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "refresh_credentials" },
  });
  assert.ok(!(objectWithAction instanceof Error));
  assert.deepEqual(objectWithAction?.recovery_hint, { action: "refresh_credentials" });

  const objectWithBoth = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
  });
  assert.ok(!(objectWithBoth instanceof Error));
  assert.deepEqual(objectWithBoth?.recovery_hint, { action: "retry_on_connector_upgrade", retryable: false });
  for (const invalid of [
    {},
    { retryable: true },
    { action: "made_up_action" },
    { action: "refresh_credentials", retryable: "false" },
    { action: "refresh_credentials", connector_detail: "private" },
  ]) {
    const result = validateDoneError("failed", { message: "failed", recovery_hint: invalid });
    assert.ok(result instanceof Error, `accepted invalid recovery_hint: ${JSON.stringify(invalid)}`);
    assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
  }
});

// Pinned truth: Collection Profile 0.2.0 Sections 3.8, 5.10-5.11,
// data-connectors 9e70c433. Direct deterministic rules complement the real-child
// persistence/continuation tests in collection-profile.test.ts.
test("OBSERVATION diagnosis limits scope to cited, live, declared facts", async () => {
  const { createObservationRunRecord } = await import("../runtime/observation.ts");
  const { diagnoseObservationFailure } = await import("../runtime/failure-diagnosis.ts");
  const store = createObservationRunRecord({
    diagnostic_descriptors: { expectations: [{ id: "email", step: "login" }], steps: [{ id: "login" }] },
    protocol_capabilities: ["OBSERVATION"],
  });
  const observe = (id: string, fact: string, attrs: Record<string, unknown>, extra = {}) =>
    store.accept({ attrs, fact, id, type: "OBSERVATION", ...extra }, 2048);
  assert.equal(
    observe(
      "mismatch",
      "element_expectation",
      { expectation: "email", final: "hidden", states_seen: ["hidden"] },
      { step: "login" }
    ),
    true
  );
  assert.equal(observe("wait", "wait_expired", { awaited: "email", budget_ms: 10 }, { step: "login" }), true);
  assert.equal(observe("uncited", "provider_message", { kind: "auth_failure" }), true);
  const diagnose = (basis: string[]) =>
    diagnoseObservationFailure(store.snapshot(), { error: { basis }, status: "failed" });
  assert.equal(diagnose(["wait"]).cause.category, "unknown");
  assert.deepEqual(diagnose(["mismatch", "wait"]).cause, {
    attribution: "connector",
    basis: ["mismatch"],
    category: "expectation_mismatch",
  });
  assert.equal(observe("recovered", "provider_message", { kind: "other" }, { resolves: ["mismatch"] }), true);
  assert.equal(diagnose(["mismatch"]).cause.category, "unknown");
  assert.equal(diagnose(["mismatch"]).facts.find((fact) => fact.id === "mismatch")?.retired, true);
  assert.equal(observe("missing_rule", "provider_message", { kind: "auth_failure", rule: "not_declared" }), true);
  assert.equal(diagnose(["missing_rule"]).cause.category, "unknown");
  assert.equal(diagnoseObservationFailure(store.snapshot(), null).terminal_event, "process_exit");
  const invalidDescriptors = createObservationRunRecord({
    diagnostic_descriptors: {
      expectations: [{ id: "email", step: "login" }],
      steps: [{ id: "login" }, { id: "login" }],
    },
    protocol_capabilities: ["OBSERVATION"],
  });
  invalidDescriptors.accept(
    {
      attrs: { expectation: "email", final: "hidden", states_seen: ["hidden"] },
      fact: "element_expectation",
      id: "o1",
      step: "login",
      type: "OBSERVATION",
    },
    100
  );
  assert.equal(
    diagnoseObservationFailure(invalidDescriptors.snapshot(), { error: { basis: ["o1"] }, status: "failed" }).cause
      .category,
    "unknown"
  );
});

test("DONE.error.basis accepts only earlier connector facts with OBSERVATION declared", () => {
  const observations = { declared: true, hasConnectorId: (id: string) => id === "o1" };
  assert.deepEqual(validateDoneError("failed", { basis: ["o1"], message: "cause" }, observations), {
    basis: ["o1"],
    message: "cause",
    retryable: null,
  });
  for (const basis of [["future"], ["runtime_record"], "o1", [1], null]) {
    assert.ok(validateDoneError("failed", { basis, message: "cause" }, observations) instanceof Error);
  }
  assert.ok(
    validateDoneError("failed", { basis: ["o1"], message: "cause" }, { ...observations, declared: false }) instanceof
      Error
  );
});

test("OBSERVATION evidence_ref accepts local handles and rejects URLs without //", async () => {
  const { createObservationRunRecord } = await import("../runtime/observation.ts");
  const store = createObservationRunRecord({ protocol_capabilities: ["OBSERVATION"] });
  const fact = (id: string, evidence_ref: string) => ({
    attrs: { kind: "other" },
    evidence_ref,
    fact: "provider_message",
    id,
    type: "OBSERVATION",
  });
  assert.equal(store.accept(fact("local", "trace:step-3"), 150), true);
  assert.equal(store.accept(fact("relative", "artifacts/step-3.json"), 150), true);
  for (const [index, reference] of [
    "https:example.com",
    "data:text/plain,provider-text",
    "//example.com/private",
    "file:/private",
  ].entries()) {
    assert.equal(store.accept(fact(`bad${index}`, reference), 150), false, reference);
  }
  assert.equal(store.snapshot().facts.filter((entry) => entry.source === "connector").length, 2);
});
