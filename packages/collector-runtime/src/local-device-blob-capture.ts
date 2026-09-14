// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { LocalDeviceBlobSpool, LocalDeviceBlobSpoolContent } from "./local-device-blob-spool.ts";
import { buildLocalDeviceOutboxId, type LocalDeviceOutbox } from "./local-device-outbox.ts";

/**
 * Durable payload of a `blob_upload` outbox row.
 *
 * It names the spooled body by digest rather than carrying it: `payload_json`
 * is TEXT and must stay small enough that the outbox's existing prune,
 * compact, and dead-letter-summary machinery keeps working on a multi-GB
 * capture. The bytes live in the spool; this is the delivery instruction.
 */
export interface BlobUploadPayload {
  connectorId: string;
  connectorInstanceId: string | null;
  /** Optional JSON pointer to the field the blob backs, for server binding. */
  jsonPath?: string;
  mimeType: string;
  recordKey: string;
  /** sha256 of the spooled body, computed during spooling. */
  sha256: string;
  sizeBytes: number;
  sourceInstanceId: string;
  stream: string;
}

export interface CaptureBlobArtifactInput {
  connectorId: string;
  connectorInstanceId?: string | null;
  content: LocalDeviceBlobSpoolContent;
  jsonPath?: string;
  mimeType: string;
  outbox: LocalDeviceOutbox;
  recordKey: string;
  sourceInstanceId: string;
  spool: LocalDeviceBlobSpool;
  stream: string;
}

export interface CaptureBlobArtifactResult {
  /** Outbox row id of the queued upload. */
  outboxId: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Capture an artifact's complete bytes durably, then queue its upload.
 *
 * This is the one function a connector calls to honour "no silent loss". It
 * returns only after the bytes are BOTH committed to the local spool AND
 * admitted to the durable outbox; until then it throws. A caller may therefore
 * treat a successful return — and only a successful return — as the artifact
 * being durably captured, with delivery now the outbox's responsibility.
 *
 * **Ordering is the whole design.** Spool first, enqueue second:
 *
 *  - Crash between the two leaves an orphan spool body and no queue row. The
 *    bytes are safe but undelivered; the connector re-reads the same source on
 *    its next run, re-spools to the SAME digest (content addressing makes that
 *    a no-op), and enqueues the same deterministic outbox id. Nothing is lost
 *    and nothing is duplicated.
 *  - The reverse order would admit a queue row pointing at bytes that do not
 *    exist, which is exactly the "acknowledged but absent" state the design
 *    forbids.
 *
 * The outbox id is derived from the content digest and the record coordinates,
 * so re-admission after an interrupted run is idempotent: `enqueue` returns
 * the existing row rather than creating a second upload of identical bytes.
 */
export async function captureBlobArtifact(input: CaptureBlobArtifactInput): Promise<CaptureBlobArtifactResult> {
  // 1. Bytes to durable local disk, hashed on the way in. No network.
  const entry = await input.spool.put(input.content);

  const payload: BlobUploadPayload = {
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId ?? null,
    mimeType: input.mimeType,
    recordKey: input.recordKey,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    sourceInstanceId: input.sourceInstanceId,
    stream: input.stream,
    ...(input.jsonPath ? { jsonPath: input.jsonPath } : {}),
  };

  // 2. Queue admission. Deterministic in the digest + coordinates so a
  //    re-run after an interrupted capture re-admits the same row.
  const outboxId = buildLocalDeviceOutboxId({
    kind: "blob_upload",
    parts: [input.connectorId, input.stream, input.recordKey, input.jsonPath ?? "", entry.sha256],
    sourceInstanceId: input.sourceInstanceId,
  });
  input.outbox.enqueue({
    id: outboxId,
    kind: "blob_upload",
    payload,
    sourceInstanceId: input.sourceInstanceId,
  });

  return { outboxId, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
}

export function isBlobUploadPayload(value: unknown): value is BlobUploadPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.connectorId === "string" &&
    typeof payload.mimeType === "string" &&
    typeof payload.recordKey === "string" &&
    typeof payload.sha256 === "string" &&
    typeof payload.sizeBytes === "number" &&
    typeof payload.sourceInstanceId === "string" &&
    typeof payload.stream === "string"
  );
}
