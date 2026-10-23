// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpineEventRecord } from "../lib/spine.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Regression coverage for the live runtime path (reference-implementation/runtime/index.ts)
// used by every real connector run, as distinct from the standalone
// polyfill-connectors local collector (packages/polyfill-connectors/src/collector-runner.ts),
// which is a separate, unrelated execution path and is NOT exercised by this file.
//
// Incident: a run enumerating several streams hit a retryable, stream-scoped
// failure on one of them (reported via SKIP_RESULT{reason:"stream_collection_failed"}
// + a terminal DONE{status:"failed", error:{code:"stream_collection_failed"}}).
// The runtime's `handleDoneClose` only ever committed staged STATE when
// `done.status === "succeeded"`; any failed DONE discarded every staged
// cursor, including ones for sibling streams that had already reached their
// own terminal STATE with no reported failure — forcing a full re-scan on
// retry.
//
// Fix: `handleDoneClose` now also commits when a failed DONE is structurally
// certified as stream-scoped — DONE.error.code === "stream_collection_failed"
// AND at least one in-scope SKIP_RESULT named the failing stream(s) — and
// then commits only the staged streams NOT named by those SKIP_RESULTs. Any
// other failure shape (no matching SKIP_RESULT, missing DONE/crash, global
// failure, cancellation, protocol mismatch) still discards everything, exactly
// as before.
//
// `runConnector` RESOLVES (never rejects) for any connector-reported terminal
// status, including "failed" — it only rejects for genuine runtime errors
// (e.g. a state-PUT that itself fails mid-commit). Every test below awaits
// the resolved result directly.

const CHILD_B_STREAM_NAME_PATTERN = /child_b/;
const STREAMLESS_OMISSION_PATTERN = /an unnamed stream reported an omission \(retryable_skip\)/;

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}
interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

interface TestSpineEventData {
  [key: string]: unknown;
}
type TestSpineEvent = Omit<SpineEventRecord, "data"> & { data: TestSpineEventData };
interface TraceTimelineBody {
  data: TestSpineEvent[];
}

