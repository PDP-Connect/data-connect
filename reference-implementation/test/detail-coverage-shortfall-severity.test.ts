// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Regression for run_1786242751717 (live UAT, 2026-08-08).
//
// A run authenticated, ingested real records, and then died with
// terminal_reason=connector_protocol_violation and an EMPTY connector_error_json
// — the owner saw a failure with no explanation at all. The precise reason
// ("Connector detail coverage incomplete: state_stream=... stream=...
// missing_required_keys=1") reached only the container log.
//
// Two distinct defects, both proven from the live DB:
//
// 1. SEVERITY. The connector declared DETAIL_COVERAGE for two child streams off
//    the same parent key. For the key it could not hydrate this run it declared
//    `gap_keys: [key]` on BOTH coverage entries — an honest report — but emitted
//    a durable DETAIL_GAP for only ONE of the two streams. The commit gate
//    matched durable gaps strictly by `gap.stream === coverage.stream`
//    (runtime/index.ts) and never consulted the connector's own `gap_keys`, so
//    the second stream's key counted as unaccounted and the gate THREW,
//    terminating a run whose records were already flushed and durable.
//
//    A DETAIL_COVERAGE shortfall is a coverage GAP, not a protocol violation:
//    the connector spoke a well-formed protocol and told the truth about what it
//    could not reach. The honest response is to report the shortfall and
//    withhold that state_stream's cursor (so the next run re-collects it) — not
//    to fail a run and discard the evidence of work already committed.
//
// 2. REPORTING. The runtime authored a precise `failure_message` onto the
//    terminal spine event, but the run_history writer reassembled
//    connector_error_json from `connector_error_*` fields only. A run the
//    RUNTIME failed carries none of those (the connector reported DONE with no
//    error), so the column was written NULL and the explanation was lost. Live
//    evidence: run_1786242751717 stored connector_error_json=null / error=null
//    while the terminal spine event carried the full failure_message.
//
// Live shape reproduced here connector-agnostically: parent state_stream with
// one required key, two child streams both declaring that key as a gap, only one
// carrying a durable DETAIL_GAP.
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";

import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Hoisted: the coverage-shortfall explanation the runtime authors, and the
// connection-scoped denominator the sibling-isolation oracle asserts on.
const SHORTFALL_MESSAGE_PATTERN =
  /Connector detail coverage incomplete: state_stream=holdings stream=valuations missing_required_keys=1/;
const SCOPED_DENOMINATOR_PATTERN = /stream=valuations missing_required_keys=1/;
const HOLDINGS_STATE_STREAM_PATTERN = /state_stream=holdings/;
const ACTIVITY_STATE_STREAM_PATTERN = /state_stream=activity/;
const DUPLICATE_COVERAGE_PATTERN = /duplicate DETAIL_COVERAGE/;
const OVERLAPPING_OUTCOME_PATTERN = /outcome key appears in multiple sets/;
const UNKNOWN_CAPABILITY_PATTERN = /protocol_capabilities must be an array of known capability names/;
const UNSUPPORTED_CAPABILITY_PATTERN = /requires protocol capabilities this runtime does not support: (\S+)/;
const STALL_MESSAGE_PATTERN =
  /withheld for 3 consecutive runs, each time because activity left required keys uncredited/;

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

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}

const typedStartServer = startServer as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;

