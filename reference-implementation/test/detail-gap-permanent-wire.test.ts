// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permanent DETAIL_GAP wire contract (collection-profile §5.6, data-connectors
 * PR 398 at 53758e49): `retryable` and `status: "pending"` are REQUIRED on both
 * gap forms, `source_unrepresentable` <=> `retryable: false`, and a runtime MUST
 * NOT schedule, request, or offer a refetch of a `retryable: false` gap.
 *
 * These tests drive the real `runConnector` against a real SQLite detail-gap
 * store and a scripted child process. Malformed messages are raw JSON in the
 * script, never production casts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

type RunConnectorTestOptions = Omit<RuntimeRunConnectorOptions, "detailGapStore"> & { detailGapStore?: unknown };
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;

const DETAIL_GAP_ERROR_PATTERN = /DETAIL_GAP/;

interface ConnectorHandle {
  cleanup: () => void;
  connectorPath: string;
}

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-wire-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function createConnector(messages: readonly Record<string, unknown>[]): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-connector-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const message of ${JSON.stringify(messages)}) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createStartCaptureConnector(outputPath: string): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-start-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(msg), 'utf8');
  process.stdout.write(JSON.stringify({ records_emitted: 0, status: 'succeeded', type: 'DONE' }) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

// Recovers every gap it is served (START + paged) and records which gap ids it
// was ever offered, so a test can prove a permanent gap is never offered.
function createPagedRecoveryConnector(outputPath: string): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-paged-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
const offered = [];
let requestCounter = 0;
function emit(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function recover(gaps) {
  for (const gap of gaps) {
    offered.push(gap.gap_id);
    emit({
      type: 'DETAIL_GAP_RECOVERED',
      reference_only: true,
      gap_id: gap.gap_id,
      lease_id: gap.lease_id,
      stream: gap.stream,
      record_key: gap.record_key,
    });
  }
}
function requestNext() {
  emit({
    type: 'DETAIL_GAPS_PAGE_REQUEST',
    reference_only: true,
    request_id: 'page_' + (++requestCounter),
    streams: ['messages'],
  });
}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    recover(msg.detail_gaps || []);
    requestNext();
    return;
  }
  if (msg.type === 'DETAIL_GAPS_PAGE_RESPONSE') {
    const gaps = msg.detail_gaps || [];
    recover(gaps);
    if (gaps.length === 0) {
      writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ offered }), 'utf8');
      rl.close();
      emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
      process.stdout.write('', () => process.exit(0));
      return;
    }
    requestNext();
  }
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

const BASE_GAP = {
  detail_locator: { kind: "test.item", item_id: "k1" },
  record_key: "k1",
  reference_only: true,
  status: "pending",
  stream: "messages",
  type: "DETAIL_GAP",
} as const;

const PERMANENT_GAP = { ...BASE_GAP, reason: "source_unrepresentable", retryable: false } as const;
const TRANSIENT_GAP = { ...BASE_GAP, reason: "temporary_unavailable", retryable: true } as const;
const DONE = { records_emitted: 0, status: "succeeded", type: "DONE" } as const;
const RETRYABLE_REASONS = ["rate_limited", "retry_exhausted", "temporary_unavailable", "upstream_pressure"] as const;

function runtimeArgs(connectorId: string, store: unknown, connectorInstanceId: string | null = null) {
  return {
    admitRunConnection: fakeAdmitRunConnection(),
    connectorId,
    connectorInstanceId,
    detailGapStore: store,
    grantId: "grant_1",
    manifest: { streams: [{ name: "messages" }] },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    onProgress: () => {},
    ownerToken: "owner",
    persistState: false,
  };
}

async function runMessages(
  connectorId: string,
  store: unknown,
  messages: readonly Record<string, unknown>[]
): Promise<RuntimeRunConnectorResult> {
  const handle = createConnector(messages);
  try {
    return await runConnectorWithGapStore({ ...runtimeArgs(connectorId, store), connectorPath: handle.connectorPath });
  } finally {
    handle.cleanup();
  }
}

test(
  "a valid permanent DETAIL_GAP persists retryable:false and is accounted without any hydrated RECORD",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const result = await runMessages("perm_wire_valid", store, [PERMANENT_GAP, DONE]);

    assert.equal(result.status, "succeeded");
    assert.equal(result.records_emitted, 0, "a permanent gap is never turned into a synthetic hydrated RECORD");
    assert.equal(result.detail_gaps?.length, 1, "the permanent gap is reported as accounted loss");

    const stored = await store.listPendingGapsForConnector("perm_wire_valid");
    assert.equal(stored.length, 1, "the permanent gap stays inspectable");
    assert.equal(stored[0]?.retryable, false, "retryable:false round-trips through the durable row");
    assert.equal(stored[0]?.reason, "source_unrepresentable");
    assert.equal(stored[0]?.status, "pending", "no new terminal wire status: the durable row stays pending");

    const recoverable = await store.listPendingGaps({
      connectorId: "perm_wire_valid",
      connectorInstanceId: stored[0]?.connector_instance_id,
      grantId: "grant_1",
    });
    assert.deepEqual(recoverable, [], "a permanent gap is never in a recovery selection");
  })
);

