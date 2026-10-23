// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Atomicity of the per-connection collection revision. The server allocates
// the next revision inside the same transaction as the durable event it
// orders: each device batch record write, the batch acceptance (the replay
// decision), a delivered failure report, a terminal run commit and the legacy
// split terminal report. A refusal has no other durable effect, so its
// revision is its only write. If the revision cannot be recorded, the request
// fails and nothing is admitted; no catch turns that into a definitive answer.
//
// Interleavings are deterministic: the device ingest phase hook pauses a batch
// between its committed boundaries, and a database trigger makes every
// revision write fail. Every test runs on SQLite, and on a real PostgreSQL
// database when PDPP_TEST_POSTGRES_URL names one.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { validateResponse } from "@pdpp/reference-contract";

import type { Controller } from "../runtime/controller.ts";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import {
  __testOnlySetFoldPauseHook,
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { startServer } from "../server/index.ts";
import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { __setLocalCollectorReleaseForTest } from "../server/local-collector-profiles.ts";
import { __setPostgresAdmissionLockedPhaseHookForTest } from "../server/postgres-records.ts";
import { bootstrapPostgresSchema, closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { putSyncState, readCommittedLocalCoverageDiagnostics } from "../server/records.ts";
import { getConnectorDetail, getOwnerConnectionDiagnostics, listConnectorSummaries } from "../server/ref-control.ts";
import { __setDeviceIngestPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import {
  __setLocalCoverageFenceReadHookForTest,
  beginStorageEpochAfterRestore,
  isCollectionRevisionUnavailable,
  issueCollectionRunSequence,
  RunStartConflictError,
} from "../server/stores/collection-revision-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

type Backend = "postgres" | "sqlite";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const BACKENDS: readonly Backend[] = ["sqlite", "postgres"];
const CONNECTOR_ID = "claude-code";
const OWNER_PASSWORD = "local-coverage-revision-atomicity-password";
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const CSRF_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const PROFILE = {
  connector_id: CONNECTOR_ID,
  protocol_capabilities: ["RUN_COVERAGE_V1"],
  protocol_version: "0.2.0",
  streams: [
    { coverage_stores: ["projects"], name: "sessions", primary_key: ["id"] },
    { coverage_stores: ["derived_messages"], name: "messages", primary_key: ["id"] },
  ],
  version: "0.0.0-revision-atomicity",
};
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(PROFILE)).digest("hex")}`;
const SERVER_RELEASE = { artifactDigest: ARTIFACT_DIGEST, manifest: PROFILE };
const EMITTED_AT = "2026-10-22T12:00:00.000Z";

interface Enrolled {
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

interface Lane {
  readonly asUrl: string;
  readonly backend: Backend;
  readonly controller?: Controller;
  readonly enrolled: Enrolled;
}

interface JsonResponse {
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

interface Projection {
  readonly asOf: Record<string, unknown> | null;
  readonly axis: string;
}

interface HighWater {
  readonly event: string | null;
  readonly revision: number;
  readonly runId: string | null;
}

type TerminalCommit = Parameters<typeof commitTerminalRun>[0];

function testName(backend: Backend, name: string): string {
  return backend === "postgres" ? `${name} [real PostgreSQL]` : name;
}

const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";

const READS = /^\s*SELECT\b/i;

/** Run a statement on the lane's backend. Postgres takes `$n` placeholders; SQLite takes `?`. */
async function sql(lane: Pick<Lane, "backend">, sqlite: string, postgres: string, params: unknown[] = []) {
  if (lane.backend === "postgres") {
    return (await postgresQuery(postgres, params)).rows as Record<string, unknown>[];
  }
  const statement = getDb().prepare(sqlite);
  if (READS.test(sqlite)) {
    return statement.all(...params) as Record<string, unknown>[];
  }
  statement.run(...params);
  return [];
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const resp = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  const text = await resp.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A non-JSON response keeps a null body; the status assertion reports it.
  }
  return { body, status: resp.status };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return requestJson(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
}

function setCookiePair(resp: Response, name: string): string | null {
  for (const header of resp.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return null;
}

async function ownerSessionCookie(asUrl: string): Promise<string> {
  const page = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = setCookiePair(page, "pdpp_owner_csrf") ?? "";
  const csrfField = CSRF_FIELD_PATTERN.exec(await page.text())?.[1] ?? "";
  const login = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
    method: "POST",
    redirect: "manual",
  });
  const session = setCookiePair(login, "pdpp_owner_session");
  assert.ok(session, `owner login should set pdpp_owner_session (status ${login.status})`);
  return session;
}

async function enroll(asUrl: string, cookie: string): Promise<Enrolled> {
  const code = await postJson(
    `${asUrl}/_ref/device-exporters/enrollment-codes`,
    { connector_id: CONNECTOR_ID, local_binding_name: "revision-atomicity-laptop" },
    { Cookie: cookie }
  );
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const enrolled = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: String(code.body?.enrollment_code) },
    PROTOCOL_HEADERS
  );
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const body = enrolled.body ?? {};
  return {
    connector_instance_id: String(body.connector_instance_id),
    device_id: String(body.device_id),
    device_token: String(body.device_token),
    source_instance_id: String(body.source_instance_id),
  };
}

/** Narrow the enrolled catalog manifest to the release's two streams, as a catalog update does. */
async function registerFixtureManifest(lane: Lane): Promise<void> {
  const [row] = await sql(
    lane,
    "SELECT manifest FROM connectors WHERE connector_id = ?",
    "SELECT manifest::text AS manifest FROM connectors WHERE connector_id = $1",
    [CONNECTOR_ID]
  );
  assert.ok(row, "enrolment registers the claude-code catalog manifest");
  const catalog = JSON.parse(String(row.manifest)) as Record<string, unknown> & { streams: Record<string, unknown>[] };
  const streams = PROFILE.streams.map((release) => {
    const declared = catalog.streams.find((stream) => stream.name === release.name);
    assert.ok(declared, `the catalog declares ${release.name}`);
    return { ...declared, coverage_stores: release.coverage_stores };
  });
  await sql(
    lane,
    "UPDATE connectors SET manifest = ? WHERE connector_id = ?",
    "UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2",
    [JSON.stringify({ ...catalog, streams }), CONNECTOR_ID]
  );
  await sql(
    lane,
    "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_instance_id = ?",
    "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_instance_id = $1",
    [lane.enrolled.connector_instance_id]
  );
}

async function withServerLane(
  backend: Backend,
  options: { readonly dbPath: string; readonly postgresUrl?: string },
  run: (lane: Lane) => Promise<void>
): Promise<void> {
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (options.postgresUrl) {
    initDb(":memory:");
    process.env.PDPP_DATABASE_URL = options.postgresUrl;
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      asPort: 0,
      dbPath: options.dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      quiet: true,
      rsPort: 0,
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
  }
  await server.startupBackfillDone?.catch(() => undefined);
  const asUrl = `http://localhost:${server.asPort}`;
  __setLocalCollectorReleaseForTest(CONNECTOR_ID, SERVER_RELEASE);
  try {
    const cookie = await ownerSessionCookie(asUrl);
    const enrolled = await enroll(asUrl, cookie);
    const lane = { asUrl, backend, controller: server.controller, enrolled };
    await registerFixtureManifest(lane);
    await run(lane);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
    __setLocalCollectorReleaseForTest(CONNECTOR_ID, null);
    await closeTestServer(server);
    if (options.postgresUrl) {
      await closePostgresStorage().catch(() => undefined);
    }
    closeDb();
  }
}

let databaseCounter = 0;