// Mirrors the production `createController({ admitRunConnection: ... })` wiring:
// state-commit ingest checks the bearer token's subject against the target
// instance's owner, so admission must resolve the same subject issueOwnerToken
// approved. Same fixture as detail-coverage-recovered-gap-regression.test.ts.
function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "test_user"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const c = (srv: { close: (cb: (err?: Error) => void) => void }) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, 2000);
      srv.close(() => {
        clearTimeout(t);
        r();
      });
    });
  await Promise.allSettled([
    c(server.asServer),
    c(server.rsServer),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "pdpp_cli";
  const { body: device } = await fetchJson<DeviceAuthorizationResponse>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return body.access_token;
}

// Connector-agnostic shape of the live failure: one parent state_stream
// ("holdings") whose key fans out to two child detail streams.
const MANIFEST = {
  connector_id: "coverage-shortfall-regression",
  display_name: "Coverage Shortfall Regression",
  manifest_uri: "https://registry.pdpp.dev/connectors/coverage-shortfall-regression",
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
      name: "activity",
      primary_key: ["id"],
      relationships: [{ cardinality: "has_one", foreign_key: "holding_id", name: "holding", stream: "holdings" }],
      schema: {
        properties: { holding_id: { type: "string" }, id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
    {
      coverage_strategy: "parent_detail_accounting",
      name: "valuations",
      parent_streams: ["holdings", "activity"],
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

/**
 * The same connector, declaring DETAIL_COVERAGE_KEY_SETS. Only a connector that
 * declares it gets evidence-based crediting of hydrated keys; MANIFEST keeps
 * the crediting it had before the capability existed. The capability is new in
 * Collection Profile 0.2.0, so the manifest declares that version (Section 3.1).
 */
const KEY_SETS_MANIFEST = {
  ...MANIFEST,
  protocol_capabilities: ["DETAIL_COVERAGE_KEY_SETS"],
  protocol_version: "0.2.0",
};

function createCannedConnector(messages: readonly Record<string, unknown>[]): {
  connectorPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-coverage-shortfall-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

/**
 * The live message sequence: a record is emitted and flushed, one child stream
 * declares a gap for key K AND carries a durable DETAIL_GAP, the sibling child
 * stream declares the SAME key as a gap but carries NO durable DETAIL_GAP.
 * Before the fix the sibling's key was unaccounted and the gate threw.
 */
function shortfallMessages(): Record<string, unknown>[] {
  return [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      detail_locator: { holding_id: "K", kind: "test.holding" },
      parent_stream: "holdings",
      reason: "temporary_unavailable",
      record_key: "K",
      retryable: true,
      status: "pending",
      stream: "activity",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["K"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "activity",
      type: "DETAIL_COVERAGE",
    },
    // Sibling child stream: same unreachable key, honestly declared as a gap,
    // but with no durable DETAIL_GAP of its own. This is the exact live shape.
    {
      gap_keys: ["K"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];
}

async function runShortfall(
  server: ClosableServer,
  ownerToken: string,
  messages: readonly Record<string, unknown>[],
  connectorInstanceId?: string,
  streams: readonly string[] = ["holdings", "activity", "valuations"],
  manifest: typeof MANIFEST = MANIFEST
): Promise<{ result: RuntimeRunConnectorResult | null; thrown: unknown }> {
  const { connectorPath, cleanup } = createCannedConnector(messages);
  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      ...(connectorInstanceId ? { connectorInstanceId } : {}),
      connectorPath,
      detailGapStore: getDefaultConnectorDetailGapStore(),
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${server.rsPort}`,
      scope: { streams: streams.map((name) => ({ name })) },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }
  return { result, thrown };
}

async function registerAndAuthorize(server: ClosableServer): Promise<string> {
  const asUrl = `http://localhost:${server.asPort}`;
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return await issueOwnerToken(asUrl);
}

// A gap_keys declaration is diagnostic, not retry authority. Without a matching
// durable DETAIL_GAP the runtime must keep the parent checkpoint uncommitted so
// a connector cannot turn an assertion into evidence and strand the detail.
test("a connector-declared gap key without a durable DETAIL_GAP withholds the parent checkpoint", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const { result, thrown } = await runShortfall(server, ownerToken, shortfallMessages());

  assert.equal(thrown, null, "an unbacked coverage gap is incomplete, not a protocol crash");
  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded", "the run keeps the records it already ingested");
  assert.equal(result.records_emitted, 1);
  assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 0, "the shared holdings parent remains uncommitted");
  assert.equal(result.checkpoint_summary?.commit_status, "not_committed");
});

// Required oracle: two instances of the SAME connector, one REVOKED (holding a
// durable detail gap of its own) and one ACTIVE. A revoked or sibling connection
// must never participate in the active run's coverage authority — neither
// satisfying its required keys nor inflating its denominator. The active run
// must retain its committed records and report its own bounded gap honestly.
test("a revoked sibling connection never participates in the active run's coverage authority", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const store = getDefaultConnectorDetailGapStore() as {
    upsertPendingGap: (input: Record<string, unknown>) => Promise<{ gap_id: string } | null>;
  };

  const revokedInstanceId = "cin_shortfall_revoked_sibling";
  const activeInstanceId = "cin_shortfall_active";

  // The live shape: one connector_id with a revoked connection and an active
  // one. Distinct binding keys — the store keys account bindings by
  // (connector_id, source_binding_key), so a shared key would collapse both
  // onto a single row and there would be no sibling at all.
  const instanceStore = createRequestConnectorInstanceStore();
  for (const [connectorInstanceId, status] of [
    [revokedInstanceId, "revoked"],
    [activeInstanceId, "active"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential fixture seeding.
    await instanceStore.upsert({
      connectorId: MANIFEST.connector_id,
      connectorInstanceId,
      createdAt: "2026-05-20T12:00:00.000Z",
      displayName: "Shortfall Connection",
      ownerSubjectId: "test_user",
      sourceBinding: { account_id: connectorInstanceId, kind: "account" },
      sourceBindingKey: connectorInstanceId,
      sourceKind: "account",
      status,
      updatedAt: "2026-05-20T12:00:00.000Z",
    });
  }

  // The revoked sibling owns a durable pending gap for the SAME record key the
  // active run will require. Scoped to the active run's own connection, this row
  // must be invisible: it belongs to a different connector_instance_id.
  const seeded = await store.upsertPendingGap({
    connectorId: MANIFEST.connector_id,
    connectorInstanceId: revokedInstanceId,
    detailLocator: { holding_id: "K", kind: "test.holding" },
    discoveredRunId: "prior_revoked",
    grantId: null,
    lastError: null,
    lastRunId: "prior_revoked",
    listCursor: null,
    parentStream: "holdings",
    reason: "temporary_unavailable",
    recordKey: "K",
    scope: null,
    source: { id: MANIFEST.connector_id, kind: "connector" },
    stream: "valuations",
  });
  assert.ok(seeded, "the revoked sibling's durable gap is seeded");

  // The active connection declares key K required with nothing to account for it
  // in ITS OWN authority. The sibling's gap must not silently satisfy it.
  const messages: Record<string, unknown>[] = [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages, activeInstanceId);

  assert.equal(thrown, null, "a sibling connection's state must never fail the active run");
  assert.ok(result, "runConnector returned a result");
  // (a) the active run RETAINS its committed records
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "the active connection keeps the record it ingested");

  // (b) it reports its OWN bounded gap honestly, computed only from its own
  // connection's authority — the revoked sibling neither satisfied the key nor
  // inflated the denominator (missing_required_keys is 1, not 2).
  const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
  const coverageGap = gaps.find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.ok(coverageGap, "the active run reports its own coverage shortfall");
  assert.match(
    String(coverageGap.message ?? ""),
    SCOPED_DENOMINATOR_PATTERN,
    "the denominator counts only this connection's required keys"
  );
});

// The severity question, proven directly: a coverage shortfall the connector did
// NOT declare (no gap_keys, no durable gap) is still a real shortfall — but it
// must be REPORTED as a gap and withhold that state_stream's cursor, never kill
// a run whose records are already durable.
test("an undeclared coverage shortfall reports a gap and withholds the cursor instead of failing the run", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  // No gap_keys and no DETAIL_GAP anywhere: key K is simply unaccounted for.
  const messages: Record<string, unknown>[] = [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null, "an unproven coverage claim is a reported gap, not a run-killing error");
  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "records already ingested are never discarded");

  // The shortfall is surfaced honestly: a known gap naming the affected stream.
  const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
  const coverageGap = gaps.find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.ok(coverageGap, "the shortfall is reported as a known gap");
  assert.equal(coverageGap.stream, "valuations");
  assert.match(
    String(coverageGap.message ?? ""),
    SHORTFALL_MESSAGE_PATTERN,
    "the gap carries the precise coverage explanation the owner needs"
  );

  // A claim of completeness must carry proof: the unproven state_stream's
  // cursor is withheld so the next run re-collects it.
  assert.ok(result.checkpoint_summary, "result carries a checkpoint_summary");
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    0,
    "the unproven state_stream's cursor is not advanced"
  );
});

test("one detail stream can independently prove two parent checkpoints", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const messages: Record<string, unknown>[] = [
    { data: { id: "H" }, emitted_at: "2026-04-18T00:00:00Z", key: "H", stream: "holdings", type: "RECORD" },
    { data: { id: "A" }, emitted_at: "2026-04-18T00:00:00Z", key: "A", stream: "activity", type: "RECORD" },
    { data: { id: "A" }, emitted_at: "2026-04-18T00:00:00Z", key: "A", stream: "valuations", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["H"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    {
      hydrated_keys: ["A"],
      reference_only: true,
      required_keys: ["A"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 3, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null, "sharing a detail stream across parents is valid when each report names its parent");
  assert.ok(result?.checkpoint_summary);
  assert.equal(result.checkpoint_summary.state_streams_staged, 2);
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    1,
    "the proven activity cursor commits while the incomplete holdings cursor remains retryable"
  );
  const coverageGap = (result.known_gaps ?? []).find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.equal(coverageGap?.stream, "valuations");
  assert.match(String(coverageGap?.message ?? ""), HOLDINGS_STATE_STREAM_PATTERN);
});

test("a durable gap cannot satisfy the same detail key under a different parent", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const messages: Record<string, unknown>[] = [
    {
      detail_locator: { holding_id: "K", kind: "test.holding" },
      parent_stream: "holdings",
      reason: "temporary_unavailable",
      record_key: "K",
      retryable: true,
      status: "pending",
      stream: "valuations",
      type: "DETAIL_GAP",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null);
  assert.ok(result?.checkpoint_summary);
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    1,
    "the holdings gap accounts only for holdings; activity remains retryable despite sharing key K"
  );
  const coverageGap = (result.known_gaps ?? []).find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.equal(coverageGap?.stream, "valuations");
  assert.match(String(coverageGap?.message ?? ""), ACTIVITY_STATE_STREAM_PATTERN);
});

test("a legacy parentless gap cannot authorize one parent of a manifest-declared multi-parent detail stream", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const messages: Record<string, unknown>[] = [
    {
      detail_locator: { kind: "test.valuation" },
      reason: "temporary_unavailable",
      record_key: "K",
      reference_only: true,
      retryable: true,
      status: "pending",
      stream: "valuations",
      type: "DETAIL_GAP",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages, undefined, ["activity", "valuations"]);

  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 0);
  assert.ok(result?.known_gaps?.some((gap) => gap.reason === "detail_coverage_incomplete"));
});

test("a staged parent without its required detail coverage report cannot commit", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const messages: Record<string, unknown>[] = [
    {
      empty_keys: ["H"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["H"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_staged, 2);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 1);
  const missingReport = result?.known_gaps?.find(
    (gap) => gap.reason === "detail_coverage_incomplete" && String(gap.message).includes("coverage_report=missing")
  );
  assert.ok(missingReport, "the missing activity report remains visible instead of silently committing its cursor");
});

test("duplicate coverage reports for one parent boundary fail closed", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const report = {
    hydrated_keys: ["K"],
    reference_only: true,
    required_keys: ["K"],
    state_stream: "holdings",
    stream: "valuations",
    type: "DETAIL_COVERAGE",
  };

  const { result, thrown } = await runShortfall(server, ownerToken, [report, report]);

  assert.equal(result, null);
  assert.match(String(thrown), DUPLICATE_COVERAGE_PATTERN);
});

test("overlapping coverage outcome sets fail closed", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const { result, thrown } = await runShortfall(server, ownerToken, [
    {
      hydrated_keys: ["K"],
      optional_skip_keys: ["K"],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
  ]);

  assert.equal(result, null);
  assert.match(String(thrown), OVERLAPPING_OUTCOME_PATTERN);
});

test("an uncovered detail key leaves its parent retryable and a later complete pass commits it", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const incomplete = await runShortfall(server, ownerToken, [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);
  assert.equal(incomplete.thrown, null);
  assert.equal(incomplete.result?.checkpoint_summary?.state_streams_committed, 0);

  const complete = await runShortfall(server, ownerToken, [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "valuations", type: "RECORD" },
    {
      hydrated_keys: ["K"],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "2" }, stream: "holdings", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ]);
  assert.equal(complete.thrown, null);
  assert.equal(complete.result?.checkpoint_summary?.state_streams_committed, 1);
});

function terminalCoveredFor(runId: string, stream: string): unknown {
  const row = getDb()
    .prepare(
      `SELECT data_json FROM spine_events
       WHERE run_id = ? AND event_type IN ('run.completed', 'run.failed', 'run.cancelled')
       ORDER BY event_seq DESC LIMIT 1`
    )
    .get<{ data_json: string }>(runId);
  assert.ok(row, `expected a terminal spine event for run ${runId}`);
  const data = JSON.parse(row.data_json) as { collection_facts?: { streams?: Record<string, unknown>[] } };
  const fact = data.collection_facts?.streams?.find((entry) => entry.stream === stream);
  assert.ok(fact, `expected a collection fact for ${stream}`);
  return fact.covered;
}

function hydratedKeyMessages(activityData: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { data: { id: "H" }, emitted_at: "2026-04-18T00:00:00Z", key: "H", stream: "holdings", type: "RECORD" },
    { data: activityData, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "activity", type: "RECORD" },
    {
      considered: 1,
      covered: 1,
      hydrated_keys: ["K"],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "activity",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ];
}

// The RS permanently rejects a record whose key disagrees with data.id. A
// DETAIL_COVERAGE that still lists that key as hydrated claims coverage the
// store never accepted: it must not pass the checkpoint gate or count as covered.
test("a hydrated key the RS rejected neither passes the checkpoint gate nor counts as covered", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const rejected = await runShortfall(server, ownerToken, hydratedKeyMessages({ id: "not-K" }), undefined, [
    "holdings",
    "activity",
  ]);
  assert.equal(rejected.thrown, null);
  assert.equal(rejected.result?.status, "succeeded");
  assert.equal(rejected.result?.checkpoint_summary?.state_streams_staged, 1);
  assert.equal(
    rejected.result?.checkpoint_summary?.state_streams_committed,
    0,
    "a rejected key is not hydrated, so the holdings cursor must not commit"
  );
  assert.equal(terminalCoveredFor(rejected.result?.run_id as string, "activity"), 0);

  // Control: the same report over an accepted record commits and counts.
  const accepted = await runShortfall(server, ownerToken, hydratedKeyMessages({ id: "K" }), undefined, [
    "holdings",
    "activity",
  ]);
  assert.equal(accepted.thrown, null);
  assert.equal(accepted.result?.checkpoint_summary?.state_streams_committed, 1);
  assert.equal(terminalCoveredFor(accepted.result?.run_id as string, "activity"), 1);
});

// An optional skip is an accepted terminal absence, so it may release the
// checkpoint, but it is not coverage: `covered` counts emitted and unchanged
// items only.
test("optional_skip_keys release the checkpoint but never inflate covered", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const { result, thrown } = await runShortfall(
    server,
    ownerToken,
    [
      { data: { id: "H" }, emitted_at: "2026-04-18T00:00:00Z", key: "H", stream: "holdings", type: "RECORD" },
      { data: { id: "K1" }, emitted_at: "2026-04-18T00:00:00Z", key: "K1", stream: "activity", type: "RECORD" },
      {
        considered: 2,
        covered: 2,
        hydrated_keys: ["K1"],
        optional_skip_keys: ["K2"],
        reference_only: true,
        required_keys: ["K1", "K2"],
        state_stream: "holdings",
        stream: "activity",
        type: "DETAIL_COVERAGE",
      },
      { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
      { records_emitted: 2, status: "succeeded", type: "DONE" },
    ],
    undefined,
    ["holdings", "activity"]
  );
  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 1);
  assert.equal(terminalCoveredFor(result?.run_id as string, "activity"), 1);
});