type RunResult = RuntimeRunConnectorResult & {
  checkpoint_summary?: {
    state_streams_committed?: number;
    state_streams_staged?: number;
  };
  connector_error?: { code?: string; message?: string; retryable?: boolean | null } | null;
};

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "u1"): Promise<string> {
  const clientId = "pdpp_cli";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "u1"
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

// Two in-scope streams; no provider identity anywhere in the manifest/connector
// stub — the incident's real connector had three sibling streams and one
// failing stream, but the fix is provider-neutral and this is the minimal
// shape that discriminates it: one sibling that fully succeeds, one stream
// that reports its own certified failure.
function testManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Runtime stream isolation test",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "sibling_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "sibling_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

type RuntimeManifest = NonNullable<Parameters<typeof runConnector>[0]["manifest"]> & {
  connector_id: string;
  streams: NonNullable<NonNullable<Parameters<typeof runConnector>[0]["manifest"]>["streams"]>;
};
type RuntimeManifestStream = NonNullable<RuntimeManifest["streams"]>[number];

function completeManifest(connectorId: string, streams: RuntimeManifestStream[]): RuntimeManifest {
  return {
    connector_id: connectorId,
    display_name: "Runtime stream isolation test",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: streams.map((stream) => ({
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
      ...stream,
    })),
    version: "1.0.0",
  };
}

function writeConnectorStub(tmpDir: string, script: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  ${script}
});
`,
    "utf8"
  );
  return connectorPath;
}

async function runStub(input: {
  asUrl: string;
  connectorPath: string;
  manifest: RuntimeManifest;
  ownerToken: string;
  rsUrl: string;
}): Promise<RunResult> {
  return (await runConnector({
    admitRunConnection: fakeAdmitRunConnection(),
    collectionMode: "incremental",
    connectorId: input.manifest.connector_id,
    connectorPath: input.connectorPath,
    manifest: input.manifest,
    onInteraction: async () => ({}),
    ownerToken: input.ownerToken,
    persistState: true,
    rsUrl: input.rsUrl,
    state: null,
  })) as RunResult;
}

test("runConnector commits the untouched sibling's checkpoint when the other stream reports a certified stream_collection_failed", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-certified-partial-failure-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });

    // The run stayed failed and retryable — the connection must not falsely
    // read complete.
    assert.equal(result.status, "failed");
    assert.equal(result.connector_error?.code, "stream_collection_failed");
    assert.equal(result.connector_error?.retryable, true);

    // But the untouched sibling's checkpoint DID commit.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(result.run_id ?? "")}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.state_advanced"), "expected the sibling commit to advance state");
    assert.ok(eventTypes.includes("run.stream_skipped"), "expected the failed stream's SKIP_RESULT to be recorded");
    assert.ok(eventTypes.includes("run.failed"), "expected the run to still terminate as failed");
    assert.ok(!eventTypes.includes("run.completed"), "a stream-scoped failure must never read as run.completed");

    const advancedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.state_advanced");
    assert.equal(advancedEvent?.stream_id, "sibling_a");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds an unrelated DETAIL_COVERAGE shortfall during a certified stream failure", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-failure-and-coverage-shortfall-test", [
    ...testManifest("unused").streams,
    {
      name: "shortfall_sibling",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-shortfall-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'shortfall_sibling', stream: 'shortfall_sibling', required_keys: ['detail-1'], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'shortfall_sibling', cursor: { cursor: 'shortfall_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    const runId = result.run_id;
    assert.ok(runId);
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(result.run_id ?? "")}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.stream_skipped"), "the coverage shortfall must be reported");
    assert.ok(eventTypes.includes("run.failed"), "the certified failure must keep the run failed");
    assert.ok(!eventTypes.includes("run.completed"), "a stream-scoped failure must not read as success");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds the failed stream's cursor even when the child leaks a STATE for it before failing it", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-leaked-cursor-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-leaked-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'unsafe_leaked_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");

    // Even though sibling_b leaked a STATE cursor before reporting its own
    // failure, that cursor must never commit — only sibling_a, which
    // reported no failure, is provably safe.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });
    assert.ok(!("sibling_b" in (stateBody.state ?? {})), "the failed stream's leaked cursor must not commit");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds a manifest-declared PARENT state_stream shared with a failed CHILD data stream", async () => {
  // SKIP_RESULT.stream names a DATA stream, but STATE/newState/commitState
  // are keyed by STATE_STREAM — a manifest may declare several data streams
  // sharing one parent state_stream (stream.state_stream). If the failed
  // data stream is mapped through as if its own name WERE the state_stream
  // key, the filter finds no matching newState entry and falsely commits the
  // shared parent checkpoint even though one of its two child streams
  // reported a certified failure and never finished.
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-parent-state-stream-test", [
    {
      coverage_strategy: "checkpoint_window",
      name: "child_a",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      state_stream: "parent",
    },
    {
      coverage_strategy: "checkpoint_window",
      name: "child_b",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      state_stream: "parent",
    },
    // state_stream must name another declared manifest stream (server-side
    // registration validation) — 'parent' is itself a declared stream that
    // the connector never emits RECORD/SKIP_RESULT for directly; it only
    // exists as the shared checkpoint key child_a/child_b both declare.
    {
      name: "parent",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-parent-state-stream-"));
  // child_a finishes and the connector advances the SHARED parent cursor;
  // child_b then fails. The connector never emits a second STATE for
  // 'parent' after the failure (the honest, GroupMe-shaped behavior this
  // suite already assumes elsewhere) -- the one staged 'parent' cursor
  // reflects a run that did NOT finish walking everything state_stream
  // 'parent' covers, so it must not commit.
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'child_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent', cursor: { cursor: 'parent_cursor_after_child_a' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'child_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: child_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");

    // The shared 'parent' state_stream must NOT commit: child_b (which maps
    // to it via the manifest) reported a certified failure, so the parent
    // checkpoint is unproven even though child_a's own portion succeeded.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {}, "the shared parent checkpoint must not falsely commit");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector rejects a state_stream-declared child that emits its own DETAIL_COVERAGE, preventing any commit", async () => {
  // Manifest-authoritative model (spec "Precedence between manifest and
  // run-time evidence"): a state_stream-declared child's checkpoint parent
  // is ALWAYS the manifest's static declaration. Live DETAIL_COVERAGE can no
  // longer supersede it — a state_stream-declared stream MUST NOT emit
  // DETAIL_COVERAGE at all, and doing so is a protocol violation that fails
  // the whole run (no commit for any staged stream, including the unrelated
  // child_a). This replaces the old "live wins unconditionally" behavior
  // this exact scenario used to exercise as a feature.
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-detail-coverage-state-stream-test", [
    {
      name: "child_a",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      coverage_strategy: "checkpoint_window",
      name: "child_b",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      state_stream: "manifest_parent",
    },
    {
      name: "manifest_parent",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      name: "runtime_parent",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-detail-coverage-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'child_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'runtime_parent', cursor: { cursor: 'runtime_parent_cursor_after_child_a' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'runtime_parent', stream: 'child_b', required_keys: [], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'child_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: child_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    let rejection: Error | null = null;
    try {
      await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    } catch (err) {
      rejection = err as Error;
    }

    assert.ok(rejection, "a state_stream-declared stream (child_b) emitting DETAIL_COVERAGE must be rejected");
    assert.match(rejection?.message || "", CHILD_B_STREAM_NAME_PATTERN, "the rejection must name the offending stream");

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state ?? {},
      {},
      "no checkpoint may advance once the connector violates the static state_stream contract, not even runtime_parent's own STATE"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds every declared parent of a failed shared detail stream", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-conflicting-detail-coverage-test", [
    {
      name: "sibling_a",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      name: "parent_a",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      name: "parent_b",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    // sibling_b is a manifest-declared parent_detail_accounting stream with
    // BOTH parent_a and parent_b as its declared parents. Under the
    // manifest-authoritative model, its failure must withhold every
    // DECLARED parent — including parent_b, which committed its own STATE
    // this run but never got a live DETAIL_COVERAGE report for this failed
    // run at all (see spec "Precedence between manifest and run-time
    // evidence"). This is distinct from the old defect where an
    // undeclared, ad-hoc live parent pair could be introduced with no
    // manifest declaration at all.
    {
      coverage_strategy: "parent_detail_accounting",
      name: "sibling_b",
      parent_streams: ["parent_a", "parent_b"],
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-conflict-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent_a', cursor: { cursor: 'parent_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent_b', cursor: { cursor: 'parent_b_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'parent_a', stream: 'sibling_b', required_keys: [], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    const runId = result.run_id;
    assert.ok(runId);
    assert.equal(result.checkpoint_summary?.state_streams_staged, 3);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state ?? {},
      { sibling_a: { cursor: "sibling_a_cursor" } },
      "every declared parent of the failed detail stream is withheld — including parent_b, which got no live coverage report this run — while an unrelated sibling still commits"
    );

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.failed"));
    assert.ok(eventTypes.includes("run.state_advanced"));
    assert.ok(!eventTypes.includes("run.completed"));
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint when DONE claims stream_collection_failed but no SKIP_RESULT named any stream", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-uncertified-code-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-uncertified-"));
  // Same terminal error.code as the certified case, but with ZERO SKIP_RESULT
  // messages — the runtime cannot verify which (if any) stream actually
  // failed, so this must fail exactly like an ordinary global failure: no
  // commit at all, not even for sibling_a which reached its own STATE.
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {});
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint on an ordinary uncoded failed DONE (counterweight)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-generic-failure-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-generic-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { message: 'boom', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint when the connector crashes without a terminal DONE (counterweight)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-crash-no-done-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-crash-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {});
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

// A retryable SKIP_RESULT is a reported omission. On a SUCCESSFUL DONE the
// runtime previously recorded it only as a known gap and still committed the
// stream's staged cursor, so the omitted rows sat behind a committed
// checkpoint with no durable work item to replay them. The stream's cursor
// must be withheld so the next run starts from the prior checkpoint.
test("runConnector withholds a stream's cursor after a retryable SKIP_RESULT on a successful DONE, and the next run replays from the prior checkpoint", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-retryable-skip-withholds-cursor-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-retryable-skip-"));
  const startStatePath = join(tmpDir, "start-state.json");
  const firstRunPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_b', key: 'b-1', data: { id: 'b-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'beyond_withheld_rows' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'upstream_pressure', message: 'withheld rows after 429', recovery_hint: 'retry_by_runtime' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath: firstRunPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "succeeded");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(
      result.checkpoint_summary?.state_streams_committed,
      1,
      "the stream that reported a retryable omission must not commit its cursor"
    );

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });

    // Next run: START carries the committed state. sibling_b has no
    // checkpoint, so the connector re-collects the omitted rows.
    const replayPath = join(tmpDir, "replay-connector.mjs");
    writeFileSync(
      replayPath,
      `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(startStatePath)}, JSON.stringify(msg));
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_b', key: 'b-2', data: { id: 'b-2' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'replayed' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
      "utf8"
    );
    const replay = (await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "incremental",
      connectorId: manifest.connector_id,
      connectorPath: replayPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      state: stateBody.state ?? null,
    })) as RunResult;
    assert.equal(replay.status, "succeeded");
    const replayStart = JSON.parse(readFileSync(startStatePath, "utf8")) as {
      protocol_capabilities?: string[];
      state?: Record<string, unknown> | null;
      type: string;
    };
    assert.equal(replayStart.type, "START");
    assert.ok(
      replayStart.protocol_capabilities?.includes("DETAIL_COVERAGE_KEY_SETS"),
      "START must advertise support before connectors emit empty_keys/unchanged_keys"
    );
    const replayStartState = replayStart.state;
    assert.ok(
      !("sibling_b" in (replayStartState ?? {})),
      "the replay run must start sibling_b from its prior checkpoint"
    );

    const afterReplay = (await (
      await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    ).json()) as { state?: Record<string, unknown> };
    assert.deepEqual(afterReplay.state, {
      sibling_a: { cursor: "sibling_a_cursor" },
      sibling_b: { cursor: "replayed" },
    });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

