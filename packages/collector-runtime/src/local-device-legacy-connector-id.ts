// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { hashCanonicalJson } from "./local-device-envelope.ts";
import type { LocalDeviceOutbox, LocalDeviceOutboxKind } from "./local-device-outbox.ts";

/**
 * Queued work written before connector ids became manifest keys.
 *
 * An older collector named `claude-code` as `claude_code` and wrote that
 * spelling into every outbox payload it queued. The drain sends the stored
 * value, and a server that only knows the manifest key rejects the old
 * spelling with `400 connector_id does not match source_instance_id`, so a
 * backlog queued before an upgrade would be resent and rejected forever.
 *
 * This is the one place that rewrites stored payloads. The same legacy
 * spelling names the queue file that `migrateUnderscoreSpelledQueue` in
 * `@pdpp/local-collector` renames once; both derive it as
 * `replaceAll("-", "_")`, never from a list.
 */

/** The underscore spelling an older collector used, or null when the key has no hyphen. */
export function legacyUnderscoreSpelling(connectorKey: string): string | null {
  const legacy = connectorKey.replaceAll("-", "_");
  return legacy === connectorKey ? null : legacy;
}

/**
 * Rewrite the connector id in this source instance's stored outbox payloads
 * from the underscore spelling to the manifest key, in one transaction.
 *
 * Covers every row that can still be sent: ready, leased and dead-letter rows
 * of every kind (dead letters so `recover --apply` can requeue them and have
 * them accepted), and succeeded `gap` rows, which a later run replays to the
 * server as gap recoveries. Other succeeded rows are history and stay as
 * written. Idempotent: once rewritten, no row carries the legacy spelling.
 * Returns the number of rows rewritten.
 */
export function migrateLegacyConnectorIdSpelling(
  outbox: LocalDeviceOutbox,
  input: { connectorId: string; sourceInstanceId: string }
): number {
  const legacy = legacyUnderscoreSpelling(input.connectorId);
  if (legacy === null) {
    return 0;
  }
  return outbox.rewriteStoredPayloads({
    alsoSucceededKinds: ["gap"],
    connectorId: legacy,
    rewrite: ({ kind, payload }) => withManifestKeyConnectorId(kind, payload, input.connectorId),
    sourceInstanceId: input.sourceInstanceId,
  });
}

/**
 * The payload as a collector that spells the connector `connectorKey` would
 * have queued it. Field names differ by kind: `connector_id` on
 * `terminal_run_commit`, `connectorId` on the rest.
 *
 * `record_batch` also carries the id inside every record envelope, and the
 * drain computes `body_hash` over those stored envelopes, which the server
 * rebuilds from the request's own connector id; leaving an envelope on the old
 * spelling would fail that hash check. Each envelope's `body_hash` covers its
 * `connector_id`, so it is recomputed, and the batch gets a new identity (see
 * {@link rewriteRecordBatch}).
 */
function withManifestKeyConnectorId(kind: LocalDeviceOutboxKind, payload: unknown, connectorKey: string): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  if (kind === "terminal_run_commit") {
    // `commit_id` stays as queued: it is an opaque idempotency key, and the
    // server's replay check is bound to the run, not to its spelling.
    return { ...payload, connector_id: connectorKey };
  }
  if (kind === "record_batch") {
    return rewriteRecordBatch(payload, connectorKey);
  }
  return { ...payload, connectorId: connectorKey };
}

/**
 * A rewritten batch gets a new `batchId` (and the same value in each envelope).
 *
 * The server keys a delivery by `(device_id, batch_id)` and, for an existing
 * reservation, requires the same `body_hash` and connector. A batch that the
 * server had begun or finished before the upgrade (sent, then the
 * acknowledgement was lost) holds the old body hash; resending the rewritten
 * batch under the old id would be a `409 device_batch_conflict` and, for a
 * partly ingested batch, would strand its unwritten tail. The server never
 * checks that a batch id is a hash of anything, so a new id starts a fresh
 * reservation and re-ingests the same records, which is idempotent per record.
 * The id is derived from the old one and the manifest key, so it is stable.
 */
function rewriteRecordBatch(payload: Record<string, unknown>, connectorKey: string): Record<string, unknown> {
  const { batchId, batchSeq, sourceInstanceId } = payload;
  const nextBatchId =
    typeof batchId === "string" && typeof batchSeq === "number" && typeof sourceInstanceId === "string"
      ? `local-batch:${hashCanonicalJson({
          batch_seq: batchSeq,
          connector_id: connectorKey,
          legacy_batch_id: batchId,
          source_instance_id: sourceInstanceId,
        })}`
      : batchId;
  const records = Array.isArray(payload.records)
    ? payload.records.map((envelope) => rewriteEnvelope(envelope, connectorKey, nextBatchId))
    : payload.records;
  return { ...payload, batchId: nextBatchId, connectorId: connectorKey, records };
}

function rewriteEnvelope(envelope: unknown, connectorKey: string, batchId: unknown): unknown {
  if (!isRecord(envelope)) {
    return envelope;
  }
  const body = {
    connector_id: connectorKey,
    data: envelope.data,
    emitted_at: envelope.emitted_at,
    record_key: envelope.record_key,
    stream: envelope.stream,
  };
  return { ...envelope, ...body, batch_id: batchId, body_hash: hashCanonicalJson(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