const RECORD_AT = "2026-04-18T00:00:00Z";

function activityRecord(key: string, data: Record<string, unknown>): Record<string, unknown> {
  return { data, emitted_at: RECORD_AT, key, stream: "activity", type: "RECORD" };
}

function holdingsCoverage(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    hydrated_keys: [],
    reference_only: true,
    state_stream: "holdings",
    stream: "activity",
    type: "DETAIL_COVERAGE",
    ...fields,
  };
}

/** holdings record H, then `middle`, then the holdings STATE and a successful DONE. */
function holdingsRun(middle: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const records = middle.filter((message) => message.type === "RECORD").length + 1;
  return [
    { data: { id: "H" }, emitted_at: RECORD_AT, key: "H", stream: "holdings", type: "RECORD" },
    ...middle,
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: records, status: "succeeded", type: "DONE" },
  ];
}

async function runHoldings(
  server: ClosableServer,
  ownerToken: string,
  middle: readonly Record<string, unknown>[],
  manifest: typeof MANIFEST = MANIFEST
): Promise<RuntimeRunConnectorResult> {
  const { result, thrown } = await runShortfall(
    server,
    ownerToken,
    holdingsRun(middle),
    undefined,
    ["holdings", "activity"],
    manifest
  );
  assert.equal(thrown, null);
  assert.ok(result);
  assert.equal(result.status, "succeeded");
  return result;
}

