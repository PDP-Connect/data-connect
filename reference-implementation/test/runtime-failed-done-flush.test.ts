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
//   certified stream-scoped failure,| dropped, counted| staged       | run.failed, as above
//   flush itself fails              |                 | siblings only|
//   DONE succeeded, flush fails     | dropped, counted| NO           | run.failed (unchanged: run fails, no success claim)
//   DONE cancelled (connector)      | dropped         | NO           | run.failed
//   owner cancel / run timeout      | dropped         | NO           | run.cancelled / run.failed
//   exit without DONE               | dropped         | NO           | run.failed
//
// Ingest is an upsert on (connector_instance_id, stream, record_key)
// (runtime/ingest-retry.ts), so the next run re-emitting the same records is
// idempotent. An ordinary failed run commits no STATE, so the next run still
// re-walks from the last good checkpoint. A certified stream-scoped failure
// (DONE.error.code "stream_collection_failed" plus a matching SKIP_RESULT)
// commits the staged checkpoints of its other streams; a failed terminal flush
// does not change that, because STATE flushes its stream and every stream it
// owns before the cursor is staged, so a committed cursor never covers a
// dropped record.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const ITEMS = "items";
const ORDERS = "orders";
const ORDER_NOTES = "order_notes";

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

// `failIngestAfter` lets that many ingest POSTs succeed before every later
// one fails; `failIngest` is the same with zero. Ingests for `driftStreams`
// are answered as transient manifest drift (404 not_found).
function startMockRs({
  driftStreams = [],
  failIngestAfter,
}: {
  driftStreams?: readonly string[];
  failIngestAfter: number | null;
}) {
  let ingestPosts = 0;
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
        if (driftStreams.includes(decodeURIComponent(pathname.slice("/v1/ingest/".length)))) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "not_found", message: "stream not declared by the connector" } }));
          return;
        }
        ingestPosts += 1;
        if (failIngestAfter !== null && ingestPosts > failIngestAfter) {
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
  driftStreams?: readonly string[];
  exitCode: number;
  failIngest?: boolean;
  failIngestAfter?: number;
  manifest?: typeof MANIFEST;
  messages: readonly StubMessage[];
  runId: string;
}

async function runScenario(t: TestContext, scenario: Scenario) {
  freshDb(t);
  const failIngestAfter = scenario.failIngest === true ? 0 : (scenario.failIngestAfter ?? null);
  const { server, requests } = startMockRs({
    failIngestAfter,
    ...(scenario.driftStreams ? { driftStreams: scenario.driftStreams } : {}),
  });
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
      manifest: scenario.manifest ?? MANIFEST,
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

test("certified stream-scoped failure with a failing terminal flush: the staged sibling checkpoint still commits", async (t) => {
  // items: 2 records, then STATE (flushes both and stages the cursor), then 1
  // tail record. orders: 3 records, then the connector certifies orders as the
  // failed stream. The first ingest POST (the STATE flush) succeeds; the
  // terminal flush fails, so the items tail and all orders are dropped. The
  // items cursor covers only the 2 records that landed, so it commits.
  const { events, outcome, outcomeError, requests, stateCommits } = await runScenario(t, {
    exitCode: 1,
    failIngestAfter: 1,
    messages: [
      ...records(ITEMS, 2),
      { cursor: { offset: 2 }, stream: ITEMS, type: "STATE" },
      record(ITEMS, "items_tail"),
      ...records(ORDERS, 3),
      { message: "upstream 500", reason: "stream_collection_failed", stream: ORDERS, type: "SKIP_RESULT" },
      {
        error: {
          code: "stream_collection_failed",
          message: "stream collection failed: orders: upstream 500",
          retryable: true,
        },
        records_emitted: 6,
        status: "failed",
        type: "DONE",
      },
    ],
    runId: "run_failed_done_flush_certified_partial",
  });

  assert.equal(outcomeError, null);
  assert.equal(outcome?.status, "failed");
  assert.equal(outcome?.connector_error?.code, "stream_collection_failed", "the connector's error stays primary");
  assert.deepEqual(
    stateCommits.map((r) => decodeURIComponent(r.pathname)),
    // The runtime addresses state by the connector key when it can derive one.
    [`/v1/state/${canonicalConnectorKey(MANIFEST.connector_id) ?? MANIFEST.connector_id}`],
    "exactly one STATE commit"
  );
  assert.deepEqual(
    Object.keys((JSON.parse((stateCommits[0] as RsRequest).body) as { state: Record<string, unknown> }).state),
    [ITEMS],
    "only the sibling's checkpoint commits"
  );
  const acceptedPost = requests.find((r) => r.method === "POST" && r.pathname.startsWith("/v1/ingest/"));
  assert.equal(acceptedPost?.pathname, `/v1/ingest/${ITEMS}`);
  assert.deepEqual(
    acceptedPost?.body
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { key: string }).key),
    ["items_0", "items_1"],
    "the one accepted ingest, at STATE, holds exactly the records the committed cursor covers"
  );

  assertNoIngestAfterTerminal(events);
  assert.equal(events.filter((e) => e.event_type === "run.terminal_flush_failed").length, 1);
  const data = terminalData(events, "run.failed");
  assert.equal(data.connector_error_code, "stream_collection_failed");
  assert.equal(data.buffered_records_dropped, 4, "the items tail and the orders did not land");
});

