// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * collection-profile §5.6: "A gap key counts as accounted only when the runtime
 * observed a matching DETAIL_GAP for the same stream, key, and parent boundary.
 * This holds for retryable and permanent gaps alike. A key accounted by a
 * permanent gap is accounted but not hydrated."
 *
 * Real `runConnector` against a real in-process server. Proves:
 *   - required [a, b], accepted RECORD a, permanent DETAIL_GAP b, hydrated [a],
 *     gap_keys [b]: accounting covers both keys, only `a` is hydrated, `b` has
 *     no record, no optional skip, and the permanent row stays pending.
 *   - A missing observed gap, or one for the wrong key / stream / parent, leaves
 *     the key unaccounted and withholds the parent checkpoint.
 *   - The records a coverage claim covers are durable before the claim; a crash
 *     before backing persistence cannot leave an accepted coverage proof.
 * No new STATE policy is exercised: STATE is the ordinary parent cursor.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

interface ClosableServer {
  abortStartupBackfill: (reason: string) => void;
  asPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop: () => void };
  startupBackfillDone: Promise<unknown>;
  startupSummaryEvidenceSweepDone: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
}

const typedStartServer = startServer as unknown as (opts: {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}) => Promise<ClosableServer>;

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
const runConnectorWithGapStore = runConnector as (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "test_user";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const close = (srv: { close: (cb: (err?: Error) => void) => void }) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([
    close(server.asServer),
    close(server.rsServer),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(url: string, opts: RequestInit = {}): Promise<T> {
  const response = await fetch(url, opts);
  return (await response.json()) as T;
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "pdpp_cli";
  const device = await fetchJson<{ device_code: string; user_code: string }>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return token.access_token;
}

const MANIFEST = {
  connector_id: "permanent-gap-accounting",
  display_name: "Permanent Gap Accounting",
  manifest_uri: "https://sources.example/permanent-gap-accounting",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "holdings",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
    {
      coverage_strategy: "parent_detail_accounting",
      name: "valuations",
      parent_streams: ["holdings"],
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];
function runtimeManifest(): RuntimeManifest {
  return {
    ...MANIFEST,
    streams: MANIFEST.streams.map((stream) => {
      const { selection: _selection, ...withoutSelection } = stream;
      return withoutSelection;
    }),
  };
}

function createScriptConnector(messages: readonly Record<string, unknown>[], exitAfterMs: number | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-accounting-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const m of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(m) + '\\n');
  ${exitAfterMs === null ? "rl.close(); process.exit(0);" : `setTimeout(() => process.exit(3), ${exitAfterMs});`}
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

const RECORD_A = {
  data: { id: "a" },
  emitted_at: "2026-10-15T00:00:00Z",
  key: "a",
  stream: "valuations",
  type: "RECORD",
} as const;

function permanentGap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detail_locator: { kind: "test.valuation", valuation_id: "b" },
    parent_stream: "holdings",
    reason: "source_unrepresentable",
    record_key: "b",
    reference_only: true,
    retryable: false,
    status: "pending",
    stream: "valuations",
    type: "DETAIL_GAP",
    ...overrides,
  };
}

function coverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gap_keys: ["b"],
    hydrated_keys: ["a"],
    reference_only: true,
    required_keys: ["a", "b"],
    state_stream: "holdings",
    stream: "valuations",
    type: "DETAIL_COVERAGE",
    ...overrides,
  };
}

const STATE = { cursor: { page: "1" }, stream: "holdings", type: "STATE" } as const;
const DONE = { records_emitted: 1, status: "succeeded", type: "DONE" } as const;

async function start(t: { after: (fn: () => Promise<void>) => void }) {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const asUrl = `http://localhost:${server.asPort}`;
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return { ownerToken: await issueOwnerToken(asUrl), server };
}

