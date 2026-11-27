// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { hashCanonicalJson } from "./local-device-envelope.ts";
import { legacyUnderscoreSpelling, migrateLegacyConnectorIdSpelling } from "./local-device-legacy-connector-id.ts";
import { LocalDeviceOutbox, type LocalDeviceOutboxKind } from "./local-device-outbox.ts";

const LEGACY = "claude_code";
const KEY = "claude-code";

function envelope(connectorId: string, batchId: string) {
  const body = {
    connector_id: connectorId,
    data: { id: "m-1" },
    emitted_at: "2026-05-19T12:00:00.000Z",
    record_key: "m-1",
    stream: "messages",
  };
  return {
    batch_id: batchId,
    batch_seq: 3,
    body_hash: hashCanonicalJson(body),
    device_id: "device-1",
    source_instance_id: "src-1",
    ...body,
  };
}

/** One payload per kind, as a collector that spelled the connector `connectorId` queued it. */
function payloadFor(kind: LocalDeviceOutboxKind, connectorId: string, sourceInstanceId: string, tag: string): unknown {
  switch (kind) {
    case "record_batch":
      return {
        batchId: `local-batch:${tag}`,
        batchSeq: 3,
        connectorId,
        deviceId: "device-1",
        records: [{ ...envelope(connectorId, `local-batch:${tag}`), source_instance_id: sourceInstanceId }],
        sourceInstanceId,
      };
    case "checkpoint":
      return { connectorId, sourceInstanceId, state: { messages: { cursor: tag } } };
    case "terminal_run_commit":
      return {
        collection_boundary: "unscoped",
        commit_id: `terminal-commit:${tag}`,
        connector_id: connectorId,
        connector_instance_id: "cin_1",
        device_id: "device-1",
        run_id: `run-${tag}`,
        source_instance_id: sourceInstanceId,
        state_delta: {},
        terminal_facts: [{ coverage_statuses: ["complete"], stream: "messages" }],
        version: 1,
      };
    case "gap":
      return {
        connectorId,
        firstSeenAt: "2026-05-19T12:00:00.000Z",
        nextAttemptBackoffMs: 1000,
        reason: "policy_budget",
        retryable: true,
        sourceInstanceId,
      };
    case "blob_upload":
      return {
        connectorId,
        connectorInstanceId: "cin_1",
        mimeType: "text/plain",
        recordKey: tag,
        sha256: "a".repeat(64),
        sizeBytes: 3,
        sourceInstanceId,
        stream: "attachments",
      };
    default:
      throw new Error(`unhandled kind ${kind satisfies never}`);
  }
}

const KINDS: readonly LocalDeviceOutboxKind[] = [
  "record_batch",
  "checkpoint",
  "terminal_run_commit",
  "gap",
  "blob_upload",
];

type Seeded = Record<
  string,
  { kind: LocalDeviceOutboxKind; sourceInstanceId: string; state: "dead_letter" | "ready" | "succeeded" | "leased" }
>;

/** Seed every kind in every state for src-1, plus src-1-unrelated rows and a src-2 row that must stay as written. */
function seed(outbox: LocalDeviceOutbox): Seeded {
  const seeded: Seeded = {};
  const add = (
    id: string,
    kind: LocalDeviceOutboxKind,
    sourceInstanceId: string,
    state: Seeded[string]["state"],
    connectorId = LEGACY
  ) => {
    outbox.enqueue({ id, kind, payload: payloadFor(kind, connectorId, sourceInstanceId, id), sourceInstanceId });
    seeded[id] = { kind, sourceInstanceId, state };
    if (state === "ready") {
      return;
    }
    // Claimed straight after enqueue, so it is the oldest ready row of its source.
    const [claim] = outbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId });
    assert.ok(claim);
    assert.equal(claim.id, id);
    if (state === "dead_letter") {
      outbox.deadLetter({ error: "400 invalid_request", holder: "seed", id, leaseEpoch: claim.lease_epoch });
    }
    if (state === "succeeded") {
      outbox.acknowledge({ holder: "seed", id, leaseEpoch: claim.lease_epoch });
    }
  };
  // Claimed states first, while no ready row of src-1 exists to be claimed instead.
  for (const kind of KINDS) {
    add(`dead-${kind}`, kind, "src-1", "dead_letter");
    add(`done-${kind}`, kind, "src-1", "succeeded");
  }
  add("leased-record", "record_batch", "src-1", "leased");
  for (const kind of KINDS) {
    add(`ready-${kind}`, kind, "src-1", "ready");
    add(`other-${kind}`, kind, "src-2", "ready");
  }
  // Already on the manifest key: must be left alone.
  add("current-record", "record_batch", "src-1", "ready", KEY);
  return seeded;
}