async function withLane(backend: Backend, run: (lane: Lane) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-revision-atomicity-"));
  try {
    if (backend === "sqlite") {
      await withServerLane(backend, { dbPath: join(dir, "pdpp.sqlite") }, run);
      return;
    }
    assert.ok(POSTGRES_URL, "the Postgres lane requires PDPP_TEST_POSTGRES_URL");
    databaseCounter += 1;
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_revision_atomicity_${process.pid}_${databaseCounter}`,
      },
      (url) => withServerLane(backend, { dbPath: ":memory:", postgresUrl: url }, run)
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function deviceUrl(lane: Lane, suffix: string): string {
  return `${lane.asUrl}/_ref/device-exporters/${encodeURIComponent(lane.enrolled.device_id)}${suffix}`;
}

function sourceUrl(lane: Lane, suffix: string): string {
  return deviceUrl(lane, `/source-instances/${encodeURIComponent(lane.enrolled.source_instance_id)}${suffix}`);
}

function authHeaders(lane: Lane): Record<string, string> {
  return { Authorization: `Bearer ${lane.enrolled.device_token}`, ...PROTOCOL_HEADERS };
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, canonical(object[key])])
  );
}

function sessionRecords(...ids: string[]): Record<string, unknown>[] {
  return ids.map((id) => ({ data: { id }, emitted_at: EMITTED_AT, record_key: id, stream: "sessions" }));
}

function batchBody(lane: Lane, batchId: string, records: Record<string, unknown>[]): Record<string, unknown> {
  return {
    batch_id: batchId,
    batch_seq: 0,
    body_hash: createHash("sha256")
      .update(JSON.stringify(canonical(records)))
      .digest("hex"),
    connector_id: CONNECTOR_ID,
    device_id: lane.enrolled.device_id,
    records,
    source_instance_id: lane.enrolled.source_instance_id,
  };
}

function postBatch(lane: Lane, body: Record<string, unknown>): Promise<JsonResponse> {
  return postJson(deviceUrl(lane, "/ingest-batches"), body, authHeaders(lane));
}

function postFailureReport(lane: Lane, runId: string): Promise<JsonResponse> {
  return postJson(
    sourceUrl(lane, "/local-collector-gaps"),
    {
      connector_id: CONNECTOR_ID,
      first_seen_at: EMITTED_AT,
      last_run_id: runId,
      next_attempt_backoff_ms: 0,
      reason: "connector_child_failure",
      retryable: true,
      source_instance_id: lane.enrolled.source_instance_id,
    },
    authHeaders(lane)
  );
}

/** Register a run at its start, as the runtime does before its scan. Returns the issued sequence. */
async function issueRun(
  lane: Lane,
  runId: string,
  identity: { readonly deviceId?: string; readonly sourceInstanceId?: string } = {}
): Promise<number> {
  const { issued } = await issueCollectionRunSequence({
    connectorInstanceId: lane.enrolled.connector_instance_id,
    deviceId: identity.deviceId ?? lane.enrolled.device_id,
    runId,
    sourceInstanceId: identity.sourceInstanceId ?? lane.enrolled.source_instance_id,
  });
  return issued.runSequence;
}

/** A v2 terminal proof for both streams, bound to the server's release, for a run registered at its start. Returns the commit so a test can replay it. */
async function commitProof(lane: Lane, runId: string): Promise<TerminalCommit> {
  await issueRun(lane, runId);
  return await commitIssuedProof(lane, runId);
}

/** `commitProof` for a run that is already registered, or deliberately is not. */
async function commitIssuedProof(
  lane: Lane,
  runId: string,
  identity: Partial<TerminalCommit> = {}
): Promise<TerminalCommit> {
  const commit = { ...(await buildProof(lane, runId)), ...identity };
  const result = await commitTerminalRun(commit);
  assert.equal(result.replayed, false, `run ${runId} commits a new terminal proof`);
  return commit;
}

/** The device's last heartbeat: a drained outbox, as after a complete run. */
async function markDrained(lane: Lane): Promise<void> {
  await getDefaultDeviceExporterStore().markSourceInstanceHeartbeat(
    lane.enrolled.device_id,
    lane.enrolled.source_instance_id,
    {
      lastError: null,
      outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 1, total: 1 },
      receivedAt: new Date().toISOString(),
      recordsPending: 0,
      status: "healthy",
    }
  );
}

/** The v2 terminal commit `commitProof` sends, not yet committed. */
async function buildProof(
  lane: Lane,
  runId: string,
  stateDelta: TerminalCommit["stateDelta"] = {}
): Promise<TerminalCommit> {
  const { connector_instance_id: connectorInstanceId, device_id: deviceId } = lane.enrolled;
  const sourceInstanceId = lane.enrolled.source_instance_id;
  await markDrained(lane);
  const [instance] = await sql(
    lane,
    "SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?",
    "SELECT manifest_generation::integer AS manifest_generation FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const bindings = {
    artifact_digest: ARTIFACT_DIGEST,
    binding_generation: Number(instance?.manifest_generation),
    manifest_fingerprint: fingerprintDeviceAttemptManifest(PROFILE),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    server_artifact_digest: ARTIFACT_DIGEST,
  };
  const stream = (name: string, store: string) => ({
    ...bindings,
    checkpoint: "committed",
    collected: 0,
    considered: null,
    coverage_statuses: ["collected"],
    covered: null,
    pending_detail_gaps: 0,
    scoped: true,
    skipped: null,
    stores: [{ status: "collected", store }],
    stream: name,
  });
  // The proof measures the collection boundary the connection declares (enrolment sets a window).
  const diagnostics = await readCommittedLocalCoverageDiagnostics({
    connector_id: CONNECTOR_ID,
    connector_instance_id: connectorInstanceId,
  });
  assert.ok("declaredCollectionScope" in diagnostics, "the connection declares its collection boundary");
  const commit: TerminalCommit = {
    collectionBoundary: diagnostics.declaredCollectionScope,
    commitId: `commit_${runId}`,
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    deviceId,
    envelopeHash: `envelope_${runId}`,
    normalizedFacts: [stream("sessions", "projects"), stream("messages", "derived_messages")],
    runId,
    sourceInstanceId,
    stateDelta,
    version: 2,
  };
  return commit;
}

async function projection(lane: Lane): Promise<Projection> {
  await reconcileDirtyConnectorSummaryEvidence(null);
  const summary = (await listConnectorSummaries()).find(
    (row) => row.connector_instance_id === lane.enrolled.connector_instance_id
  );
  assert.ok(summary, "the lane's connection is projected");
  return {
    asOf: (summary.coverage_as_of as Record<string, unknown> | null) ?? null,
    axis: summary.connection_health.axes.coverage,
  };
}

async function assertCovered(lane: Lane, runId: string, message: string): Promise<void> {
  const projected = await projection(lane);
  assert.equal(projected.axis, "complete", message);
  assert.equal(projected.asOf?.run_id, runId, `${message}: the coverage names its run`);
}

async function assertRetired(lane: Lane, message: string): Promise<void> {
  const projected = await projection(lane);
  assert.equal(projected.axis, "unknown", `${message}: ${JSON.stringify(projected)}`);
  assert.equal(projected.asOf, null, `${message}: retired coverage carries no as-of`);
}

laneTest("placement: direct runNow refuses a local-device connection at shared admission", async (lane) => {
  assert.ok(lane.controller, "server controller is available");
  await assert.rejects(
    lane.controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: lane.enrolled.connector_instance_id,
      runId: "run-local-device-server-run-refused",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "local_device_control_unsupported");
      assert.ok((error as Error).message.includes("cannot be started by the reference server"));
      return true;
    }
  );
  const [run] = await sql(
    lane,
    "SELECT run_id FROM run_history WHERE run_id = ?",
    "SELECT run_id FROM run_history WHERE run_id = $1",
    ["run-local-device-server-run-refused"]
  );
  assert.equal(run, undefined, "admission refuses before a server run record is written");
});

laneTest("placement: webhook-triggered runNow refuses a local-device connection at shared admission", async (lane) => {
  assert.ok(lane.controller, "server controller is available");
  await assert.rejects(
    lane.controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: lane.enrolled.connector_instance_id,
      runId: "run-local-device-webhook-refused",
      sourceWebhookEvent: {
        action: "schedule_run",
        bodyHash: "a".repeat(64),
        eventId: "evt-local-device-webhook-refused",
        receivedAt: EMITTED_AT,
        sourceId: "source-webhook-local-device-refused",
      },
      triggerKind: "webhook",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "local_device_control_unsupported");
      assert.ok((error as Error).message.includes("cannot be started by the reference server"));
      return true;
    }
  );
  const [run] = await sql(
    lane,
    "SELECT run_id FROM run_history WHERE run_id = ?",
    "SELECT run_id FROM run_history WHERE run_id = $1",
    ["run-local-device-webhook-refused"]
  );
  assert.equal(run, undefined, "webhook admission refuses before a server run record is written");
});

async function highWater(lane: Lane): Promise<HighWater> {
  const [row] = await sql(
    lane,
    `SELECT collection_revision AS revision, collection_revision_event AS event, collection_revision_run_id AS run_id
       FROM connector_instances WHERE connector_instance_id = ?`,
    `SELECT collection_revision::text AS revision, collection_revision_event AS event,
            collection_revision_run_id AS run_id
       FROM connector_instances WHERE connector_instance_id = $1`,
    [lane.enrolled.connector_instance_id]
  );
  assert.ok(row, "the connection has a revision row");
  return {
    event: (row.event as string | null) ?? null,
    revision: Number(row.revision),
    runId: (row.run_id as string | null) ?? null,
  };
}

async function sessionRecordCount(lane: Lane): Promise<number> {
  const [row] = await sql(
    lane,
    "SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ? AND stream = 'sessions'",
    "SELECT COUNT(*)::integer AS n FROM records WHERE connector_instance_id = $1 AND stream = 'sessions'",
    [lane.enrolled.connector_instance_id]
  );
  return Number(row?.n ?? 0);
}

async function openGapCount(lane: Lane): Promise<number> {
  const [row] = await sql(
    lane,
    "SELECT COUNT(*) AS n FROM connector_detail_gaps WHERE connector_instance_id = ?",
    "SELECT COUNT(*)::integer AS n FROM connector_detail_gaps WHERE connector_instance_id = $1",
    [lane.enrolled.connector_instance_id]
  );
  return Number(row?.n ?? 0);
}

/**
 * Make every write that advances a collection revision fail, as a storage
 * fault would. With `event`, only the advance for that event kind fails, so
 * a test can fail one step of a multi-step request after earlier steps
 * committed.
 */
async function failRevisionWrites(lane: Lane, event?: string): Promise<() => Promise<void>> {
  const only = (column: string) => (event ? ` AND ${column} = '${event}'` : "");
  if (lane.backend === "postgres") {
    await postgresQuery(`CREATE FUNCTION pdpp_test_fail_collection_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected collection revision failure'; END $$`);
    await postgresQuery(`CREATE TRIGGER pdpp_test_fail_collection_revision
      BEFORE UPDATE OF collection_revision ON connector_instances FOR EACH ROW
      WHEN (NEW.collection_revision IS DISTINCT FROM OLD.collection_revision${only("NEW.collection_revision_event")})
      EXECUTE FUNCTION pdpp_test_fail_collection_revision()`);
    return async () => {
      await postgresQuery("DROP TRIGGER pdpp_test_fail_collection_revision ON connector_instances");
      await postgresQuery("DROP FUNCTION pdpp_test_fail_collection_revision()");
    };
  }
  getDb().exec(`CREATE TRIGGER pdpp_test_fail_collection_revision
    BEFORE UPDATE OF collection_revision ON connector_instances
    WHEN NEW.collection_revision IS NOT OLD.collection_revision${only("NEW.collection_revision_event")}
    BEGIN SELECT RAISE(ABORT, 'injected collection revision failure'); END`);
  return () => {
    getDb().exec("DROP TRIGGER pdpp_test_fail_collection_revision");
    return Promise.resolve();
  };
}

/** Fail run-start persistence once, then let the terminal route record its unregistered run. */
async function failRunStartWrites(lane: Lane): Promise<() => Promise<void>> {
  if (lane.backend === "postgres") {
    await postgresQuery(`CREATE FUNCTION pdpp_test_fail_run_start() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected run-start failure'; END $$`);
    await postgresQuery(`CREATE TRIGGER pdpp_test_fail_run_start
      BEFORE INSERT ON collection_run_sequences FOR EACH ROW
      EXECUTE FUNCTION pdpp_test_fail_run_start()`);
    return async () => {
      await postgresQuery("DROP TRIGGER pdpp_test_fail_run_start ON collection_run_sequences");
      await postgresQuery("DROP FUNCTION pdpp_test_fail_run_start()");
    };
  }
  getDb().exec(`CREATE TRIGGER pdpp_test_fail_run_start
    BEFORE INSERT ON collection_run_sequences
    BEGIN SELECT RAISE(ABORT, 'injected run-start failure'); END`);
  return () => {
    getDb().exec("DROP TRIGGER pdpp_test_fail_run_start");
    return Promise.resolve();
  };
}

/** A promise the test resolves to release a paused batch. */
function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

/** Register one test per backend. The Postgres one skips without a dedicated test database. */
function laneTest(name: string, body: (lane: Lane) => Promise<void>): void {
  for (const backend of BACKENDS) {
    test(testName(backend, name), { skip: backend === "postgres" ? POSTGRES_SKIP : false }, () =>
      withLane(backend, body)
    );
  }
}

laneTest("a refused batch whose revision cannot be recorded fails the request", async (lane) => {
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof is current");
  const refused = { ...batchBody(lane, "batch-bad-hash", sessionRecords("s-1")), body_hash: "0".repeat(64) };

  const restore = await failRevisionWrites(lane);
  const failed = await postBatch(lane, refused);
  await restore();
  assert.equal(failed.status, 503, `an unrecorded refusal is not a definitive answer: ${JSON.stringify(failed.body)}`);
  assert.equal((failed.body?.error as Record<string, unknown> | undefined)?.code, "device_ingest_retryable");

  const answered = await postBatch(lane, refused);
  assert.equal(answered.status, 400, JSON.stringify(answered.body));
  await assertRetired(lane, "the recorded refusal retires run A's proof");
  assert.equal((await highWater(lane)).event, "batch_rejected");
});

