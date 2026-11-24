// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector `DETAIL_GAP_RECOVERED` for a gap that is not leased to the run reads
 * the gap, awaits `flushAll()` (an ingest round trip), then writes the status. A
 * run the controller's watchdog has already force-finalized can still be inside
 * that flush while the next run on the same connection records the same record
 * as permanent. The old run's late write must not turn a permanent loss into a
 * recovered, hydrated-looking one.
 *
 * The fake record store holds its ingest response so the interleaving is
 * deterministic: the second writer (a stand-in for the new run) and the abort
 * both land while the old run's handler is parked in the flush. Real SQLite store
 * always; real Postgres when `PDPP_TEST_POSTGRES_URL` names an isolated test
 * database. The abort case uses the abort signal the controller watchdog calls
 * (`cancellation.abort.abort()`) as a stand-in for the watchdog itself: it does not
 * run the controller. Authored failing-first.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
} from "../server/stores/connector-detail-gap-store.ts";

type Store = ReturnType<typeof createSqliteConnectorDetailGapStore>;
type RunOptions = Parameters<typeof runConnector>[0];

const CONNECTOR_ID = "recovered_race_conn";
const INSTANCE_ID = "cin_recovered_race";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL as string;

interface Backend {
  readonly name: string;
  readonly run: (fn: (store: Store) => Promise<void>) => Promise<void>;
}

const BACKENDS: readonly Backend[] = [
  {
    name: "sqlite",
    run: async (fn) => {
      const dir = mkdtempSync(join(tmpdir(), "pdpp-recovered-race-"));
      initDb(join(dir, "pdpp.sqlite"));
      try {
        await fn(createSqliteConnectorDetailGapStore());
      } finally {
        closeDb();
        rmSync(dir, { force: true, recursive: true });
      }
    },
  },
  ...(POSTGRES_URL
    ? [
        {
          name: "postgres",
          run: async (fn: (store: Store) => Promise<void>) => {
            initDb(":memory:");
            await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
            try {
              await fn(createPostgresConnectorDetailGapStore() as unknown as Store);
            } finally {
              await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [CONNECTOR_ID]);
              await closePostgresStorage();
              closeDb();
            }
          },
        },
      ]
    : []),
];

interface HeldRecordStore {
  readonly close: () => Promise<void>;
  /** Resolves when the first ingest request has arrived and is being held. */
  readonly ingestHeld: Promise<void>;
  readonly releaseIngest: () => void;
  readonly rsUrl: string;
}

async function startHeldRecordStore(): Promise<HeldRecordStore> {
  let markHeld: () => void = () => undefined;
  const ingestHeld = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/ingest/")) {
      markHeld();
      await released;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    ingestHeld,
    releaseIngest: release,
    rsUrl: `http://127.0.0.1:${address.port}`,
  };
}

