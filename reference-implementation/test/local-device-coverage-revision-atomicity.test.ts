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

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { startServer } from "../server/index.ts";
import { COLLECTION_SCOPE_STATE_KEY, readStoredCollectionScope } from "../server/local-collection-scope.ts";
import { __setLocalCollectorReleaseForTest } from "../server/local-collector-profiles.ts";
import { bootstrapPostgresSchema, closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getSyncState } from "../server/records.ts";
import { getConnectorDetail, getOwnerConnectionDiagnostics, listConnectorSummaries } from "../server/ref-control.ts";
import { __setDeviceIngestPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
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
  run_coverage: { version: 1 },
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
    const lane = { asUrl, backend, enrolled };
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

/** A v2 terminal proof for both streams, bound to the server's release. Returns the commit so a test can replay it. */
async function commitProof(lane: Lane, runId: string): Promise<TerminalCommit> {
  const { connector_instance_id: connectorInstanceId, device_id: deviceId } = lane.enrolled;
  const sourceInstanceId = lane.enrolled.source_instance_id;
  await getDefaultDeviceExporterStore().markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
    lastError: null,
    outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 1, total: 1 },
    receivedAt: new Date().toISOString(),
    recordsPending: 0,
    status: "healthy",
  });
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
  const scopeProjection = await getSyncState(
    { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId },
    { allowedStreams: new Set([COLLECTION_SCOPE_STATE_KEY]), grantId: null }
  );
  const declaredScope = readStoredCollectionScope({
    [COLLECTION_SCOPE_STATE_KEY]: scopeProjection.state[COLLECTION_SCOPE_STATE_KEY] ?? null,
  });
  assert.ok(declaredScope.fingerprint, "the connection declares its collection boundary");
  const commit: TerminalCommit = {
    collectionBoundary: declaredScope.fingerprint,
    commitId: `commit_${runId}`,
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    deviceId,
    envelopeHash: `envelope_${runId}`,
    normalizedFacts: [stream("sessions", "projects"), stream("messages", "derived_messages")],
    runId,
    sourceInstanceId,
    stateDelta: {},
    version: 2,
  };
  const result = await commitTerminalRun(commit);
  assert.equal(result.replayed, false, `run ${runId} commits a new terminal proof`);
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
  assert.equal(projected.axis, "unknown", message);
  assert.equal(projected.asOf, null, `${message}: retired coverage carries no as-of`);
}

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

/** Make every write that advances a collection revision fail, as a storage fault would. */
async function failRevisionWrites(lane: Lane): Promise<() => Promise<void>> {
  if (lane.backend === "postgres") {
    await postgresQuery(`CREATE FUNCTION pdpp_test_fail_collection_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected collection revision failure'; END $$`);
    await postgresQuery(`CREATE TRIGGER pdpp_test_fail_collection_revision
      BEFORE UPDATE OF collection_revision ON connector_instances FOR EACH ROW
      WHEN (NEW.collection_revision IS DISTINCT FROM OLD.collection_revision)
      EXECUTE FUNCTION pdpp_test_fail_collection_revision()`);
    return async () => {
      await postgresQuery("DROP TRIGGER pdpp_test_fail_collection_revision ON connector_instances");
      await postgresQuery("DROP FUNCTION pdpp_test_fail_collection_revision()");
    };
  }
  getDb().exec(`CREATE TRIGGER pdpp_test_fail_collection_revision
    BEFORE UPDATE OF collection_revision ON connector_instances
    WHEN NEW.collection_revision IS NOT OLD.collection_revision
    BEGIN SELECT RAISE(ABORT, 'injected collection revision failure'); END`);
  return () => {
    getDb().exec("DROP TRIGGER pdpp_test_fail_collection_revision");
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