laneTest("a batch whose revision cannot be recorded admits no record", async (lane) => {
  await commitProof(lane, "run-a");
  const batch = batchBody(lane, "batch-unrecorded", sessionRecords("s-1", "s-2"));
  const before = await highWater(lane);

  const restore = await failRevisionWrites(lane);
  const failed = await postBatch(lane, batch);
  await restore();
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(await sessionRecordCount(lane), 0, "no record is durable without its revision");
  assert.deepEqual(await highWater(lane), before, "nothing advanced the revision");
  await assertCovered(lane, "run-a", "the server admitted nothing after run A");

  const retried = await postBatch(lane, batch);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(await sessionRecordCount(lane), 2);
  await assertRetired(lane, "the admitted batch retires run A's proof");
  assert.equal((await highWater(lane)).event, "batch_accepted");
});

laneTest("a crash after a batch record is durable cannot leave the earlier proof current", async (lane) => {
  await commitProof(lane, "run-a");
  const observed: Array<[string, string]> = [];
  __setDeviceIngestPhaseFaultHookForTest(async (point, inputIndex) => {
    if (point === "after-durable-record" || point === "after-durable-phase") {
      // The process could die here. What the owner would see is what is durable now.
      observed.push([`${point}${inputIndex === undefined ? "" : `:${inputIndex}`}`, (await projection(lane)).axis]);
    }
  });
  const accepted = await postBatch(lane, batchBody(lane, "batch-crash-window", sessionRecords("s-1", "s-2")));
  __setDeviceIngestPhaseFaultHookForTest(null);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.deepEqual(observed, [
    ["after-durable-record:0", "unknown"],
    ["after-durable-record:1", "unknown"],
    ["after-durable-phase", "unknown"],
  ]);
  await assertRetired(lane, "the accepted batch retires run A's proof");
});

laneTest(
  "a terminal proof committed inside a batch is retired by the batch's later record and acceptance",
  async (lane) => {
    const observed: Array<[string, string, unknown]> = [];
    __setDeviceIngestPhaseFaultHookForTest(async (point, inputIndex) => {
      if (point === "after-durable-record" && inputIndex === 0) {
        await commitProof(lane, "run-b");
        const projected = await projection(lane);
        observed.push(["proof", projected.axis, projected.asOf?.run_id]);
      } else if (point === "after-durable-record" && inputIndex === 1) {
        const projected = await projection(lane);
        observed.push(["record after proof", projected.axis, projected.asOf?.run_id ?? null]);
      }
    });
    const accepted = await postBatch(lane, batchBody(lane, "batch-straddles-proof", sessionRecords("s-1", "s-2")));
    __setDeviceIngestPhaseFaultHookForTest(null);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.deepEqual(observed, [
      ["proof", "complete", "run-b"],
      ["record after proof", "unknown", null],
    ]);
    await assertRetired(lane, "the acceptance is later than run B's proof");
    assert.equal((await highWater(lane)).event, "batch_accepted");
  }
);

laneTest("two interleaved batches and a terminal commit: the newest event decides", async (lane) => {
  const paused = gate();
  const reachedPause = gate();
  __setDeviceIngestPhaseFaultHookForTest(async (point, _inputIndex, identity) => {
    if (point === "after-durable-phase" && identity?.batchId === "batch-x") {
      reachedPause.open();
      await paused.wait;
    }
  });
  const x = postBatch(lane, batchBody(lane, "batch-x", sessionRecords("x-1")));
  await reachedPause.wait;
  const y = await postBatch(lane, batchBody(lane, "batch-y", sessionRecords("y-1")));
  assert.equal(y.status, 201, JSON.stringify(y.body));
  await commitProof(lane, "run-b");
  await assertCovered(lane, "run-b", "run B's proof is newer than batch Y");

  paused.open();
  const xResult = await x;
  __setDeviceIngestPhaseFaultHookForTest(null);
  assert.equal(xResult.status, 201, JSON.stringify(xResult.body));
  await assertRetired(lane, "batch X's acceptance is newer than run B's proof");

  await commitProof(lane, "run-c");
  await assertCovered(lane, "run-c", "run C's proof is the newest event");
});

laneTest(
  "replaying a stored terminal response allocates no revision and does not restore a retired proof",
  async (lane) => {
    const proof = await commitProof(lane, "run-b");
    await assertCovered(lane, "run-b", "run B's proof is current");
    const accepted = await postBatch(lane, batchBody(lane, "batch-after-b", sessionRecords("s-1")));
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const retired = await highWater(lane);

    const replay = await commitTerminalRun(proof);
    assert.equal(replay.replayed, true, "the exact commit replays its stored response");
    assert.deepEqual(await highWater(lane), retired, "a replay is not a new event");
    await assertRetired(lane, "the replay does not restore run B's proof");
  }
);

laneTest("a refused resend of a batch from the proof's own run retires the proof", async (lane) => {
  const batch = batchBody(lane, "batch-run-a", sessionRecords("s-1"));
  assert.equal((await postBatch(lane, batch)).status, 201);
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof follows its own batch");

  const conflicting = batchBody(lane, "batch-run-a", sessionRecords("s-1", "s-2"));
  const refused = await postBatch(lane, conflicting);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  await assertRetired(lane, "the refused resend is a later observed attempt");
  assert.equal((await highWater(lane)).event, "batch_rejected");
});

laneTest("a failure report whose revision cannot be recorded stores no gap", async (lane) => {
  await commitProof(lane, "run-a");
  const restore = await failRevisionWrites(lane);
  const failed = await postFailureReport(lane, "run-b");
  await restore();
  assert.ok(failed.status >= 500, `the report is not acknowledged: ${failed.status} ${JSON.stringify(failed.body)}`);
  assert.equal(await openGapCount(lane), 0, "the gap is not stored without its revision");
  await assertCovered(lane, "run-a", "nothing was recorded after run A");

  const delivered = await postFailureReport(lane, "run-b");
  assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
  assert.equal(await openGapCount(lane), 1);
  // The open failure gap is a coverage shortfall of its own; run A's proof no longer stands behind the axis.
  const projected = await projection(lane);
  assert.equal(projected.axis, "retryable_gap", "the delivered failure report retires run A's proof");
  assert.equal(projected.asOf, null, "retired coverage carries no as-of");
  assert.deepEqual(
    { ...(await highWater(lane)), revision: 0 },
    {
      event: "failure_report",
      revision: 0,
      runId: "run-b",
    }
  );
});

laneTest("a delayed legacy split terminal for an older run retires a newer proof", async (lane) => {
  // Run A (legacy split protocol): its state commit reaches the server.
  const state = await requestJson(sourceUrl(lane, "/state"), {
    body: JSON.stringify({ state: { sessions: { cursor: "a" } } }),
    headers: { "Content-Type": "application/json", ...authHeaders(lane) },
    method: "PUT",
  });
  assert.equal(state.status, 200, JSON.stringify(state.body));
  // Run B commits a v2 proof.
  await commitProof(lane, "run-b");
  await assertCovered(lane, "run-b", "run B's proof is current");

  // Run A's split terminal report arrives late. The server observes it after run B's proof.
  const report = await postJson(
    sourceUrl(lane, "/terminal-collection"),
    {
      connector_id: CONNECTOR_ID,
      run_id: "run-a",
      source_instance_id: lane.enrolled.source_instance_id,
      streams: [
        { coverage_statuses: ["collected"], stream: "sessions" },
        { coverage_statuses: ["collected"], stream: "messages" },
      ],
    },
    authHeaders(lane)
  );
  assert.equal(report.status, 201, JSON.stringify(report.body));
  await assertRetired(lane, "the later legacy terminal retires run B's proof");
  const after = await highWater(lane);
  assert.equal(after.runId, "run-a", "the high-water mark names the newest observed event");
  assert.notEqual(after.event, "terminal_run", "a legacy terminal is not a v2 proof");
  const [run] = await sql(
    lane,
    "SELECT facts_json FROM run_history WHERE run_id = ?",
    "SELECT facts_json::text AS facts_json FROM run_history WHERE run_id = $1",
    ["run-a"]
  );
  assert.equal(
    (JSON.parse(String(run?.facts_json)) as { collection_revision?: unknown }).collection_revision,
    after.revision,
    "the legacy run record carries its own revision"
  );
});

laneTest("every projection that shows complete coverage carries its as-of", async (lane) => {
  await commitProof(lane, "run-a");
  await reconcileDirtyConnectorSummaryEvidence(null);
  const { revision } = await highWater(lane);
  const expected = { artifact_digest: ARTIFACT_DIGEST, collection_revision: revision, run_id: "run-a" };
  const pick = (asOf: unknown) => {
    const value = (asOf ?? {}) as Record<string, unknown>;
    assert.equal(typeof value.committed_at, "string", "the as-of names its commit time");
    return {
      artifact_digest: value.artifact_digest,
      collection_revision: value.collection_revision,
      run_id: value.run_id,
    };
  };

  const summary = (await listConnectorSummaries()).find(
    (row) => row.connector_instance_id === lane.enrolled.connector_instance_id
  );
  assert.equal(summary?.connection_health.axes.coverage, "complete", "summary connection health");
  assert.deepEqual(pick(summary?.coverage_as_of), expected, "summary");

  const detail = await getConnectorDetail(CONNECTOR_ID);
  const detailRecord = detail as unknown as Record<string, unknown>;
  assert.equal(
    (detailRecord.connection_health as { axes: { coverage: string } }).axes.coverage,
    "complete",
    "detail connection health"
  );
  assert.deepEqual(pick(detailRecord.coverage_as_of), expected, "detail");

  const diagnostics = await getOwnerConnectionDiagnostics(lane.enrolled.connector_instance_id);
  assert.ok(diagnostics, "diagnostics resolve the connection");
  assert.equal(diagnostics.health.axes.coverage, "complete", "diagnostics health");
  assert.deepEqual(pick((diagnostics as unknown as Record<string, unknown>).coverage_as_of), expected, "diagnostics");

  // A health object read on its own still names what its coverage is a fact about.
  const detailHealth = detailRecord.connection_health as Record<string, unknown>;
  const healthAsOf = (health: unknown) => (health as Record<string, unknown> | undefined)?.coverage_as_of;
  assert.deepEqual(
    {
      detailHealth: healthAsOf(detailHealth),
      diagnosticsHealth: healthAsOf(diagnostics.health),
      summaryHealth: healthAsOf(summary?.connection_health),
    },
    {
      detailHealth: detailRecord.coverage_as_of,
      diagnosticsHealth: diagnostics.coverage_as_of,
      summaryHealth: summary?.coverage_as_of,
    },
    "every embedded health carries its projection's as-of"
  );
  assert.deepEqual(diagnostics.health.coverage_as_of, summary?.coverage_as_of, "one as-of across the projections");
});