test(
  "a valid transient DETAIL_GAP persists retryable:true and stays recoverable (control)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const result = await runMessages("perm_wire_transient", store, [TRANSIENT_GAP, DONE]);

    assert.equal(result.status, "succeeded");
    const stored = await store.listPendingGapsForConnector("perm_wire_transient");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.retryable, true);
    const recoverable = await store.listPendingGaps({
      connectorId: "perm_wire_transient",
      connectorInstanceId: stored[0]?.connector_instance_id,
      grantId: "grant_1",
    });
    assert.equal(recoverable.length, 1, "transient recovery is preserved");
  })
);

interface InvalidCase {
  readonly label: string;
  readonly message: Record<string, unknown>;
}

function without(message: Record<string, unknown>, field: string): Record<string, unknown> {
  const { [field]: _removed, ...rest } = message;
  return rest;
}

const INVALID_CASES: readonly InvalidCase[] = [
  { label: "retryable omitted", message: without(PERMANENT_GAP, "retryable") },
  { label: "retryable null", message: { ...PERMANENT_GAP, retryable: null } },
  { label: "retryable string", message: { ...PERMANENT_GAP, retryable: "false" } },
  { label: "retryable number 0", message: { ...PERMANENT_GAP, retryable: 0 } },
  { label: "retryable number 1", message: { ...TRANSIENT_GAP, retryable: 1 } },
  { label: "transient retryable omitted", message: without(TRANSIENT_GAP, "retryable") },
  { label: "status omitted", message: without(PERMANENT_GAP, "status") },
  { label: "status terminal", message: { ...PERMANENT_GAP, status: "terminal" } },
  { label: "status null", message: { ...TRANSIENT_GAP, status: null } },
  { label: "status recovered", message: { ...TRANSIENT_GAP, status: "recovered" } },
  { label: "reason omitted", message: without(TRANSIENT_GAP, "reason") },
  { label: "reason empty", message: { ...TRANSIENT_GAP, reason: "" } },
  { label: "reason unknown", message: { ...TRANSIENT_GAP, reason: "totally_made_up" } },
  { label: "reason non-string", message: { ...TRANSIENT_GAP, reason: 5 } },
  { label: "source_unrepresentable with retryable:true", message: { ...PERMANENT_GAP, retryable: true } },
  ...RETRYABLE_REASONS.map((reason) => ({
    label: `${reason} with retryable:false`,
    message: { ...TRANSIENT_GAP, reason, retryable: false },
  })),
];

for (const invalid of INVALID_CASES) {
  test(
    `DETAIL_GAP is rejected before any effect: ${invalid.label}`,
    withTempDb(async () => {
      const store = createSqliteConnectorDetailGapStore();
      const connectorId = `perm_wire_invalid_${invalid.label.replace(/[^a-z0-9]+/gi, "_")}`;
      await assert.rejects(
        () => runMessages(connectorId, store, [invalid.message, DONE]),
        DETAIL_GAP_ERROR_PATTERN,
        "the runtime rejects the message as a protocol violation"
      );
      const stored = await store.listPendingGapsForConnector(connectorId);
      assert.deepEqual(stored, [], "nothing is persisted for a rejected gap");
    })
  );
}

test(
  "an existing durable explicit-false row is untouched by a rejected mismatched pair",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    await runMessages("perm_wire_mismatch_keeps_false", store, [PERMANENT_GAP, DONE]);
    await assert.rejects(
      () =>
        runMessages("perm_wire_mismatch_keeps_false", store, [
          { ...PERMANENT_GAP, reason: "temporary_unavailable" },
          DONE,
        ]),
      DETAIL_GAP_ERROR_PATTERN
    );
    const [row] = await store.listPendingGapsForConnector("perm_wire_mismatch_keeps_false");
    assert.equal(row?.retryable, false);
    assert.equal(row?.reason, "source_unrepresentable");
  })
);