async function run(
  server: ClosableServer,
  ownerToken: string,
  messages: readonly Record<string, unknown>[],
  exitAfterMs: number | null = null,
  detailGapStore: unknown = getDefaultConnectorDetailGapStore()
): Promise<{ result: RuntimeRunConnectorResult | null; runId: string | null; thrown: unknown }> {
  const handle = createScriptConnector(messages, exitAfterMs);
  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      connectorPath: handle.connectorPath,
      detailGapStore,
      manifest: runtimeManifest(),
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${server.rsPort}`,
      scope: { streams: [{ name: "holdings" }, { name: "valuations" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    handle.cleanup();
  }
  const runId = result?.run_id ?? (thrown as { run_id?: string } | null)?.run_id ?? null;
  return { result, runId, thrown };
}

function spineEvents(runId: string, eventType: string) {
  return getDb()
    .prepare(
      "SELECT event_seq, event_type, stream_id, data_json FROM spine_events WHERE run_id = ? AND event_type = ? ORDER BY event_seq"
    )
    .all<{ data_json: string; event_seq: number; event_type: string; stream_id: string | null }>(runId, eventType);
}

function recordKeys(stream: string): string[] {
  return getDb()
    .prepare("SELECT record_key FROM records WHERE stream = ? ORDER BY record_key")
    .all<{ record_key: string }>(stream)
    .map((row) => row.record_key);
}

test("required [a,b], RECORD a, permanent gap b, hydrated [a], gap_keys [b]: accounted, not hydrated, not complete-by-proof", async (t) => {
  const { ownerToken, server } = await start(t);
  const { result, runId, thrown } = await run(server, ownerToken, [RECORD_A, permanentGap(), coverage(), STATE, DONE]);

  assert.equal(thrown, null);
  assert.ok(result && runId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "only the hydrated key produced a record");
  assert.deepEqual(recordKeys("valuations"), ["a"], "no record exists for the permanently lost key b");
  assert.equal(result.checkpoint_summary?.state_streams_committed, 1, "both keys are accounted, so the cursor commits");

  const [coverageEvent] = spineEvents(runId, "run.detail_coverage_declared");
  assert.ok(coverageEvent);
  const data = JSON.parse(coverageEvent.data_json) as Record<string, number>;
  assert.equal(data.required_keys, 2);
  assert.equal(data.hydrated_keys, 1, "hydrated stays 1: a permanent gap does not hydrate");
  assert.equal(data.gap_keys, 1);
  assert.equal(data.optional_skip_keys, 0, "a permanent gap is never reclassified as an optional skip");

  const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
  assert.equal(
    gaps.some((gap) => gap.reason === "detail_coverage_incomplete"),
    false,
    "the accounted key is not a shortfall"
  );
  assert.ok(
    gaps.some((gap) => gap.kind === "detail_gap"),
    "the loss stays visible as a detail_gap known gap"
  );

  const store = getDefaultConnectorDetailGapStore() as {
    listPendingGapsForConnector: (id: string) => Promise<{ retryable: boolean; status: string; record_key: string }[]>;
  };
  const rows = await store.listPendingGapsForConnector(MANIFEST.connector_id);
  assert.deepEqual(
    rows.map((row) => [row.record_key, row.status, row.retryable]),
    [["b", "pending", false]]
  );
});

const UNACCOUNTED_CASES: ReadonlyArray<{ label: string; messages: Record<string, unknown>[] }> = [
  {
    label: "gap_keys names b but no DETAIL_GAP was observed",
    messages: [RECORD_A, coverage(), STATE, DONE],
  },
  {
    label: "the observed gap is for a different key",
    messages: [
      RECORD_A,
      permanentGap({ detail_locator: { kind: "test.valuation", valuation_id: "c" }, record_key: "c" }),
      coverage(),
      STATE,
      DONE,
    ],
  },
  {
    label: "the observed gap is for a different stream",
    messages: [RECORD_A, permanentGap({ stream: "holdings" }), coverage(), STATE, DONE],
  },
  {
    label: "the observed gap names a different parent boundary",
    messages: [RECORD_A, permanentGap({ parent_stream: "valuations" }), coverage(), STATE, DONE],
  },
];

for (const unaccounted of UNACCOUNTED_CASES) {
  test(`a permanent gap does not account a key when ${unaccounted.label}`, async (t) => {
    const { ownerToken, server } = await start(t);
    const { result, thrown } = await run(server, ownerToken, unaccounted.messages);

    if (thrown !== null) {
      // A stricter parent/stream check may reject the run outright; either way
      // the key must not have been credited and nothing hydrated for b.
      assert.deepEqual(
        recordKeys("valuations").filter((key) => key === "b"),
        []
      );
      return;
    }
    assert.ok(result);
    assert.equal(result.status, "succeeded", "the run keeps the records it already ingested");
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0, "the parent checkpoint is withheld");
    const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
    assert.ok(
      gaps.some((gap) => gap.reason === "detail_coverage_incomplete"),
      "the unaccounted key is reported as a coverage shortfall"
    );
    assert.deepEqual(
      recordKeys("valuations").filter((key) => key === "b"),
      [],
      "b is never hydrated"
    );
  });
}

test("an optional_skip claim cannot launder a permanent gap into an accepted skip", async (t) => {
  const { ownerToken, server } = await start(t);
  const { result, thrown } = await run(server, ownerToken, [
    RECORD_A,
    permanentGap(),
    coverage({ gap_keys: ["b"], optional_skip_keys: ["b"] }),
    STATE,
    DONE,
  ]);
  // The same key in two outcome sets is already a protocol violation; the
  // permanent gap must not change that.
  assert.ok(thrown !== null || result?.checkpoint_summary?.state_streams_committed === 0);
});

test("crash AFTER persistence (not a before-durability proof): a=durable, b=absent, claim ordered after the flush", async (t) => {
  const { ownerToken, server } = await start(t);
  const { runId } = await run(server, ownerToken, [RECORD_A, permanentGap(), coverage()], 250);
  assert.ok(runId, "the failed run still carries a run_id to audit");

  const ingest = spineEvents(runId, "run.batch_ingested").find((event) => event.stream_id === "valuations");
  const [claim] = spineEvents(runId, "run.detail_coverage_declared");
  assert.ok(ingest, "the buffered record was flushed before the claim was made durable");
  assert.ok(claim);
  assert.ok(ingest.event_seq < claim.event_seq, "flush precedes claim");
  assert.deepEqual(recordKeys("valuations"), ["a"], "the claimed hydrated key is durable; the lost key has no record");
});

// Fault injection at the real persistence seam. The existing flush-ordering
// suite has no hook: it kills the child process. A crash AFTER the gap and
// records were persisted (the previous test) does not prove durability ordering
// for the gap itself. Here the real SQLite-backed store is wrapped so the
// permanent gap's durable write FAILS; the runtime must not leave an accepted
// coverage proof or a committed cursor that credits the unpersisted gap.
function storeFailingOnPermanentGapWrite(): unknown {
  const real = getDefaultConnectorDetailGapStore() as Record<string, unknown>;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "upsertPendingGap" || prop === "settleLeasedGapPending") {
        return () => Promise.reject(new Error("injected: durable gap write failed"));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

test("coverage that credits a permanent gap whose durable write fails cannot commit the parent cursor", async (t) => {
  const { ownerToken, server } = await start(t);
  // Coverage is declared BEFORE the gap, so the gap's failed write is the only
  // thing standing between the claim and a committed checkpoint.
  const { result, runId, thrown } = await run(
    server,
    ownerToken,
    [RECORD_A, coverage(), permanentGap(), STATE, DONE],
    null,
    storeFailingOnPermanentGapWrite()
  );

  assert.ok(thrown !== null, "the failed durable write fails the run instead of being swallowed");
  assert.equal(result, null);
  const summary = (thrown as { checkpoint_summary?: Record<string, unknown> | null }).checkpoint_summary;
  assert.notEqual(summary?.state_streams_committed, 1, "no cursor is committed over an unpersisted gap");
  assert.ok(runId);
  const store = getDefaultConnectorDetailGapStore() as {
    listPendingGapsForConnector: (id: string) => Promise<unknown[]>;
  };
  assert.deepEqual(await store.listPendingGapsForConnector(MANIFEST.connector_id), [], "no gap row exists");
});