// ---------------------------------------------------------------------------
// Round 3: required terminal allocation, guarded advance, legacy replay,
// device diagnostics, boundary snapshot, selective failures and lock order.
// ---------------------------------------------------------------------------

async function rawRevision(lane: Lane): Promise<string> {
  const [row] = await sql(
    lane,
    "SELECT CAST(collection_revision AS TEXT) AS revision FROM connector_instances WHERE connector_instance_id = ?",
    "SELECT collection_revision::text AS revision FROM connector_instances WHERE connector_instance_id = $1",
    [lane.enrolled.connector_instance_id]
  );
  return String(row?.revision);
}

/** Store a revision value as a storage fault or a hand edit could leave it. */
async function storeRevision(lane: Lane, value: unknown): Promise<void> {
  await sql(
    lane,
    "UPDATE connector_instances SET collection_revision = ? WHERE connector_instance_id = ?",
    "UPDATE connector_instances SET collection_revision = $1::bigint WHERE connector_instance_id = $2",
    [value, lane.enrolled.connector_instance_id]
  );
}

async function runRows(lane: Lane, runId: string): Promise<{ readonly events: number; readonly runs: number }> {
  const [runs] = await sql(
    lane,
    "SELECT COUNT(*) AS n FROM run_history WHERE run_id = ?",
    "SELECT COUNT(*)::integer AS n FROM run_history WHERE run_id = $1",
    [runId]
  );
  const [events] = await sql(
    lane,
    "SELECT COUNT(*) AS n FROM spine_events WHERE run_id = ?",
    "SELECT COUNT(*)::integer AS n FROM spine_events WHERE run_id = $1",
    [runId]
  );
  return { events: Number(events?.n ?? 0), runs: Number(runs?.n ?? 0) };
}

/** The stored `sessions` cursor, or null when no state row exists. */
async function sessionsCursor(lane: Lane): Promise<unknown> {
  const [row] = await sql(
    lane,
    "SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = 'sessions'",
    "SELECT state_json::text AS state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = 'sessions'",
    [lane.enrolled.connector_instance_id]
  );
  return row ? (JSON.parse(String(row.state_json)) as { cursor?: unknown }).cursor : null;
}

function putDeviceState(lane: Lane, cursor: string): Promise<JsonResponse> {
  return requestJson(sourceUrl(lane, "/state"), {
    body: JSON.stringify({ state: { sessions: { cursor } } }),
    headers: { "Content-Type": "application/json", ...authHeaders(lane) },
    method: "PUT",
  });
}

async function terminalOutcome(commit: TerminalCommit): Promise<string> {
  try {
    await commitTerminalRun(commit);
    return "committed";
  } catch (error) {
    return isCollectionRevisionUnavailable(error) ? "revision_unavailable" : String(error);
  }
}

laneTest("no event commits against a stored revision that is unreadable or cannot advance", async (lane) => {
  await commitProof(lane, "run-a");
  // Both schemas accept a negative revision; SQLite's INTEGER affinity also keeps text and reals.
  const stored: ReadonlyArray<readonly [string, unknown]> = [
    ["negative", -1],
    ...(lane.backend === "sqlite"
      ? ([
          ["text", "abc"],
          ["real", 1.5],
        ] as const)
      : []),
    ["exhausted", Number.MAX_SAFE_INTEGER],
  ];
  const outcomes: Record<string, unknown>[] = [];
  for (const [label, value] of stored) {
    await storeRevision(lane, value);
    const before = await rawRevision(lane);
    const runId = `run-${label}`;
    const terminal = await terminalOutcome(await buildProof(lane, runId, { sessions: { cursor: label } }));
    const state = await putDeviceState(lane, `state-${label}`);
    outcomes.push({
      label,
      revisionUnchanged: (await rawRevision(lane)) === before,
      run: await runRows(lane, runId),
      sessionsCursor: await sessionsCursor(lane),
      state: state.status >= 500 ? "refused" : state.status,
      terminal,
    });
  }
  assert.deepEqual(
    outcomes,
    stored.map(([label]) => ({
      label,
      revisionUnchanged: true,
      run: { events: 0, runs: 0 },
      sessionsCursor: null,
      state: "refused",
      terminal: "revision_unavailable",
    }))
  );
});

laneTest("a terminal commit whose revision write fails rolls back whole and keeps the prior proof", async (lane) => {
  await commitProof(lane, "run-a");
  const before = await highWater(lane);
  const restore = await failRevisionWrites(lane, "terminal_run");
  try {
    const outcome = await commitTerminalRun(await buildProof(lane, "run-b", { sessions: { cursor: "b" } })).then(
      () => "committed",
      (error: unknown) => String((error as Error).message)
    );
    assert.match(outcome, /injected collection revision failure/);
    // The trigger fails only the terminal advance: a state commit still records its own revision.
  } finally {
    await restore();
  }
  assert.deepEqual(await highWater(lane), before, "no revision was allocated");
  assert.deepEqual(await runRows(lane, "run-b"), { events: 0, runs: 0 }, "no run event or run record");
  assert.equal(await sessionsCursor(lane), null, "no state row from the rolled-back commit");
  await assertCovered(lane, "run-a", "run A's proof is still the newest event");
});

laneTest(
  "a retried legacy split terminal report neither advances the revision nor retires a newer proof",
  async (lane) => {
    const report = (statuses: string[]) =>
      postJson(
        sourceUrl(lane, "/terminal-collection"),
        {
          connector_id: CONNECTOR_ID,
          run_id: "run-a",
          source_instance_id: lane.enrolled.source_instance_id,
          streams: [
            { coverage_statuses: statuses, stream: "sessions" },
            { coverage_statuses: ["collected"], stream: "messages" },
          ],
        },
        authHeaders(lane)
      );
    const first = await report(["collected"]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await commitProof(lane, "run-b");
    await assertCovered(lane, "run-b", "run B's proof follows run A's report");
    const proof = await highWater(lane);

    const retried = await report(["collected"]);
    const afterRetry = { highWater: await highWater(lane), run: await runRows(lane, "run-a") };
    const conflicting = await report(["partial"]);
    const afterConflict = { highWater: await highWater(lane), run: await runRows(lane, "run-a") };
    assert.deepEqual(afterRetry, { highWater: proof, run: { events: 1, runs: 1 } }, "the retry is not a new event");
    assert.deepEqual(afterConflict, afterRetry, "a conflicting report for the run writes nothing");
    await assertCovered(lane, "run-b", "run B's proof is still current");
    assert.deepEqual(
      [
        [retried.status, retried.body],
        [conflicting.status, (conflicting.body?.error as Record<string, unknown> | undefined)?.code],
      ],
      [
        [200, { ok: true }],
        [409, "terminal_collection_conflict"],
      ],
      "an identical retry is acknowledged; a different report for the run is a conflict"
    );
  }
);

/** Raw `coverage_diagnostics` records, as an old collector left them: no run, release or revision behind them. */
async function seedRawCoverageRows(lane: Lane): Promise<void> {
  for (const [store, stream] of [
    ["projects", "sessions"],
    ["derived_messages", "messages"],
  ] as const) {
    const json = JSON.stringify({ id: `coverage:${store}`, status: "collected", store, stream });
    await sql(
      lane,
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, 'coverage_diagnostics', ?, ?, ?, 1, 0)`,
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted,
                           primary_key_text)
       VALUES ($1, $2, 'coverage_diagnostics', $3, $4::jsonb, $5, 1, FALSE, $3)`,
      [CONNECTOR_ID, lane.enrolled.connector_instance_id, `coverage:${store}`, json, EMITTED_AT]
    );
  }
}

async function deviceCoverage(lane: Lane, cookie: string): Promise<Record<string, unknown>> {
  const diagnostics = await requestJson(`${lane.asUrl}/_ref/device-exporters/diagnostics`, {
    headers: { Cookie: cookie },
  });
  assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.body));
  const devices = (diagnostics.body?.data ?? []) as Array<{ source_instances: Array<Record<string, unknown>> }>;
  const source = devices
    .flatMap((device) => device.source_instances)
    .find((row) => row.source_instance_id === lane.enrolled.source_instance_id);
  assert.ok(source, "the lane's source instance is listed");
  return source.local_collector_coverage as Record<string, unknown>;
}

