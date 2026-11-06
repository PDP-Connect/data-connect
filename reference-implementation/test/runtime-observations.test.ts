// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateDoneError } from "../runtime/done-validators.ts";
import {
  type AcceptOutcome,
  type CreateObservationRunInput,
  createObservationRun,
  type DiagnosticDescriptors,
  ObservationContractError,
  type ObservationLimits,
  type ObservationRun,
  validateDiagnosticDescriptors,
} from "../runtime/observations.ts";

const SECRET = "SECRET-MARKER-7f3a9c";

const DESCRIPTORS: DiagnosticDescriptors = validateDiagnosticDescriptors({
  expectations: [{ id: "email_input", step: "sign_in" }],
  rules: [{ id: "password_rejected", kind: "auth", step: "sign_in" }],
  steps: [{ id: "sign_in" }],
});

interface Harness {
  readonly run: ObservationRun;
  setNow: (ms: number) => void;
}

function harness(
  options: { declared?: boolean; limits?: ObservationLimits; descriptors?: DiagnosticDescriptors } = {}
): Harness {
  let clock = 0;
  const input: CreateObservationRunInput = {
    declared: options.declared ?? true,
    descriptors: options.descriptors ?? DESCRIPTORS,
    now: () => clock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  return {
    run: createObservationRun(input),
    setNow(ms: number) {
      clock = ms;
    },
  };
}

function expectation(id: string, final: "matched" | "hidden" = "hidden", step = "sign_in") {
  return {
    attrs: {
      expectation: "email_input",
      final,
      states_seen: ["absent", final],
    },
    evidence_ref: "trace:step-3",
    fact: "element_expectation",
    id,
    step,
    type: "OBSERVATION",
  };
}

function authFailure(id: string, extra: Record<string, unknown> = {}) {
  return {
    attrs: { kind: "auth_failure", ...extra },
    fact: "provider_message",
    id,
    type: "OBSERVATION",
  };
}

function waitExpired(id: string) {
  return {
    attrs: { awaited: "email_input", budget_ms: 5000 },
    fact: "wait_expired",
    id,
    step: "sign_in",
    type: "OBSERVATION",
  };
}

function rejectedReason(outcome: AcceptOutcome): string {
  assert.equal(outcome.status, "rejected");
  return outcome.reason;
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

test("absent diagnostic_descriptors normalize to empty arrays", () => {
  assert.deepEqual(validateDiagnosticDescriptors(undefined), {
    expectations: [],
    rules: [],
    steps: [],
  });
});

test("canonical descriptors normalize to closed typed members", () => {
  const normalized = validateDiagnosticDescriptors({
    expectations: [{ id: "email_input", step: "sign_in" }],
    rules: [
      { id: "password_rejected", kind: "auth", step: "sign_in" },
      { id: "any_auth", kind: "auth" },
    ],
    steps: [{ id: "sign_in" }],
  });
  assert.deepEqual(normalized, {
    expectations: [{ id: "email_input", step: "sign_in" }],
    rules: [
      { id: "password_rejected", kind: "auth", step: "sign_in" },
      { id: "any_auth", kind: "auth" },
    ],
    steps: [{ id: "sign_in" }],
  });
});

test("descriptor syntax, extra members and rule kind are rejected with a bounded code", () => {
  const malformed: unknown[] = [
    { steps: [{ id: "Sign_In" }] },
    { steps: [{ id: "a".repeat(65) }] },
    { steps: [{ id: "sign_in", label: "Sign in" }] },
    { rules: [{ id: "r1", kind: "network" }] },
    { expectations: [{ id: "e1" }] },
    { surprises: [] },
    null,
  ];
  for (const value of malformed) {
    assert.throws(
      () => validateDiagnosticDescriptors(value),
      (error: unknown) => error instanceof ObservationContractError && error.code === "descriptor_schema"
    );
  }
});

test("duplicate descriptor ids and undeclared expectation steps are rejected", () => {
  const cases: [unknown, string][] = [
    [{ steps: [{ id: "a" }, { id: "a" }] }, "descriptor_duplicate_id"],
    [
      {
        expectations: [
          { id: "e", step: "a" },
          { id: "e", step: "a" },
        ],
        steps: [{ id: "a" }],
      },
      "descriptor_duplicate_id",
    ],
    [
      {
        rules: [
          { id: "r", kind: "auth" },
          { id: "r", kind: "auth" },
        ],
        steps: [{ id: "a" }],
      },
      "descriptor_duplicate_id",
    ],
    [{ expectations: [{ id: "e", step: "b" }], steps: [{ id: "a" }] }, "descriptor_undeclared_step"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => validateDiagnosticDescriptors(value),
      (error: unknown) => error instanceof ObservationContractError && error.code === code
    );
  }
});

test("an optional rule step follows the canonical schema without an extra reference restriction", () => {
  assert.deepEqual(
    validateDiagnosticDescriptors({
      rules: [{ id: "r", kind: "auth", step: "b" }],
    }).rules,
    [{ id: "r", kind: "auth", step: "b" }]
  );
});

test("an invalid observation cannot reuse its earlier id for an accepted fact", () => {
  const { run } = harness();
  assert.equal(rejectedReason(run.accept({ ...authFailure("used"), attrs: { kind: "invalid" } })), "invalid");
  assert.equal(rejectedReason(run.accept(authFailure("used"))), "duplicate_id");
  assert.equal(run.snapshot().facts.length, 0);
});

test("a raw line is measured in UTF-8 bytes before parse; a line of 2049 bytes is oversize", () => {
  const line = (size: number) => {
    const base = JSON.stringify(waitExpired("b1"));
    return base + " ".repeat(size - base.length);
  };
  const { run } = harness();
  assert.equal(run.acceptLine(line(2048)).status, "accepted");
  const over = harness();
  assert.equal(rejectedReason(over.run.acceptLine(line(2049))), "oversize");
  assert.equal(over.run.snapshot().truncated, true);
});

test("a multi-byte character counts by its UTF-8 length, not its UTF-16 length", () => {
  const { run } = harness();
  const base = JSON.stringify(waitExpired("b2"));
  // 2047 characters, one of them a three-byte euro sign, make 2049 bytes.
  const padded = `${base}${" ".repeat(2046 - base.length)}\u20ac`;
  assert.equal(padded.length < 2048, true);
  assert.equal(Buffer.byteLength(padded, "utf8"), 2049);
  assert.equal(rejectedReason(run.acceptLine(padded)), "oversize");
});

test("a raw line that is not JSON is invalid and is not echoed", () => {
  const { run } = harness();
  assert.equal(rejectedReason(run.acceptLine(`{"id": "${SECRET}"`)), "invalid");
  assert.equal(JSON.stringify(run.snapshot()).includes(SECRET), false);
});

test("a raw line from an undeclared connector is rejected as undeclared_capability", () => {
  const { run } = harness({ declared: false });
  assert.equal(rejectedReason(run.acceptLine(JSON.stringify(waitExpired("u1")))), "undeclared_capability");
});

test("hasEmittedId reports rejected ids as well as accepted ones", () => {
  const { run } = harness();
  run.accept({
    ...expectation("h1"),
    attrs: { ...expectation("h1").attrs, final: "matched", states_seen: ["absent"] },
  });
  assert.equal(run.hasEmittedId("h1"), true);
  assert.equal(run.hasEmittedId("never"), false);
});

function doneContract(run: ObservationRun) {
  return {
    hasEmittedId: (id: string) => run.hasEmittedId(id),
    idLedgerOverflowed: run.idLedgerOverflowed(),
    observationDeclared: true,
    strict: true,
  };
}

test("a failed DONE citing an id past the full discard ledger is kept without the unverifiable id", () => {
  const { run } = harness({ limits: { maxFacts: 64, maxPerWindow: 1000 } });
  run.accept(authFailure("c0"));
  // Invalid messages still emit their ids (Sections 5.8 and 5.10.2). The ledger
  // for them is bounded, so the 65th id is emitted but cannot be kept.
  for (let i = 0; i < 65; i += 1) {
    assert.equal(rejectedReason(run.accept({ fact: "nope", id: `d${i}`, type: "OBSERVATION" })), "invalid");
  }
  assert.equal(run.idLedgerOverflowed(), true);
  assert.equal(run.hasEmittedId("d64"), false);
  const result = validateDoneError("failed", { basis: ["c0", "d64"], message: "stopped", retryable: false }, doneContract(run));
  assert.ok(!(result instanceof Error), "a connector that overflowed the ledger must still get its terminal outcome");
  assert.deepEqual(result?.basis, ["c0"]);
  // The dropped id names no stored fact, so dropping it cannot change the diagnosis.
  assert.deepEqual(run.diagnose(result?.basis ?? []), run.diagnose(["c0", "d64"]));
  assert.equal(run.diagnose(result?.basis ?? []).category, "auth_rejected");
});

test("a valid fact refused for the fact limit still counts as emitted and its id stays citable", () => {
  const { run } = harness({ limits: { maxFacts: 64, maxPerWindow: 1000 } });
  for (let i = 0; i < 64; i += 1) {
    assert.equal(run.accept(waitExpired(`c${i}`)).status, "accepted");
  }
  assert.equal(rejectedReason(run.accept(waitExpired("c64"))), "count_exceeded");
  assert.equal(run.idLedgerOverflowed(), false, "refusing a valid fact is not a ledger overflow");
  const result = validateDoneError("failed", { basis: ["c0", "c64"], message: "stopped", retryable: false }, doneContract(run));
  assert.ok(!(result instanceof Error));
  assert.deepEqual(result?.basis, ["c0", "c64"]);
});

test("invalid traffic does not spend the budget that accepted facts need", () => {
  const { run } = harness({ limits: { maxFacts: 64, maxPerWindow: 64 } });
  for (let i = 0; i < 500; i += 1) {
    assert.equal(rejectedReason(run.accept({ fact: "nope", id: `bad${i}`, type: "OBSERVATION" })), "invalid");
  }
  for (let i = 0; i < 64; i += 1) {
    assert.equal(run.accept(waitExpired(`ok${i}`)).status, "accepted", `valid fact ${i} must not be evicted by invalid traffic`);
  }
  assert.equal(run.snapshot().facts.length, 64);
  assert.equal(run.snapshot().truncated, false, "no valid fact was lost, so the record is not truncated");
  assert.deepEqual(run.gateRecoveryHint("not_retriable", "skip_result"), { result: "authorized" });
});

test("a line that is not JSON never marks the record truncated, however long it is", () => {
  const { run } = harness();
  assert.equal(rejectedReason(run.acceptLine("x".repeat(5000))), "oversize");
  assert.equal(run.snapshot().truncated, false);
  assert.deepEqual(run.gateRecoveryHint("not_retriable", "skip_result"), { result: "authorized" });
});

test("a duplicate id is reported as duplicate_id even when the repeat is also oversize", () => {
  const { run } = harness();
  assert.equal(run.accept(waitExpired("dup")).status, "accepted");
  assert.equal(rejectedReason(run.accept({ ...waitExpired("dup"), padding: "x".repeat(3000) })), "duplicate_id");
  // An oversize first sighting still uses its id.
  assert.equal(rejectedReason(run.accept({ ...waitExpired("big"), padding: "x".repeat(3000) })), "oversize");
  assert.equal(rejectedReason(run.accept(waitExpired("big"))), "duplicate_id");
});

test("a DONE basis with a malformed id names the syntax problem, not a missing emission", () => {
  const { run } = harness();
  run.accept(waitExpired("c0"));
  const malformed = validateDoneError("failed", { basis: ["Not A Valid Id"], message: "stopped", retryable: false }, doneContract(run));
  const missing = validateDoneError("failed", { basis: ["never"], message: "stopped", retryable: false }, doneContract(run));
  assert.ok(malformed instanceof Error && missing instanceof Error);
  assert.notEqual(malformed.message, missing.message);
  assert.match(malformed.message, /not a valid OBSERVATION id/);
  assert.equal(malformed.message.includes("Not A Valid Id"), false, "the rejected id is not echoed");
});

test("a failed DONE citing an id the connector never emitted is still rejected while the ledger has room", () => {
  const { run } = harness();
  run.accept(waitExpired("c0"));
  const result = validateDoneError(
    "failed",
    { basis: ["never"], message: "stopped", retryable: false },
    {
      hasEmittedId: (id) => run.hasEmittedId(id),
      idLedgerOverflowed: run.idLedgerOverflowed(),
      observationDeclared: true,
      strict: true,
    }
  );
  assert.ok(result instanceof Error);
});

test("a descriptor error never echoes the rejected value", () => {
  assert.throws(
    () => validateDiagnosticDescriptors({ steps: [{ id: SECRET }] }),
    (error: unknown) => {
      assert.ok(error instanceof ObservationContractError);
      assert.equal(String(error.message).includes(SECRET), false);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Accept: the three connector fact types and schema grammar
// ---------------------------------------------------------------------------

test("all three connector fact types are accepted and visible in the snapshot", () => {
  const { run } = harness();
  assert.deepEqual(run.accept(expectation("o1")), {
    id: "o1",
    retired: [],
    status: "accepted",
  });
  assert.deepEqual(run.accept(waitExpired("o2")), {
    id: "o2",
    retired: [],
    status: "accepted",
  });
  assert.deepEqual(run.accept(authFailure("o3", { rule: "password_rejected" })), {
    id: "o3",
    retired: [],
    status: "accepted",
  });

  const snap = run.snapshot();
  assert.deepEqual(
    snap.facts.map((fact) => [fact.id, fact.fact, fact.retired]),
    [
      ["o1", "element_expectation", false],
      ["o2", "wait_expired", false],
      ["o3", "provider_message", false],
    ]
  );
  assert.equal(snap.truncated, false);
  assert.deepEqual(snap.defects, []);
});

test("schema forbids extra members, provider text, URL evidence and bad id grammar", () => {
  const { run } = harness();
  const invalid: unknown[] = [
    { ...expectation("x1"), password: SECRET },
    {
      ...expectation("x2"),
      attrs: { ...expectation("x2").attrs, message: SECRET },
    },
    authFailure("x3", { detail: SECRET }),
    { ...expectation("x4"), evidence_ref: "https://example.test/trace" },
    { ...expectation("x5"), evidence_ref: "trace step 3" },
    { ...expectation("Bad Id!") },
    {
      ...waitExpired("x6"),
      attrs: { awaited: "email_input", budget_ms: 86_400_001 },
    },
    {
      ...expectation("x7"),
      resolves: Array.from({ length: 17 }, (_, i) => `r${i}`),
    },
    { ...expectation("x8"), fact: "http_response" },
  ];
  for (const value of invalid) {
    assert.equal(rejectedReason(run.accept(value)), "invalid");
  }
  assert.equal(run.snapshot().facts.length, 0);
});

test("final must be a member of states_seen", () => {
  const { run } = harness();
  const value = {
    attrs: {
      expectation: "email_input",
      final: "hidden",
      states_seen: ["absent"],
    },
    fact: "element_expectation",
    id: "f1",
    step: "sign_in",
    type: "OBSERVATION",
  };
  assert.equal(rejectedReason(run.accept(value)), "invalid");
  assert.deepEqual(run.snapshot().facts, []);
});

test("runtime-only fact types are rejected as runtime_fact_type and never stored", () => {
  const { run } = harness();
  for (const fact of ["credential_submission", "rule_match", "connector_defect"]) {
    const value = {
      attrs: { outcome: "rejected" },
      fact,
      id: `forged-${fact}`,
      type: "OBSERVATION",
    };
    assert.equal(rejectedReason(run.accept(value)), "runtime_fact_type");
  }
  const snap = run.snapshot();
  assert.deepEqual(snap.facts, []);
  assert.deepEqual(
    snap.defects.map((defect) => [defect.class, defect.class === "protocol_violation" ? defect.reason : null]),
    [["protocol_violation", "runtime_fact_type"]]
  );
});

test("an undeclared OBSERVATION capability rejects every fact", () => {
  const { run } = harness({ declared: false });
  assert.equal(rejectedReason(run.accept(expectation("o1"))), "undeclared_capability");
  assert.equal(rejectedReason(run.accept(authFailure("o2"))), "undeclared_capability");
  const snap = run.snapshot();
  assert.deepEqual(snap.facts, []);
  assert.equal(snap.truncated, false);
  assert.deepEqual(
    snap.defects.map((defect) => (defect.class === "protocol_violation" ? defect.reason : null)),
    ["undeclared_capability"]
  );
});

test("facts naming undeclared step, expectation or rule ids are accepted but support nothing", () => {
  const { run } = harness();
  run.accept(expectation("u1", "hidden", "other_step"));
  run.accept(authFailure("u2", { rule: "unknown_rule" }));
  run.accept({
    attrs: {
      expectation: "not_declared",
      final: "absent",
      states_seen: ["absent"],
    },
    fact: "element_expectation",
    id: "u3",
    step: "sign_in",
    type: "OBSERVATION",
  });
  const snap = run.snapshot();
  assert.deepEqual(
    snap.facts.map((fact) => fact.id),
    ["u1", "u2", "u3"]
  );
  assert.deepEqual(run.diagnose(["u1", "u2", "u3"]), {
    attribution: "none",
    basis: [],
    category: "unknown",
    contributing: [],
  });
});

test("duplicate accepted ids are rejected as duplicate_id and the first fact is kept", () => {
  const { run } = harness();
  assert.equal(run.accept(expectation("o1", "hidden")).status, "accepted");
  assert.equal(rejectedReason(run.accept(authFailure("o1"))), "duplicate_id");
  const snap = run.snapshot();
  assert.equal(snap.facts.length, 1);
  assert.equal(snap.facts[0]?.fact, "element_expectation");
});

// ---------------------------------------------------------------------------
// Retirement and runtime records
// ---------------------------------------------------------------------------

test("resolves retires an earlier connector fact, which stays visible", () => {
  const { run } = harness();
  run.accept(expectation("o1"));
  assert.deepEqual(run.accept({ ...waitExpired("o2"), resolves: ["o1"] }), {
    id: "o2",
    retired: ["o1"],
    status: "accepted",
  });
  const snap = run.snapshot();
  assert.deepEqual(
    snap.facts.map((fact) => [fact.id, fact.retired]),
    [
      ["o1", true],
      ["o2", false],
    ]
  );
  assert.deepEqual(run.diagnose(["o1"]), {
    attribution: "none",
    basis: [],
    category: "unknown",
    contributing: [],
  });
});

test("unknown resolves ids are a no-op and rejected facts retire nothing", () => {
  const { run } = harness();
  run.accept(expectation("o1"));
  assert.deepEqual(run.accept({ ...waitExpired("o2"), resolves: ["never_seen"] }), {
    id: "o2",
    retired: [],
    status: "accepted",
  });
  assert.equal(rejectedReason(run.accept({ ...waitExpired("o3"), extra: true, resolves: ["o1"] })), "invalid");
  assert.equal(run.snapshot().facts[0]?.retired, false);
});

test("resolves cannot name or retire a runtime record", () => {
  const { run } = harness();
  run.accept(authFailure("o1"));
  run.accept(expectation("o2"));
  // Runtime record ids contain ":", which the connector id grammar forbids, so the fact is invalid.
  assert.equal(
    rejectedReason(
      run.accept({
        ...waitExpired("o3"),
        resolves: ["runtime:connector_defect:protocol_violation:invalid"],
      })
    ),
    "invalid"
  );
  assert.equal(rejectedReason(run.accept({ ...waitExpired("o4"), resolves: ["runtime:rule_match:x"] })), "invalid");
  const snap = run.snapshot();
  assert.deepEqual(
    snap.facts.map((fact) => [fact.id, fact.retired]),
    [
      ["o1", false],
      ["o2", false],
    ]
  );
  assert.deepEqual(snap.defects, [
    {
      class: "protocol_violation",
      count: 2,
      id: "runtime:connector_defect:protocol_violation:invalid",
      reason: "invalid",
    },
  ]);
  assert.equal(run.diagnose(["o1", "o2"]).category, "auth_rejected");
});

// ---------------------------------------------------------------------------
// Secrecy, aliasing and immutability
// ---------------------------------------------------------------------------

test("a secret marker in rejected input never appears in defects, snapshot or outcomes", () => {
  const { run } = harness();
  const outcomes = [
    run.accept({ ...expectation("s1"), password: SECRET }),
    run.accept({
      ...authFailure("s2"),
      attrs: { kind: "auth_failure", note: SECRET },
    }),
    run.accept({ fact: "wait_expired", id: SECRET, type: "OBSERVATION" }),
    run.accept({
      attrs: { handle: SECRET },
      fact: "rule_match",
      id: "s3",
      type: "OBSERVATION",
    }),
    run.accept({ ...expectation("s4"), padding: "x".repeat(4000) + SECRET }),
  ];
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.status === "rejected" ? outcome.reason : outcome.status)),
    ["invalid", "invalid", "invalid", "runtime_fact_type", "oversize"]
  );
  assert.equal(JSON.stringify(outcomes).includes(SECRET), false);
  assert.equal(JSON.stringify(run.snapshot()).includes(SECRET), false);
});

test("accepted facts are copies: caller mutation does not reach the run, and snapshots are frozen", () => {
  const { run } = harness();
  const input = expectation("o1");
  run.accept(input);
  input.attrs.final = "matched";
  input.attrs.states_seen.push("matched");
  const snap = run.snapshot();
  const [stored] = snap.facts;
  assert.ok(stored);
  assert.equal(stored.fact === "element_expectation" ? stored.attrs.final : null, "hidden");
  assert.equal(Object.isFrozen(stored), true);
  assert.throws(() => {
    (stored as { id: string }).id = "changed";
  }, TypeError);
  assert.equal(run.diagnose(["o1"]).category, "expectation_mismatch");
});

// ---------------------------------------------------------------------------
// Limits: bytes, count, rate, defect capacity
// ---------------------------------------------------------------------------

test("a 2048-byte raw line is accepted and no oversize truncation is recorded", () => {
  const base = JSON.stringify(waitExpired("b1"));
  const { run } = harness();
  assert.equal(run.acceptLine(base + " ".repeat(2048 - base.length)).status, "accepted");
  assert.equal(run.snapshot().truncated, false);
});

test("the byte bound is measured before validation when no serialized size is supplied", () => {
  const { run } = harness();
  const padded = { ...expectation("b3"), padding: "x".repeat(3000) };
  assert.equal(rejectedReason(run.accept(padded)), "oversize");
});

test("64 facts are accepted with a 64-fact limit and the 65th is count_exceeded", () => {
  const { run } = harness({ limits: { maxFacts: 64, maxPerWindow: 1000 } });
  for (let i = 0; i < 64; i += 1) {
    assert.equal(run.accept(waitExpired(`c${i}`)).status, "accepted");
  }
  assert.equal(rejectedReason(run.accept(waitExpired("c64"))), "count_exceeded");
  const snap = run.snapshot();
  assert.equal(snap.facts.length, 64);
  assert.equal(snap.truncated, true);
});

test("configured limits cannot fall below the profile minimums", () => {
  for (const limits of [{ maxFacts: 63 }, { maxFactBytes: 2047 }, { maxFacts: 0 }, { maxPerWindow: 1.5 }]) {
    assert.throws(
      () => harness({ limits }),
      (error: unknown) => error instanceof ObservationContractError && error.code === "limits_invalid"
    );
  }
});

test("the default capacity is 256 facts on a single clock tick", () => {
  const { run } = harness();
  for (let i = 0; i < 256; i += 1) {
    assert.equal(run.accept(waitExpired(`r${i}`)).status, "accepted");
  }
  assert.equal(rejectedReason(run.accept(waitExpired("r256"))), "count_exceeded");
  assert.equal(run.snapshot().facts.length, 256);
});

test("the default rate is 256 messages per 1000 ms window on an injected clock", () => {
  const { run, setNow } = harness({ limits: { maxFacts: 1000 } });
  for (let i = 0; i < 256; i += 1) {
    assert.equal(run.accept(waitExpired(`t${i}`)).status, "accepted");
  }
  assert.equal(rejectedReason(run.accept(waitExpired("t256"))), "count_exceeded");
  setNow(999);
  assert.equal(rejectedReason(run.accept(waitExpired("t257"))), "count_exceeded");
  setNow(1000);
  assert.equal(run.accept(waitExpired("t258")).status, "accepted");
  assert.equal(run.snapshot().truncated, true);
});

test("a flood of violations keeps defect records bounded and does not erase accepted evidence", () => {
  const { run } = harness({
    limits: { maxFacts: 64, maxPerWindow: 1_000_000 },
  });
  assert.equal(run.accept(authFailure("keep")).status, "accepted");
  for (let i = 0; i < 10_000; i += 1) {
    run.accept({ fact: "nope", id: `bad-${i}`, type: "OBSERVATION" });
    run.accept({ ...waitExpired(`flood-${i}`), padding: "x".repeat(4096) });
    run.accept({
      fact: "connector_defect",
      id: `dupe-${i}`,
      type: "OBSERVATION",
    });
  }
  const snap = run.snapshot();
  assert.ok(snap.defects.length <= 7, `defect records bounded, got ${snap.defects.length}`);
  assert.equal(snap.truncated, true);
  assert.ok(snap.facts.some((fact) => fact.id === "keep" && fact.retired === false));
  assert.equal(run.diagnose(["keep"]).category, "auth_rejected");
});

test("violation defects aggregate by reason with counts and no connector text", () => {
  const { run } = harness();
  for (let i = 0; i < 5; i += 1) {
    run.accept({
      attrs: { note: SECRET },
      fact: "invalid_fact",
      id: `x${i}`,
      type: "OBSERVATION",
    });
  }
  const snap = run.snapshot();
  assert.deepEqual(snap.defects, [
    {
      class: "protocol_violation",
      count: 5,
      id: "runtime:connector_defect:protocol_violation:invalid",
      reason: "invalid",
    },
  ]);
  assert.equal(JSON.stringify(snap).includes(SECRET), false);
});

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

test("an auth_failure cited in the basis diagnoses auth_rejected attributed to the connector", () => {
  const { run } = harness();
  run.accept(authFailure("a1"));
  assert.deepEqual(run.diagnose(["a1"]), {
    attribution: "connector",
    basis: ["a1"],
    category: "auth_rejected",
    contributing: [],
  });
});

test("auth_rejected outranks expectation_mismatch and the mismatch is listed as contributing", () => {
  const { run } = harness();
  run.accept(expectation("e1", "hidden"));
  run.accept(authFailure("a1", { rule: "password_rejected" }));
  assert.deepEqual(run.diagnose(["e1", "a1"]), {
    attribution: "connector",
    basis: ["a1"],
    category: "auth_rejected",
    contributing: ["e1"],
  });
});

test("a declared expectation that did not match diagnoses expectation_mismatch", () => {
  const { run } = harness();
  run.accept(expectation("e1", "hidden"));
  assert.deepEqual(run.diagnose(["e1"]), {
    attribution: "connector",
    basis: ["e1"],
    category: "expectation_mismatch",
    contributing: [],
  });
});

test("matched expectations, wait_expired and uncited facts never support a cause", () => {
  const { run } = harness();
  run.accept(expectation("m1", "matched"));
  run.accept(waitExpired("w1"));
  run.accept(authFailure("a1"));
  assert.equal(run.diagnose(["m1", "w1"]).category, "unknown");
  assert.equal(run.diagnose([]).category, "unknown");
  assert.equal(run.diagnose().category, "unknown");
  assert.equal(run.diagnose(["unknown_id"]).category, "unknown");
});

test("an auth_failure with kind other or a provider message under undeclared rule supports nothing", () => {
  const { run } = harness();
  run.accept({
    attrs: { kind: "other" },
    fact: "provider_message",
    id: "a1",
    type: "OBSERVATION",
  });
  run.accept(authFailure("a2", { rule: "undeclared" }));
  run.accept({
    attrs: { kind: "auth_failure" },
    fact: "provider_message",
    id: "a3",
    step: "undeclared_step",
    type: "OBSERVATION",
  });
  assert.equal(run.diagnose(["a1", "a2", "a3"]).category, "unknown");
});

test("ties break by record order and basis is listed in that order", () => {
  const { run } = harness();
  run.accept(authFailure("a2"));
  run.accept(authFailure("a1"));
  assert.deepEqual(run.diagnose(["a1", "a2"]).basis, ["a2", "a1"]);
  assert.deepEqual(run.diagnose(["a1", "a2"]).basis, run.diagnose(["a2", "a1"]).basis);
});

test("a retired fact cannot become the cause", () => {
  const { run } = harness();
  run.accept(authFailure("a1"));
  run.accept({ ...waitExpired("w1"), resolves: ["a1"] });
  assert.equal(run.diagnose(["a1"]).category, "unknown");
});

test("diagnosis output carries no action authority", () => {
  const { run } = harness();
  run.accept(authFailure("a1"));
  const diagnosis = run.diagnose(["a1"]);
  assert.deepEqual(
    Object.keys(diagnosis).sort((a, b) => (a < b ? -1 : Number(a > b))),
    ["attribution", "basis", "category", "contributing"]
  );
  assert.equal(run.gateRecoveryHint("refresh_credentials", "skip_result").result, "unsupported");
});

// ---------------------------------------------------------------------------
// Recovery-hint gate
// ---------------------------------------------------------------------------

test("not_retriable and unknown hold; other hints are unsupported", () => {
  const { run } = harness();
  assert.deepEqual(run.gateRecoveryHint("not_retriable", "skip_result"), {
    result: "authorized",
  });
  assert.deepEqual(run.gateRecoveryHint("unknown", "skip_result"), { result: "authorized" });
  for (const hint of [
    "refresh_credentials",
    "manual_action_required",
    "update_selector",
    "retry_on_connector_upgrade",
    "upstream_unblock",
    "retry_by_runtime",
  ]) {
    assert.deepEqual(run.gateRecoveryHint(hint, "skip_result"), { result: "unsupported" });
  }
});

test("an unsupported hint from a declarer adds one bounded hint_unsupported defect and never echoes the action", () => {
  const { run } = harness();
  run.gateRecoveryHint("refresh_credentials", "skip_result");
  run.gateRecoveryHint(`SECRET-ACTION-${SECRET}`, "skip_result");
  assert.deepEqual(run.snapshot().defects, [
    {
      class: "hint_unsupported",
      count: 2,
      id: "runtime:connector_defect:hint_unsupported",
    },
  ]);
  assert.equal(JSON.stringify(run.snapshot()).includes(SECRET), false);
});

test("a non-declarer's unsupported hint adds no defect", () => {
  const { run } = harness({ declared: false });
  assert.deepEqual(run.gateRecoveryHint("manual_action_required", "skip_result"), {
    result: "unsupported",
  });
  assert.deepEqual(run.snapshot().defects, []);
});

test("a truncated record blocks even a holding hint", () => {
  const { run } = harness({ limits: { maxFacts: 64, maxPerWindow: 1000 } });
  for (let i = 0; i < 65; i += 1) {
    run.accept(waitExpired(`t${i}`));
  }
  assert.equal(run.snapshot().truncated, true);
  assert.deepEqual(run.gateRecoveryHint("not_retriable", "skip_result"), {
    reason: "truncated",
    result: "blocked",
  });
  assert.deepEqual(run.gateRecoveryHint("unknown", "skip_result"), {
    reason: "truncated",
    result: "blocked",
  });
  assert.equal(
    run.snapshot().defects.find((d) => d.class === "hint_unsupported")?.count,
    2,
    "Section 5.11 records unsupported hints even when truncation caused the denial"
  );
});

test("connector auth facts never unlock a recovery hint", () => {
  const { run } = harness();
  run.accept(authFailure("a1", { rule: "password_rejected" }));
  assert.deepEqual(run.diagnose(["a1"]).category, "auth_rejected");
  assert.deepEqual(run.gateRecoveryHint("refresh_credentials", "skip_result"), {
    result: "unsupported",
  });
});

test("an unauthorized connector hint is recorded once per origin and action as a bounded suggestion", () => {
  const { run } = harness();
  assert.equal(run.snapshot().connector_suggestions, undefined);
  run.gateRecoveryHint("refresh_credentials", "done_error");
  run.gateRecoveryHint("refresh_credentials", "done_error");
  run.gateRecoveryHint("manual_action_required", "skip_result");
  run.gateRecoveryHint(`SECRET-ACTION-${SECRET}`, "skip_result");
  assert.deepEqual(run.snapshot().connector_suggestions, [
    { action: "refresh_credentials", attribution: "connector", origin: "done_error" },
    { action: "manual_action_required", attribution: "connector", origin: "skip_result" },
  ]);
  assert.equal(JSON.stringify(run.snapshot()).includes(SECRET), false);
});