// Records may follow their DETAIL_COVERAGE and are flushed at DONE. Coverage
// is reconciled against ingest evidence at DONE, so a rejection that arrives
// after the report still counts against the key.
test("a rejection that arrives after its DETAIL_COVERAGE still withholds the parent and uncovers the key", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const result = await runHoldings(server, ownerToken, [
    holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] }),
    activityRecord("K", { id: "not-K" }),
  ]);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 0);
  assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 0);
});

// The converse: a record rejected before the report and accepted on a retry
// after it is hydrated.
test("an accepted retry after DETAIL_COVERAGE credits a key whose first attempt was rejected", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const result = await runHoldings(
    server,
    ownerToken,
    [
      activityRecord("K", { id: "not-K" }),
      holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] }),
      activityRecord("K", { id: "K" }),
    ],
    KEY_SETS_MANIFEST
  );
  assert.equal(result.checkpoint_summary?.state_streams_committed, 1);
  assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 1);
});

// For a connector that declares DETAIL_COVERAGE_KEY_SETS, a hydrated listing
// is a claim, not evidence. With no accepted record for the key the parent
// stays put; a key with no detail must say so in empty_keys.
test("a hydrated key with no accepted record for it withholds the parent and does not count as covered", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const result = await runHoldings(
    server,
    ownerToken,
    [holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] })],
    KEY_SETS_MANIFEST
  );
  assert.equal(result.checkpoint_summary?.state_streams_committed, 0);
  assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 0);
  const coverageGap = (result.known_gaps ?? []).find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.match(String(coverageGap?.message ?? ""), HOLDINGS_STATE_STREAM_PATTERN);
});