function snapshot(outbox: LocalDeviceOutbox) {
  return new Map(
    outbox
      .list()
      .map((item) => [
        item.id,
        { body_hash: item.body_hash, payload: JSON.stringify(item.payload), status: item.status },
      ])
  );
}

test("legacyUnderscoreSpelling derives the old spelling from the key, or none when the key has no hyphen", () => {
  assert.equal(legacyUnderscoreSpelling("claude-code"), "claude_code");
  assert.equal(legacyUnderscoreSpelling("google-takeout"), "google_takeout");
  assert.equal(legacyUnderscoreSpelling("gmail"), null);
});

test("migrateLegacyConnectorIdSpelling rewrites every sendable row to the manifest key and leaves history alone", () => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  try {
    const seeded = seed(outbox);
    const before = snapshot(outbox);

    const rewritten = migrateLegacyConnectorIdSpelling(outbox, { connectorId: KEY, sourceInstanceId: "src-1" });

    const after = snapshot(outbox);
    const sendable = Object.entries(seeded).filter(
      ([id, row]) =>
        row.sourceInstanceId === "src-1" && id !== "current-record" && (row.state !== "succeeded" || row.kind === "gap")
    );
    assert.equal(rewritten, sendable.length);
    for (const [id] of sendable) {
      const item = outbox.get(id);
      assert.ok(item);
      const payload = item.payload as Record<string, unknown>;
      assert.equal(payload.connectorId ?? payload.connector_id, KEY, id);
      assert.doesNotMatch(JSON.stringify(item.payload), /claude_code/, id);
      assert.equal(item.body_hash, hashCanonicalJson(item.payload), `${id} body_hash follows the payload`);
      assert.equal(item.status, before.get(id)?.status, `${id} keeps its status`);
    }
    for (const [id, row] of Object.entries(seeded)) {
      if (!sendable.some(([sendableId]) => sendableId === id)) {
        assert.deepEqual(after.get(id), before.get(id), `${id} (${row.sourceInstanceId}, ${row.state}) is untouched`);
      }
    }

    assert.deepEqual(snapshot(outbox), after);
    assert.equal(migrateLegacyConnectorIdSpelling(outbox, { connectorId: KEY, sourceInstanceId: "src-1" }), 0);
    assert.deepEqual(snapshot(outbox), after, "a second open changes nothing");
  } finally {
    outbox.close();
  }
});

test("a rewritten record_batch is internally consistent: envelope ids, body hashes and a fresh batch identity", () => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  try {
    seed(outbox);
    const original = outbox.get("dead-record_batch")?.payload as { batchId: string };
    migrateLegacyConnectorIdSpelling(outbox, { connectorId: KEY, sourceInstanceId: "src-1" });
    const payload = outbox.get("dead-record_batch")?.payload as {
      batchId: string;
      records: ReturnType<typeof envelope>[];
    };
    assert.notEqual(payload.batchId, original.batchId, "the server may already hold a reservation under the old id");
    assert.match(payload.batchId, /^local-batch:[0-9a-f]{64}$/);
    for (const record of payload.records) {
      assert.equal(record.batch_id, payload.batchId);
      assert.equal(record.connector_id, KEY);
      assert.equal(
        record.body_hash,
        hashCanonicalJson({
          connector_id: KEY,
          data: record.data,
          emitted_at: record.emitted_at,
          record_key: record.record_key,
          stream: record.stream,
        })
      );
    }
    const history = outbox.get("done-record_batch");
    assert.ok(history);
    assert.equal(
      (history.payload as { batchId: string }).batchId,
      "local-batch:done-record_batch",
      "succeeded batches keep their identity"
    );
  } finally {
    outbox.close();
  }
});

test("a connector key without a hyphen has no legacy spelling and nothing is rewritten", () => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  try {
    seed(outbox);
    const before = snapshot(outbox);
    assert.equal(migrateLegacyConnectorIdSpelling(outbox, { connectorId: "gmail", sourceInstanceId: "src-1" }), 0);
    assert.deepEqual(snapshot(outbox), before);
  } finally {
    outbox.close();
  }
});