laneTest("device diagnostics show no coverage positive the owner projection has retired", async (lane) => {
  const cookie = await ownerSessionCookie(lane.asUrl);
  await seedRawCoverageRows(lane);
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof is current");
  const current = await deviceCoverage(lane, cookie);

  const refused = await postBatch(lane, {
    ...batchBody(lane, "batch-refused", sessionRecords("s-1")),
    body_hash: "0".repeat(64),
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  await assertRetired(lane, "the refused batch retires run A's proof");
  const retired = await deviceCoverage(lane, cookie);

  const view = (coverage: Record<string, unknown>) => ({
    asOfRun: (coverage.coverage_as_of as Record<string, unknown> | null | undefined)?.run_id ?? null,
    fullyAccounted: coverage.fully_accounted,
    inventory: coverage.by_store,
  });
  const inventory = { derived_messages: "collected", projects: "collected" };
  assert.deepEqual(
    [view(current), view(retired)],
    [
      { asOfRun: "run-a", fullyAccounted: true, inventory },
      { asOfRun: null, fullyAccounted: false, inventory },
    ],
    "the positive follows the owner projection; the raw inventory stays as history"
  );
});

/**
 * Change the boundary between the projection's own boundary reads and its
 * fence read: a proof commits against the boundary the projection already
 * read, then the boundary changes. Runs once.
 */
function changeBoundaryMidProjection(lane: Lane, change: () => Promise<void>): { readonly fired: () => boolean } {
  let fired = false;
  __setLocalCoverageFenceReadHookForTest(async (ids) => {
    if (fired || !ids.includes(lane.enrolled.connector_instance_id)) {
      return;
    }
    fired = true;
    __setLocalCoverageFenceReadHookForTest(null);
    await commitProof(lane, "run-b");
    await change();
  });
  return { fired: () => fired };
}

laneTest("a scope change between the projection's reads composes no positive from two moments", async (lane) => {
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof is current");
  const hook = changeBoundaryMidProjection(lane, async () => {
    await putSyncState(
      { connector_id: CONNECTOR_ID, connector_instance_id: lane.enrolled.connector_instance_id },
      { [COLLECTION_SCOPE_STATE_KEY]: buildStoredCollectionScope(null, new Date().toISOString()) }
    );
  });
  try {
    const during = await projection(lane);
    assert.ok(hook.fired(), "the boundary changed mid-projection");
    assert.deepEqual(during, { asOf: null, axis: "unknown" }, "run B's proof measured the scope that was replaced");
  } finally {
    __setLocalCoverageFenceReadHookForTest(null);
  }
  await assertRetired(lane, "run B's proof does not measure the current scope");
});

laneTest("a manifest change between the projection's reads composes no positive from two moments", async (lane) => {
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof is current");
  const hook = changeBoundaryMidProjection(lane, () => registerFixtureManifest(lane));
  try {
    const during = await projection(lane);
    assert.ok(hook.fired(), "the manifest generation changed mid-projection");
    assert.deepEqual(during, { asOf: null, axis: "unknown" }, "run B's proof is bound to the replaced generation");
  } finally {
    __setLocalCoverageFenceReadHookForTest(null);
  }
  await assertRetired(lane, "run B's proof is bound to the replaced generation");
});

laneTest("a batch whose acceptance cannot be recorded keeps its records and retries to acceptance", async (lane) => {
  await commitProof(lane, "run-a");
  const batch = batchBody(lane, "batch-acceptance-fails", sessionRecords("s-1", "s-2"));
  const restore = await failRevisionWrites(lane, "batch_accepted");
  let failed: JsonResponse;
  try {
    failed = await postBatch(lane, batch);
  } finally {
    await restore();
  }
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(await sessionRecordCount(lane), 2, "each record committed with its own revision");
  // The acceptance and its revision rolled back together. The retryable 503
  // for an attempt the server received is itself an observed refusal.
  assert.equal((await highWater(lane)).event, "batch_rejected", "no batch_accepted revision committed");
  await assertRetired(lane, "the durable records retire run A's proof");

  const retried = await postBatch(lane, batch);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(await sessionRecordCount(lane), 2);
  assert.equal((await highWater(lane)).event, "batch_accepted");
  await assertRetired(lane, "the accepted batch is still later than run A's proof");
});

laneTest("a state commit whose revision write fails writes no state and keeps the prior proof", async (lane) => {
  await commitProof(lane, "run-a");
  const before = await highWater(lane);
  const restore = await failRevisionWrites(lane, "state_commit");
  let failed: JsonResponse;
  try {
    failed = await putDeviceState(lane, "unrecorded");
  } finally {
    await restore();
  }
  assert.ok(
    failed.status >= 500,
    `the state commit is not acknowledged: ${failed.status} ${JSON.stringify(failed.body)}`
  );
  assert.equal(await sessionsCursor(lane), null, "no state without its revision");
  assert.deepEqual(await highWater(lane), before);
  await assertCovered(lane, "run-a", "nothing was recorded after run A");

  const committed = await putDeviceState(lane, "recorded");
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(await sessionsCursor(lane), "recorded");
  assert.equal((await highWater(lane)).event, "state_commit");
  await assertRetired(lane, "the state commit retires run A's proof");
});

// ---------------------------------------------------------------------------
// Round 4: run order decides eligibility; commit revision orders observations.
// ---------------------------------------------------------------------------

interface RunOrderRow {
  readonly event: string | null;
  readonly issued: number;
  readonly revision: number | null;
  readonly runId: string | null;
  readonly sequence: number;
  readonly storageEpoch: number;
}

async function runOrder(lane: Lane): Promise<RunOrderRow> {
  const [row] = await sql(
    lane,
    `SELECT run_order_sequence AS sequence, run_order_event AS event, run_order_run_id AS run_id,
            run_order_revision AS revision, run_sequence_issued AS issued, storage_epoch
       FROM connector_instances WHERE connector_instance_id = ?`,
    `SELECT run_order_sequence::text AS sequence, run_order_event AS event, run_order_run_id AS run_id,
            run_order_revision::text AS revision, run_sequence_issued::text AS issued,
            storage_epoch::text AS storage_epoch
       FROM connector_instances WHERE connector_instance_id = $1`,
    [lane.enrolled.connector_instance_id]
  );
  assert.ok(row, "the connection has a run-order row");
  return {
    event: (row.event as string | null) ?? null,
    issued: Number(row.issued),
    revision: row.revision === null ? null : Number(row.revision),
    runId: (row.run_id as string | null) ?? null,
    sequence: Number(row.sequence),
    storageEpoch: Number(row.storage_epoch),
  };
}

/** The run-order facts the server stored with one run record. */
async function storedRunOrder(
  lane: Lane,
  runId: string
): Promise<{ readonly collection_revision: unknown; readonly run_sequence: unknown; readonly storage_epoch: unknown }> {
  const [run] = await sql(
    lane,
    "SELECT facts_json FROM run_history WHERE run_id = ?",
    "SELECT facts_json::text AS facts_json FROM run_history WHERE run_id = $1",
    [runId]
  );
  assert.ok(run, `the server stored run ${runId}`);
  const facts = JSON.parse(String(run.facts_json)) as Record<string, unknown>;
  return {
    collection_revision: facts.collection_revision,
    run_sequence: facts.run_sequence,
    storage_epoch: facts.storage_epoch,
  };
}

function postRunStart(lane: Lane, runId: string): Promise<JsonResponse> {
  return postJson(sourceUrl(lane, "/run-starts"), { connector_id: CONNECTOR_ID, run_id: runId }, authHeaders(lane));
}

/** A v2 terminal record as the device sends it on the wire, bound to the server's release. */
async function terminalWireBody(
  lane: Lane,
  runId: string,
  stateDelta: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const diagnostics = await readCommittedLocalCoverageDiagnostics({
    connector_id: CONNECTOR_ID,
    connector_instance_id: lane.enrolled.connector_instance_id,
  });
  assert.ok("declaredCollectionScope" in diagnostics, "the connection declares its collection boundary");
  const fact = (stream: string, store: string) => ({
    artifact_digest: ARTIFACT_DIGEST,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(PROFILE),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store }],
    stream,
  });
  return {
    collection_boundary: diagnostics.declaredCollectionScope,
    commit_id: `wire_commit_${runId}`,
    connector_id: CONNECTOR_ID,
    connector_instance_id: lane.enrolled.connector_instance_id,
    device_id: lane.enrolled.device_id,
    run_id: runId,
    source_instance_id: lane.enrolled.source_instance_id,
    state_delta: stateDelta,
    terminal_facts: [fact("messages", "derived_messages"), fact("sessions", "projects")],
    version: 2,
  };
}

function postTerminal(lane: Lane, body: Record<string, unknown>): Promise<JsonResponse> {
  return postJson(sourceUrl(lane, "/terminal-run-commits"), body, authHeaders(lane));
}

laneTest(
  "run order: an older run's proof that arrives after a newer run's terminal record stays history",
  async (lane) => {
    assert.equal(await issueRun(lane, "run-a"), 1, "run A starts first");
    assert.equal(await issueRun(lane, "run-b"), 2, "run B starts second");
    await commitIssuedProof(lane, "run-b");
    await assertCovered(lane, "run-b", "run B's proof is current");
    const bOrder = await runOrder(lane);

    // Run A's proof was queued on its device and reaches the server after run B's terminal record.
    await commitIssuedProof(lane, "run-a");
    const aStored = await storedRunOrder(lane, "run-a");
    const bStored = await storedRunOrder(lane, "run-b");
    assert.ok(
      Number(aStored.collection_revision) > Number(bStored.collection_revision),
      "run A's record is the newer observation in commit order"
    );
    assert.equal((await highWater(lane)).runId, "run-a", "commit order names run A's record as the newest observation");
    assert.deepEqual(
      aStored,
      { collection_revision: aStored.collection_revision, run_sequence: 1, storage_epoch: 1 },
      "run A's record keeps its own as-of: its revision, run sequence and epoch"
    );
    assert.deepEqual(await runOrder(lane), bOrder, "an older run's terminal record does not move the run-order marker");
    const projected = await projection(lane);
    assert.equal(projected.axis, "complete", "run B's proof stays current");
    assert.equal(projected.asOf?.run_id, "run-b");
    assert.equal(projected.asOf?.run_sequence, 2, "the as-of names run B's sequence");
    assert.equal(projected.asOf?.collection_revision, bStored.collection_revision, "and run B's own revision");
  }
);

laneTest("run order: an unregistered attempt retires prior coverage and cannot establish a proof", async (lane) => {
  await commitProof(lane, "run-covered");
  await assertCovered(lane, "run-covered", "the registered run's proof is current");

  const batch = await postBatch(lane, batchBody(lane, "unregistered-run-batch", sessionRecords("unregistered-record")));
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  assert.equal((await highWater(lane)).event, "batch_accepted");
  await assertRetired(lane, "an admitted effect from an unregistered attempt retires the prior proof");

  await commitProof(lane, "run-covered-before-unregistered-terminal");
  await assertCovered(lane, "run-covered-before-unregistered-terminal", "coverage is standing before the unregistered terminal");

  await commitIssuedProof(lane, "run-unregistered");
  assert.equal((await storedRunOrder(lane, "run-unregistered")).run_sequence, null);
  await assertRetired(lane, "an unregistered terminal retires prior coverage and cannot establish a proof");

  await commitProof(lane, "run-registered");
  await assertCovered(lane, "run-registered", "a registered run's proof is current");
});

laneTest("run start alone leaves earlier coverage and its as-of standing", async (lane) => {
  await commitProof(lane, "run-covered");
  const before = await projection(lane);
  assert.equal(before.axis, "complete");
  const beforeOrder = await highWater(lane);

  const registered = await postRunStart(lane, "run-with-no-effect");
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const after = await projection(lane);
  assert.equal(after.axis, "complete", "registering a run is not an observed coverage effect");
  assert.deepEqual(after.asOf, before.asOf, "the earlier proof keeps its original as-of");
  assert.deepEqual(await highWater(lane), beforeOrder, "registration takes no collection revision");
});

laneTest("coverage: a later collected proof replaces an earlier partial for the same scope", async (lane) => {
  const partialRunId = "run-partial";
  await issueRun(lane, partialRunId);
  const partial = await buildProof(lane, partialRunId);
  const partialFacts = partial.normalizedFacts.map((fact) => {
    const stores = Array.isArray(fact.stores) ? fact.stores : [];
    return {
      ...fact,
      coverage_statuses: ["partial"],
      pending_detail_gaps: 1,
      stores: stores.map((store) => ({ ...(store as Record<string, unknown>), status: "partial" })),
    };
  });
  const partialResult = await commitTerminalRun({ ...partial, normalizedFacts: partialFacts });
  assert.equal(partialResult.replayed, false);
  assert.notEqual((await projection(lane)).axis, "complete", "the earlier partial is not positive coverage");

  await commitProof(lane, "run-collected");
  const collected = await projection(lane);
  assert.equal(collected.axis, "complete", "a validated proof for the same scope replaces the partial");
  assert.equal(collected.asOf?.run_id, "run-collected");
});