// A connector without DETAIL_COVERAGE_KEY_SETS may list a key with no detail
// record (an account with no transactions) as hydrated. Crediting it by
// evidence would stall that connector's cursor every run, so it keeps the
// crediting it had before the capability: the declaration credits the key.
test("without DETAIL_COVERAGE_KEY_SETS, a hydrated key with no record still commits the parent and counts as covered", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  for (let run = 0; run < 2; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second run proves the cursor keeps moving.
    const result = await runHoldings(server, ownerToken, [
      holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] }),
    ]);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1, `run ${run + 1}`);
    assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 1);
    assert.deepEqual(withheldEvents(result.run_id as string), []);
    assert.equal(
      (result.known_gaps ?? []).some((gap) => gap.reason === "detail_coverage_incomplete"),
      false,
      "no shortfall is reported"
    );
  }
});

// START lists DETAIL_COVERAGE_KEY_SETS to every connector, so a connector whose
// manifest does not declare it may still send empty_keys and unchanged_keys.
// They credit like its hydrated keys: rejecting the message would fail a run
// the host invited, and ignoring the keys would stall the cursor.
test("without DETAIL_COVERAGE_KEY_SETS, empty_keys and unchanged_keys credit like hydrated keys", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const result = await runHoldings(server, ownerToken, [
    holdingsCoverage({ empty_keys: ["E"], required_keys: ["E", "U"], unchanged_keys: ["U"] }),
  ]);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 1);
});

