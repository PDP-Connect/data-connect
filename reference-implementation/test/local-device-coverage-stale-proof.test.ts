// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Stale terminal proof. A negotiated run commits a v2 terminal proof for every
// requested stream. A later successful run that did not negotiate run coverage
// then reaches the server with no terminal evidence. The server must not keep
// projecting the older proof as covered once a later state commit exists that
// the proof does not account for.
//
// Two layers:
//
//   - Store-level boundary tests with an injected clock. They pin the ordering
//     rule: a state commit strictly after the proof retires it; one at the same
//     instant (the proof's own transaction) or before it does not.
//   - End-to-end journey through the real collector runner, the reference
//     server, and the HTTP owner list and detail routes, as in
//     local-device-coverage-journey.test.ts. Run B is unnegotiated and runs on a
//     fresh device outbox, so the device holds no local receipt for it. The
//     server projection must not depend on that device state.
//
// The journey has one limit that the server cannot close on its own. An
// unnegotiated run that commits no state and no terminal record leaves nothing
// the server can order against the proof. That case is pinned below as a
// known limit, not a fix.

// The local-collector bin reaches the untyped installer core. This names the
// local collector's own shim for it, which the reference-implementation program
// does not otherwise include.
/// <reference path="../../packages/local-collector/src/managed/installer-core.d.ts" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { expectedLocalCoverageStoreDescriptors } from "@pdpp/polyfill-connectors/local-source-inventory";

import { bindOptionalRunCoverageToRelease } from "../../packages/local-collector/bin/pdpp-local-collector.ts";
import {
  type CollectorConnectorSpec,
  type CollectorRunResult,
  runCollectorConnector,
} from "../../packages/local-collector/src/runner.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { startServer } from "../server/index.ts";
import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { __setLocalCollectorReleaseForTest, readLocalCollectorRelease } from "../server/local-collector-profiles.ts";
import { putSyncState } from "../server/records.ts";
import { listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

const CONNECTOR_ID = "claude-code";
const LOCAL_BINDING_NAME = "stale-proof-laptop";
const OWNER_PASSWORD = "local-coverage-stale-proof-password";
const STREAMS = ["sessions", "messages"];
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const CSRF_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

// The fixture release declares run coverage for both streams. A negotiated run
// binds to it; an unnegotiated run leaves the spec unbound.
const PROFILE = {
  connector_id: CONNECTOR_ID,
  run_coverage: { version: 1 },
  streams: [
    { coverage_stores: ["projects"], name: "sessions", primary_key: ["id"] },
    { coverage_stores: ["derived_messages"], name: "messages", primary_key: ["id"] },
  ],
  version: "0.0.0-stale-proof",
};
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(PROFILE)).digest("hex")}`;
const SERVER_RELEASE = { artifactDigest: ARTIFACT_DIGEST, manifest: PROFILE };

// Offline fixture connector. It sends the same records in every mode. Its DONE
// carries a coverage claim only when START negotiated run coverage, as a real
// connector does. Mode "complete" also commits STATE; "records-only" does not.
// Written with no template interpolation so it can sit inside this file.
const FIXTURE_CONNECTOR_SOURCE = `
import { writeFileSync } from "node:fs";