test("certified stream-scoped failure with a failing terminal flush: a parent's STATE first makes its co-emitted child's records durable", async (t) => {
  // order_notes declares state_stream: orders, so the orders cursor vouches
  // for the notes buffered before it. items fails and is certified. Two
  // ingest POSTs succeed; the terminal flush then fails. If STATE flushed only
  // orders, the terminal flush would deliver items first (it was buffered
  // first), fail on order_notes, and the committed orders cursor would cover
  // two dropped notes.
  const manifest = {
    ...MANIFEST,
    streams: [
      ...MANIFEST.streams.filter((stream) => stream.name === ITEMS),
      { ...(MANIFEST.streams[0] as (typeof MANIFEST.streams)[number]), name: ORDERS },
      { ...(MANIFEST.streams[0] as (typeof MANIFEST.streams)[number]), name: ORDER_NOTES, state_stream: ORDERS },
    ],
  };
  const { outcome, outcomeError, requests, stateCommits } = await runScenario(t, {
    exitCode: 1,
    failIngestAfter: 2,
    manifest,
    messages: [
      ...records(ITEMS, 2),
      ...records(ORDER_NOTES, 2),
      record(ORDERS, "orders_0"),
      { cursor: { offset: 1 }, stream: ORDERS, type: "STATE" },
      { message: "upstream 500", reason: "stream_collection_failed", stream: ITEMS, type: "SKIP_RESULT" },
      {
        error: { code: "stream_collection_failed", message: "stream collection failed: items: upstream 500", retryable: true },
        records_emitted: 5,
        status: "failed",
        type: "DONE",
      },
    ],
    runId: "run_failed_done_flush_shared_parent",
  });

  assert.equal(outcomeError, null);
  assert.equal(outcome?.status, "failed");
  assert.deepEqual(
    stateCommits.map((r) => Object.keys((JSON.parse(r.body) as { state: Record<string, unknown> }).state)),
    [[ORDERS]],
    "the parent's checkpoint commits"
  );
  const acceptedPosts = requests
    .filter((r) => r.method === "POST" && r.pathname.startsWith("/v1/ingest/"))
    .slice(0, 2)
    .map((r) => ({
      keys: r.body
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { key: string }).key),
      stream: decodeURIComponent(r.pathname.slice("/v1/ingest/".length)),
    }));
  assert.deepEqual(
    acceptedPosts,
    [
      { keys: ["orders_0"], stream: ORDERS },
      { keys: ["order_notes_0", "order_notes_1"], stream: ORDER_NOTES },
    ],
    "both accepted ingests happen at STATE and hold every record the committed cursor covers"
  );
});

test("a parent's cursor is not staged when its co-emitted child's batch was dropped as manifest drift", async (t) => {
  // order_notes declares state_stream: orders. The notes ingest is answered
  // as transient manifest drift, which drops the batch and returns normally.
  // Staging the orders cursor would commit a checkpoint that covers notes
  // the server never stored, and the next run would not collect them again.
  const manifest = {
    ...MANIFEST,
    streams: [
      { ...(MANIFEST.streams[0] as (typeof MANIFEST.streams)[number]), name: ORDERS },
      { ...(MANIFEST.streams[0] as (typeof MANIFEST.streams)[number]), name: ORDER_NOTES, state_stream: ORDERS },
    ],
  };
  const { ingested, outcomeError, stateCommits } = await runScenario(t, {
    driftStreams: [ORDER_NOTES],
    exitCode: 0,
    manifest,
    messages: [
      ...records(ORDER_NOTES, 2),
      record(ORDERS, "orders_0"),
      { cursor: { offset: 1 }, stream: ORDERS, type: "STATE" },
      done("succeeded", 3),
    ],
    runId: "run_failed_done_flush_child_drift",
  });

  assert.equal(outcomeError, null);
  assert.deepEqual(
    ingested.map((r) => r.stream).sort(),
    [ORDER_NOTES, ORDER_NOTES, ORDERS],
    "both streams were sent; the notes were answered as drift"
  );
  assert.deepEqual(
    stateCommits.flatMap((r) => Object.keys((JSON.parse(r.body) as { state: Record<string, unknown> }).state)),
    [],
    "no committed cursor covers the dropped notes"
  );
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
