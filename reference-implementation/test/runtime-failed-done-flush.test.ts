// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DONE handling vs buffered records: which terminal paths make the records a
// connector already emitted durable?
//
// Records are buffered per stream and flushed at BATCH_SIZE or when the
// connector sends STATE / DETAIL_COVERAGE / STREAM_EVIDENCE /
// DETAIL_GAP_RECOVERED. Before this contract, only `DONE succeeded` flushed
// the tail, so whether a failed run's records landed depended on where the
// 500-record batch boundary fell.
//
// Contract (pinned by the table below, one real run per row):
//
//   terminal path                   | buffered tail   | STATE commit | terminal event
//   --------------------------------+-----------------+--------------+---------------
//   DONE succeeded                  | flushed         | yes          | run.completed
//   DONE failed                     | flushed         | NO           | run.failed (after the flush)
//   DONE failed, flush itself fails | dropped, counted| NO           | run.failed, connector error stays primary,
//                                   |                 |              | flush failure recorded as run.terminal_flush_failed
//   DONE succeeded, flush fails     | dropped, counted| NO           | run.failed (unchanged: run fails, no success claim)
//   DONE cancelled (connector)      | dropped         | NO           | run.failed
//   owner cancel / run timeout      | dropped         | NO           | run.cancelled / run.failed
//   exit without DONE               | dropped         | NO           | run.failed
//
// Ingest is an upsert on (connector_instance_id, stream, record_key)
// (runtime/ingest-retry.ts), so the next run re-emitting the same records is
// idempotent. STATE is never committed on a failed run, so the next run still
// re-walks from the last good checkpoint.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const ITEMS = "items";
const ORDERS = "orders";

const MANIFEST = {
  connector_id: "https://registry.pdpp.dev/connectors/failed-done-flush-stub",
  runtime_requirements: {},
  streams: [ITEMS, ORDERS].map((name) => ({
    name,
    primary_key: "id",
    schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
  })),
  version: "0.1.0",
};

type StubMessage = Record<string, unknown>;

interface RsRequest {
  body: string;
  method: string | undefined;
  pathname: string;
}

function startMockRs({ failIngest }: { failIngest: boolean }) {
  const requests: RsRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      requests.push({ body, method: req.method, pathname });
      if (req.method === "POST" && pathname.startsWith("/v1/ingest/")) {
        if (failIngest) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid or expired token" } }));
          return;
        }
        const records_accepted = body.split("\n").filter(Boolean).length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records_accepted, records_attempted: records_accepted, records_rejected: 0, rejections: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return { requests, server };
}

function record(stream: string, id: string): StubMessage {
  return { data: { id }, emitted_at: new Date().toISOString(), key: id, stream, type: "RECORD" };
}

function records(stream: string, count: number, prefix = stream): StubMessage[] {
  return Array.from({ length: count }, (_, index) => record(stream, `${prefix}_${index}`));
}

function done(status: "succeeded" | "failed" | "cancelled", recordsEmitted: number): StubMessage {
  const base = { records_emitted: recordsEmitted, status, type: "DONE" };
  return status === "succeeded"
    ? base
    : { ...base, error: { code: "upstream_boom", message: "connector-reported failure", retryable: true } };
}

