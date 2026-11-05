// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mixed versions of the claude-code Collection Profile.
 *
 * The collector pin and the profile this server registers move together
 * (claude-code 0.3.0 to 0.3.4), but a device and a server do not upgrade at the
 * same moment, and the server registers a pinned profile only when a device
 * enrolls (`ensureReferenceConnectorCatalogEntry`). This test holds one enrolled
 * device across both directions:
 *
 *  - a new collector pushes `usage` to a server that still holds the previous
 *    profile: the push is refused at ingest, nothing is stored;
 *  - the server then registers the new profile: the same connection keeps its
 *    id, its checkpoint and its records, `usage` is accepted, the coverage proof
 *    stamped under the previous profile reads `generation_mismatch` (`unknown`),
 *    and the next run's coverage write brings the axis back.
 *
 * `fixtures/collector-profile-upgrade/claude-code-0.3.0.json` is the verbatim
 * profile the previous pin shipped. Only the device-side process is simulated;
 * enrollment, registration, ingest, state and the health projection are the
 * production paths.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { expectedLocalCoverageStoreDescriptors } from "@pdpp/polyfill-connectors/local-source-inventory";
import { registerConnector } from "../server/auth.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { readLocalCollectorProfile } from "../server/local-collector-profiles.ts";
import { putSyncState, readCommittedLocalCoverageDiagnostics } from "../server/records.ts";
import { deriveLocalCoverageAxis, listConnectorSummaries } from "../server/ref-control.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { fetchJson, type TestServer } from "./helpers/legacy-upgrade.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTOR_ID = "claude-code";
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };

function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetchJson(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalValue(record[key])])
  );
}

function bodyHash(records: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(records)))
    .digest("hex");
}

/** The manifest the server registers for a local-collector connector (see `readReferenceLocalConnectorCatalogManifest`). */
function enrollmentManifest(profile: Record<string, unknown>) {
  return { ...profile, connector_id: CONNECTOR_ID, display_name: profile.display_name || CONNECTOR_ID };
}

function register(profile: Record<string, unknown>) {
  return registerConnector(enrollmentManifest(profile), {
    backfillRetrievalIndexes: false,
    replaceAcceptedDigest: true,
  });
}

interface Device {
  connector_instance_id: string;
  device_id: string;
  device_token: string;
  source_instance_id: string;
}

let batchSeq = 0;
function push(asUrl: string, device: Device, records: readonly Record<string, unknown>[]) {
  batchSeq += 1;
  return postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
    {
      batch_id: `profile-upgrade-${batchSeq}`,
      batch_seq: batchSeq,
      body_hash: bodyHash(records),
      connector_id: CONNECTOR_ID,
      device_id: device.device_id,
      records,
      source_instance_id: device.source_instance_id,
    },
    { Authorization: `Bearer ${device.device_token}`, ...PROTOCOL_HEADERS }
  );
}

function emitted(stream: string, key: string, data: Record<string, unknown>) {
  return { data, emitted_at: "2026-11-05T10:00:00.000Z", record_key: key, stream };
}

/** One `coverage_diagnostics` state write, as the connector commits it at the end of a successful run. */
const COVERAGE_STORES = [
  { status: "collected", store: "projects", stream: "sessions" },
  { status: "collected", store: "derived_messages", stream: "messages" },
  { status: "collected", store: "derived_attachments", stream: "attachments" },
  { status: "collected", store: "derived_memory_notes", stream: "memory_notes" },
  { status: "inventory_only", store: "cache", stream: null },
  { status: "excluded", store: "auth", stream: null },
];

function coverageRows() {
  const expected = expectedLocalCoverageStoreDescriptors(CONNECTOR_ID);
  assert.ok(expected, "the production claude-code connector declares a fixed inventory");
  const supplied = new Map(COVERAGE_STORES.map((row) => [row.store, row]));
  return expected.map(({ store, stream }) => ({
    status: supplied.get(store)?.status ?? "inventory_only",
    store,
    stream,
  }));
}

