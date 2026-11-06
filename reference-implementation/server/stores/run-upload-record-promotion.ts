// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { exec, getOne } from "../../lib/db.ts";
import { assertRecordWithinRunUploadSelection } from "../../runtime/run-upload-selection.ts";
import { applyDatasetSummaryBlobDelta } from "../dataset-summary-read-model.ts";
import { referenceQueries } from "../queries/index.ts";
import { applyRetainedSizePromotionPostgres, applyRetainedSizePromotionSqlite } from "../retained-size-read-model.ts";
import {
  postgresStagedRecordGrant,
  type RunUploadGrant,
  RunUploadPermissionError,
  sqliteStagedRecordGrant,
} from "./run-upload-permission-store.ts";

interface Promotion {
  connectionId: string;
  connectorId: string;
  ownerId: string | undefined;
  record: { stream: string; key: unknown; data?: unknown };
  recordKey: string;
  runId: string;
}
interface Stage {
  blob_id: string;
  connection_id: string;
  connector_id: string;
  data: Buffer;
  generation: number | string;
  issuer_epoch: string;
  json_path: string;
  mime_type: string;
  owner_id: string;
  record_key: string;
  run_id: string;
  sha256: string;
  size_bytes: number | string;
  stage_id: string;
  stream: string;
}
const TOP_FIELD_POINTER = /^\/(?:[^~/]|~[01])+$/;
function deny(): never {
  throw new RunUploadPermissionError();
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertSelection(grant: RunUploadGrant, input: Promotion): void {
  if (!(grant.staging && object(input.record.data))) {
    deny();
  }
  try {
    assertRecordWithinRunUploadSelection(grant.staging.selection, { ...input.record, data: input.record.data });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "run_upload_denied" });
  }
}
function validate(grant: RunUploadGrant, input: Promotion, stage: Stage): void {
  const { record } = input;
  const selection = grant.staging?.selection;
  if (!selection || grant.connectorId !== input.connectorId || !object(record.data)) {
    deny();
  }
  assertSelection(grant, input);
  if (
    stage.owner_id !== grant.ownerId ||
    stage.connector_id !== grant.connectorId ||
    stage.connection_id !== grant.connectionId ||
    stage.run_id !== grant.runId ||
    stage.issuer_epoch !== grant.issuerEpoch ||
    Number(stage.generation) !== grant.generation ||
    stage.stream !== record.stream ||
    stage.record_key !== input.recordKey ||
    !grant.associations.some(
      (a) =>
        a.stream === stage.stream &&
        (a.paths.includes(stage.json_path) || (a.allJsonPointers && stage.json_path.startsWith("/"))) &&
        (a.recordKeys === "any" || a.recordKeys.includes(stage.record_key))
    )
  ) {
    deny();
  }
  const hash = createHash("sha256").update(stage.data).digest("hex");
  if (
    stage.sha256 !== hash ||
    stage.blob_id !== `blob_sha256_${hash}` ||
    Number(stage.size_bytes) !== stage.data.byteLength
  ) {
    deny();
  }
  if (stage.json_path === "@record") {
    const ref = record.data.blob_ref;
    if (
      !object(ref) ||
      ref.blob_id !== stage.blob_id ||
      (Object.hasOwn(ref, "sha256") && ref.sha256 !== hash) ||
      (Object.hasOwn(ref, "size_bytes") && ref.size_bytes !== Number(stage.size_bytes)) ||
      (Object.hasOwn(record.data, "content_sha256") && record.data.content_sha256 !== hash) ||
      (Object.hasOwn(record.data, "size_bytes") && record.data.size_bytes !== Number(stage.size_bytes))
    ) {
      deny();
    }
    return;
  }
  // Implicit producer association: sanitized body text may be null or truncated.
  // Only a present top-level field is supported here; do not guess nested paths.
  if (!TOP_FIELD_POINTER.test(stage.json_path)) {
    deny();
  }
  const field = stage.json_path.slice(1).replaceAll("~1", "/").replaceAll("~0", "~");
  const stream = selection.streams.find((s) => s.name === record.stream);
  if (
    !Object.hasOwn(record.data, field) ||
    (stream?.fields && ![...stream.fields, ...stream.requiredFields].includes(field))
  ) {
    deny();
  }
}
function delta(input: Promotion, stage: Stage) {
  return {
    blobBytesDelta: Number(stage.size_bytes),
    blobCountDelta: 1,
    connectorId: input.connectorId,
    connectorInstanceId: input.connectionId,
    stream: input.record.stream,
  };
}
/** Caller holds instance fence and SQLite write transaction, including accepted noops. */
export function promoteSqliteRunUploadRecord(input: Promotion): boolean {
  const grant = sqliteStagedRecordGrant(input.connectionId, input.runId, input.ownerId);
  if (!grant) {
    if (
      getOne(referenceQueries.runUploadPromotionNext, [input.connectionId, input.record.stream, input.recordKey, ""])
    ) {
      deny();
    }
    return false;
  }
  if (!(grant.staging && object(input.record.data))) {
    deny();
  }
  assertSelection(grant, input);
  let cursor = "";
  for (;;) {
    const stage = getOne<Stage>(referenceQueries.runUploadPromotionNext, [
      input.connectionId,
      input.record.stream,
      input.recordKey,
      cursor,
    ]);
    if (!stage) {
      return true;
    }
    validate(grant, input, stage);
    const inserted = exec(referenceQueries.blobsInsertBlob, [
      stage.blob_id,
      input.connectorId,
      input.connectionId,
      stage.stream,
      stage.record_key,
      stage.mime_type,
      Number(stage.size_bytes),
      stage.sha256,
      stage.data,
    ]);
    const stored = getOne<{ sha256: string; size_bytes: number }>(referenceQueries.blobsGetStoredById, [stage.blob_id]);
    if (!stored || stored.sha256 !== stage.sha256 || Number(stored.size_bytes) !== Number(stage.size_bytes)) {
      deny();
    }
    const binding = exec(referenceQueries.runUploadInsertBinding, [
      stage.blob_id,
      input.connectorId,
      input.connectionId,
      stage.stream,
      stage.record_key,
      stage.json_path,
    ]);
    if (inserted.changes) {
      applyDatasetSummaryBlobDelta({ blobBytesDelta: Number(stage.size_bytes) });
    }
    if (binding.changes) {
      applyRetainedSizePromotionSqlite(delta(input, stage));
    }
    exec(referenceQueries.runUploadPromotionConsume, [stage.stage_id]);
    cursor = stage.stage_id;
  }
}
/** Same client as record acceptance; never opens a pool transaction. */
export async function promotePostgresRunUploadRecord(client: PoolClient, input: Promotion): Promise<boolean> {
  const grant = await postgresStagedRecordGrant(client, input.connectionId, input.runId, input.ownerId);
  if (!grant) {
    const {
      rows: [orphan],
    } = await client.query(
      "SELECT 1 FROM connector_run_upload_stages WHERE connection_id=$1 AND stream=$2 AND record_key=$3 LIMIT 1",
      [input.connectionId, input.record.stream, input.recordKey]
    );
    if (orphan) {
      deny();
    }
    return false;
  }
  if (!(grant.staging && object(input.record.data))) {
    deny();
  }
  assertSelection(grant, input);
  const { rows } = await client.query<Stage>(
    "SELECT * FROM connector_run_upload_stages WHERE connection_id=$1 AND stream=$2 AND record_key=$3 ORDER BY stage_id FOR UPDATE",
    [input.connectionId, input.record.stream, input.recordKey]
  );
  await rows.reduce(async (previous, stage) => {
    await previous;
    validate(grant, input, stage);
    await client.query(
      "INSERT INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
      [
        stage.blob_id,
        input.connectorId,
        input.connectionId,
        stage.stream,
        stage.record_key,
        stage.mime_type,
        Number(stage.size_bytes),
        stage.sha256,
        stage.data,
      ]
    );
    const {
      rows: [stored],
    } = await client.query("SELECT sha256, size_bytes FROM blobs WHERE blob_id=$1 FOR KEY SHARE", [stage.blob_id]);
    if (!stored || stored.sha256 !== stage.sha256 || Number(stored.size_bytes) !== Number(stage.size_bytes)) {
      deny();
    }
    const binding = await client.query(
      "INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING blob_id",
      [stage.blob_id, input.connectorId, input.connectionId, stage.stream, stage.record_key, stage.json_path]
    );
    if (binding.rowCount) {
      await applyRetainedSizePromotionPostgres(client, delta(input, stage));
    }
    await client.query("DELETE FROM connector_run_upload_stages WHERE stage_id=$1", [stage.stage_id]);
  }, Promise.resolve());
  return true;
}