function writeStub(messages: readonly StubMessage[], exitCode: number, readyFile?: string): { stubPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-failed-done-flush-"));
  const stubPath = join(tmpDir, "stub.mjs");
  // With `readyFile`, the stub emits everything except DONE, signals the test,
  // then emits DONE only on SIGTERM (the owner-cancel shape).
  const body = readyFile
    ? `
const messages = ${JSON.stringify(messages.filter((m) => m.type !== "DONE"))};
const doneMessage = ${JSON.stringify(messages.find((m) => m.type === "DONE"))};
process.on('SIGTERM', () => { process.stdout.write(JSON.stringify(doneMessage) + '\\n'); setTimeout(() => process.exit(1), 10); });
for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
writeFileSync(${JSON.stringify(readyFile)}, 'ready');
setInterval(() => {}, 1000);
`
    : `
process.stdout.write(${JSON.stringify(messages.map((m) => `${JSON.stringify(m)}
`).join(""))}, () => process.exit(${exitCode}));
`;
  writeFileSync(
    stubPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.once('line', () => {
${body}
});
`,
    "utf8"
  );
  chmodSync(stubPath, 0o755);
  return { stubPath, tmpDir };
}

function freshDb(t: TestContext): void {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-failed-done-flush-db-")), "pdpp.sqlite"));
  t.after(() => closeDb());
}

interface SpineRow {
  data_json: string;
  event_type: string;
  stream_id: string | null;
}

function spineRows(runId: string): SpineRow[] {
  return getDb()
    .prepare("SELECT event_type, stream_id, data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq ASC")
    .all(runId) as SpineRow[];
}

interface Scenario {
  cancelAfterReady?: boolean;
  exitCode: number;
  failIngest?: boolean;
  messages: readonly StubMessage[];
  runId: string;
}

async function runScenario(t: TestContext, scenario: Scenario) {
  freshDb(t);
  const { server, requests } = startMockRs({ failIngest: scenario.failIngest === true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "ephemeral port");
  const readyDir = mkdtempSync(join(tmpdir(), "pdpp-failed-done-flush-ready-"));
  const readyFile = scenario.cancelAfterReady ? join(readyDir, "ready") : undefined;
  const { stubPath, tmpDir } = writeStub(scenario.messages, scenario.exitCode, readyFile);
  const controller = new AbortController();
  if (readyFile) {
    const poll = setInterval(() => {
      if (existsSync(readyFile)) {
        clearInterval(poll);
        controller.abort();
      }
    }, 10);
    t.after(() => clearInterval(poll));
  }

  let outcome: RuntimeRunConnectorResult | null = null;
  let outcomeError: unknown = null;
  try {
    outcome = await runConnector({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
        await Promise.resolve();
        const exactId = makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
        assert.ok(connectorInstanceId === null || connectorInstanceId === exactId);
        assert.equal(ownerSubjectId, OWNER_AUTH_DEFAULT_SUBJECT_ID);
        return { connectorId, connectorInstanceId: exactId, ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID };
      },
      cancelSignal: controller.signal,
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      connectorPath: stubPath,
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract.
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract.
        async markGapStatus() {
          return null;
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract.
        async upsertPendingGap() {
          return null;
        },
      },
      manifest: MANIFEST,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double.
      onProgress: () => {},
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      ownerToken: "test-owner-token",
      persistState: true,
      rsUrl: `http://127.0.0.1:${address.port}`,
      runId: scenario.runId,
      state: null,
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    server.close();
    rmSync(tmpDir, { force: true, recursive: true });
    rmSync(readyDir, { force: true, recursive: true });
  }

  const ingested = requests
    .filter((r) => r.method === "POST" && r.pathname.startsWith("/v1/ingest/"))
    .flatMap((r) => {
      const stream = decodeURIComponent(r.pathname.slice("/v1/ingest/".length));
      return r.body
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ id: (JSON.parse(line) as { key: string }).key, stream }));
    });
  const stateCommits = requests.filter((r) => r.method === "PUT" && r.pathname.startsWith("/v1/state/"));
  return { events: spineRows(scenario.runId), ingested, outcome, outcomeError, requests, stateCommits };
}

function terminalIndex(events: readonly SpineRow[]): number {
  return events.findIndex((e) => ["run.completed", "run.failed", "run.cancelled"].includes(e.event_type));
}

function terminalData(events: readonly SpineRow[], type: string): Record<string, unknown> {
  const event = events.find((e) => e.event_type === type);
  assert.ok(event, `expected a ${type} event`);
  return JSON.parse(event.data_json) as Record<string, unknown>;
}