// A retryable SKIP_RESULT that names no stream still omitted rows that some
// staged cursor owns. Nothing proves which, so no staged cursor may move; the
// run stays successful and says why each cursor was withheld.
test("runConnector withholds every staged cursor after a retryable SKIP_RESULT that names no stream", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-streamless-retryable-skip-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-streamless-skip-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'beyond_withheld_rows' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', reason: 'upstream_pressure', message: 'withheld rows after 429', recovery_hint: 'retry_by_runtime' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "succeeded");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(
      result.checkpoint_summary?.state_streams_committed,
      0,
      "no staged cursor is proven clear of the omission"
    );
    const withheld = (result.known_gaps ?? []).filter((gap) => gap.kind === "checkpoint_withheld");
    assert.deepEqual(withheld.map((gap) => gap.stream).sort(), ["sibling_a", "sibling_b"]);
    for (const gap of withheld) {
      assert.match(String(gap.message), STREAMLESS_OMISSION_PATTERN);
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector still commits a stream whose SKIP_RESULT is not retryable (counterweight)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-permanent-skip-commits-cursor-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-permanent-skip-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'sibling_b_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'not_available', message: 'provider never exposes this', recovery_hint: 'not_retriable' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "succeeded");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 2);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

// The scheduler decides whether a failed run still counts toward back-off by
// reading `connector_error.code` and `checkpoint_summary.commit_status` off the
// run result (scheduler-backoff.ts, isCertifiedStreamFailureWithCommittedSiblings).
// Pin that those two facts are what a certified failure with committed siblings
// reports, and that, for a failed stream that staged a cursor before its
// SKIP_RESULT, `checkpoint_stalled` still appears on the third consecutive run.
// The next test covers the shape where the failed stream stages no cursor.
test("a certified failure with committed siblings reports the scheduler's facts and stalls the failed stream's checkpoint at 3 runs", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-certified-stall-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-stall-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'sibling_b_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const reasons: (string | undefined)[] = [];
    for (let run = 1; run <= 3; run += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the stall streak is defined by run order.
      const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
      assert.equal(result.status, "failed", `run ${run}`);
      assert.equal(result.connector_error?.code, "stream_collection_failed", `run ${run}`);
      assert.equal(
        (result.checkpoint_summary as { commit_status?: string } | undefined)?.commit_status,
        "partially_committed",
        `run ${run}: the sibling committed, the failed stream did not`
      );
      assert.equal(result.checkpoint_summary?.state_streams_committed, 1, `run ${run}`);
      const withheld = (result.known_gaps ?? []).find((gap) => gap.kind === "checkpoint_withheld");
      reasons.push(withheld?.reason as string | undefined);
    }
    assert.deepEqual(reasons, ["checkpoint_withheld", "checkpoint_withheld", "checkpoint_stalled"]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

// The natural early-failure shape: the failed stream never reaches a STATE, so
// it stages no cursor and there is nothing to withhold. `checkpoint_stalled`
// is a property of a staged-then-withheld cursor, so it does NOT fire here, however
// many runs repeat. Pin what the owner does see on every run instead: the run is
// failed and carries the failed stream's SKIP_RESULT gap plus the commit status.
test("a certified failure whose failed stream stages no cursor reports the failure on every run and never stalls a checkpoint", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-certified-natural-shape-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-natural-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    for (let run = 1; run <= 4; run += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the streak is defined by run order.
      const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
      const gaps = result.known_gaps ?? [];
      assert.equal(result.status, "failed", `run ${run}`);
      assert.equal(
        (result.checkpoint_summary as { commit_status?: string } | undefined)?.commit_status,
        "committed",
        `run ${run}: the one staged cursor is the sibling's and it committed`
      );
      assert.deepEqual(
        gaps.filter((gap) => gap.kind === "checkpoint_withheld"),
        [],
        `run ${run}: no staged cursor is withheld, so no checkpoint_withheld or checkpoint_stalled gap`
      );
      const skipGap = gaps.find((gap) => gap.kind === "skip_result");
      assert.equal(skipGap?.reason, "stream_collection_failed", `run ${run}: the failed stream stays reported`);
      assert.equal(skipGap?.stream, "sibling_b", `run ${run}`);
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});
