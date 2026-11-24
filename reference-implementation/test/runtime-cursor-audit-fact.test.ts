// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #76: `run.state_staged` and `run.state_advanced` spine events record a
 * compact audit fact for the connector cursor (`cursor_sha256`, `cursor_bytes`)
 * instead of embedding the full cursor.
 *
 * Unit tests cover the fact itself. The integration scenario runs a real
 * `runConnector` sync with a ~1 MB cursor, then a resume from the persisted
 * state, and proves that
 *   - the authoritative state in the RS is the full cursor, byte for byte,
 *   - the resumed run receives that state in START (behavior unchanged),
 *   - the spine events carry the compact fields and no `cursor`.
 * It runs on SQLite always and on PostgreSQL when `PDPP_TEST_POSTGRES_URL` is
 * set (same convention as `checkpoint-dependency-profile-conformance-postgres.test.ts`).
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalCursorJson, cursorAuditFact } from "../runtime/cursor-audit-fact.ts";
import { loadSyncState, runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const OWNER_SUBJECT_ID = "u1";
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Unit: the audit fact
// ---------------------------------------------------------------------------

test("cursorAuditFact is deterministic and matches a pinned vector", () => {
  const fact = cursorAuditFact({ cursor: "abc" });
  assert.deepEqual(fact, cursorAuditFact({ cursor: "abc" }));
  // sha256 of the UTF-8 bytes of `{"cursor":"abc"}` (16 bytes).
  assert.deepEqual(fact, {
    cursor_bytes: 16,
    cursor_sha256: createHash("sha256").update('{"cursor":"abc"}', "utf8").digest("hex"),
  });
  assert.match(fact.cursor_sha256, SHA256_HEX);
});

test("cursorAuditFact ignores object key order at every depth but not array order", () => {
  const a = { a: 1, b: { x: [1, 2], y: "z" } };
  const b = { b: { y: "z", x: [1, 2] }, a: 1 };
  assert.equal(canonicalCursorJson(a), canonicalCursorJson(b));
  assert.deepEqual(cursorAuditFact(a), cursorAuditFact(b));
  assert.notEqual(cursorAuditFact({ x: [1, 2] }).cursor_sha256, cursorAuditFact({ x: [2, 1] }).cursor_sha256);
  assert.notEqual(cursorAuditFact({ x: 1 }).cursor_sha256, cursorAuditFact({ x: 2 }).cursor_sha256);
});

test("canonical JSON preserves __proto__, constructor and prototype keys so distinct cursors never collide", () => {
  const one = JSON.parse('{"__proto__":{"value":1}}');
  const two = JSON.parse('{"__proto__":{"value":2}}');
  assert.equal(canonicalCursorJson(one), '{"__proto__":{"value":1}}');
  assert.equal(canonicalCursorJson(two), '{"__proto__":{"value":2}}');
  assert.notEqual(cursorAuditFact(one).cursor_sha256, cursorAuditFact(two).cursor_sha256);
  assert.notEqual(cursorAuditFact(one).cursor_sha256, cursorAuditFact({}).cursor_sha256);

  const cases = [
    '{"a":{"__proto__":{"x":1}}}',
    '{"list":[{"__proto__":{"x":1}},{"__proto__":{"x":2}}]}',
    '{"constructor":{"prototype":{"y":1}},"prototype":2,"b":1,"__proto__":3}',
    '{"z":{"__proto__":{"__proto__":{"deep":true}}},"a":null}',
  ];
  for (const source of cases) {
    const input = JSON.parse(source);
    const output = canonicalCursorJson(input);
    assert.deepEqual(JSON.parse(output), input, `round-trip keeps every own key: ${source}`);
    assert.equal(output, sortedReserialize(input), `output is the own keys in sorted order: ${source}`);
  }
  const nestedA = JSON.parse('{"a":{"__proto__":{"x":1}}}');
  const nestedB = JSON.parse('{"a":{"__proto__":{"x":2}}}');
  assert.notEqual(cursorAuditFact(nestedA).cursor_sha256, cursorAuditFact(nestedB).cursor_sha256);
  const arrayA = JSON.parse('[{"__proto__":{"x":1}}]');
  const arrayB = JSON.parse('[{"__proto__":{"x":2}}]');
  assert.notEqual(cursorAuditFact(arrayA).cursor_sha256, cursorAuditFact(arrayB).cursor_sha256);
});

/** Independent oracle: re-serialize own keys in sorted order via Map-free entry arrays. */
function sortedReserialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedReserialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedReserialize(v)}`).join(",")}}`;
}