laneTest("run order: a second collector on one connection is ordered by run start, not by commit", async (lane) => {
  const second = { deviceId: "device-second-collector", sourceInstanceId: "src-second-collector" };
  assert.equal(await issueRun(lane, "run-first-device"), 1);
  assert.equal(await issueRun(lane, "run-second-device", second), 2, "issuance is connection-scoped");
  await commitIssuedProof(lane, "run-second-device", second);
  await assertCovered(lane, "run-second-device", "the later-started run's proof is current");
  await commitIssuedProof(lane, "run-first-device");
  await assertCovered(lane, "run-second-device", "the earlier-started run's later commit stays history");

  // A run id belongs to the device and source that registered it.
  const before = await runOrder(lane);
  await assert.rejects(issueRun(lane, "run-second-device"), RunStartConflictError);
  const conflict = await postRunStart(lane, "run-second-device");
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal((conflict.body?.error as Record<string, unknown> | undefined)?.code, "run_start_conflict");
  assert.deepEqual(await runOrder(lane), before, "a conflicting run start issues nothing");
});

laneTest("run start: the route issues a connection-scoped sequence and an exact replay returns it", async (lane) => {
  const first = await postRunStart(lane, "run-route");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body, {
    connector_instance_id: lane.enrolled.connector_instance_id,
    object: "device_run_start",
    run_id: "run-route",
    run_sequence: 1,
    storage_epoch: 1,
  });
  const replay = await postRunStart(lane, "run-route");
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, first.body, "a replay returns the stored sequence");
  assert.equal((await runOrder(lane)).issued, 1, "a replay issues nothing");
});

laneTest(
  "replay: an exact terminal replay after an inventory change gets its receipt; a conflicting duplicate fails atomically",
  async (lane) => {
    assert.equal((await postRunStart(lane, "run-a")).status, 201);
    await markDrained(lane);
    const body = await terminalWireBody(lane, "run-a", { sessions: { cursor: "a" } });
    const committed = await postTerminal(lane, body);
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    await assertCovered(lane, "run-a", "run A's proof is current");
    const snapshot = async () => ({
      cursor: await sessionsCursor(lane),
      highWater: await highWater(lane),
      order: await runOrder(lane),
      rows: await runRows(lane, "run-a"),
    });
    const before = await snapshot();

    // The release now declares another store, so run A's facts no longer match the current inventory.
    const changed = {
      ...PROFILE,
      streams: PROFILE.streams.map((stream) =>
        stream.name === "sessions" ? { ...stream, coverage_stores: ["projects", "archived_projects"] } : stream
      ),
    };
    __setLocalCollectorReleaseForTest(CONNECTOR_ID, { artifactDigest: ARTIFACT_DIGEST, manifest: changed });
    try {
      const replay = await postTerminal(lane, body);
      assert.equal(
        replay.status,
        200,
        `an exact authorized replay gets its stored receipt: ${JSON.stringify(replay.body)}`
      );
      assert.deepEqual(replay.body, committed.body, "the replay returns the stored receipt");
      assert.deepEqual(await snapshot(), before, "a replay moves neither the run sequence nor the revision");

      const conflicting = await postTerminal(lane, { ...body, state_delta: { sessions: { cursor: "other" } } });
      assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
      assert.equal(
        (conflicting.body?.error as Record<string, unknown> | undefined)?.code,
        "terminal_run_commit_conflict"
      );
      assert.deepEqual(await snapshot(), before, "a conflicting duplicate writes nothing");
    } finally {
      __setLocalCollectorReleaseForTest(CONNECTOR_ID, SERVER_RELEASE);
    }
    await assertCovered(lane, "run-a", "neither request changed run A's proof");
  }
);

laneTest("restore: the restore step makes a restored proof unknown until a new eligible terminal", async (lane) => {
  await commitProof(lane, "run-a");
  await assertCovered(lane, "run-a", "run A's proof is current");
  const backup = await runOrder(lane);
  const backupHighWater = await highWater(lane);

  await commitProof(lane, "run-b");
  await assertCovered(lane, "run-b", "run B's proof replaces run A's");

  // Restore a backup taken after run A: run B's records and the connection's order columns roll back.
  const id = lane.enrolled.connector_instance_id;
  await sql(
    lane,
    `UPDATE connector_instances
        SET run_order_sequence = ?, run_order_event = ?, run_order_run_id = ?, run_order_revision = ?,
            run_sequence_issued = ?, collection_revision = ?, collection_revision_event = ?,
            collection_revision_run_id = ?
      WHERE connector_instance_id = ?`,
    `UPDATE connector_instances
        SET run_order_sequence = $1, run_order_event = $2, run_order_run_id = $3, run_order_revision = $4,
            run_sequence_issued = $5, collection_revision = $6, collection_revision_event = $7,
            collection_revision_run_id = $8
      WHERE connector_instance_id = $9`,
    [
      backup.sequence,
      backup.event,
      backup.runId,
      backup.revision,
      backup.issued,
      backupHighWater.revision,
      backupHighWater.event,
      backupHighWater.runId,
      id,
    ]
  );
  for (const table of ["run_history", "spine_events", "collection_run_sequences"]) {
    // biome-ignore lint/performance/noAwaitInLoops: the restore rewrites one table after another on one connection.
    await sql(lane, `DELETE FROM ${table} WHERE run_id = ?`, `DELETE FROM ${table} WHERE run_id = $1`, ["run-b"]);
  }
  // The restored snapshot is internally consistent, so without the restore step its proof reads as current.
  await assertCovered(lane, "run-a", "an undetected restore revives run A's proof (the disclosed limitation)");

  const { connections } = await beginStorageEpochAfterRestore();
  assert.ok(connections >= 1, "the restore step reaches the connection");
  await assertRetired(lane, "after the restore step, the pre-restore proof is unknown");
  assert.equal((await runOrder(lane)).storageEpoch, 2);

  // A replay of the pre-restore record is still only a replay.
  const replay = await commitTerminalRun(await buildProof(lane, "run-a"));
  assert.equal(replay.replayed, true);
  await assertRetired(lane, "a replay does not revive the pre-restore proof");

  // Run C, issued after the restore step, re-uses a sequence number the lost history had issued,
  // but in the new epoch, and its proof is current.
  assert.equal(await issueRun(lane, "run-c"), 2, "issuance continues from the restored counter");
  await commitIssuedProof(lane, "run-c");
  await assertCovered(lane, "run-c", "a run issued after the restore step proves coverage again");
  assert.equal((await storedRunOrder(lane, "run-c")).storage_epoch, 2);
});

laneTest(
  "crash after ingest: a later run's durable records retire an earlier positive without its terminal",
  async (lane) => {
    await commitProof(lane, "run-a");
    await assertCovered(lane, "run-a", "run A's proof is current");
    const bSequence = await issueRun(lane, "run-b");
    const accepted = await postBatch(lane, batchBody(lane, "batch-run-b", sessionRecords("b-1")));
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    // Run B dies here, before its terminal record.
    await assertRetired(lane, "run B's admitted records retire run A's proof");
    const order = await runOrder(lane);
    assert.equal(order.sequence, bSequence, "the records are attributed to the newest issued run");
    assert.equal(order.runId, null, "an attributed observation names no run, so it can never be a proof");

    // A late delivery of run A's own terminal record is only a replay; run A cannot become current again.
    const replay = await commitTerminalRun(await buildProof(lane, "run-a"));
    assert.equal(replay.replayed, true);
    await assertRetired(lane, "run A stays retired");
    await commitIssuedProof(lane, "run-b");
    await assertCovered(lane, "run-b", "run B's eventual terminal record is current");
  }
);

const STREAM_NAME_PATH = /^\/streams\/\d+$/;

laneTest(
  "coverage: a browser_collector terminal commit stores the run but cannot establish a positive",
  async (lane) => {
    await sql(
      lane,
      "UPDATE connector_instances SET source_kind = 'browser_collector' WHERE connector_instance_id = ?",
      "UPDATE connector_instances SET source_kind = 'browser_collector' WHERE connector_instance_id = $1",
      [lane.enrolled.connector_instance_id]
    );
    assert.equal((await postRunStart(lane, "run-browser-source-kind")).status, 201);
    const batch = await postBatch(lane, batchBody(lane, "batch-browser-source-kind", sessionRecords("browser-record")));
    assert.equal(batch.status, 201, JSON.stringify(batch.body));

    const committed = await postTerminal(lane, await terminalWireBody(lane, "run-browser-source-kind"));
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    assert.equal(await sessionRecordCount(lane), 1, "the device record remains stored");

    const [run] = await sql(
      lane,
      "SELECT run_id, facts_json FROM run_history WHERE run_id = ?",
      "SELECT run_id, facts_json::text AS facts_json FROM run_history WHERE run_id = $1",
      ["run-browser-source-kind"]
    );
    assert.ok(run, "the browser_collector device run remains stored");
    assert.equal(
      (JSON.parse(String(run.facts_json)).collection_facts as Record<string, unknown>).coverage_eligibility_reason,
      "connection_source_kind_not_local_device",
      "run history retains the rejected coverage reason for projection"
    );
    const [terminal] = await sql(
      lane,
      "SELECT data_json FROM spine_events WHERE event_id = ?",
      "SELECT data_json::text AS data_json FROM spine_events WHERE event_id = $1",
      [String(committed.body?.terminal_event_id)]
    );
    assert.ok(terminal, "the terminal event remains stored");
    const data = JSON.parse(String(terminal.data_json)) as Record<string, unknown>;
    const receipt = data.terminal_run_commit_receipt as Record<string, unknown>;
    const collectionFacts = data.collection_facts as Record<string, unknown>;
    const facts = collectionFacts.streams as Record<string, unknown>[];
    assert.equal(receipt.coverage_eligibility_reason, "connection_source_kind_not_local_device");
    assert.equal(collectionFacts.coverage_eligibility_reason, "connection_source_kind_not_local_device");
    assert.ok(facts.length > 0, "the terminal report retains its stream facts");
    for (const fact of facts) {
      assert.deepEqual(fact.coverage_statuses, ["collected"], "the stored run retains the device's assertion");
      assert.deepEqual(
        (fact.stores as Record<string, unknown>[]).map((store) => store.status),
        ["collected"],
        "the terminal record stores the device's collected assertions"
      );
    }
    await assertRetired(lane, "a browser_collector terminal record projects no store-coverage positive");
  }
);