const [mode, observePath, tag] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const start = JSON.parse(input.split("\\n")[0]);
  writeFileSync(observePath, JSON.stringify(start));
  const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const emittedAt = "2026-10-22T12:00:00.000Z";
  const record = (stream, id) => emit({ data: { id }, emitted_at: emittedAt, key: id, stream, type: "RECORD" });
  const coverage = {
    collection_scope: start.collection_scope,
    streams: [
      { scoped: true, stores: [{ status: "collected", store: "projects" }], stream: "sessions" },
      { scoped: true, stores: [{ status: "collected", store: "derived_messages" }], stream: "messages" },
    ],
    version: 1,
  };
  record("sessions", "s-1");
  record("sessions", "s-2");
  record("messages", "m-1");
  if (mode === "complete") {
    emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
    emit({ cursor: { cursor: tag + "-messages" }, stream: "messages", type: "STATE" });
  }
  emit({
    ...(start.run_coverage_version === 1 ? { coverage } : {}),
    records_emitted: 3,
    status: "succeeded",
    type: "DONE",
  });
});
`;

interface JsonResponse {
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

interface Enrolled {
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

interface Journey {
  readonly asUrl: string;
  readonly childPath: string;
  readonly cookie: string;
  readonly dir: string;
  readonly enrolled: Enrolled;
  readonly queuePath: string;
}

interface RunOptions {
  readonly mode: "complete" | "records-only";
  readonly negotiated: boolean;
  readonly queuePath?: string;
  readonly tag: string;
}

interface RunOutcome {
  readonly observed: Record<string, unknown>;
  readonly result: CollectorRunResult;
}

interface ProjectedStream {
  readonly coverage_condition: string;
  readonly stream: string;
}

interface OwnerConnectionRow {
  readonly collection_report: readonly ProjectedStream[];
  readonly connection_health: { readonly axes: { readonly coverage: string; readonly outbox: string } };
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

async function enrollLaptop(asUrl: string, cookie: string): Promise<Enrolled> {
  const code = await postJson(
    `${asUrl}/_ref/device-exporters/enrollment-codes`,
    { connector_id: CONNECTOR_ID, local_binding_name: LOCAL_BINDING_NAME },
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

/**
 * Enrolment registers the checked-in claude-code catalog manifest. The lane
 * covers two streams, so the catalog entry is narrowed to the release's streams
 * and its manifest generation advances, as a catalog update does.
 */
function registerFixtureManifest(connectorInstanceId: string): void {
  const row = getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get(CONNECTOR_ID) as
    | { manifest: string }
    | undefined;
  assert.ok(row, "enrolment registers the claude-code catalog manifest");
  const catalog = JSON.parse(row.manifest) as Record<string, unknown> & { streams: Record<string, unknown>[] };
  const streams = PROFILE.streams.map((release) => {
    const declared = catalog.streams.find((stream) => stream.name === release.name);
    assert.ok(declared, `the catalog declares ${release.name}`);
    return { ...declared, coverage_stores: release.coverage_stores };
  });
  getDb()
    .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
    .run(JSON.stringify({ ...catalog, streams }), CONNECTOR_ID);
  getDb()
    .prepare(
      "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_instance_id = ?"
    )
    .run(connectorInstanceId);
}

async function withJourney(run: (journey: Journey) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-coverage-stale-proof-"));
  const childPath = join(dir, "fixture-connector.mjs");
  await writeFile(childPath, FIXTURE_CONNECTOR_SOURCE);
  const server = await startServer({
    asPort: 0,
    dbPath: join(dir, "pdpp.sqlite"),
    ownerAuthPassword: OWNER_PASSWORD,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  __setLocalCollectorReleaseForTest(CONNECTOR_ID, SERVER_RELEASE);
  try {
    const cookie = await ownerSessionCookie(asUrl);
    const enrolled = await enrollLaptop(asUrl, cookie);
    registerFixtureManifest(enrolled.connector_instance_id);
    await run({ asUrl, childPath, cookie, dir, enrolled, queuePath: join(dir, "outbox.sqlite") });
  } finally {
    __setLocalCollectorReleaseForTest(CONNECTOR_ID, null);
    await closeTestServer(server);
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
}

async function runOnce(journey: Journey, options: RunOptions): Promise<RunOutcome> {
  const observePath = join(journey.dir, `start-${options.tag}.json`);
  const base: CollectorConnectorSpec = {
    args: [journey.childPath, options.mode, observePath, options.tag],
    command: process.execPath,
    connector_id: CONNECTOR_ID,
    protocol_capabilities: [],
    runtime_requirements: { bindings: {} },
    streams: STREAMS,
  };
  const connector = options.negotiated
    ? bindOptionalRunCoverageToRelease(base, { digest: ARTIFACT_DIGEST }, PROFILE)
    : base;
  const result = await runCollectorConnector({
    baseUrl: journey.asUrl,
    connector,
    deviceId: journey.enrolled.device_id,
    deviceToken: journey.enrolled.device_token,
    executionRoot: dirname(journey.childPath),
    outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 1 },
    queuePath: options.queuePath ?? journey.queuePath,
    runId: options.tag,
    sourceInstanceId: journey.enrolled.source_instance_id,
  });
  return { observed: JSON.parse(await readFile(observePath, "utf8")) as Record<string, unknown>, result };
}

/** The terminal facts a device outbox holds as its current receipt, or none for a fresh outbox. */
function deviceReceiptFacts(queuePath: string, sourceInstanceId: string): Record<string, unknown>[] {
  const db = new DatabaseSync(queuePath);
  try {
    const row = db
      .prepare("SELECT terminal_facts_json FROM local_device_terminal_coverage_receipts WHERE source_instance_id = ?")
      .get(sourceInstanceId) as { terminal_facts_json: string } | undefined;
    return row ? (JSON.parse(row.terminal_facts_json) as Record<string, unknown>[]) : [];
  } finally {
    db.close();
  }
}

/** The per-stream facts the server stored for one terminal commit, or null when none was committed. */
function serverRunStreams(runId: string): Record<string, unknown>[] | null {
  const row = getDb().prepare("SELECT facts_json FROM run_history WHERE run_id = ?").get(runId) as
    | { facts_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  const facts = JSON.parse(row.facts_json) as { collection_facts?: { streams?: Record<string, unknown>[] } };
  return facts.collection_facts?.streams ?? [];
}

/** Stream cursors only. The `$`-prefixed rows are the server's own collection-scope state, not connector cursors. */
function serverCursors(journey: Journey): Record<string, unknown> {
  const rows = getDb()
    .prepare("SELECT stream, state_json FROM connector_state WHERE connector_instance_id = ? ORDER BY stream")
    .all(journey.enrolled.connector_instance_id) as Array<{ state_json: string; stream: string }>;
  return Object.fromEntries(
    rows.filter((row) => !row.stream.startsWith("$")).map((row) => [row.stream, JSON.parse(row.state_json) as unknown])
  );
}

/**
 * The owner list row and the owner detail for the connection. Both read the
 * same projection; the test asserts they agree before it looks at the value.
 */
async function ownerConnectionRow(journey: Journey): Promise<OwnerConnectionRow> {
  // The owner routes read a summary read model that the server refreshes from
  // dirty evidence in the background. Refresh it here, as the projection oracle
  // does, so the read reflects the run just made.
  await reconcileDirtyConnectorSummaryEvidence(null);
  const list = await requestJson(`${journey.asUrl}/_ref/connectors?limit=100`, { headers: { Cookie: journey.cookie } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const rows = (list.body?.data ?? []) as Record<string, unknown>[];
  const row = rows.find((candidate) => candidate.connection_id === journey.enrolled.connector_instance_id);
  assert.ok(row, "the owner list projects the enrolled connection");
  // The detail route is keyed by connector; each lane here holds one connection.
  const detail = await requestJson(`${journey.asUrl}/_ref/connectors/${CONNECTOR_ID}`, {
    headers: { Cookie: journey.cookie },
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body?.collection_report, row.collection_report, "list and detail agree");
  const detailHealth = detail.body?.connection_health as OwnerConnectionRow["connection_health"] | undefined;
  assert.equal(
    detailHealth?.axes.coverage,
    (row as unknown as OwnerConnectionRow).connection_health.axes.coverage,
    "list and detail agree on the coverage axis"
  );
  return row as unknown as OwnerConnectionRow;
}

function conditions(row: OwnerConnectionRow): Record<string, string> {
  return Object.fromEntries(row.collection_report.map((entry) => [entry.stream, entry.coverage_condition]));
}

// ---------------------------------------------------------------------------
// Store-level ordering boundary. The clock is injected, so "the same instant as
// the proof" and "strictly later" are exact, not timing-dependent.
// ---------------------------------------------------------------------------

const connectorId = "claude-code";
const connectorInstanceId = "cin_stale_proof_boundary";
const deviceId = "dev_stale_proof_boundary";
const sourceInstanceId = "src_stale_proof_boundary";
const ownerSubjectId = "owner_local";
const PROOF_AT = "2026-10-22T10:00:00.000Z";

async function withBoundaryConnection(run: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-stale-proof-boundary-"));
  initDb(join(directory, "pdpp.sqlite"));
  try {
    const now = "2026-10-22T09:00:00.000Z";
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(
        connectorId,
        JSON.stringify({
          capabilities: { public_listing: { tier: "supported" } },
          connector_id: connectorId,
          display_name: "Stale Proof Fixture",
          protocol_version: "0.1.0",
          streams: [
            {
              coverage_stores: ["projects"],
              coverage_strategy: "checkpoint_window",
              name: "sessions",
              primary_key: ["id"],
            },
            {
              coverage_stores: ["derived_messages"],
              coverage_strategy: "checkpoint_window",
              name: "messages",
              primary_key: ["id"],
            },
          ],
          version: "1.0.0",
        }),
        now
      );
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId,
      createdAt: now,
      displayName: "laptop",
      ownerSubjectId,
      sourceBinding: { device: "laptop", kind: "local_device" },
      sourceBindingKey: "laptop",
      sourceKind: "local_device",
      status: "active",
      updatedAt: now,
    });
    const store = getDefaultDeviceExporterStore();
    await store.createDevice({
      createdAt: now,
      deviceId,
      displayName: "laptop",
      ownerSubjectId,
      status: "active",
      updatedAt: now,
    });
    await store.upsertSourceInstance({
      connectorId,
      connectorInstanceId,
      createdAt: now,
      deviceId,
      displayName: "laptop collector",
      localBindingId: "laptop",
      sourceInstanceId,
      status: "active",
      updatedAt: now,
    });
    await run();
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * Commit a v2 terminal proof for both streams with the given run id. The source
 * heartbeat is recorded at the same instant, so the outbox axis is fresh against
 * the injected clock; its state rows and the run's completion carry that instant.
 */
async function seedV2Proof(runId: string): Promise<void> {
  const release = readLocalCollectorRelease(connectorId);
  assert.ok(release, "the reference server must have a verified local-collector release pin");
  await getDefaultDeviceExporterStore().markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
    lastError: null,
    outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 1, total: 1 },
    receivedAt: new Date().toISOString(),
    recordsPending: 0,
    status: "healthy",
  });
  const bindings = {
    artifact_digest: release.artifactDigest,
    binding_generation: 0,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(release.manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    server_artifact_digest: release.artifactDigest,
  };
  await commitTerminalRun({
    collectionBoundary: "unscoped",
    commitId: `commit_${runId}`,
    connectorId,
    connectorInstanceId,
    deviceId,
    envelopeHash: `envelope_${runId}`,
    normalizedFacts: [
      {
        ...bindings,
        checkpoint: "committed",
        collected: 0,
        considered: null,
        coverage_statuses: ["collected"],
        covered: null,
        pending_detail_gaps: 0,
        scoped: true,
        skipped: null,
        stores: [{ status: "collected", store: "projects" }],
        stream: "sessions",
      },
      {
        ...bindings,
        checkpoint: "committed",
        collected: 0,
        considered: null,
        coverage_statuses: ["collected"],
        covered: null,
        pending_detail_gaps: 0,
        scoped: true,
        skipped: null,
        stores: [{ status: "collected", store: "derived_messages" }],
        stream: "messages",
      },
    ],
    runId,
    sourceInstanceId,
    stateDelta: {},
    version: 2,
  });
}

async function boundaryProjection(): Promise<{ axis: string; conditions: Record<string, string> }> {
  await reconcileDirtyConnectorSummaryEvidence(null);
  const summary = (await listConnectorSummaries()).find((row) => row.connector_instance_id === connectorInstanceId);
  assert.ok(summary, "the boundary connection is projected");
  return {
    axis: summary.connection_health.axes.coverage,
    conditions: Object.fromEntries(summary.collection_report.map((entry) => [entry.stream, entry.coverage_condition])),
  };
}

const BOUNDARY_TARGET = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

test("store: a state commit at the proof's own instant does not retire it; a strictly later one does", async (t) => {
  await withBoundaryConnection(async () => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(PROOF_AT) });
    await seedV2Proof("run_boundary_proof");
    assert.deepEqual(await boundaryProjection(), {
      axis: "complete",
      conditions: { messages: "complete", sessions: "complete" },
    });

    // The same instant as the proof: nothing is later than the proof's own commit.
    await putSyncState(BOUNDARY_TARGET, { messages: { cursor: "same-instant" } });
    assert.equal((await boundaryProjection()).axis, "complete", "a same-instant state commit is not later");

    // One millisecond later: a state commit the proof does not account for.
    t.mock.timers.setTime(Date.parse(PROOF_AT) + 1);
    await putSyncState(BOUNDARY_TARGET, { messages: { cursor: "later" } });
    assert.deepEqual(await boundaryProjection(), {
      axis: "unknown",
      conditions: { messages: "unknown", sessions: "unknown" },
    });
  });
});

test("store: a state commit before the proof does not retire it", async (t) => {
  await withBoundaryConnection(async () => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T09:30:00.000Z") });
    await putSyncState(BOUNDARY_TARGET, { messages: { cursor: "earlier" } });
    t.mock.timers.setTime(Date.parse(PROOF_AT));
    await seedV2Proof("run_boundary_after_earlier_state");
    assert.equal((await boundaryProjection()).axis, "complete");
  });
});

// Legacy path: no v2 run exists, so the projection reads the committed
// `coverage_diagnostics` snapshot. Its `updated_at` is the proof's instant.
const LEGACY_DIAGNOSTICS_STREAM = "coverage_diagnostics";

test("store: a legacy diagnostics proof is retired by a later state commit, not by one at its own instant", async (t) => {
  await withBoundaryConnection(async () => {
    const stores = expectedLocalCoverageStoreDescriptors(connectorId);
    assert.ok(stores, "the claude-code inventory declares its coverage stores");
    const snapshot = {
      fetched_at: PROOF_AT,
      stores: stores.map(({ store, stream }) => ({ status: "collected", store, stream })),
    };
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(PROOF_AT) });
    await putSyncState(BOUNDARY_TARGET, { [LEGACY_DIAGNOSTICS_STREAM]: snapshot });
    assert.equal((await boundaryProjection()).axis, "complete", "the legacy snapshot is a reliable complete proof");

    await putSyncState(BOUNDARY_TARGET, { messages: { cursor: "same-instant" } });
    assert.equal((await boundaryProjection()).axis, "complete", "a same-instant state write is not later");

    t.mock.timers.setTime(Date.parse(PROOF_AT) + 1);
    await putSyncState(BOUNDARY_TARGET, { messages: { cursor: "later" } });
    assert.equal(
      (await boundaryProjection()).axis,
      "unknown",
      "a later unaccounted state write retires the legacy proof"
    );
  });
});

test("store: a later server-owned scope write is not a state commit and does not retire the proof", async (t) => {
  await withBoundaryConnection(async () => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(PROOF_AT) });
    await seedV2Proof("run_boundary_scope_proof");
    t.mock.timers.setTime(Date.parse(PROOF_AT) + 1);
    await putSyncState(BOUNDARY_TARGET, {
      [COLLECTION_SCOPE_STATE_KEY]: buildStoredCollectionScope(null, new Date().toISOString()),
    });
    assert.equal(
      (await boundaryProjection()).axis,
      "complete",
      "the `$`-prefixed scope row is server state, not a commit"
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end journey through the real runner and the HTTP owner routes.
// ---------------------------------------------------------------------------

test("journey: a later unnegotiated run that commits state retires the earlier v2 proof on list and detail", async () => {
  await withJourney(async (journey) => {
    // Run A: negotiated and complete. The server holds a v2 terminal proof for both streams.
    const a = await runOnce(journey, { mode: "complete", negotiated: true, tag: "a-complete" });
    assert.equal(a.observed.run_coverage_version, 1, "START negotiated run coverage");
    assert.ok(serverRunStreams("a-complete"), "the server committed run A's terminal proof");
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");

    // Run B: unnegotiated and successful, on a fresh device outbox. It commits state and no terminal evidence.
    const freshQueue = join(journey.dir, "outbox-fresh.sqlite");
    const b = await runOnce(journey, { mode: "complete", negotiated: false, queuePath: freshQueue, tag: "b-state" });
    assert.equal(b.observed.run_coverage_version, undefined, "START did not negotiate run coverage");
    assert.equal(b.result.done?.status, "succeeded");
    assert.deepEqual(
      deviceReceiptFacts(freshQueue, journey.enrolled.source_instance_id),
      [],
      "the fresh outbox holds no receipt"
    );
    assert.equal(serverRunStreams("b-state"), null, "the server committed no terminal evidence for run B");
    assert.deepEqual(
      serverCursors(journey).messages,
      { cursor: "b-state-messages" },
      "run B's state reached the server"
    );

    // Run B's state is a later commit the proof does not cover. Neither list nor detail may keep it complete.
    const owner = await ownerConnectionRow(journey);
    assert.equal(owner.connection_health.axes.coverage, "unknown");
    assert.deepEqual(conditions(owner), { messages: "unknown", sessions: "unknown" });
  });
});

test("journey: a later negotiated run with valid evidence projects covered again after an unnegotiated state commit", async () => {
  await withJourney(async (journey) => {
    await runOnce(journey, { mode: "complete", negotiated: true, tag: "a-complete" });
    const freshQueue = join(journey.dir, "outbox-fresh.sqlite");
    await runOnce(journey, { mode: "complete", negotiated: false, queuePath: freshQueue, tag: "b-state" });
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "unknown");

    // Run C: negotiated and complete. Its own terminal commit is the newest proof, so coverage is covered again.
    const c = await runOnce(journey, { mode: "complete", negotiated: true, tag: "c-complete" });
    assert.equal(c.result.done?.status, "succeeded");
    assert.ok(serverRunStreams("c-complete"), "the server committed run C's terminal proof");
    const owner = await ownerConnectionRow(journey);
    assert.equal(owner.connection_health.axes.coverage, "complete");
    assert.deepEqual(conditions(owner), { messages: "complete", sessions: "complete" });
  });
});

test("journey: an unnegotiated state commit before a negotiated proof does not retire that proof", async () => {
  await withJourney(async (journey) => {
    const earlier = await runOnce(journey, { mode: "complete", negotiated: false, tag: "a-earlier-state" });
    assert.equal(earlier.result.done?.status, "succeeded");
    // Run B: negotiated and complete, after the unnegotiated commit. Its proof is the newest settled evidence.
    await runOnce(journey, { mode: "complete", negotiated: true, tag: "b-complete" });
    const owner = await ownerConnectionRow(journey);
    assert.equal(owner.connection_health.axes.coverage, "complete");
    assert.deepEqual(conditions(owner), { messages: "complete", sessions: "complete" });
  });
});

test("journey, known limit: an unnegotiated run that commits no state leaves no server record, so the last proof stands", async () => {
  await withJourney(async (journey) => {
    await runOnce(journey, { mode: "complete", negotiated: true, tag: "a-complete" });
    // Run B: unnegotiated, records only, no STATE, fresh outbox. The server gets
    // records but no commit it can order against the proof.
    const freshQueue = join(journey.dir, "outbox-fresh.sqlite");
    const b = await runOnce(journey, {
      mode: "records-only",
      negotiated: false,
      queuePath: freshQueue,
      tag: "b-silent",
    });
    assert.equal(b.result.done?.status, "succeeded");
    assert.equal(serverRunStreams("b-silent"), null, "the server committed no terminal evidence for run B");
    assert.deepEqual(serverCursors(journey).messages, { cursor: "a-complete-messages" }, "no cursor moved");
    // This pins what the server can observe today. Closing it needs a run boundary from the runtime.
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");
  });
});