test("verified-empty and verified-unchanged keys release the parent and count as covered", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const result = await runHoldings(server, ownerToken, [
    holdingsCoverage({
      considered: 2,
      covered: 2,
      empty_keys: ["E"],
      required_keys: ["E", "U"],
      unchanged_keys: ["U"],
    }),
  ]);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 1);
  assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 2);
});

// The USAA/Chase shape: required keys are parent (account) keys and detail
// records carry them in a manifest-declared foreign key, not as their own key.
test("a detail record's parent foreign key evidences the parent key; a rejected one withholds it", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const coverage = holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] });

  const accepted = await runHoldings(
    server,
    ownerToken,
    [activityRecord("txn-1", { holding_id: "K", id: "txn-1" }), coverage],
    KEY_SETS_MANIFEST
  );
  assert.equal(accepted.checkpoint_summary?.state_streams_committed, 1);
  assert.equal(terminalCoveredFor(accepted.run_id as string, "activity"), 1);

  // Rejections withhold for every connector, so the legacy MANIFEST applies.
  const rejected = await runHoldings(server, ownerToken, [
    activityRecord("txn-1", { holding_id: "K", id: "txn-1" }),
    activityRecord("txn-2", { holding_id: "K", id: "not-txn-2" }),
    coverage,
  ]);
  assert.equal(
    rejected.checkpoint_summary?.state_streams_committed,
    0,
    "one rejected transaction of the account leaves the account incomplete"
  );
  assert.equal(terminalCoveredFor(rejected.run_id as string, "activity"), 0);
});

function withheldEvents(runId: string): { consecutive_runs: number | null; stalled: boolean; state_stream: string }[] {
  return getDb()
    .prepare(
      "SELECT data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.checkpoint_withheld' ORDER BY event_seq"
    )
    .all<{ data_json: string }>(runId)
    .map((row) => JSON.parse(row.data_json));
}

// Withholding is safe against loss but not live: the same reason every run
// means the cursor never moves. The owner is told once it persists.
test("a checkpoint withheld for the same reason on consecutive runs is reported as stalled; a commit resets the count", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const unproven = [holdingsCoverage({ hydrated_keys: ["K"], required_keys: ["K"] })];

  const streaks: (number | null)[] = [];
  let last: RuntimeRunConnectorResult | null = null;
  for (let run = 0; run < 3; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the streak is defined by run order.
    last = await runHoldings(server, ownerToken, unproven, KEY_SETS_MANIFEST);
    const [event, ...rest] = withheldEvents(last.run_id as string);
    assert.ok(event);
    assert.equal(rest.length, 0);
    assert.equal(event.state_stream, "holdings");
    streaks.push(event.consecutive_runs);
  }
  assert.deepEqual(streaks, [1, 2, 3]);
  const stall = (last?.known_gaps ?? []).find((gap) => gap.kind === "checkpoint_withheld");
  assert.equal(stall?.reason, "checkpoint_stalled");
  assert.equal(stall?.severity, "actionable");
  assert.match(String(stall?.message), STALL_MESSAGE_PATTERN);

  const committed = await runHoldings(
    server,
    ownerToken,
    [holdingsCoverage({ empty_keys: ["K"], required_keys: ["K"] })],
    KEY_SETS_MANIFEST
  );
  assert.equal(committed.checkpoint_summary?.state_streams_committed, 1);
  assert.deepEqual(withheldEvents(committed.run_id as string), []);

  const again = await runHoldings(server, ownerToken, unproven, KEY_SETS_MANIFEST);
  const [event] = withheldEvents(again.run_id as string);
  assert.ok(event);
  assert.equal(event.consecutive_runs, 1, "a commit ends the streak");
  assert.equal(event.stalled, false);
  const gap = (again.known_gaps ?? []).find((entry) => entry.kind === "checkpoint_withheld");
  assert.equal(gap?.reason, "checkpoint_withheld");
  assert.equal(gap?.severity, "transient");
});