async function seedPermanentAndTransient(store: ReturnType<typeof createSqliteConnectorDetailGapStore>) {
  const connectorId = "perm_wire_serve";
  const connectorInstanceId = "cin_perm_wire_serve";
  const common = {
    connectorId,
    connectorInstanceId,
    grantId: "grant_1",
    parentStream: null,
    stream: "messages",
  };
  const permanent = await store.upsertPendingGap({
    ...common,
    detailLocator: { kind: "test.item", item_id: "p" },
    reason: "source_unrepresentable",
    recordKey: "p",
    retryable: false,
  });
  const transient = await store.upsertPendingGap({
    ...common,
    detailLocator: { kind: "test.item", item_id: "t" },
    reason: "temporary_unavailable",
    recordKey: "t",
    retryable: true,
  });
  // Foreign-instance sentinel: same stream, different connection. It must not
  // leak into this connection's served pages and must not be touched.
  const foreign = await store.upsertPendingGap({
    ...common,
    connectorInstanceId: "cin_perm_wire_foreign",
    detailLocator: { kind: "test.item", item_id: "f" },
    reason: "temporary_unavailable",
    recordKey: "f",
    retryable: true,
  });
  assert.ok(permanent && transient && foreign);
  return { connectorId, connectorInstanceId, foreign, permanent, transient };
}

test(
  "START.detail_gaps never contains a permanent gap",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await seedPermanentAndTransient(store);
    const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-start-out-"));
    const startPath = join(dir, "start.json");
    const capturer = createStartCaptureConnector(startPath);
    try {
      const result = await runConnectorWithGapStore({
        ...runtimeArgs(seeded.connectorId, store, seeded.connectorInstanceId),
        connectorPath: capturer.connectorPath,
      });
      assert.equal(result.status, "succeeded");
      const start = JSON.parse(readFileSync(startPath, "utf8"));
      const served = (start.detail_gaps ?? []).map((gap: { gap_id: string }) => gap.gap_id);
      assert.deepEqual(served, [seeded.transient.gap_id], "only the transient gap is served");
    } finally {
      capturer.cleanup();
      rmSync(dir, { force: true, recursive: true });
    }
    const permanentAfter = await store.getGapById(seeded.permanent.gap_id);
    assert.equal(permanentAfter?.status, "pending", "the permanent gap was never leased");
    assert.equal(permanentAfter?.attempt_count, 0, "serving the transient gap consumed no attempt of the permanent one");
  })
);

test(
  "paged DETAIL_GAPS_PAGE_REQUEST never offers a permanent gap and recovery of the transient gap is unaffected",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await seedPermanentAndTransient(store);
    const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-paged-out-"));
    const outPath = join(dir, "offered.json");
    const connector = createPagedRecoveryConnector(outPath);
    try {
      const result = await runConnectorWithGapStore({
        ...runtimeArgs(seeded.connectorId, store, seeded.connectorInstanceId),
        connectorPath: connector.connectorPath,
      });
      assert.equal(result.status, "succeeded");
      const { offered } = JSON.parse(readFileSync(outPath, "utf8")) as { offered: string[] };
      assert.ok(offered.includes(seeded.transient.gap_id), "the transient gap is offered and recovered");
      assert.equal(offered.includes(seeded.permanent.gap_id), false, "the permanent gap is never offered");
    } finally {
      connector.cleanup();
      rmSync(dir, { force: true, recursive: true });
    }
    const transientAfter = await store.getGapById(seeded.transient.gap_id);
    assert.equal(transientAfter?.status, "recovered");
    const permanentAfter = await store.getGapById(seeded.permanent.gap_id);
    assert.equal(permanentAfter?.status, "pending");
    assert.equal(permanentAfter?.retryable, false);
    assert.equal(permanentAfter?.attempt_count, 0);
    const foreignAfter = await store.getGapById(seeded.foreign.gap_id);
    assert.equal(foreignAfter?.status, "pending", "the foreign-instance sentinel is untouched");
  })
);

test(
  "a connector DETAIL_GAP_RECOVERED naming a permanent gap is refused: no bare claim manufactures hydration",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    await runMessages("perm_wire_recovered_claim", store, [PERMANENT_GAP, DONE]);
    const [permanent] = await store.listPendingGapsForConnector("perm_wire_recovered_claim");
    assert.ok(permanent);

    await assert.rejects(
      () =>
        runMessages("perm_wire_recovered_claim", store, [
          {
            gap_id: permanent.gap_id,
            record_key: "k1",
            reference_only: true,
            stream: "messages",
            type: "DETAIL_GAP_RECOVERED",
          },
          DONE,
        ]),
      /permanent|non-?retryable|source_unrepresentable/i,
      "the claim is refused with a clear permanent/non-retryable message, not a misleading lease-lost error"
    );
    await assert.rejects(
      () =>
        runMessages("perm_wire_recovered_claim", store, [
          {
            gap_id: permanent.gap_id,
            record_key: "k1",
            reference_only: true,
            stream: "messages",
            type: "DETAIL_GAP_RECOVERED",
          },
          DONE,
        ]),
      (err: unknown) => !/lease was lost|lease lost/i.test(String((err as Error).message)),
      "the refusal is not the misleading lease-lost text"
    );
    const after = await store.getGapById(permanent.gap_id);
    assert.equal(after?.status, "pending", "the loss stays visible and un-hydrated");
    assert.equal(after?.retryable, false);
    assert.equal(after?.recovered_run_id, null);
  })
);