function assertNoIngestAfterTerminal(events: readonly SpineRow[]): void {
  const terminal = terminalIndex(events);
  assert.ok(terminal >= 0, "a terminal event was recorded");
  const lateBatches = events.slice(terminal + 1).filter((e) => e.event_type === "run.batch_ingested");
  assert.equal(lateBatches.length, 0, "no batch lands after the terminal event");
  assert.equal(
    events.filter((e) => ["run.completed", "run.failed", "run.cancelled"].includes(e.event_type)).length,
    1,
    "exactly one terminal event"
  );
}

test("DONE failed: a stream's sub-batch tail is flushed, STATE is not committed, flush precedes run.failed", async (t) => {
  // items: 502 records (one full 500 batch lands mid-run; 2 are tail).
  // orders: 3 records, never reaches a batch boundary. Before the fix the 3
  // orders were silently dropped while the 500 items had already landed.
  const messages = [...records(ITEMS, 502), ...records(ORDERS, 3), { cursor: { offset: 1 }, stream: ITEMS, type: "STATE" }];
  const tail = [record(ITEMS, "items_tail")];
  const emitted = 502 + 3 + 1;
  const { events, ingested, outcome, outcomeError, stateCommits } = await runScenario(t, {
    exitCode: 1,
    messages: [...messages, ...tail, done("failed", emitted)],
    runId: "run_failed_done_flush_tail",
  });

  assert.equal(outcomeError, null);
  assert.equal(outcome?.status, "failed");
  assert.equal(ingested.length, emitted, "every record the connector emitted reached the resource server");
  assert.equal(ingested.filter((r) => r.stream === ORDERS).length, 3, "the sub-batch stream landed");
  assert.equal(stateCommits.length, 0, "STATE is never committed on a failed run");

  assertNoIngestAfterTerminal(events);
  const data = terminalData(events, "run.failed");
  assert.equal(data.reason, "connector_reported_failed");
  assert.equal(data.buffered_records_dropped, 0, "nothing is left buffered");
  assert.equal(data.records_flushed, emitted, "terminal counts reflect what landed");
  assert.equal(data.connector_error_code, "upstream_boom");
  assert.equal(data.checkpoint_commit_status, "not_committed");
  assert.equal(data.ingest_failure, undefined, "a clean flush records no ingest failure");
});

test("DONE failed: a flush failure never replaces the connector's error", async (t) => {
  const { events, ingested, outcome, outcomeError, stateCommits } = await runScenario(t, {
    exitCode: 1,
    failIngest: true,
    messages: [...records(ORDERS, 3), done("failed", 3)],
    runId: "run_failed_done_flush_fails",
  });

  assert.equal(outcomeError, null, "the run still terminates as a failed result, not a runtime throw");
  assert.equal(outcome?.status, "failed");
  assert.equal(ingested.length, 3, "the flush was attempted");
  assert.equal(stateCommits.length, 0);

  assertNoIngestAfterTerminal(events);
  const data = terminalData(events, "run.failed");
  assert.equal(data.reason, "connector_reported_failed", "the connector's failure stays the primary reason");
  assert.equal(data.connector_error_code, "upstream_boom");
  assert.equal(data.connector_error_message, "connector-reported failure");
  assert.equal(data.ingest_failure, undefined, "the terminal event keeps only the connector's failure");
  const flushFailed = events.filter((e) => e.event_type === "run.terminal_flush_failed");
  assert.equal(flushFailed.length, 1, "the flush failure is recorded as its own event");
  assert.ok(
    events.findIndex((e) => e.event_type === "run.terminal_flush_failed") < terminalIndex(events),
    "the flush failure is recorded before the terminal event"
  );
  assert.ok(JSON.parse((flushFailed[0] as SpineRow).data_json).ingest_failure, "with the ingest failure detail");
  assert.equal(data.buffered_records_dropped, 3, "the records that did not land are counted as dropped");
  assert.equal(outcome?.connector_error?.code, "upstream_boom");
});