test("changed-FK accepted retry cannot credit a rejected parent", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const result = await runHoldings(server, ownerToken, [
    activityRecord("T", { id: "wrong", holding_id: "A" }),
    holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["A"], required_keys: ["A"] }),
    activityRecord("T", { id: "T", holding_id: "B" }),
  ]);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 0);
  assert.equal(terminalCoveredFor(result.run_id as string, "activity"), 0);
});

test("successful cursor resets its streak when the next cursor PUT fails", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const unproven = [holdingsCoverage({ hydrated_keys: ["K"], required_keys: ["K"] })];
  await runHoldings(server, ownerToken, unproven, KEY_SETS_MANIFEST);
  const originalFetch = globalThis.fetch;
  const puts: string[] = [];
  const mocked = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "PUT" && String(input).includes("/v1/state/")) {
      const stream = Object.keys(JSON.parse(String(init.body)).state)[0] as string;
      puts.push(stream);
      if (stream === "activity") {
        return new Response("injected second cursor failure", { status: 400 });
      }
    }
    return originalFetch(input, init);
  });
  const attempt = await runShortfall(server, ownerToken, [
    { data: { id: "H" }, emitted_at: RECORD_AT, key: "H", stream: "holdings", type: "RECORD" },
    activityRecord("T", { id: "T" }),
    holdingsCoverage({ empty_keys: ["K"], required_keys: ["K"] }),
    { cursor: { page: "2" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "2" }, stream: "activity", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ], undefined, ["holdings", "activity"], KEY_SETS_MANIFEST);
  mocked.mock.restore();
  assert.deepEqual(puts, ["holdings", "activity"]);
  assert.ok(attempt.thrown || attempt.result?.status === "failed");
  const again = await runHoldings(server, ownerToken, unproven, KEY_SETS_MANIFEST);
  assert.equal(withheldEvents(again.run_id as string)[0]?.consecutive_runs, 1);
});

async function registerManifest(server: ClosableServer, manifest: Record<string, unknown>): Promise<number> {
  const { status } = await fetchJson(`http://localhost:${server.asPort}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return status;
}

function isAdmitted(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Run `messages` as the connector and return the START line it received, or null if it never started. */
async function runCapturingStart(
  server: ClosableServer,
  ownerToken: string,
  manifest: Record<string, unknown>,
  messages: readonly Record<string, unknown>[]
): Promise<{ result: RuntimeRunConnectorResult | null; start: Record<string, unknown> | null; thrown: unknown }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-start-capture-"));
  const startPath = join(tmpDir, "start.json");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { writeFileSync } from 'fs';
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    writeFileSync(${JSON.stringify(startPath)}, line);
    for (const m of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf-8"
  );
  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      connectorPath,
      detailGapStore: getDefaultConnectorDetailGapStore(),
      manifest: manifest as typeof MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${server.rsPort}`,
      scope: { streams: ["holdings", "activity"].map((name) => ({ name })) },
      state: null,
    });
  } catch (err) {
    thrown = err;
  }
  let start: Record<string, unknown> | null = null;
  try {
    start = JSON.parse(readFileSync(startPath, "utf-8")) as Record<string, unknown>;
  } catch {
    start = null;
  }
  rmSync(tmpDir, { force: true, recursive: true });
  return { result, start, thrown };
}

const UNPROVEN_HYDRATED_KEY = [
  holdingsCoverage({ considered: 1, covered: 1, hydrated_keys: ["K"], required_keys: ["K"] }),
];