async function commitCoverage(connectorInstanceId: string, rows: ReturnType<typeof coverageRows>) {
  for (const row of rows) {
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
         VALUES (?, ?, 'coverage_diagnostics', ?, ?, ?, 1, 0)
         ON CONFLICT DO NOTHING`
      )
      .run(
        CONNECTOR_ID,
        connectorInstanceId,
        `coverage:${row.store}`,
        JSON.stringify({ id: `coverage:${row.store}`, ...row }),
        "2026-11-05T10:00:00.000Z"
      );
  }
  await putSyncState(
    { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId },
    { coverage_diagnostics: { fetched_at: new Date(Date.now() - 30_000).toISOString(), stores: rows } }
  );
}

/** The local-coverage axis the server derives from the committed proof (`deriveLocalCoverageAxis`). */
async function localCoverage(connectorInstanceId: string) {
  const proof = (await readCommittedLocalCoverageDiagnostics({
    connector_id: CONNECTOR_ID,
    connector_instance_id: connectorInstanceId,
  })) as Parameters<typeof deriveLocalCoverageAxis>[0];
  const { axis, reliable, unreliableReason } = deriveLocalCoverageAxis(proof);
  return { axis, reliable, unreliableReason };
}

async function projectedConnectionIds(): Promise<string[]> {
  await reconcileDirtyConnectorSummaryEvidence(null);
  return (await listConnectorSummaries()).map((summary) => summary.connector_instance_id);
}

function stateRow(connectorInstanceId: string, stream: string) {
  return getDb()
    .prepare("SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = ?")
    .get<{ state_json: string }>(connectorInstanceId, stream)?.state_json;
}

function recordCount(connectorInstanceId: string, stream: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ? AND stream = ?")
      .get<{ n: number }>(connectorInstanceId, stream)?.n ?? 0
  );
}

test("a device enrolled on the previous claude-code profile survives the server registering the new profile, in both push directions", async () => {
  const previous = JSON.parse(
    readFileSync(join(HERE, "fixtures", "collector-profile-upgrade", "claude-code-0.3.0.json"), "utf8")
  ) as Record<string, unknown>;
  const current = readLocalCollectorProfile(CONNECTOR_ID);
  assert.ok(current, "claude-code must have a pinned Collection Profile");
  const names = (profile: Record<string, unknown>) =>
    (profile.streams as { name: string }[]).map((stream) => stream.name);
  assert.equal(previous.version, "0.3.0");
  assert.equal(names(previous).includes("usage"), false);
  assert.equal(names(current).includes("usage"), true);

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
  })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: CONNECTOR_ID,
      local_binding_name: "laptop",
    });
    assert.equal(code.status, 201, JSON.stringify(code.body));
    const enrolled = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: code.body.enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
    const device = enrolled.body as Device;
    const connectionId = device.connector_instance_id;

    // The server a previous release left behind: it holds the previous profile.
    await register(previous);

    const first = await push(asUrl, device, [
      emitted("sessions", "s1", { id: "s1" }),
      emitted("messages", "m1", { id: "m1", session_id: "s1" }),
    ]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.connector_instance_id, connectionId);
    const checkpoint = { cursor: "sessions-checkpoint-1" };
    await putSyncState({ connector_id: CONNECTOR_ID, connector_instance_id: connectionId }, { sessions: checkpoint });
    await commitCoverage(connectionId, coverageRows());
    assert.deepEqual(await localCoverage(connectionId), { axis: "complete", reliable: true, unreliableReason: undefined });
    assert.deepEqual(await projectedConnectionIds(), [connectionId]);

    // New collector, previous server: `usage` is not declared, so the push is refused and stores nothing.
    const usage = emitted("usage", "usage", {
      currency: "USD",
      daily_activity: [],
      daily_model_tokens: [],
      hour_counts: {},
      id: "usage",
      models: [],
      source: "stats-cache",
      total_cost_usd_cents: 0,
    });
    const refused = await push(asUrl, device, [usage]);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.message, "records[0].stream is not declared by the connector manifest");
    assert.equal(recordCount(connectionId, "usage"), 0);

    // The server registers the new profile.
    await register(current);

    const accepted = await push(asUrl, device, [usage]);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.connector_instance_id, connectionId);
    assert.equal(recordCount(connectionId, "usage"), 1);
    // Identity, checkpoint and stored records are untouched by the profile change.
    assert.equal(recordCount(connectionId, "sessions"), 1);
    assert.equal(recordCount(connectionId, "messages"), 1);
    assert.deepEqual(JSON.parse(stateRow(connectionId, "sessions") ?? "null"), checkpoint);
    assert.deepEqual(await projectedConnectionIds(), [connectionId]);
    // The coverage proof was stamped under the previous profile, so it is not
    // trusted until the next run writes it again (`generation_mismatch`).
    assert.deepEqual(await localCoverage(connectionId), {
      axis: "unknown",
      reliable: false,
      unreliableReason: "generation_mismatch",
    });

    await commitCoverage(connectionId, coverageRows());
    assert.deepEqual(await localCoverage(connectionId), { axis: "complete", reliable: true, unreliableReason: undefined });
    assert.deepEqual(await projectedConnectionIds(), [connectionId]);
  } finally {
    await closeTestServer(server);
  }
});
