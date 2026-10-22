// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Journey J1 for local-device run coverage. It crosses real process and HTTP
// boundaries:
//
//   fixture connector (child process, collector JSONL protocol)
//     -> collector runner (runCollectorConnector)
//     -> reference server (startServer: production routes, file SQLite,
//        enrollment over HTTP, owner session login)
//     -> owner projections read over HTTP, and the device outbox read with
//        the device status command.
//
// Three substitutions, all about the release the lane runs. None changes what
// the lane does with it:
//
//   - The checked-in claude-code pin declares no run_coverage, so no real
//     release can emit a v2 proof yet. The test registers a fixture release
//     that declares it: on the server through __setLocalCollectorReleaseForTest,
//     and on the device through bindOptionalRunCoverageToRelease, as
//     prepareConnectorSpec binds a pinned release.
//   - Enrolment registers the eleven-stream claude-code catalog manifest. The
//     journey narrows that entry to the release's two streams.
//   - The owner routes read a summary read model that the server refreshes in
//     the background. The journey refreshes it before each owner read, as the
//     projection oracle does.
//
// Records, cursors and the terminal verdict all come from the child, through
// the runner. The test seeds none of them.

// The local-collector bin reaches the untyped installer core. This names the
// local collector's own shim for it, which the reference-implementation program
// does not otherwise include.
/// <reference path="../../packages/local-collector/src/managed/installer-core.d.ts" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { hashCanonicalJson } from "@pdpp/collector-runtime";

import {
  bindOptionalRunCoverageToRelease,
  inspectLocalOutboxStatus,
  type LocalOutboxStatusOutput,
  parseArgs,
} from "../../packages/local-collector/bin/pdpp-local-collector.ts";
import {
  type CollectorConnectorSpec,
  type CollectorRunResult,
  LocalDeviceHttpError,
  runCollectorConnector,
} from "../../packages/local-collector/src/runner.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { __setLocalCollectorReleaseForTest } from "../server/local-collector-profiles.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

const CONNECTOR_ID = "claude-code";
const LOCAL_BINDING_NAME = "journey-laptop";
const OWNER_PASSWORD = "local-coverage-journey-password";
const STREAMS = ["sessions", "messages"];
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const CSRF_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