// Collection Profile 0.2.0 adds DETAIL_COVERAGE_KEY_SETS (Sections 3.4, 8). A
// manifest that declares it at 0.2.0 registers, passes the pre-spawn gate, and
// gets evidence-based crediting: a hydrated key with no record is not credited.
test("a 0.2.0 manifest declaring DETAIL_COVERAGE_KEY_SETS registers, starts, and gets evidence-based crediting", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  assert.equal(isAdmitted(await registerManifest(server, KEY_SETS_MANIFEST)), true, "the 0.2.0 manifest is admitted");

  const { result, start, thrown } = await runCapturingStart(
    server,
    ownerToken,
    KEY_SETS_MANIFEST,
    holdingsRun(UNPROVEN_HYDRATED_KEY)
  );
  assert.equal(thrown, null);
  assert.ok(start, "the connector received START");
  assert.equal(result?.status, "succeeded");
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 0, "the unproven parent cursor is withheld");
  assert.equal(terminalCoveredFor(result?.run_id as string, "activity"), 0);
});

// A 0.1.0 manifest keeps the 0.1.0 crediting, and may not declare a capability
// that 0.2.0 adds (Section 3.1).
test("a 0.1.0 manifest keeps legacy crediting and cannot declare a 0.2.0 capability", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  assert.equal(isAdmitted(await registerManifest(server, MANIFEST)), true, "the 0.1.0 manifest is admitted");
  assert.equal(
    await registerManifest(server, { ...KEY_SETS_MANIFEST, protocol_version: "0.1.0" }),
    400,
    "DETAIL_COVERAGE_KEY_SETS requires protocol_version 0.2.0"
  );

  const { result, thrown } = await runCapturingStart(server, ownerToken, MANIFEST, holdingsRun(UNPROVEN_HYDRATED_KEY));
  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 1, "the declaration alone credits the key");
  assert.equal(terminalCoveredFor(result?.run_id as string, "activity"), 1);
});

// Pre-spawn gate (Sections 3.4 and 4): an unknown capability name fails closed,
// and a known required capability this runtime does not implement fails before
// any connector code runs. DETAIL_COVERAGE_KEY_SETS is advisory and
// STREAM_EVIDENCE is implemented, so both pass.
test("the pre-spawn gate rejects unknown and unsupported required capabilities and admits implemented ones", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  assert.equal(
    await registerManifest(server, { ...KEY_SETS_MANIFEST, protocol_capabilities: ["FORGED"] }),
    400,
    "an unknown capability name is not admitted"
  );

  const cases: [unknown, RegExp | null, string | null][] = [
    [["FORGED"], UNKNOWN_CAPABILITY_PATTERN, null],
    [["DETAIL_COVERAGE_KEY_SETS", "FORGED"], UNKNOWN_CAPABILITY_PATTERN, null],
    ["DETAIL_COVERAGE_KEY_SETS", UNKNOWN_CAPABILITY_PATTERN, null],
    [null, UNKNOWN_CAPABILITY_PATTERN, null],
    [["OBSERVATION"], UNSUPPORTED_CAPABILITY_PATTERN, "OBSERVATION"],
    [["DETAIL_COVERAGE_KEY_SETS", "BLOB"], UNSUPPORTED_CAPABILITY_PATTERN, "BLOB"],
    [["DETAIL_COVERAGE_KEY_SETS", "STREAM_EVIDENCE"], null, null],
  ];
  for (const [protocolCapabilities, rejection, unsupported] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const { result, start, thrown } = await runCapturingStart(
      server,
      ownerToken,
      { ...KEY_SETS_MANIFEST, protocol_capabilities: protocolCapabilities },
      holdingsRun([holdingsCoverage({ empty_keys: ["K"], required_keys: ["K"] })])
    );
    const label = JSON.stringify(protocolCapabilities);
    if (rejection === null) {
      assert.equal(thrown, null, label);
      assert.ok(start, `${label} starts`);
      assert.equal(result?.status, "succeeded", label);
      continue;
    }
    assert.equal(start, null, `${label} never reaches the connector`);
    assert.match(String((thrown as Error | null)?.message), rejection, label);
    if (unsupported !== null) {
      assert.equal(UNSUPPORTED_CAPABILITY_PATTERN.exec(String((thrown as Error).message))?.[1], unsupported, label);
    }
  }
});

// START.protocol_capabilities lists what this runtime implements (Section
// 5.1): it accepts empty_keys/unchanged_keys and it validates STREAM_EVIDENCE.
// It does not implement BLOB or OBSERVATION, so it does not list them.
test("START advertises the protocol capabilities this runtime implements, to every connector", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  for (const manifest of [MANIFEST, KEY_SETS_MANIFEST]) {
    // biome-ignore lint/performance/noAwaitInLoops: each manifest is one isolated run.
    const { start, thrown } = await runCapturingStart(
      server,
      ownerToken,
      manifest,
      holdingsRun([holdingsCoverage({ empty_keys: ["K"], required_keys: ["K"] })])
    );
    assert.equal(thrown, null);
    assert.deepEqual(start?.protocol_capabilities, ["DETAIL_COVERAGE_KEY_SETS", "STREAM_EVIDENCE"]);
  }
});