test("cursorAuditFact counts UTF-8 bytes, not characters, and always yields a digest", () => {
  assert.equal(cursorAuditFact("é").cursor_bytes, Buffer.byteLength('"é"', "utf8"));
  assert.equal(cursorAuditFact(undefined).cursor_bytes, 4);
  assert.equal(cursorAuditFact(null).cursor_sha256, cursorAuditFact(undefined).cursor_sha256);
});

test("a 1 MB cursor yields a bounded fact", () => {
  const big = { seen: "x".repeat(1_000_000) };
  const fact = cursorAuditFact(big);
  assert.ok(fact.cursor_bytes > 1_000_000);
  assert.ok(JSON.stringify(fact).length < 120, "audit fact must stay tiny regardless of cursor size");
});

// ---------------------------------------------------------------------------
// Integration: sync with checkpoints, then resume
// ---------------------------------------------------------------------------

interface ClosableServer {
  abortStartupBackfill?: (reason: unknown) => void;
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  controller?: { drainActiveRuns: (timeoutMs: number) => Promise<unknown> };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop?: () => void };
  startupBackfillDone?: Promise<unknown>;
  startupSummaryEvidenceSweepDone?: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep?: () => void;
  stopClientEventDeliveryWorker?: () => Promise<void>;
  stopConnectorMaintenanceSweep?: () => void;
}
interface StartServerOptions {
  asPort?: number;
  databaseUrl?: string;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
  storageBackend?: "postgres";
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill?.("test shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep?.();
  server.stopConnectorMaintenanceSweep?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    server.controller?.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker?.(),
  ]);
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<{ body: T; status: number }> {
  const resp = await fetch(url, init);
  return { body: (await resp.json()) as T, status: resp.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "pdpp_cli";
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    { body: new URLSearchParams({ client_id: clientId }).toString(), headers: form, method: "POST" },
  );
  const approve = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: OWNER_SUBJECT_ID, user_code: device.user_code }).toString(),
    headers: form,
    method: "POST",
  });
  assert.equal(approve.status, 200);
  const { body: token } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: form,
    method: "POST",
  });
  return token.access_token;
}

function streamDef(name: string) {
  return {
    name,
    primary_key: ["id"],
    schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    selection: { fields: true, resources: true },
    semantics: "mutable_state",
  };
}

function manifestFor(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [streamDef("alpha"), streamDef("beta")],
    version: "0.1.0",
  };
}

