// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile 0.2.0 runtime journeys. Each test runs a real connector
// child process through runConnector and asserts on the observable outcome:
// the run result, the persisted diagnostic record, the trace file, or whether
// the child executed at all. Connector stubs are generated files, so the
// runtime's own parsing, validation, and gates are what the tests exercise.
//
// Spec: data-connectors docs/spec/collection-profile.md, Sections 3.4, 3.8,
// 5.5, 5.8, 5.10 to 5.13, 6.2 and 8.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, mock } from "node:test";
import { listSpineEventsPage } from "../lib/spine.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import {
  CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR,
  getDefaultConnectorObservationStore,
} from "../server/stores/connector-observation-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const CONNECTOR_ID = "collection-profile-020-test";
const SECRET_MARKER = "SECRET-MARKER-7f3a";
const INVALID_DONE_STATUS = /invalid DONE status/;
const PROTOCOL_VERSION_NAMED = /protocol_version/;
const OBSERVATION_NEEDS_020 = /OBSERVATION require protocol_version 0\.2\.0/;
const DIAGNOSTIC_DESCRIPTORS_NEEDS_020 = /diagnostic_descriptors require protocol_version 0\.2\.0/;
const UNDECLARED_STEP = /descriptor_undeclared_step/;
const BLOB_REFUSED = /BLOB/;
// A refusal before spawn carries a stable code the scheduler and console can key on.
const CAPABILITY_REFUSAL_REASON = "protocol_capability_unsupported";
const RETRYABLE_FIELD = /DONE\.error\.retryable/;
// Backend under test. With the dedicated private PostgreSQL URL the runtime, the
// admission store and the observation store all use Postgres. Without it the
// file runs on in-memory SQLite, as before. The journey and assertions are the
// same on both backends. No shared or production database is ever selected.
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
// The admitted instance row for this connector. Set in `before`, so each run
// and each persisted-record lookup use a real instance, as production does.
let INSTANCE_ID = "";

before(async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    // The connector_instances row references connectors(connector_id); admission
    // fails its foreign key check for an unregistered connector.
    await postgresQuery(
      "INSERT INTO connectors(connector_id, manifest) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
      [CONNECTOR_ID, JSON.stringify({ connector_id: CONNECTOR_ID })]
    );
  } else {
    initDb(":memory:");
    // The connector_instances row references connectors(connector_id); admission
    // fails its foreign key check for an unregistered connector.
    getDb()
      .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(CONNECTOR_ID, JSON.stringify({ connector_id: CONNECTOR_ID }), "2026-11-02T00:00:00.000Z");
  }
  const namespace = await admitOwnerRunConnection({
    connectorId: CONNECTOR_ID,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId: "owner_local",
  });
  INSTANCE_ID = namespace.connectorInstanceId;
});

after(async () => {
  if (POSTGRES_URL) {
    await closePostgresStorage();
  } else {
    closeDb();
  }
});

interface Stub {
  readonly connectorPath: string;
  readonly dir: string;
  readonly markerPath: string;
}