test("DONE succeeded: the tail is flushed and STATE is committed (control)", async (t) => {
  const { events, ingested, outcome, stateCommits } = await runScenario(t, {
    exitCode: 0,
    messages: [...records(ORDERS, 3), { cursor: { offset: 1 }, stream: ORDERS, type: "STATE" }, ...records(ITEMS, 2), done("succeeded", 5)],
    runId: "run_failed_done_flush_succeeded",
  });

  assert.equal(outcome?.status, "succeeded");
  assert.equal(ingested.length, 5);
  assert.equal(stateCommits.length, 1);
  assertNoIngestAfterTerminal(events);
});

test("DONE cancelled (connector-reported): buffered records are dropped and STATE is not committed", async (t) => {
  const { events, ingested, outcome, stateCommits } = await runScenario(t, {
    exitCode: 1,
    messages: [...records(ORDERS, 3), done("cancelled", 3)],
    runId: "run_failed_done_flush_connector_cancelled",
  });

  assert.equal(outcome?.status, "cancelled");
  assert.equal(ingested.length, 0, "a connector-reported cancel is a revoke-shaped stop: nothing new is ingested");
  assert.equal(stateCommits.length, 0);
  assertNoIngestAfterTerminal(events);
  assert.equal(terminalData(events, "run.failed").buffered_records_dropped, 3);
});

test("owner cancel before a failed DONE is handled: nothing is ingested", async (t) => {
  const { events, ingested, outcome, outcomeError, stateCommits } = await runScenario(t, {
    cancelAfterReady: true,
    exitCode: 1,
    messages: [...records(ORDERS, 3), done("failed", 3)],
    runId: "run_failed_done_flush_owner_cancel",
  });

  const result = (outcome ?? outcomeError) as { status?: unknown };
  assert.equal(result.status, "cancelled");
  assert.equal(ingested.length, 0, "cancellation never ingests buffered records");
  assert.equal(stateCommits.length, 0);
  assertNoIngestAfterTerminal(events);
  assert.ok(events.some((e) => e.event_type === "run.cancelled"));
  assert.ok(!events.some((e) => e.event_type === "run.failed"));
});

test("exit without DONE: buffered records stay dropped (unchanged)", async (t) => {
  const { events, ingested, outcome, outcomeError, stateCommits } = await runScenario(t, {
    exitCode: 1,
    messages: records(ORDERS, 3),
    runId: "run_failed_done_flush_no_done",
  });

  const result = (outcome ?? outcomeError) as { status?: unknown };
  assert.equal(result.status, "failed");
  assert.equal(ingested.length, 0);
  assert.equal(stateCommits.length, 0);
  assertNoIngestAfterTerminal(events);
});

test("DONE failed with nothing buffered: no extra ingest, STATE still not committed", async (t) => {
  // STATE flushes the stream, so the DONE-time flush has nothing to send.
  const { events, ingested, outcome, stateCommits } = await runScenario(t, {
    exitCode: 1,
    messages: [...records(ORDERS, 3), { cursor: { offset: 1 }, stream: ORDERS, type: "STATE" }, done("failed", 3)],
    runId: "run_failed_done_flush_empty_buffer",
  });

  assert.equal(outcome?.status, "failed");
  assert.equal(ingested.length, 3, "records are ingested exactly once");
  assert.equal(stateCommits.length, 0);
  assertNoIngestAfterTerminal(events);
  assert.equal(terminalData(events, "run.failed").buffered_records_dropped, 0);
});

test("DONE succeeded with a failing flush: the run fails and STATE is not committed (unchanged)", async (t) => {
  const { events, outcome, outcomeError, stateCommits } = await runScenario(t, {
    exitCode: 0,
    failIngest: true,
    messages: [...records(ORDERS, 3), done("succeeded", 3)],
    runId: "run_failed_done_flush_succeeded_flush_fails",
  });

  assert.equal(outcome, null, "a succeeded run whose flush fails does not resolve");
  assert.equal((outcomeError as { failure_reason?: unknown } | null)?.failure_reason, "authentication_error");
  assert.equal(stateCommits.length, 0);
  assertNoIngestAfterTerminal(events);
  assert.ok(events.some((e) => e.event_type === "run.failed"));
  assert.ok(!events.some((e) => e.event_type === "run.completed"));
});
