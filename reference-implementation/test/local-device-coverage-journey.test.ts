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
import { existsSync } from "node:fs";
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
  resolveExecutionRoot,
  type SelectedCollectionRelease,
} from "../../packages/local-collector/bin/pdpp-local-collector.ts";
import { managedConnectorCommand, obtainManagedConnectors } from "../../packages/local-collector/src/managed/index.ts";
import {
  type CollectorConnectorSpec,
  type CollectorRunResult,
  LocalDeviceHttpError,
  runCollectorConnector,
} from "../../packages/local-collector/src/runner.ts";
import { httpRegistryClient, stubVerifier } from "../../packages/local-collector/test/helpers/live-registry-client.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { __setLocalCollectorReleaseForTest } from "../server/local-collector-profiles.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import {
  fixtureConnectorSource,
  INSTALL_PATH_CONNECTOR_ID,
  INSTALL_PATH_REPOSITORY,
  INSTALL_PATH_VERSION,
} from "./helpers/install-path-fixture.ts";

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

// The offline fixture connector (see install-path-fixture.ts): it reads START,
// records what it was asked for, and answers with protocol messages chosen by its
// mode. The journey's child runs this source as a file, labelled "source".
const FIXTURE_CONNECTOR_SOURCE = fixtureConnectorSource("source");

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

/** A lane's server and device identity: what the owner reads and the device reports on. */
interface Lane {
  readonly asUrl: string;
  readonly cookie: string;
  readonly dir: string;
  readonly enrolled: Enrolled;
  readonly queuePath: string;
}

/** J1's lane, which also names the fixture child it runs. */
interface Journey extends Lane {
  readonly childPath: string;
}