// The connector emits two checkpoints per run. On START it records what it
// received as `state` (as a digest + size, written to a side file the test
// reads) so the test can prove the resumed run was handed the persisted state.
// The alpha cursor is ~1 MB and written with non-sorted keys.
function writeConnector(tmpDir: string, receivedPath: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const received = JSON.stringify(msg.state ?? null);
  writeFileSync(${JSON.stringify(receivedPath)}, JSON.stringify({
    bytes: Buffer.byteLength(received),
    sha256: createHash('sha256').update(received).digest('hex'),
  }));
  const generation = msg.state && msg.state.alpha ? msg.state.alpha.generation + 1 : 1;
  const alpha = { z_last: 'z', generation, blob: 'x'.repeat(1000000), a_first: 'a' };
  const beta = { page: 'beta-' + generation };
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  out({ type: 'RECORD', stream: 'alpha', key: 'A' + generation, data: { id: 'A' + generation }, emitted_at: new Date().toISOString() });
  out({ type: 'STATE', stream: 'alpha', cursor: alpha });
  out({ type: 'RECORD', stream: 'beta', key: 'B' + generation, data: { id: 'B' + generation }, emitted_at: new Date().toISOString() });
  out({ type: 'STATE', stream: 'beta', cursor: beta });
  out({ type: 'DONE', status: 'succeeded', records_emitted: 2 });
  // No process.exit(): exiting right after a ~1 MB pipe write truncates stdout.
  rl.close();
});
`,
    "utf8",
  );
  return connectorPath;
}

interface TimelineEvent {
  data: Record<string, unknown>;
  event_type: string;
  stream_id?: string | null;
}

async function runCursorAuditScenario(
  server: ClosableServer,
  connectorId: string,
  diagnostic: (message: string) => void,
): Promise<void> {
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = manifestFor(connectorId);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cursor-audit-"));
  const receivedPath = join(tmpDir, "received.json");
  const connectorPath = writeConnector(tmpDir, receivedPath);
  const readReceived = async () => (await import("node:fs")).readFileSync(receivedPath, "utf8");

  try {
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    const common = {
      admitRunConnection: async ({ connectorId: id }: { connectorId: string }) => ({
        connectorId: id,
        connectorInstanceId,
        ownerSubjectId: OWNER_SUBJECT_ID,
      }),
      collectionMode: "incremental" as const,
      connectorId,
      connectorInstanceId,
      connectorPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
    };

    // Run 1: fresh sync with two checkpoints.
    const run1 = await runConnector({ ...common, runId: `run_${randomUUID()}`, state: null });
    assert.equal(run1.status, "succeeded");
    assert.equal(run1.checkpoint_summary?.state_streams_committed, 2);
    const received1 = JSON.parse(await readReceived());
    assert.equal(received1.sha256, createHash("sha256").update("null").digest("hex"));

    // Authoritative persisted state is the FULL cursor, unchanged by the audit fact.
    const state1 = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(state1.alpha?.generation, 1);
    assert.equal(String(state1.alpha?.blob).length, 1_000_000);
    assert.deepEqual(state1.beta, { page: "beta-1" });

    // Run 2: resume from the persisted state.
    const run2Id = `run_${randomUUID()}`;
    const run2 = await runConnector({ ...common, runId: run2Id, state: state1 });
    assert.equal(run2.status, "succeeded");
    const received2 = JSON.parse(await readReceived());
    const state1Json = JSON.stringify(state1);
    assert.deepEqual(received2, {
      bytes: Buffer.byteLength(state1Json),
      sha256: createHash("sha256").update(state1Json).digest("hex"),
    });
    const state2 = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(state2.alpha?.generation, 2);
    assert.deepEqual(state2.beta, { page: "beta-2" });
    // Printed so the same value can be compared across commits (before/after this change).
    diagnostic(
      `persisted-state-digest ${createHash("sha256").update(JSON.stringify({ state1, state2 })).digest("hex")}`,
    );

    // Spine: compact fact only, for both runs and both event types.
    for (const [runId, persisted] of [
      [run1.run_id, state1],
      [run2Id, state2],
    ] as const) {
      const { body: timeline } = await fetchJson<{ data: TimelineEvent[] }>(
        `${asUrl}/_ref/runs/${encodeURIComponent(String(runId))}/timeline`,
      );
      for (const eventType of ["run.state_staged", "run.state_advanced"]) {
        const events = timeline.data.filter((e) => e.event_type === eventType);
        assert.equal(events.length, 2, `${eventType} once per checkpoint`);
        for (const event of events) {
          const stream = String(event.stream_id);
          assert.equal("cursor" in event.data, false, `${eventType} must not embed the cursor`);
          assert.deepEqual(
            { bytes: event.data.cursor_bytes, sha: event.data.cursor_sha256 },
            {
              bytes: cursorAuditFact(persisted[stream]).cursor_bytes,
              sha: cursorAuditFact(persisted[stream]).cursor_sha256,
            },
            `${eventType}/${stream} audit fact matches the persisted cursor`,
          );
          assert.ok(JSON.stringify(event.data).length < 1000, `${eventType} event data stays small`);
        }
      }
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

test("SQLite: checkpoint then resume persists the full cursor; spine events carry only the audit fact", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-cursor-audit-sqlite-"));
  const server = await startServer({ asPort: 0, dbPath: join(dir, "store.sqlite"), quiet: true, rsPort: 0 });
  try {
    await runCursorAuditScenario(server, "cursor-audit-sqlite", (m) => t.diagnostic(m));
  } finally {
    await closeServer(server);
    rmSync(dir, { force: true, recursive: true });
  }
});

if (POSTGRES_URL) {
  const baseUrl = POSTGRES_URL;
  test("PostgreSQL: checkpoint then resume persists the full cursor; spine events carry only the audit fact", async (t) => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: baseUrl,
        databaseName: `pdpp_cursor_audit_${randomUUID().replaceAll("-", "")}`,
      },
      async (databaseUrl) => {
        const server = await startServer({
          asPort: 0,
          databaseUrl,
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        try {
          await runCursorAuditScenario(server, "cursor-audit-postgres", (m) => t.diagnostic(m));
        } finally {
          await closeServer(server);
          await closePostgresStorage();
        }
      },
    );
  });
} else {
  test("PostgreSQL cursor audit scenario (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