/** Move the connection to another source kind, as an owner or migration would, and queue its evidence for repair. */
async function changeSourceKind(lane: Lane, sourceKind: string): Promise<void> {
  const id = lane.enrolled.connector_instance_id;
  await sql(
    lane,
    "UPDATE connector_instances SET source_kind = ? WHERE connector_instance_id = ?",
    "UPDATE connector_instances SET source_kind = $1 WHERE connector_instance_id = $2",
    [sourceKind, id]
  );
  await sql(
    lane,
    "UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?",
    "UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = $1",
    [id]
  );
}

/** The folded stream-fact cache the evidence row holds, as stored. */
async function foldedStreamFacts(lane: Lane): Promise<{ readonly streams: string[]; readonly version: number | null }> {
  const [row] = await sql(
    lane,
    "SELECT stream_latest_facts_json AS facts, stream_facts_fold_version AS version FROM connector_summary_evidence WHERE connector_instance_id = ?",
    "SELECT stream_latest_facts_json::text AS facts, stream_facts_fold_version AS version FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [lane.enrolled.connector_instance_id]
  );
  assert.ok(row, "the connection has an evidence row");
  const facts = row.facts === null ? {} : (JSON.parse(String(row.facts)) as Record<string, unknown>);
  return { streams: Object.keys(facts).sort(), version: row.version === null ? null : Number(row.version) };
}

/**
 * Literal on purpose: the fold version this change introduces, and the one before it. Deriving either from the
 * current constant would let a revert of the bump pass.
 */
const PREDECESSOR_FOLD_VERSION = 7;
const UPGRADED_FOLD_VERSION = 8;

/** Pretend the predecessor fold version built the cache, and mirror the source kind so no evidence repair fires. */
async function ageFoldCache(lane: Lane, sourceKind: string): Promise<void> {
  await sql(
    lane,
    "UPDATE connector_summary_evidence SET source_kind = ?, stream_facts_fold_version = ?, dirty = 0 WHERE connector_instance_id = ?",
    "UPDATE connector_summary_evidence SET source_kind = $1, stream_facts_fold_version = $2, dirty = 0 WHERE connector_instance_id = $3",
    [sourceKind, PREDECESSOR_FOLD_VERSION, lane.enrolled.connector_instance_id]
  );
}

/** The per-stream coverage conditions the owner's collection report shows for the connection. */
async function reportedConditions(lane: Lane, repairFirst = true): Promise<Record<string, unknown>> {
  if (repairFirst) {
    await reconcileDirtyConnectorSummaryEvidence(null);
  }
  const summary = (await listConnectorSummaries()).find(
    (row) => row.connector_instance_id === lane.enrolled.connector_instance_id
  );
  assert.ok(summary, "the lane's connection is projected");
  return Object.fromEntries(summary.collection_report.map((entry) => [entry.stream, entry.coverage_condition]));
}

const UNKNOWN_CONDITIONS = { messages: "unknown", sessions: "unknown" };

async function assertNoDeviceCoverage(lane: Lane, message: string): Promise<void> {
  assert.deepEqual(await reportedConditions(lane), UNKNOWN_CONDITIONS, `${message}: no stream is credited`);
  await assertRetired(lane, message);
  assert.deepEqual((await foldedStreamFacts(lane)).streams, [], `${message}: the fold cache credits no stream`);
}

laneTest(
  "source kind: an unmarked device terminal credits nothing to a browser_collector connection, whatever the cache holds",
  async (lane) => {
    await commitProof(lane, "run-unmarked");
    await assertCovered(lane, "run-unmarked", "the device terminal covers its local_device connection");
    assert.deepEqual((await foldedStreamFacts(lane)).streams, ["messages", "sessions"], "the fold cached its facts");
    // The terminal carries no coverage_eligibility_reason: it predates the marker. The cache was folded by an
    // earlier fold version that accepted it.
    await changeSourceKind(lane, "browser_collector");
    await ageFoldCache(lane, "browser_collector");
    await assertNoDeviceCoverage(lane, "an unmarked device terminal on a browser_collector connection");
    const { version } = await foldedStreamFacts(lane);
    assert.equal(version, UPGRADED_FOLD_VERSION, "the fold replayed the cache");
  }
);

laneTest(
  "source kind: a behind-version cache holding an unmarked device fact reads unknown before any repair runs",
  async (lane) => {
    await commitProof(lane, "run-behind");
    await assertCovered(lane, "run-behind", "the device terminal covers its local_device connection");
    await changeSourceKind(lane, "browser_collector");
    await ageFoldCache(lane, "browser_collector");
    // No reconcile, no maintenance sweep: this is what a read sees between a deploy and the first replay.
    // Each mask on its own: the shaped evidence withholds the cached facts and marks terminal facts behind.
    const evidence = await getConnectorSummaryEvidence(lane.enrolled.connector_instance_id);
    assert.ok(evidence, "the connection has shaped evidence");
    assert.equal(evidence.stream_latest_facts, null, "a behind-version cache credits no stream facts");
    assert.equal(evidence.terminal_facts.state, "unobserved", "a behind-version cache is not current terminal evidence");
    assert.equal(evidence.terminal_facts.reason_code, "fold_logic_version_behind");
    assert.deepEqual(
      await reportedConditions(lane, false),
      UNKNOWN_CONDITIONS,
      "the list read credits no stream from a cache an older fold built"
    );
    const detail = await getConnectorDetail(CONNECTOR_ID);
    assert.deepEqual(
      Object.fromEntries(detail.collection_report.map((entry) => [entry.stream, entry.coverage_condition])),
      UNKNOWN_CONDITIONS,
      "the detail read credits no stream from a cache an older fold built"
    );
    assert.equal(
      (await foldedStreamFacts(lane)).version,
      PREDECESSOR_FOLD_VERSION,
      "the reads repaired nothing: the cache is still the predecessor's"
    );
  }
);

laneTest(
  "source kind: a connection that stops being local_device projects its earlier device terminal as unknown",
  async (lane) => {
    await commitProof(lane, "run-was-local");
    await assertCovered(lane, "run-was-local", "the device terminal covers its local_device connection");
    await changeSourceKind(lane, "browser_collector");
    await assertNoDeviceCoverage(lane, "a device terminal stored while the connection was local_device");
  }
);

laneTest(
  "source kind: a fold begun under local_device cannot publish after the connection's source kind changed",
  async (lane) => {
    await commitProof(lane, "run-fenced");
    await assertCovered(lane, "run-fenced", "the device terminal covers its local_device connection");
    const id = lane.enrolled.connector_instance_id;
    // The cache as an evidence repair leaves it: no checkpoint, no facts, the current fold version.
    await sql(
      lane,
      "UPDATE connector_summary_evidence SET stream_latest_facts_json = NULL, stream_facts_event_seq = NULL, stream_facts_fold_version = ?, dirty = 0 WHERE connector_instance_id = ?",
      "UPDATE connector_summary_evidence SET stream_latest_facts_json = NULL, stream_facts_event_seq = NULL, stream_facts_fold_version = $1, dirty = 0 WHERE connector_instance_id = $2",
      [UPGRADED_FOLD_VERSION, id]
    );
    const paused = gate();
    const reached = gate();
    let held = false;
    __testOnlySetFoldPauseHook(async (point) => {
      if (point === "before_cas_write" && !held) {
        held = true;
        reached.open();
        await paused.wait;
      }
    });
    try {
      const inFlight = foldConnectorSummaryStreamFacts([id]);
      await Promise.race([
        reached.wait,
        inFlight.then(() => assert.fail("the fold finished without reaching its compare-and-set write")),
      ]);
      // The fold has folded the device terminal as local_device and not yet written. The source kind changes:
      // the repair writes the new kind on the evidence row and leaves checkpoint and version as they were.
      await changeSourceKind(lane, "browser_collector");
      await sql(
        lane,
        "UPDATE connector_summary_evidence SET source_kind = ? WHERE connector_instance_id = ?",
        "UPDATE connector_summary_evidence SET source_kind = $1 WHERE connector_instance_id = $2",
        ["browser_collector", id]
      );
      paused.open();
      // The write built under local_device loses its CAS; the fold's own retry rereads the new kind and refuses the
      // device terminal.
      const outcome = await inFlight;
      assert.ok(outcome.refused > 0, "the retry under the new source kind refuses the device terminal");
    } finally {
      __testOnlySetFoldPauseHook(null);
    }
    assert.deepEqual((await foldedStreamFacts(lane)).streams, [], "the stale fold published no device fact");
    await assertNoDeviceCoverage(lane, "the fold after the source kind changed");
  }
);

laneTest("source kind: an exact replay returns the stored receipt and grants no coverage", async (lane) => {
  assert.equal((await postRunStart(lane, "run-replayed")).status, 201);
  await markDrained(lane);
  const body = await terminalWireBody(lane, "run-replayed");
  const committed = await postTerminal(lane, body);
  assert.equal(committed.status, 201, JSON.stringify(committed.body));
  await assertCovered(lane, "run-replayed", "the device terminal covers its local_device connection");

  await changeSourceKind(lane, "browser_collector");
  const replay = await postTerminal(lane, body);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, committed.body, "the replay returns the stored receipt unchanged");
  assert.equal((await runRows(lane, "run-replayed")).events, 1, "the replay writes no second terminal event");
  await assertNoDeviceCoverage(lane, "a replayed receipt is not a coverage grant");
});

laneTest(
  "source kind: a local_device connection keeps its device coverage when its fold cache is replayed",
  async (lane) => {
    await commitProof(lane, "run-local");
    await ageFoldCache(lane, "local_device");
    await assertCovered(lane, "run-local", "the replayed fold keeps the local_device positive");
    assert.deepEqual(await foldedStreamFacts(lane), {
      streams: ["messages", "sessions"],
      version: UPGRADED_FOLD_VERSION,
    });
  }
);

laneTest("contract: owner diagnostics and connector detail validate against @pdpp/reference-contract", async (lane) => {
  await commitProof(lane, "run-a");
  await reconcileDirtyConnectorSummaryEvidence(null);

  const diagnostics = JSON.parse(
    JSON.stringify(await getOwnerConnectionDiagnostics(lane.enrolled.connector_instance_id))
  ) as Record<string, unknown>;
  const diagnosticsResult = validateResponse("ownerInspectConnectionDiagnostics", { body: diagnostics, status: 200 });
  assert.deepEqual(diagnosticsResult, { ok: true, skipped: false }, "diagnostics match the contract");

  // The connector summary schema admits additional members, so the as-of is valid there. The
  // vendored schema still types `streams` as names while the detail returns stream objects; that
  // mismatch predates this change and is the only one allowed here.
  const detail = JSON.parse(JSON.stringify(await getConnectorDetail(CONNECTOR_ID))) as Record<string, unknown>;
  assert.ok(detail.coverage_as_of, "the detail carries its as-of");
  const detailResult = validateResponse("refGetConnector", { body: detail, status: 200 });
  const detailErrors = detailResult.ok
    ? []
    : (detailResult.errors as { instancePath: string }[]).filter((error) => !STREAM_NAME_PATH.test(error.instancePath));
  assert.deepEqual(detailErrors, [], "the connector detail matches the contract outside the known streams mismatch");
});