// A string message is written to stdout as is, so a test can send a line that is not valid JSON.
// The child writes a marker file as soon as it receives START. A test that
// expects no spawn checks that the marker is absent.
function makeStub(messages: readonly unknown[], exitCode: number): Stub {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-collection-profile-020-"));
  const connectorPath = join(dir, "connector.mjs");
  const markerPath = join(dir, "spawned.marker");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  writeFileSync(${JSON.stringify(markerPath)}, line);
  for (const message of ${JSON.stringify(messages)}) process.stdout.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\\n');
  rl.close();
  process.exit(${exitCode});
});
`,
    "utf8"
  );
  return { connectorPath, dir, markerPath };
}

const DECLARED_DESCRIPTORS = {
  expectations: [{ id: "email_input", step: "sign_in" }],
  rules: [{ id: "password_rejected", kind: "auth", step: "sign_in" }],
  steps: [{ id: "sign_in" }],
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    connector_id: CONNECTOR_ID,
    diagnostic_descriptors: DECLARED_DESCRIPTORS,
    protocol_capabilities: ["OBSERVATION"],
    protocol_version: "0.2.0",
    streams: [{ name: "items" }],
    ...overrides,
  };
}

type RunOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly message: string;
      readonly connectorError: { readonly message?: string } | null;
      readonly failureReason: string | null;
    };

// A runtime rejection becomes a value, so a failing assertion names the
// outcome instead of crashing the test file.
async function runStub(
  stub: Stub,
  runId: string,
  manifestValue: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
  runOptions: Record<string, unknown> = {}
): Promise<RunOutcome> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(extraEnv)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await runConnector({
      admitRunConnection: async ({
        connectorId,
        connectorInstanceId,
        ownerSubjectId,
      }: {
        connectorId: string;
        connectorInstanceId?: string;
        ownerSubjectId?: string;
      }) => {
        const namespace = await admitOwnerRunConnection({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? INSTANCE_ID,
          connectorInstanceStore: createRequestConnectorInstanceStore(),
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        });
        return {
          connectorId: namespace.connectorId,
          connectorInstanceId: namespace.connectorInstanceId,
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        };
      },
      connectorId: CONNECTOR_ID,
      connectorPath: stub.connectorPath,
      manifest: manifestValue as never,
      onInteraction: async () => ({}),
      onProgress: () => {
        // Progress events are not asserted by these tests.
      },
      ownerToken: "test-owner-token",
      persistState: false,
      runId,
      scope: { streams: [{ name: "items" }] },
      ...runOptions,
    } as never);
    return { ok: true, result: result as unknown as Record<string, unknown> };
  } catch (caught) {
    const connectorError = (caught as { connector_error?: { message?: string } | null }).connector_error ?? null;
    const failureReason = (caught as { failure_reason?: string }).failure_reason ?? null;
    return { connectorError, failureReason, message: (caught as Error).message, ok: false };
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function persistedRecord(runId: string) {
  return getDefaultConnectorObservationStore().get({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    runId,
  });
}

// A protocol violation is keyed by its reason; a hint defect by its class.
function defectKey(defect: { class: string; reason?: string }): string {
  return defect.class === "protocol_violation" ? (defect.reason ?? "") : defect.class;
}

function observation(id: string, fields: Record<string, unknown>) {
  return { id, type: "OBSERVATION", ...fields };
}

const EXPECTATION = (id: string) =>
  observation(id, {
    attrs: { expectation: "email_input", final: "absent", states_seen: ["absent"] },
    fact: "element_expectation",
    step: "sign_in",
  });

const PROVIDER_REJECTED = (id: string, rule = "password_rejected") =>
  observation(id, {
    attrs: { kind: "auth_failure", rule },
    fact: "provider_message",
    step: "sign_in",
  });

test("declared 0.2.0 OBSERVATION facts are accepted and the run succeeds", async () => {
  const stub = makeStub([EXPECTATION("o1"), { records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const outcome = await runStub(stub, "run_c020_accept", manifest());
    assert.equal(outcome.ok, true, `declared OBSERVATION must not abort the run: ${outcome.ok ? "" : outcome.message}`);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.result.status, "succeeded");
    const start = JSON.parse(readFileSync(stub.markerPath, "utf8")) as { protocol_capabilities: string[] };
    assert.ok(start.protocol_capabilities.includes("OBSERVATION"), "START advertises the implemented message");
    assert.equal(
      start.protocol_capabilities.includes("DETAIL_COVERAGE_KEY_SETS"),
      false,
      "the runtime must not promise key-set extension credit rules it does not implement"
    );
    const record = await persistedRecord("run_c020_accept");
    assert.ok(record, "the run's bounded diagnostic record must be persisted");
    assert.deepEqual(
      record.snapshot.facts.map((fact) => fact.id),
      ["o1"]
    );
    assert.deepEqual(record.snapshot.defects, []);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a portable 0.2.0 connector cannot report runtime cancellation as a DONE status", async () => {
  const stub = makeStub([{ records_emitted: 0, status: "cancelled", type: "DONE" }], 1);
  try {
    const outcome = await runStub(stub, "run_c020_cancelled_status", manifest());
    assert.equal(outcome.ok, false, "Section 5.8 permits only succeeded and failed connector status values");
    if (!outcome.ok) {
      assert.match(outcome.message, INVALID_DONE_STATUS);
    }
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("an oversized observation still owns its emitted id and can be cited without corrupting collection", async () => {
  const stub = makeStub(
    [
      { ...EXPECTATION("large_id"), padding: "x".repeat(3000) },
      EXPECTATION("large_id"),
      {
        error: { basis: ["large_id"], message: "Connector reported failure", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const outcome = await runStub(stub, "run_c020_oversize_id", manifest());
    assert.equal(
      outcome.ok,
      true,
      "discarding an oversized fact must not turn a valid DONE citation into a protocol failure"
    );
    const record = await persistedRecord("run_c020_oversize_id");
    assert.ok(record);
    assert.deepEqual(record.snapshot.facts, [], "a later fact must not reuse an id from the oversized message");
    assert.deepEqual(record.snapshot.defects.map(defectKey).sort(), ["duplicate_id", "oversize"]);
    assert.equal(record.snapshot.truncated, true);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("an undeclared OBSERVATION is discarded as a protocol violation and collection still succeeds", async () => {
  const stub = makeStub([EXPECTATION("u1"), { records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const outcome = await runStub(
      stub,
      "run_c020_undeclared",
      manifest({ diagnostic_descriptors: undefined, protocol_capabilities: undefined, protocol_version: "0.1.0" })
    );
    assert.equal(
      outcome.ok,
      true,
      `an undeclared OBSERVATION must not abort the run: ${outcome.ok ? "" : outcome.message}`
    );
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.result.status, "succeeded");
    const record = await persistedRecord("run_c020_undeclared");
    assert.ok(record, "a legacy run's diagnostic record must still be persisted");
    assert.deepEqual(record.snapshot.facts, []);
    assert.deepEqual(record.snapshot.defects.map(defectKey), ["undeclared_capability"]);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("malformed, runtime-typed, duplicate and oversize OBSERVATIONs are discarded and later collection succeeds", async () => {
  const stub = makeStub(
    [
      observation("bad1", {
        attrs: { expectation: "email_input", final: "absent", secret: SECRET_MARKER, states_seen: ["absent"] },
        fact: "element_expectation",
        step: "sign_in",
      }),
      observation("rt1", { attrs: { handle: "h1", kind: "auth", rule: "password_rejected" }, fact: "rule_match" }),
      EXPECTATION("dup1"),
      EXPECTATION("dup1"),
      observation("big1", {
        attrs: { awaited: "email_input", budget_ms: 10 },
        fact: "wait_expired",
        padding: "x".repeat(3000),
        step: "sign_in",
      }),
      EXPECTATION("ok2"),
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_discard", manifest());
    assert.equal(
      outcome.ok,
      true,
      `discarded OBSERVATIONs must not abort the run: ${outcome.ok ? "" : outcome.message}`
    );
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.result.status, "succeeded");
    const record = await persistedRecord("run_c020_discard");
    assert.ok(record, "the diagnostic record must be persisted");
    assert.deepEqual(
      record.snapshot.facts.map((fact) => fact.id),
      ["dup1", "ok2"]
    );
    const reasons = record.snapshot.defects.map(defectKey);
    assert.deepEqual(reasons.sort(), ["duplicate_id", "invalid", "oversize", "runtime_fact_type"]);
    assert.equal(JSON.stringify(record).includes(SECRET_MARKER), false, "rejected attrs must not reach the store");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("raw OBSERVATION lines, including rejected ones, never reach the runtime trace", async () => {
  const traceDir = mkdtempSync(join(tmpdir(), "pdpp-collection-profile-020-trace-"));
  const stub = makeStub(
    [
      observation("bad2", { attrs: { kind: "auth_failure", secret: SECRET_MARKER }, fact: "provider_message" }),
      EXPECTATION("ok3"),
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_trace", manifest(), { PDPP_TRACE_DIR: traceDir });
    assert.equal(outcome.ok, true, `run must succeed: ${outcome.ok ? "" : outcome.message}`);
    const traceText = readdirSync(traceDir)
      .map((name) => readFileSync(join(traceDir, name), "utf8"))
      .join("\n");
    assert.ok(
      traceText.includes("pdpp-runtime-trace"),
      "the trace file must exist, so the absence below is meaningful"
    );
    assert.equal(traceText.includes(SECRET_MARKER), false, "a rejected OBSERVATION must not be traced verbatim");
    assert.equal(traceText.includes('"ok3"'), false, "an accepted OBSERVATION must not be traced verbatim either");
    assert.ok(traceText.includes('"DONE"'), "non-OBSERVATION lines stay in the trace");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
    rmSync(traceDir, { force: true, recursive: true });
  }
});

test("a malformed line never reaches the trace or the run error, whatever its type spelling", async () => {
  // The type is JSON-escaped and the closing brace is missing: the line does not
  // parse, and a text match on "type":"OBSERVATION" cannot classify it. It must be
  // treated as possibly private, not as trace-safe.
  const traceDir = mkdtempSync(join(tmpdir(), "pdpp-collection-profile-020-trace-"));
  const stub = makeStub(
    [
      `{"type":"\\u004fBSERVATION","private":"${SECRET_MARKER}"`,
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_escaped_malformed", manifest(), { PDPP_TRACE_DIR: traceDir });
    const traceText = readdirSync(traceDir)
      .map((name) => readFileSync(join(traceDir, name), "utf8"))
      .join("\n");
    assert.ok(traceText.includes("pdpp-runtime-trace"), "the trace file must exist, so the absence below is meaningful");
    assert.equal(traceText.includes(SECRET_MARKER), false, "an unparseable line must not be traced verbatim");
    assert.equal(JSON.stringify(outcome).includes(SECRET_MARKER), false, "the run error must not carry the line");
    assert.equal(outcome.ok, false, "an unparseable line that names no OBSERVATION is still a protocol violation");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
    rmSync(traceDir, { force: true, recursive: true });
  }
});

test("prose that quotes the OBSERVATION type is not an OBSERVATION: only a line that starts as a JSON object is", async () => {
  // OBSERVATION_TYPE_TEXT_RE classifies a line that does not parse. A log line that
  // merely quotes the type pair is still a protocol violation (as any unparseable
  // line is), not a malformed OBSERVATION that is discarded while the run goes on.
  const stub = makeStub(
    [
      'note: the connector should emit {"type":"OBSERVATION"} here',
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_prose_quotes_type", manifest());
    assert.equal(outcome.ok, false, "a prose line is a protocol violation, as any unparseable line is");
    const record = await persistedRecord("run_c020_prose_quotes_type");
    assert.deepEqual(
      (record?.snapshot.defects ?? []).map(defectKey),
      [],
      "a prose line must not accrue an OBSERVATION defect"
    );
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a truncated OBSERVATION object is a discarded OBSERVATION and collection continues", async () => {
  const stub = makeStub(
    ['{"type":"OBSERVATION","id":"cut1"', { records_emitted: 0, status: "succeeded", type: "DONE" }],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_truncated_observation", manifest());
    assert.equal(
      outcome.ok,
      true,
      `a truncated OBSERVATION must not abort the run: ${outcome.ok ? "" : outcome.message}`
    );
    const record = await persistedRecord("run_c020_truncated_observation");
    assert.deepEqual((record?.snapshot.defects ?? []).map(defectKey), ["invalid"]);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("an oversize line that is not JSON records oversize without marking the record truncated", async () => {
  // This goes through the runtime's child stdout path, not the unit entry.
  const stub = makeStub(
    [
      `{"type":"OBSERVATION","id":"junk1","pad":"${"x".repeat(3000)}`,
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(stub, "run_c020_oversize_nonjson", manifest());
    assert.equal(outcome.ok, true, `run must succeed: ${outcome.ok ? "" : outcome.message}`);
    const record = await persistedRecord("run_c020_oversize_nonjson");
    assert.ok(record, "the diagnostic record must be persisted");
    assert.deepEqual(record.snapshot.defects.map(defectKey), ["oversize"]);
    assert.equal(record.snapshot.truncated, false, "text that is not JSON is no fact, so no fact was lost");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a declared-profile run whose manifest names an unknown profile version never spawns the child", async () => {
  const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const outcome = await runStub(stub, "run_c020_version", manifest({ protocol_version: "0.3.0" }));
    assert.equal(outcome.ok, false, "an unknown profile version must be rejected before spawn");
    if (!outcome.ok) {
      assert.match(outcome.message, PROTOCOL_VERSION_NAMED);
    }
    assert.equal(existsMarker(stub.markerPath), false, "the child must not execute");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("OBSERVATION or diagnostic_descriptors without protocol_version 0.2.0 are rejected before spawn", async (t) => {
  await t.test("OBSERVATION capability on a 0.1.0 manifest", async () => {
    const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
    try {
      const outcome = await runStub(stub, "run_c020_cap_010", manifest({ protocol_version: "0.1.0" }));
      assert.equal(outcome.ok, false, "a 0.1.0 manifest may not declare OBSERVATION");
      if (!outcome.ok) {
        assert.match(outcome.message, OBSERVATION_NEEDS_020);
        assert.equal(outcome.failureReason, CAPABILITY_REFUSAL_REASON);
      }
      assert.equal(existsMarker(stub.markerPath), false, "the child must not execute");
    } finally {
      rmSync(stub.dir, { force: true, recursive: true });
    }
  });
  await t.test("diagnostic_descriptors on a 0.1.0 manifest", async () => {
    const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
    try {
      const outcome = await runStub(
        stub,
        "run_c020_desc_010",
        manifest({ protocol_capabilities: [], protocol_version: "0.1.0" })
      );
      assert.equal(outcome.ok, false, "diagnostic_descriptors require 0.2.0");
      if (!outcome.ok) {
        assert.match(outcome.message, DIAGNOSTIC_DESCRIPTORS_NEEDS_020);
      }
      assert.equal(existsMarker(stub.markerPath), false, "the child must not execute");
    } finally {
      rmSync(stub.dir, { force: true, recursive: true });
    }
  });
});

test("an expectation naming an undeclared step is rejected before spawn", async () => {
  const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const outcome = await runStub(
      stub,
      "run_c020_desc_step",
      manifest({ diagnostic_descriptors: { expectations: [{ id: "email_input", step: "sign_in" }], steps: [] } })
    );
    assert.equal(outcome.ok, false, "an expectation on an undeclared step must be rejected");
    if (!outcome.ok) {
      assert.match(outcome.message, UNDECLARED_STEP);
    }
    assert.equal(existsMarker(stub.markerPath), false, "the child must not execute");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a required BLOB capability is rejected before spawn, not waived", async () => {
  const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const outcome = await runStub(
      stub,
      "run_c020_blob",
      manifest({ diagnostic_descriptors: undefined, protocol_capabilities: ["BLOB"], protocol_version: "0.1.0" })
    );
    assert.equal(outcome.ok, false, "BLOB is not implemented, so a connector that requires it must not start");
    if (!outcome.ok) {
      assert.match(outcome.message, BLOB_REFUSED);
      assert.equal(outcome.failureReason, CAPABILITY_REFUSAL_REASON);
    }
    assert.equal(existsMarker(stub.markerPath), false, "the child must not execute");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a failed DONE that cites an accepted fact yields a connector-attributed diagnosis and keeps the original text", async () => {
  const original = "Sign-in was refused by the provider";
  const stub = makeStub(
    [
      PROVIDER_REJECTED("p1"),
      {
        error: { basis: ["p1"], code: "credential_rejected", message: original, retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const outcome = await runStub(stub, "run_c020_basis", manifest());
    assert.equal(
      outcome.ok,
      true,
      `a failed DONE is a connector-reported result, not a runtime error: ${outcome.ok ? "" : outcome.message}`
    );
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.result.status, "failed");
    assert.equal((outcome.result.connector_error as { message?: string } | null)?.message, original);
    assert.equal((outcome.result.connector_error as { code?: string } | null)?.code, "credential_rejected");
    const record = await persistedRecord("run_c020_basis");
    assert.ok(record, "the diagnostic record must be persisted");
    assert.equal(record.diagnosis.category, "auth_rejected");
    assert.equal(record.diagnosis.attribution, "connector");
    assert.deepEqual(record.diagnosis.basis, ["p1"]);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

// A reader who sees a terminal run event expects the owner diagnostic record to
// exist. The test watches the store write and asks the run timeline whether the
// terminal event was already there.
async function terminalEventSeenAtStoreWrite(stub: Stub, runId: string): Promise<boolean | null> {
  const store = getDefaultConnectorObservationStore();
  const put = store.put.bind(store);
  let terminalSeen: boolean | null = null;
  const spy = mock.method(store, "put", async (input: Parameters<typeof store.put>[0]) => {
    // PostgreSQL returns a promise here, SQLite a page; await covers both.
    const page = await listSpineEventsPage("run", runId, { limit: 500 });
    terminalSeen = page.events.some((event) => event.event_type === "run.failed");
    return put(input);
  });
  try {
    await runStub(stub, runId, manifest());
  } finally {
    spy.mock.restore();
  }
  return terminalSeen;
}

test("the diagnostic record is stored before the terminal event of a failed DONE", async () => {
  const stub = makeStub(
    [
      PROVIDER_REJECTED("o1"),
      {
        error: { basis: ["o1"], code: "credential_rejected", message: "refused", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    assert.equal(await terminalEventSeenAtStoreWrite(stub, "run_c020_order_done"), false);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("the diagnostic record is stored before the terminal event of a protocol violation", async () => {
  const done = { records_emitted: 0, status: "succeeded", type: "DONE" };
  const stub = makeStub([PROVIDER_REJECTED("o2"), done, EXPECTATION("o3")], 0);
  try {
    assert.equal(await terminalEventSeenAtStoreWrite(stub, "run_c020_order_violation"), false);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a cancelled run stores no cause, even when its failed DONE cited an auth fact", async () => {
  const stub = makeStub(
    [
      PROVIDER_REJECTED("x1"),
      {
        error: { basis: ["x1"], code: "credential_rejected", message: "refused", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  const abort = new AbortController();
  try {
    // The owner's cancel lands after DONE was read and before the run closes.
    await runStub(stub, "run_c020_cancelled", manifest(), {}, {
      cancelSignal: abort.signal,
      testOnlyTerminalProcessingFaultInjector: () => abort.abort(),
    });
    const record = await persistedRecord("run_c020_cancelled");
    assert.ok(record, "the diagnostic record must be persisted");
    assert.equal(record.diagnosis.category, "unknown");
    assert.equal(record.diagnosis.attribution, "none");
    assert.deepEqual(record.diagnosis.basis, []);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a cancel that lands while the record is being stored cannot split the record from the terminal outcome", async () => {
  // The owner record is written once, before the terminal event. The terminal
  // outcome and the record's diagnosis are decided together at that write, so an
  // abort that arrives during the write changes neither: the run ends as its
  // failed DONE said, and its record keeps the cause that DONE cited.
  const stub = makeStub(
    [
      PROVIDER_REJECTED("y1"),
      {
        error: { basis: ["y1"], code: "credential_rejected", message: "refused", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  const abort = new AbortController();
  const store = getDefaultConnectorObservationStore();
  const put = store.put.bind(store);
  const spy = mock.method(store, "put", async (input: Parameters<typeof store.put>[0]) => {
    abort.abort();
    return put(input);
  });
  try {
    await runStub(stub, "run_c020_cancel_during_put", manifest(), {}, { cancelSignal: abort.signal });
  } finally {
    spy.mock.restore();
  }
  try {
    const record = await persistedRecord("run_c020_cancel_during_put");
    assert.ok(record, "the diagnostic record must be persisted");
    const page = await listSpineEventsPage("run", "run_c020_cancel_during_put", { limit: 500 });
    const terminal = page.events.map((event) => event.event_type);
    assert.equal(terminal.includes("run.cancelled"), false, "a cancel after the record is sealed does not cancel the run");
    assert.equal(terminal.includes("run.failed"), true);
    assert.equal(record.diagnosis.category, "auth_rejected");
    assert.deepEqual(record.diagnosis.basis, ["y1"]);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("uncited, retired and undeclared-rule facts cannot support a cause", async () => {
  const stub = makeStub(
    [
      PROVIDER_REJECTED("p2", "not_declared_rule"),
      PROVIDER_REJECTED("p3"),
      observation("p4", { attrs: { kind: "other" }, fact: "provider_message", resolves: ["p3"] }),
      {
        error: { basis: ["p2", "p3"], message: "Sign-in failed", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const outcome = await runStub(stub, "run_c020_nocause", manifest());
    assert.equal(outcome.ok, true, `run must resolve: ${outcome.ok ? "" : outcome.message}`);
    const record = await persistedRecord("run_c020_nocause");
    assert.ok(record, "the diagnostic record must be persisted");
    assert.equal(record.diagnosis.category, "unknown", "an undeclared rule and a retired fact support nothing");
    assert.deepEqual(record.diagnosis.basis, []);
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a DONE that cites an id the connector never emitted is rejected with no checkpoint commit", async () => {
  const stub = makeStub(
    [
      PROVIDER_REJECTED("p5"),
      {
        error: { basis: ["never_emitted"], message: "Sign-in failed", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const outcome = await runStub(stub, "run_c020_bad_basis", manifest());
    assert.equal(outcome.ok, false, "a DONE citing an id that was never emitted must fail the run");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a malformed DONE recovery hint fails the run and keeps the connector message", async () => {
  const original = "Provider unavailable";
  const stub = makeStub(
    [
      {
        error: { message: original, recovery_hint: { action: 42 }, retryable: true },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const outcome = await runStub(stub, "run_c020_bad_hint", manifest());
    assert.equal(outcome.ok, false, "a malformed hint is an invalid DONE");
    if (outcome.ok) {
      return;
    }
    assert.ok(outcome.message.includes("DONE.error.recovery_hint"), `named rule: ${outcome.message}`);
    assert.equal(outcome.connectorError?.message, original, "the bounded connector message stays visible");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a failed 0.2.0 DONE without boolean retryable is rejected", async () => {
  const stub = makeStub([{ error: { message: "boom" }, records_emitted: 0, status: "failed", type: "DONE" }], 1);
  try {
    const outcome = await runStub(stub, "run_c020_no_retryable", manifest());
    assert.equal(outcome.ok, false, "a 0.2.0 failed DONE needs a boolean retryable");
    if (!outcome.ok) {
      assert.match(outcome.message, RETRYABLE_FIELD);
    }
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a valid 0.1.0 run without OBSERVATION still succeeds", async () => {
  const stub = makeStub(
    [
      { message: "collecting", type: "PROGRESS" },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ],
    0
  );
  try {
    const outcome = await runStub(
      stub,
      "run_c020_legacy",
      manifest({ diagnostic_descriptors: undefined, protocol_capabilities: undefined, protocol_version: "0.1.0" })
    );
    assert.equal(outcome.ok, true, `legacy run must succeed: ${outcome.ok ? "" : outcome.message}`);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.result.status, "succeeded");
  } finally {
    rmSync(stub.dir, { force: true, recursive: true });
  }
});

test("a run with no OBSERVATION and no defects writes no row, so it cannot evict an informative one", async () => {
  const informativeId = "run_c020_cap_informative";
  const informative = makeStub([PROVIDER_REJECTED("p1"), { records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
  try {
    const first = await runStub(informative, informativeId, manifest());
    assert.equal(first.ok, true, `the informative run must succeed: ${first.ok ? "" : first.message}`);
    assert.ok(await persistedRecord(informativeId), "a run with an accepted fact still writes its row");
  } finally {
    rmSync(informative.dir, { force: true, recursive: true });
  }
  // More silent runs than the per-connector cap holds: legacy connectors, and a
  // 0.2.0 connector that declared OBSERVATION and sent none.
  const silentRunIds: string[] = [];
  for (let index = 0; index < CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR + 2; index += 1) {
    const stub = makeStub([{ records_emitted: 0, status: "succeeded", type: "DONE" }], 0);
    const runId = `run_c020_cap_silent_${String(index)}`;
    silentRunIds.push(runId);
    try {
      const outcome = await runStub(
        stub,
        runId,
        index % 2 === 0
          ? manifest({ diagnostic_descriptors: undefined, protocol_capabilities: undefined, protocol_version: "0.1.0" })
          : manifest()
      );
      assert.equal(outcome.ok, true, `a silent run must succeed: ${outcome.ok ? "" : outcome.message}`);
    } finally {
      rmSync(stub.dir, { force: true, recursive: true });
    }
  }
  for (const runId of silentRunIds) {
    assert.equal(await persistedRecord(runId), null, `${runId}: no OBSERVATION and no defects, so no row`);
  }
  assert.ok(
    await persistedRecord(informativeId),
    "the informative row is still there after more silent runs than the cap holds"
  );
});

function existsMarker(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