// The fixture release: a claude-code profile that declares run coverage for
// both streams. The server registers it, and the device binds to it.
const PROFILE = {
  connector_id: CONNECTOR_ID,
  run_coverage: { version: 1 },
  streams: [
    { coverage_stores: ["projects"], name: "sessions", primary_key: ["id"] },
    { coverage_stores: ["derived_messages"], name: "messages", primary_key: ["id"] },
  ],
  version: "0.0.0-journey",
};
const ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(PROFILE)).digest("hex")}`;
const SERVER_RELEASE = { artifactDigest: ARTIFACT_DIGEST, manifest: PROFILE };
const DEVICE_RELEASE = { artifactDigest: ARTIFACT_DIGEST, manifestFingerprint: hashCanonicalJson(PROFILE) };
const PUBLISHED_POSTURE = Object.freeze({
  is_placeholder_version: false,
  kind: "published_package",
  location_hint: "node_modules/@pdpp/local-collector",
  module_basename: "pdpp-local-collector.js",
  version: "0.1.0-beta.7",
});

// Offline fixture connector. It reads START, records what it was asked for, and
// answers with protocol messages chosen by its mode. Written with no template
// interpolation so it can sit inside this file as a plain string.
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
  if (mode === "empty") {
    emit({ records_emitted: 0, status: "succeeded", type: "DONE" });
    return;
  }
  if (mode === "reject") {
    // A stream the connector manifest does not declare: the server refuses the batch.
    record("sessions", "s-1");
    record("undeclared_stream", "u-1");
    emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
    emit({ coverage, records_emitted: 2, status: "succeeded", type: "DONE" });
    return;
  }
  record("sessions", "s-1");
  record("sessions", "s-2");
  record("messages", "m-1");
  emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
  emit({ cursor: { cursor: tag + "-messages" }, stream: "messages", type: "STATE" });
  if (mode === "skip") {
    emit({ message: "one message could not be read", reason: "source_unreadable", stream: "messages", type: "SKIP_RESULT" });
  }
  emit({ coverage, records_emitted: 3, status: "succeeded", type: "DONE" });
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
 * Enrolment registers the checked-in claude-code catalog manifest, which
 * declares eleven streams. The journey's lane covers two. So the catalog entry
 * is narrowed to the release's streams, keeping each declared stream as the
 * catalog wrote it and taking the release's coverage stores. As a catalog
 * update does, the manifest generation advances, so no earlier binding carries
 * over.
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
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-coverage-journey-"));
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

async function runOnce(
  journey: Journey,
  mode: string,
  tag: string,
  options: { deviceToken?: string } = {}
): Promise<RunOutcome> {
  const observePath = join(journey.dir, `start-${tag}.json`);
  const connector: CollectorConnectorSpec = bindOptionalRunCoverageToRelease(
    {
      args: [journey.childPath, mode, observePath, tag],
      command: process.execPath,
      connector_id: CONNECTOR_ID,
      protocol_capabilities: [],
      runtime_requirements: { bindings: {} },
      streams: STREAMS,
    },
    { digest: ARTIFACT_DIGEST },
    PROFILE
  );
  const result = await runCollectorConnector({
    baseUrl: journey.asUrl,
    connector,
    deviceId: journey.enrolled.device_id,
    deviceToken: options.deviceToken ?? journey.enrolled.device_token,
    executionRoot: dirname(journey.childPath),
    outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 1 },
    queuePath: journey.queuePath,
    runId: tag,
    sourceInstanceId: journey.enrolled.source_instance_id,
  });
  return { observed: JSON.parse(await readFile(observePath, "utf8")) as Record<string, unknown>, result };
}

function deviceStatus(journey: Journey): LocalOutboxStatusOutput {
  return inspectLocalOutboxStatus(
    parseArgs([
      "status",
      "--queue",
      journey.queuePath,
      "--source-instance-id",
      journey.enrolled.source_instance_id,
      "--connector",
      CONNECTOR_ID,
    ]),
    { deploymentPosture: PUBLISHED_POSTURE, selectedRelease: DEVICE_RELEASE }
  );
}

/** The terminal facts the device acknowledged and stored as its current receipt. */
function deviceReceiptFacts(journey: Journey): Record<string, unknown>[] {
  const db = new DatabaseSync(journey.queuePath);
  try {
    const row = db
      .prepare("SELECT terminal_facts_json FROM local_device_terminal_coverage_receipts WHERE source_instance_id = ?")
      .get(journey.enrolled.source_instance_id) as { terminal_facts_json: string } | undefined;
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

/** The source generation terminal commits bind to, as the server stores it for this lane. */
function sourceGeneration(journey: Journey): number {
  const row = getDb()
    .prepare("SELECT manifest_generation FROM device_source_instances WHERE source_instance_id = ?")
    .get(journey.enrolled.source_instance_id) as { manifest_generation: number | null } | undefined;
  assert.ok(row && row.manifest_generation !== null, "the source instance carries a manifest generation");
  return Number(row.manifest_generation);
}

function serverRecordCount(journey: Journey, stream: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ? AND stream = ?")
    .get(journey.enrolled.connector_instance_id, stream) as { n: number };
  return row.n;
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

async function ownerConnectionRow(journey: Journey): Promise<OwnerConnectionRow> {
  // The owner routes read a summary read model that the server refreshes from
  // dirty evidence in the background. Refresh it here, as the projection oracle
  // does, so the read reflects the terminal commit just made.
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
  return row as unknown as OwnerConnectionRow;
}

function conditions(row: OwnerConnectionRow): Record<string, string> {
  return Object.fromEntries(row.collection_report.map((entry) => [entry.stream, entry.coverage_condition]));
}

test("J1: a registered release's run coverage crosses child, runner, server and device intact", async () => {
  await withJourney(async (journey) => {
    // Run A: every requested store collected, and the start asks for coverage.
    const a = await runOnce(journey, "complete", "a-complete");
    assert.equal(a.observed.run_coverage_version, 1, "START asked the child for run coverage");
    assert.equal(a.result.done?.status, "succeeded");
    assert.equal(a.result.statePutFailed, false);
    assert.equal(serverRecordCount(journey, "sessions"), 2);
    assert.equal(serverRecordCount(journey, "messages"), 1);
    assert.deepEqual(serverCursors(journey), {
      messages: { cursor: "a-complete-messages" },
      sessions: { cursor: "a-complete-sessions" },
    });
    const aStreams = serverRunStreams("a-complete");
    assert.ok(aStreams, "the server committed the terminal run");
    assert.deepEqual(
      aStreams.map((stream) => stream.stream),
      ["messages", "sessions"],
      "every requested stream is in the committed facts"
    );
    for (const stream of aStreams) {
      assert.equal(stream.artifact_digest, ARTIFACT_DIGEST);
      assert.equal(stream.manifest_fingerprint, DEVICE_RELEASE.manifestFingerprint);
      assert.equal(stream.binding_generation, sourceGeneration(journey), "bound to the source generation");
    }
    const aOwner = await ownerConnectionRow(journey);
    assert.equal(aOwner.connection_health.axes.coverage, "complete");
    assert.deepEqual(conditions(aOwner), { messages: "complete", sessions: "complete" });
    const aDevice = deviceStatus(journey);
    assert.equal(aDevice.terminal_coverage.verdict, "covered");
    assert.equal(aDevice.lifecycle_state, "covered");
    const aReceipt = deviceReceiptFacts(journey);
    assert.equal(aReceipt.length, 2, "the device holds a receipt for both streams");
    assert.ok(
      aReceipt.every(
        (fact) =>
          fact.artifact_digest === ARTIFACT_DIGEST && fact.manifest_fingerprint === DEVICE_RELEASE.manifestFingerprint
      ),
      "the device receipt names the release it selects"
    );

    // Run B: one SKIP_RESULT, and a DONE that still claims every store collected.
    const b = await runOnce(journey, "skip", "b-skip");
    assert.equal(b.result.done?.status, "succeeded");
    const bStreams = serverRunStreams("b-skip");
    assert.ok(bStreams, "the skipped run still commits its terminal evidence");
    const messages = bStreams.find((stream) => stream.stream === "messages");
    assert.ok(messages, "the server reports the messages stream");
    const bAccounting = messages.runtime_accounting as Record<string, unknown>;
    assert.equal(bAccounting.detail_complete, false);
    assert.ok(Number(bAccounting.outstanding_debt) >= 1, "the skip is outstanding debt");
    assert.deepEqual(messages.stores, [{ status: "partial", store: "derived_messages" }]);
    const bOwner = await ownerConnectionRow(journey);
    assert.notEqual(conditions(bOwner).messages, "complete", "the skipped stream is not complete on the server");
    assert.equal(conditions(bOwner).sessions, "complete", "the stream without a skip stays complete");
    const bDevice = deviceStatus(journey);
    assert.equal(bDevice.terminal_coverage.verdict, "incomplete");
    assert.equal(bDevice.lifecycle_state, "coverage_incomplete");
    const bReceipt = deviceReceiptFacts(journey).find((fact) => fact.stream === "messages");
    assert.deepEqual(bReceipt?.stores, [{ status: "partial", store: "derived_messages" }]);

    // Run A again: a clean run restores complete coverage on both sides.
    const restored = await runOnce(journey, "complete", "a-restored");
    assert.equal(restored.result.done?.status, "succeeded");
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");
    assert.equal(deviceStatus(journey).lifecycle_state, "covered");

    // Run C: a negotiated success with no coverage claim and no records.
    const c = await runOnce(journey, "empty", "c-empty");
    assert.equal(c.observed.run_coverage_version, 1);
    assert.equal(c.result.done?.status, "succeeded");
    const cStreams = serverRunStreams("c-empty");
    assert.ok(cStreams, "the empty v2 report is acknowledged by the server");
    assert.ok(
      cStreams.every((stream) => JSON.stringify(stream.coverage_statuses) === '["unknown"]'),
      "the empty report commits unknown inventory, not collected stores"
    );
    const cOwner = await ownerConnectionRow(journey);
    assert.equal(cOwner.connection_health.axes.coverage, "unknown", "the empty report retires the earlier proof");
    assert.deepEqual(conditions(cOwner), { messages: "unknown", sessions: "unknown" });
    const cDevice = deviceStatus(journey);
    assert.equal(cDevice.terminal_coverage.verdict, "no_evidence");
    assert.equal(cDevice.lifecycle_state, "no_evidence");
    assert.deepEqual(deviceReceiptFacts(journey), []);
  });
});

test("B2: a server-rejected record stays unadmitted, moves no cursor, and leaves the lane not covered", async () => {
  await withJourney(async (journey) => {
    const outcome = await runOnce(journey, "reject", "reject-1");
    const summary = outcome.result.outboxSummary;
    assert.ok(
      summary.ready + summary.retrying + summary.leased + summary.deadLetter > 0,
      "the record batch was not durably admitted"
    );
    assert.equal(serverRecordCount(journey, "sessions"), 0, "the rejected batch wrote no record");
    assert.deepEqual(serverCursors(journey), {}, "no cursor advanced");
    assert.equal(serverRunStreams("reject-1"), null, "no terminal commit was acknowledged");
    const status = deviceStatus(journey);
    assert.equal(status.terminal_coverage.verdict, "no_evidence");
    assert.notEqual(status.lifecycle_state, "covered");
    assert.deepEqual(deviceReceiptFacts(journey), []);
  });
});

test("J2: a run the server rejects after a covered run leaves the lane not covered", async () => {
  await withJourney(async (journey) => {
    // Run A: a clean complete run. The device holds a covered receipt and the server projects complete.
    const a = await runOnce(journey, "complete", "a-complete");
    assert.equal(a.result.done?.status, "succeeded");
    assert.equal(deviceStatus(journey).terminal_coverage.verdict, "covered");
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");

    // Run B: the server refuses its record batch (an undeclared stream), so nothing from B is admitted.
    // The batch stays ready for retry and run B's terminal commit waits behind it, so the server never
    // receives a terminal commit for run B.
    const b = await runOnce(journey, "reject", "b-reject");
    assert.equal(b.result.done?.status, "succeeded", "the child finished; the server refused its batch");
    assert.equal(serverRunStreams("b-reject"), null, "the server acknowledged no terminal commit for run B");
    assert.equal(serverRecordCount(journey, "sessions"), 2, "the rejected batch wrote no record; run A's remain");

    // The device no longer stands behind run A's receipt for the lane: its latest run is unadmitted.
    const status = deviceStatus(journey);
    assert.equal(status.terminal_coverage.verdict, "unadmitted");
    assert.equal(status.lifecycle_state, "draining");

    // The server never learns of run B as a run: nothing from B was admitted and its terminal commit never
    // arrived, so the server holds no run-level record for B. Its coverage still reflects run A's admitted
    // terminal commit, and its outbox axis shows the lane has not drained. Only the device reports run B as
    // unadmitted.
    const owner = await ownerConnectionRow(journey);
    assert.equal(owner.connection_health.axes.coverage, "complete");
    assert.deepEqual(conditions(owner), { messages: "complete", sessions: "complete" });
    assert.equal(owner.connection_health.axes.outbox, "active");
  });
});

test("J3: a run that fails before its scan leaves the lane not covered; the server keeps run A's coverage until a later run recovers the gap", async () => {
  await withJourney(async (journey) => {
    // Run A: a clean complete run. The device holds a covered receipt and the server projects complete.
    const a = await runOnce(journey, "complete", "a-complete");
    assert.equal(a.result.done?.status, "succeeded");
    assert.equal(deviceStatus(journey).terminal_coverage.verdict, "covered");
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");

    // Run B: the server refuses the run's first heartbeat, so the run fails before its state read and scan.
    // The child never starts, and the server admits nothing from the run.
    await assert.rejects(
      runOnce(journey, "complete", "b-refused", { deviceToken: "refused-device-token" }),
      (error: unknown) => error instanceof LocalDeviceHttpError && error.status === 401
    );
    await assert.rejects(readFile(join(journey.dir, "start-b-refused.json"), "utf8"), { code: "ENOENT" });
    assert.equal(serverRunStreams("b-refused"), null, "the server acknowledged no terminal commit for run B");

    // The device no longer stands behind run A's receipt: run B's failure gap is open.
    const status = deviceStatus(journey);
    assert.equal(status.terminal_coverage.verdict, "unadmitted");
    assert.equal(status.lifecycle_state, "draining");

    // The server never admitted run B, so its projection still reflects run A's admitted terminal commit.
    // Its outbox axis shows run A's last healthy heartbeat, because the refusal left the server nothing to
    // record. The owner projection and the device verdict disagree until a later run reaches the server.
    const owner = await ownerConnectionRow(journey);
    assert.equal(owner.connection_health.axes.coverage, "complete");
    assert.equal(owner.connection_health.axes.outbox, "idle");
    assert.deepEqual(conditions(owner), { messages: "complete", sessions: "complete" });

    // Run C: a clean run. Its pre-scan drain delivers run B's gap, and its complete pass recovers it.
    const c = await runOnce(journey, "complete", "c-complete");
    assert.equal(c.result.done?.status, "succeeded");
    assert.equal(deviceStatus(journey).terminal_coverage.verdict, "covered");
    assert.equal((await ownerConnectionRow(journey)).connection_health.axes.coverage, "complete");
  });
});