laneTest("contract: terminal commit, replay, unregistered run and legacy receipt validate as sent", async (lane) => {
  const runId = "run-contract-fresh";
  const registered = await postRunStart(lane, runId);
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const freshWireBody = await terminalWireBody(lane, runId);
  const fresh = await postTerminal(lane, freshWireBody);
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.ok(fresh.body);
  assert.equal(typeof fresh.body.collection_revision, "number");
  assert.equal(typeof fresh.body.run_sequence, "number");
  assert.equal(typeof fresh.body.storage_epoch, "number");
  const freshValidation = validateResponse("refCommitDeviceExporterTerminalRun", {
    body: fresh.body,
    status: fresh.status,
  });
  assert.equal(freshValidation.ok, true, `fresh terminal response: ${JSON.stringify(freshValidation)}`);
  assert.deepEqual(freshValidation, { ok: true, skipped: false });

  const replay = await postTerminal(lane, freshWireBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, fresh.body, "an exact replay returns the stored receipt");
  const replayValidation = validateResponse("refCommitDeviceExporterTerminalRun", {
    body: replay.body,
    status: replay.status,
  });
  assert.equal(replayValidation.ok, true, `exact replay response: ${JSON.stringify(replayValidation)}`);
  assert.deepEqual(replayValidation, { ok: true, skipped: false });

  const unregisteredRunId = "run-contract-start-failed";
  const restoreRunStartWrites = await failRunStartWrites(lane);
  let failedStart: JsonResponse;
  try {
    failedStart = await postRunStart(lane, unregisteredRunId);
  } finally {
    await restoreRunStartWrites();
  }
  assert.ok(
    failedStart.status >= 500,
    `the injected START registration failure is surfaced: ${JSON.stringify(failedStart.body)}`
  );
  const unregistered = await postTerminal(lane, await terminalWireBody(lane, unregisteredRunId));
  assert.equal(unregistered.status, 201, JSON.stringify(unregistered.body));
  assert.ok(unregistered.body);
  assert.equal(unregistered.body.run_sequence, null, "the failed START registration issued no run sequence");
  const unregisteredValidation = validateResponse("refCommitDeviceExporterTerminalRun", {
    body: unregistered.body,
    status: unregistered.status,
  });
  assert.equal(
    unregisteredValidation.ok,
    true,
    `unregistered terminal response: ${JSON.stringify(unregisteredValidation)}`
  );
  assert.deepEqual(unregisteredValidation, { ok: true, skipped: false });

  const legacyRunId = "run-contract-legacy-receipt";
  assert.equal((await postRunStart(lane, legacyRunId)).status, 201);
  const legacyWireBody = await terminalWireBody(lane, legacyRunId);
  const original = await postTerminal(lane, legacyWireBody);
  assert.equal(original.status, 201, JSON.stringify(original.body));
  const [stored] = await sql(
    lane,
    "SELECT event_id, data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.completed'",
    "SELECT event_id, data_json::text AS data_json FROM spine_events WHERE run_id = $1 AND event_type = 'run.completed'",
    [legacyRunId]
  );
  assert.ok(stored, "the server stored the original terminal receipt");
  const legacyEvent = JSON.parse(String(stored.data_json)) as Record<string, unknown>;
  const legacyReceipt = legacyEvent.terminal_run_commit_receipt as Record<string, unknown>;
  const legacyResponse = legacyReceipt.response as Record<string, unknown>;
  for (const field of ["collection_revision", "run_sequence", "storage_epoch"] as const) {
    delete legacyEvent[field];
    delete legacyResponse[field];
  }
  await sql(
    lane,
    "UPDATE spine_events SET data_json = ? WHERE event_id = ?",
    "UPDATE spine_events SET data_json = $1::jsonb WHERE event_id = $2",
    [JSON.stringify(legacyEvent), stored.event_id]
  );
  const legacyReplay = await postTerminal(lane, legacyWireBody);
  assert.equal(legacyReplay.status, 200, JSON.stringify(legacyReplay.body));
  assert.ok(legacyReplay.body);
  assert.deepEqual(legacyReplay.body, legacyResponse, "the legacy replay returns the stored pre-run-order receipt");
  for (const field of ["collection_revision", "run_sequence", "storage_epoch"] as const) {
    assert.equal(field in legacyReplay.body, false, `legacy replay omits ${field}`);
  }
  const legacyValidation = validateResponse("refCommitDeviceExporterTerminalRun", {
    body: legacyReplay.body,
    status: legacyReplay.status,
  });
  assert.equal(legacyValidation.ok, true, `legacy replay response: ${JSON.stringify(legacyValidation)}`);
  assert.deepEqual(legacyValidation, { ok: true, skipped: false });
});

// Bounded by the test timeout: a hang fails the test, and PostgreSQL reports a
// deadlock between the two transactions as an error (40P01) to one of them.
test("a record transaction and a terminal commit for one connection serialize without deadlock [real PostgreSQL]", {
  skip: POSTGRES_SKIP,
  timeout: 30_000,
}, async () => {
  await withLane("postgres", async (lane) => {
    await commitProof(lane, "run-a");
    const before = await highWater(lane);
    const held = gate();
    const release = gate();
    let paused = false;
    __setPostgresAdmissionLockedPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
      if (paused || point !== "after-connector-instance-admission-lock") {
        return;
      }
      if (context.connectorInstanceId !== lane.enrolled.connector_instance_id) {
        return;
      }
      paused = true;
      held.open();
      await release.wait;
    });
    try {
      const batch = postBatch(lane, batchBody(lane, "batch-holds-lock", sessionRecords("s-1")));
      await held.wait;
      const proof = await buildProof(lane, "run-b");
      const terminal = commitTerminalRun(proof);
      // The terminal commit must wait for the record transaction, not slip past it.
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting === 0; attempt += 1) {
        const [row] = await sql(
          lane,
          "",
          "SELECT COUNT(*)::integer AS n FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"
        );
        waiting = Number(row?.n ?? 0);
        if (waiting === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(waiting > 0, "the terminal commit blocks on the lock the record transaction holds");
      release.open();
      const [accepted, committed] = await Promise.all([batch, terminal]);
      assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
      assert.equal(committed.replayed, false);
    } finally {
      release.open();
      __setPostgresAdmissionLockedPhaseHookForTest(null);
    }
    const [run] = await sql(lane, "", "SELECT facts_json::text AS facts_json FROM run_history WHERE run_id = $1", [
      "run-b",
    ]);
    const proofRevision = (JSON.parse(String(run?.facts_json)) as { collection_revision: number }).collection_revision;
    assert.ok(
      proofRevision > before.revision + 1,
      `run B's revision ${proofRevision} follows the record's revision ${before.revision + 1}`
    );
  });
});

// ---------------------------------------------------------------------------
// Upgrade from a database that predates the collection revision.
// ---------------------------------------------------------------------------

async function dropRevisionColumns(lane: Pick<Lane, "backend">, dbPath: string): Promise<void> {
  const statements = [
    "ALTER TABLE connector_instances DROP COLUMN collection_revision",
    "ALTER TABLE connector_instances DROP COLUMN collection_revision_event",
    "ALTER TABLE connector_instances DROP COLUMN collection_revision_run_id",
    "ALTER TABLE connector_instances DROP COLUMN collection_revision_at",
    "ALTER TABLE connector_state DROP COLUMN collection_revision",
  ];
  if (lane.backend === "postgres") {
    for (const statement of statements) {
      await postgresQuery(statement);
    }
    await postgresQuery("UPDATE run_history SET facts_json = (facts_json::jsonb - 'collection_revision')::jsonb");
    return;
  }
  const raw = new DatabaseSync(dbPath);
  try {
    for (const statement of statements) {
      raw.exec(statement);
    }
    raw.exec("UPDATE run_history SET facts_json = json_remove(facts_json, '$.collection_revision')");
  } finally {
    raw.close();
  }
}

test("upgrade: rows from before the collection revision fail closed, and the next proof is current", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-revision-upgrade-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    let enrolled: Enrolled | null = null;
    await withServerLane("sqlite", { dbPath }, async (lane) => {
      await commitProof(lane, "run-before-upgrade");
      await assertCovered(lane, "run-before-upgrade", "the proof is current before the downgrade");
      enrolled = lane.enrolled;
    });
    // The same rows, as a server that predates the revision columns wrote them.
    await dropRevisionColumns({ backend: "sqlite" }, dbPath);
    initDb(dbPath);
    try {
      const raw = getDb()
        .prepare(
          "SELECT collection_revision, collection_revision_event FROM connector_instances WHERE connector_instance_id = ?"
        )
        .get((enrolled as Enrolled | null)?.connector_instance_id) as
        | { collection_revision: number; collection_revision_event: string | null }
        | undefined;
      assert.deepEqual(
        { ...raw },
        { collection_revision: 0, collection_revision_event: null },
        "the migration adds a zero high-water mark and invents no event"
      );
      const lane = { asUrl: "", backend: "sqlite" as const, enrolled: enrolled as unknown as Enrolled };
      __setLocalCollectorReleaseForTest(CONNECTOR_ID, SERVER_RELEASE);
      await assertRetired(lane, "a proof without a revision is unknown after the upgrade");
      await commitProof(lane, "run-after-upgrade");
      await assertCovered(lane, "run-after-upgrade", "the first proof after the upgrade is current");
    } finally {
      __setLocalCollectorReleaseForTest(CONNECTOR_ID, null);
      closeDb();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("upgrade [real PostgreSQL]: rows from before the collection revision fail closed, and the next proof is current", {
  skip: POSTGRES_SKIP,
}, async () => {
  await withLane("postgres", async (lane) => {
    await commitProof(lane, "run-before-upgrade");
    await assertCovered(lane, "run-before-upgrade", "the proof is current before the downgrade");
    await dropRevisionColumns(lane, "");
    await bootstrapPostgresSchema();
    const [row] = await postgresQuery<{ event: string | null; revision: string }>(
      `SELECT collection_revision::text AS revision, collection_revision_event AS event
         FROM connector_instances WHERE connector_instance_id = $1`,
      [lane.enrolled.connector_instance_id]
    ).then((result) => result.rows);
    assert.deepEqual({ ...row }, { event: null, revision: "0" }, "the migration invents no event");
    await assertRetired(lane, "a proof without a revision is unknown after the upgrade");
    await commitProof(lane, "run-after-upgrade");
    await assertCovered(lane, "run-after-upgrade", "the first proof after the upgrade is current");
  });
});
