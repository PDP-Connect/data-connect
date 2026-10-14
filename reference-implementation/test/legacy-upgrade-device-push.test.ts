// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-upgrade preservation: device push without a Collection Profile pin.
 *
 * c82718d4 registered `signal` from its bundled manifest. Signal has no
 * local-collector Collection Profile at the target, so no profile pin exists
 * for it. This test registers the O-era stored manifest, enrolls a device at
 * the target for that connector (the enroll route falls back to the
 * registered manifest), and shows pushes are authorized and ingested against
 * the DB-registered manifest (compileDeviceAttemptContext reads
 * ctx.getConnectorManifest, not a profile). It does NOT seed an O-era device
 * row or token: a device enrolled at c82718d4 is not reproduced byte for byte.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeConnectorManifestForStorage } from "../server/auth.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { readLocalCollectorProfile } from "../server/local-collector-profiles.ts";
import { closeServer, fetchJson, type TestServer } from "./helpers/legacy-upgrade.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-05-18T12:00:00.000Z";
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

test("a device enrolled at the target pushes a signal-style connector with no profile pin against the registered manifest", async () => {
  assert.equal(readLocalCollectorProfile("signal"), null, "signal must have no Collection Profile pin for this test");
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
  })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const legacy = JSON.parse(readFileSync(join(HERE, "fixtures", "legacy-upgrade", "signal.json"), "utf8"));
    const stored = normalizeConnectorManifestForStorage(legacy).storedManifest;
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)")
      .run("signal", JSON.stringify(stored), NOW);

    const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "signal",
      local_binding_name: "signal-desktop",
    });
    assert.equal(code.status, 201, JSON.stringify(code.body));
    const enrolled = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: code.body.enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
    const device = enrolled.body;
    const manifestAfterEnroll = (
      getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = 'signal'").get() as { manifest: string }
    ).manifest;
    assert.deepEqual(JSON.parse(manifestAfterEnroll), stored, "enrollment must not replace the registered manifest");

    const records = [
      {
        data: { conversation_id: "conv-1", id: "msg-1", sent_at: "2026-05-18T11:00:00.000Z" },
        emitted_at: NOW,
        record_key: "msg-1",
        stream: "messages",
      },
    ];
    const batch = {
      batch_id: "legacy-signal-1",
      batch_seq: 1,
      body_hash: bodyHash(records),
      connector_id: device.connector_id,
      device_id: device.device_id,
      records,
      source_instance_id: device.source_instance_id,
    };
    const ingest = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      { Authorization: `Bearer ${device.device_token}`, ...PROTOCOL_HEADERS }
    );
    assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
    assert.equal(ingest.body.accepted_record_count, 1);
    assert.equal(ingest.body.connector_instance_id, device.connector_instance_id);

    const row = getDb()
      .prepare("SELECT connector_id, connector_instance_id, stream, record_key FROM records WHERE record_key = 'msg-1'")
      .get();
    assert.deepEqual(row, {
      connector_id: "signal",
      connector_instance_id: device.connector_instance_id,
      record_key: "msg-1",
      stream: "messages",
    });

    // A stream the registered manifest does not declare is refused, so the push is validated against it.
    const bad = [{ ...records[0], record_key: "msg-2", stream: "not_a_signal_stream" }];
    const rejected = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...batch, batch_id: "legacy-signal-2", batch_seq: 2, body_hash: bodyHash(bad), records: bad },
      { Authorization: `Bearer ${device.device_token}`, ...PROTOCOL_HEADERS }
    );
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "invalid_request");
    assert.equal(rejected.body.error.message, "records[0].stream is not declared by the connector manifest");
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS n FROM records WHERE record_key = 'msg-2'").get()?.n,
      0
    );
  } finally {
    await closeServer(server);
  }
});