function recoveringConnector(gapId: string): { cleanup: () => void; connectorPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-recovered-race-connector-"));
  const connectorPath = join(dir, "connector.mjs");
  const messages = [
    {
      data: { id: "msg_1" },
      emitted_at: new Date().toISOString(),
      key: "msg_1",
      stream: "messages",
      type: "RECORD",
    },
    // No lease_id: the gap is not leased to this run (its retry floor keeps it out of START).
    { gap_id: gapId, record_key: "k1", reference_only: true, stream: "messages", type: "DETAIL_GAP_RECOVERED" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const m of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(m) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

const IDENTITY = {
  connectorId: CONNECTOR_ID,
  connectorInstanceId: INSTANCE_ID,
  detailLocator: { item: "k1", kind: "test.item" },
  grantId: "grant_1",
  recordKey: "k1",
  stream: "messages",
};

async function seedUnleasedTransientGap(store: Store): Promise<string> {
  const gap = await store.upsertPendingGap({
    ...IDENTITY,
    // A future retry floor keeps the gap out of START, so the run never leases it.
    nextAttemptAfter: "2099-01-01T00:00:00.000Z",
    now: "2026-06-01T00:00:00.000Z",
    reason: "temporary_unavailable",
    retryable: true,
  });
  assert.ok(gap);
  return gap.gap_id;
}

interface ObservedStore {
  /** Resolves once the runtime has read the (transient) gap, before its flush. */
  readonly preReadDone: Promise<void>;
  readonly store: Store;
}

/**
 * Wraps a real store so the test can prove the old run's read of the gap happened
 * before the second writer's classification, without sleeping.
 */
function observeGapReads(store: Store, gapId: string): ObservedStore {
  let markRead: () => void = () => undefined;
  const preReadDone = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  const wrapped = new Proxy(store as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "getGapById" && typeof value === "function") {
        return async (id: string) => {
          const row = await (value as (id: string) => Promise<unknown>).call(target, id);
          if (id === gapId) {
            markRead();
          }
          return row;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Store;
  return { preReadDone, store: wrapped };
}

/** Yields the event loop a fixed number of turns (no wall-clock sleep). */
async function drainEventLoop(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn must complete before the next.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function runRecoveringConnector(
  store: Store,
  connectorPath: string,
  rsUrl: string,
  extra: Partial<RunOptions> = {}
): Promise<unknown> {
  return runConnector({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? makeDefaultAccountConnectorInstanceId("owner_local", connectorId),
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    connectorPath,
    detailGapStore: store,
    grantId: "grant_1",
    manifest: { streams: [{ name: "messages" }] },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    onProgress: () => {},
    ownerToken: "owner",
    persistState: false,
    rsUrl,
    ...extra,
  } as RunOptions).then(
    (value) => value,
    (error: unknown) => error
  );
}

/**
 * Event types recorded for a run id the TEST chose (passed as `runId` to the run), so the
 * query cannot silently use a null id taken from a failed run's error. Asserts the id is
 * real by requiring that the run recorded at least one event; an absent
 * `run.detail_gap_recovered` is then a meaningful negative, not an empty result.
 */
async function runEventTypes(runId: string): Promise<string[]> {
  assert.ok(runId, "the run id is known before the run starts");
  // The spine lives in the active storage backend: Postgres when it is enabled, else SQLite.
  const types = isPostgresStorageBackend()
    ? (
        await postgresQuery<{ event_type: string }>("SELECT event_type FROM spine_events WHERE run_id = $1", [runId])
      ).rows.map((row) => row.event_type)
    : getDb()
        .prepare("SELECT event_type FROM spine_events WHERE run_id = ?")
        .all<{ event_type: string }>(runId)
        .map((row) => row.event_type);
  assert.ok(types.length > 0, `the run ${runId} recorded events, so the absence check below is not vacuous`);
  return types;
}

let runSequence = 0;
function nextRunId(): string {
  runSequence += 1;
  return `run_recovered_race_${Date.now()}_${runSequence}`;
}

for (const backend of BACKENDS) {
  test(`[${backend.name}] a permanent classification written while an unleased recovery claim is flushing is not overwritten`, async () => {
    await backend.run(async (store) => {
      const gapId = await seedUnleasedTransientGap(store);
      const held = await startHeldRecordStore();
      const connector = recoveringConnector(gapId);
      const observed = observeGapReads(store, gapId);
      const runId = nextRunId();
      try {
        const outcomePromise = runRecoveringConnector(observed.store, connector.connectorPath, held.rsUrl, { runId });
        // Latches, not sleeps: the old handler has READ the transient gap and is parked in its flush.
        await observed.preReadDone;
        await held.ingestHeld;
        // Stand-in for the next run on the same connection: it records the SAME
        // identity as permanent while the old handler is parked in its flush.
        await store.upsertPendingGap({
          ...IDENTITY,
          now: "2026-06-02T00:00:00.000Z",
          reason: "source_unrepresentable",
          retryable: false,
        });
        held.releaseIngest();
        await outcomePromise;

        const after = await store.getGapById(gapId);
        assert.equal(after?.retryable, false, "the permanent classification survives the late write");
        assert.equal(after?.status, "pending", "no recovery is recorded over a permanent loss");
        assert.equal(after?.recovered_run_id, null);
        assert.equal(
          (await runEventTypes(runId)).includes("run.detail_gap_recovered"),
          false,
          "no recovery event or accounting credit for the refused claim"
        );
      } finally {
        connector.cleanup();
        await held.close();
      }
    });
  });

  test(`[${backend.name}] a cancelled run's parked recovery claim does not record recovery after the flush returns`, async () => {
    await backend.run(async (store) => {
      const gapId = await seedUnleasedTransientGap(store);
      const held = await startHeldRecordStore();
      const connector = recoveringConnector(gapId);
      const abort = new AbortController();
      const runId = nextRunId();
      try {
        const outcomePromise = runRecoveringConnector(store, connector.connectorPath, held.rsUrl, {
          cancelSignal: abort.signal,
          runId,
        });
        await held.ingestHeld;
        // Stand-in for the controller watchdog: abort first, then the flush returns.
        abort.abort();
        held.releaseIngest();
        await outcomePromise;
        // The cancelled run can settle before its parked handler does; yield until it has.
        await drainEventLoop();

        const after = await store.getGapById(gapId);
        assert.notEqual(after?.status, "recovered", "a stopped run must not write a recovery after its flush");
        assert.equal(
          (await runEventTypes(runId)).includes("run.detail_gap_recovered"),
          false,
          "and must not emit a recovery event"
        );
      } finally {
        connector.cleanup();
        await held.close();
      }
    });
  });
}