/** The fields of a collection profile the lane reads. */
interface ReleaseProfile {
  readonly streams: readonly { readonly coverage_stores: readonly string[]; readonly name: string }[];
  readonly [key: string]: unknown;
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
function registerFixtureManifest(connectorInstanceId: string, profile: ReleaseProfile): void {
  const row = getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get(CONNECTOR_ID) as
    | { manifest: string }
    | undefined;
  assert.ok(row, "enrolment registers the claude-code catalog manifest");
  const catalog = JSON.parse(row.manifest) as Record<string, unknown> & { streams: Record<string, unknown>[] };
  const streams = profile.streams.map((release) => {
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
    registerFixtureManifest(enrolled.connector_instance_id, PROFILE);
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

function deviceStatus(
  journey: Lane,
  selectedRelease: SelectedCollectionRelease = DEVICE_RELEASE
): LocalOutboxStatusOutput {
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
    { deploymentPosture: PUBLISHED_POSTURE, selectedRelease }
  );
}

/** The terminal facts the device acknowledged and stored as its current receipt. */
function deviceReceiptFacts(journey: Lane): Record<string, unknown>[] {
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
function sourceGeneration(journey: Lane): number {
  const row = getDb()
    .prepare("SELECT manifest_generation FROM device_source_instances WHERE source_instance_id = ?")
    .get(journey.enrolled.source_instance_id) as { manifest_generation: number | null } | undefined;
  assert.ok(row && row.manifest_generation !== null, "the source instance carries a manifest generation");
  return Number(row.manifest_generation);
}

function serverRecordCount(journey: Lane, stream: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ? AND stream = ?")
    .get(journey.enrolled.connector_instance_id, stream) as { n: number };
  return row.n;
}

/** Stream cursors only. The `$`-prefixed rows are the server's own collection-scope state, not connector cursors. */
function serverCursors(journey: Lane): Record<string, unknown> {
  const rows = getDb()
    .prepare("SELECT stream, state_json FROM connector_state WHERE connector_instance_id = ? ORDER BY stream")
    .all(journey.enrolled.connector_instance_id) as Array<{ state_json: string; stream: string }>;
  return Object.fromEntries(
    rows.filter((row) => !row.stream.startsWith("$")).map((row) => [row.stream, JSON.parse(row.state_json) as unknown])
  );
}

async function ownerConnectionRow(journey: Lane): Promise<OwnerConnectionRow> {
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

// ---- J2-install: the same lane, with its child installed through the managed path -----------
//
// The lane is J1's, but the child is the installed entrypoint of a release pulled from a real OCI
// registry, verified, and installed by the managed consumer path. Release A and release B share a
// repository, a version and a byte-identical manifest. Only their code layers differ, so only their
// artifact digests differ. Nothing but the digest can tell them apart, and the second half of the
// journey tests exactly that.
//
// The registry is the one the managed-connector OCI job starts. The signature verifier is the stub
// that job uses, so signature verification is the one step this journey does not prove. To run it
// locally, push the two releases with scripts/build-install-path-releases.ts and export the three
// variables below.

const INSTALL_REGISTRY = process.env.PDPP_TEST_OCI_REGISTRY;
const INSTALL_DIGEST_A = process.env.PDPP_TEST_INSTALL_PATH_DIGEST_A;
const INSTALL_DIGEST_B = process.env.PDPP_TEST_INSTALL_PATH_DIGEST_B;
const INSTALL_SKIP =
  INSTALL_REGISTRY === undefined || INSTALL_DIGEST_A === undefined || INSTALL_DIGEST_B === undefined
    ? "set PDPP_TEST_OCI_REGISTRY, PDPP_TEST_INSTALL_PATH_DIGEST_A and PDPP_TEST_INSTALL_PATH_DIGEST_B (scripts/build-install-path-releases.ts pushes both releases)"
    : false;

/** A release as the managed consumer installed it, read back from the installed files. */
interface InstalledRelease {
  readonly digest: string;
  /** The installed bundle the child runs. */
  readonly entrypoint: string;
  /** The manifest fingerprint a receipt must carry to count as this release's. */
  readonly fingerprint: string;
  readonly profile: ReleaseProfile;
  readonly profileBytes: Buffer;
  readonly releaseRoot: string;
}

/** Owner-visible coverage for one connection, as the list and the detail both report it. */
interface CoverageView {
  readonly axis: string;
  readonly conditions: Record<string, string>;
  readonly reason: string | null;
}

/**
 * The SourceCoverageComplete reason a covered lane carries: the condition's reason mirrors its
 * coverage axis, so a complete lane reads "complete". A mismatch has its own reason.
 */
const COVERED_REASON = "complete";

/**
 * Install one pinned release through the managed consumer path. `activate` moves the install
 * store's pointer to it, as an update applied between runs would.
 */
async function installRelease(input: {
  readonly activate: boolean;
  readonly digest: string;
  readonly durableRoot: string;
  readonly installRoot: string;
}): Promise<InstalledRelease> {
  const registry = INSTALL_REGISTRY as string;
  const [managed] = await obtainManagedConnectors({
    activate: input.activate,
    client: httpRegistryClient(`http://${registry}`, INSTALL_PATH_REPOSITORY),
    durableRoot: input.durableRoot,
    installRoot: input.installRoot,
    lock: {
      connectors: [
        {
          connectorId: INSTALL_PATH_CONNECTOR_ID,
          connectorKey: CONNECTOR_ID,
          digest: input.digest,
          reference: `${registry}/${INSTALL_PATH_REPOSITORY}`,
          version: INSTALL_PATH_VERSION,
        },
      ],
      lockVersion: "2.0",
    },
    verifier: stubVerifier,
  });
  assert.ok(managed, "one connector should have been installed");
  const releaseRoot = dirname(dirname(managed.entrypoint));
  const profileBytes = await readFile(join(releaseRoot, "collection-profile.json"));
  const profile = JSON.parse(profileBytes.toString("utf8")) as ReleaseProfile;
  return {
    digest: managed.digest,
    entrypoint: managed.entrypoint,
    fingerprint: hashCanonicalJson(profile),
    profile,
    profileBytes,
    releaseRoot,
  };
}

/** The device's selected release, derived from the installed bytes rather than from a constant. */
function selectedFrom(release: InstalledRelease): SelectedCollectionRelease {
  return { artifactDigest: release.digest, manifestFingerprint: release.fingerprint };
}

/** The digest the install store's pointer names for the connector. */
async function activeDigest(installRoot: string): Promise<string> {
  const pointer = JSON.parse(await readFile(join(installRoot, "connectors", CONNECTOR_ID, "current.json"), "utf8")) as {
    digest: string;
  };
  return pointer.digest;
}

/**
 * The lane J1 builds (a server, an owner session, an enrolled device, and the catalog entry
 * narrowed to the release's streams), with the server pinned to `release`.
 */
async function withInstallLane(
  dir: string,
  release: InstalledRelease,
  run: (lane: Lane) => Promise<void>
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: join(dir, "pdpp.sqlite"),
    ownerAuthPassword: OWNER_PASSWORD,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  __setLocalCollectorReleaseForTest(CONNECTOR_ID, { artifactDigest: release.digest, manifest: release.profile });
  try {
    const cookie = await ownerSessionCookie(asUrl);
    const enrolled = await enrollLaptop(asUrl, cookie);
    registerFixtureManifest(enrolled.connector_instance_id, release.profile);
    await run({ asUrl, cookie, dir, enrolled, queuePath: join(dir, "outbox.sqlite") });
  } finally {
    __setLocalCollectorReleaseForTest(CONNECTOR_ID, null);
    await closeTestServer(server);
    closeDb();
  }
}

/** Run an installed entrypoint through the runner, with the same spec the lane's own binding produces. */
async function runInstalled(lane: Lane, release: InstalledRelease, mode: string, tag: string): Promise<RunOutcome> {
  const observePath = join(lane.dir, `start-${tag}.json`);
  const connector = bindOptionalRunCoverageToRelease(
    {
      args: [release.entrypoint, mode, observePath, tag],
      command: managedConnectorCommand(release.entrypoint),
      connector_id: CONNECTOR_ID,
      protocol_capabilities: [],
      runtime_requirements: { bindings: {} },
      streams: STREAMS,
    },
    { digest: release.digest },
    release.profile
  );
  const result = await runCollectorConnector({
    baseUrl: lane.asUrl,
    connector,
    deviceId: lane.enrolled.device_id,
    deviceToken: lane.enrolled.device_token,
    executionRoot: resolveExecutionRoot({ args: [release.entrypoint] }),
    outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 1 },
    queuePath: lane.queuePath,
    runId: tag,
    sourceInstanceId: lane.enrolled.source_instance_id,
  });
  return { observed: JSON.parse(await readFile(observePath, "utf8")) as Record<string, unknown>, result };
}

function coverageView(body: Record<string, unknown>): CoverageView {
  const health = body.connection_health as {
    axes: { coverage: string };
    conditions: { reason?: string | null; type: string }[];
  };
  const report = body.collection_report as ProjectedStream[];
  return {
    axis: health.axes.coverage,
    conditions: Object.fromEntries(report.map((entry) => [entry.stream, entry.coverage_condition])),
    reason: health.conditions.find((condition) => condition.type === "SourceCoverageComplete")?.reason ?? null,
  };
}

/** The owner's view of the connection, read from the list and the detail. The two must agree. */
async function ownerCoverage(lane: Lane): Promise<CoverageView> {
  await reconcileDirtyConnectorSummaryEvidence(null);
  const list = await requestJson(`${lane.asUrl}/_ref/connectors?limit=100`, { headers: { Cookie: lane.cookie } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = ((list.body?.data ?? []) as Record<string, unknown>[]).find(
    (candidate) => candidate.connection_id === lane.enrolled.connector_instance_id
  );
  assert.ok(row, "the owner list projects the enrolled connection");
  const detail = await requestJson(`${lane.asUrl}/_ref/connectors/${CONNECTOR_ID}`, {
    headers: { Cookie: lane.cookie },
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const fromList = coverageView(row);
  assert.deepEqual(coverageView(detail.body ?? {}), fromList, "list and detail agree on coverage and its reason");
  return fromList;
}

/** The stream facts the server stored for one terminal commit. The commit must exist. */
function requireRunStreams(runId: string): Record<string, unknown>[] {
  const streams = serverRunStreams(runId);
  assert.ok(streams, `the server committed run ${runId}`);
  return streams;
}

test("J2-install: a release installed through the managed path is covered; a replaced digest stops counting until its own run proves it", {
  skip: INSTALL_SKIP,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), "pdpp-install-path-journey-"));
  const installRoot = join(base, "connector-releases");
  const durableRoot = join(base, "connector-artifacts");
  const digestA = INSTALL_DIGEST_A as string;
  const digestB = INSTALL_DIGEST_B as string;
  try {
    // Install release A and check what the consumer made of it before anything runs.
    const releaseA = await installRelease({ activate: true, digest: digestA, durableRoot, installRoot });
    assert.equal(releaseA.digest, digestA);
    assert.equal(releaseA.profile.connector_id, INSTALL_PATH_CONNECTOR_ID);
    assert.deepEqual(
      releaseA.profile.streams.map((stream) => stream.name),
      STREAMS,
      "the installed profile declares the lane's two streams"
    );
    assert.equal(releaseA.entrypoint, join(releaseA.releaseRoot, "code", "collection-profile.mjs"));
    assert.ok(releaseA.entrypoint.startsWith(installRoot), "the entrypoint lies inside the install store");

    await withInstallLane(base, releaseA, async (lane) => {
      // Phase 1: release A runs through its installed entrypoint, and the server and the device accept it.
      const a = await runInstalled(lane, releaseA, "complete", "a-install");
      assert.equal(a.observed.build, "release-a", "the installed release A's bytes ran");
      assert.equal(a.observed.run_coverage_version, 1, "START asked the installed connector for run coverage");
      assert.equal(a.result.done?.status, "succeeded");
      assert.equal(serverRecordCount(lane, "sessions"), 2);
      assert.equal(serverRecordCount(lane, "messages"), 1);
      for (const stream of requireRunStreams("a-install")) {
        assert.equal(stream.artifact_digest, digestA, "the server stores run A under digest A");
        assert.equal(stream.manifest_fingerprint, releaseA.fingerprint);
        assert.equal(stream.binding_generation, sourceGeneration(lane), "bound to the source generation");
      }
      assert.deepEqual(await ownerCoverage(lane), {
        axis: "complete",
        conditions: { messages: "complete", sessions: "complete" },
        reason: COVERED_REASON,
      });
      const aDevice = deviceStatus(lane, selectedFrom(releaseA));
      assert.equal(aDevice.terminal_coverage.verdict, "covered");
      assert.equal(aDevice.lifecycle_state, "covered");
      const aReceipts = deviceReceiptFacts(lane);
      assert.equal(aReceipts.length, 2, "the device holds a receipt for both streams");
      assert.ok(
        aReceipts.every(
          (fact) => fact.artifact_digest === digestA && fact.manifest_fingerprint === releaseA.fingerprint
        ),
        "the device receipt names release A"
      );

      // Phase 2: install release B for the same source and select it. B does not run yet.
      const releaseB = await installRelease({ activate: true, digest: digestB, durableRoot, installRoot });
      assert.equal(releaseB.digest, digestB);
      assert.notEqual(releaseB.releaseRoot, releaseA.releaseRoot, "B installs beside A");
      assert.deepEqual(
        releaseB.profileBytes,
        releaseA.profileBytes,
        "the manifest is byte-identical, so the digest is the only difference"
      );
      assert.ok(existsSync(releaseA.entrypoint), "installing B left release A in place");
      assert.equal(await activeDigest(installRoot), digestB, "the install store points at B");
      __setLocalCollectorReleaseForTest(CONNECTOR_ID, { artifactDigest: releaseB.digest, manifest: releaseB.profile });

      // Before any B run, neither side counts A's proof for B.
      assert.deepEqual(await ownerCoverage(lane), {
        axis: "unknown",
        conditions: { messages: "unknown", sessions: "unknown" },
        reason: "coverage_unknown_artifact_mismatch",
      });
      const bBefore = deviceStatus(lane, selectedFrom(releaseB));
      assert.equal(bBefore.terminal_coverage.verdict, "not_current");
      assert.equal(bBefore.lifecycle_state, "coverage_not_current");
      // No A proof is relabelled as B: the device still holds only A's receipt, and the server still
      // records run A as A.
      assert.ok(
        deviceReceiptFacts(lane).every((fact) => fact.artifact_digest === digestA),
        "the device receipt still names release A"
      );
      assert.ok(
        requireRunStreams("a-install").every((stream) => stream.artifact_digest === digestA),
        "the server still records run A as release A"
      );

      // Phase 3: release B runs through its installed entrypoint, and proves itself.
      const b = await runInstalled(lane, releaseB, "complete", "b-install");
      assert.equal(b.observed.build, "release-b", "the installed release B's bytes ran");
      assert.equal(b.result.done?.status, "succeeded");
      assert.ok(
        requireRunStreams("b-install").every((stream) => stream.artifact_digest === digestB),
        "the server stores run B under digest B"
      );
      assert.deepEqual(await ownerCoverage(lane), {
        axis: "complete",
        conditions: { messages: "complete", sessions: "complete" },
        reason: COVERED_REASON,
      });
      const bDevice = deviceStatus(lane, selectedFrom(releaseB));
      assert.equal(bDevice.terminal_coverage.verdict, "covered");
      assert.equal(bDevice.lifecycle_state, "covered");
      const bReceipts = deviceReceiptFacts(lane);
      assert.equal(bReceipts.length, 2, "the device holds a receipt for both streams");
      assert.ok(
        bReceipts.every(
          (fact) => fact.artifact_digest === digestB && fact.manifest_fingerprint === releaseB.fingerprint
        ),
        "the device receipt names release B"
      );
      assert.ok(
        requireRunStreams("a-install").every((stream) => stream.artifact_digest === digestA),
        "run A is still recorded as release A after B is covered"
      );
    });
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});
