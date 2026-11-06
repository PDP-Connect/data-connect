// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { exec, getOne, writeTransaction } from "../../lib/db.ts";
import { withConnectorInstanceWrite } from "../connector-instance-write-coordinator.ts";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "../postgres-storage.ts";
import { referenceQueries } from "../queries/index.ts";
import { assertCurrentStorageGeneration, currentStorageGeneration } from "../storage-generation.ts";
import { canonicalBindingJson } from "./binding-json.ts";
import {
  assertPostgresRunUploadWithinTransaction,
  assertSqliteRunUploadWithinTransaction,
  copyRunUploadAuthority,
  type RunUploadAuthority,
  type RunUploadTarget,
} from "./run-upload-permission-store.ts";

const INVALID_POINTER_ESCAPE = /~(?![01])/;

interface StageRow {
  blob_id: string;
  data: Buffer | Uint8Array;
  mime_type: string;
  sha256: string;
  size_bytes: number | string;
}

interface StageAssociation {
  connectionId: string;
  connectorId: string;
  generation: number;
  issuerEpoch: string;
  jsonPath: string;
  ownerId: string;
  recordKey: string;
  runId: string;
  stream: string;
}

export interface RunUploadStageResult {
  readonly blob_id: string;
  readonly mime_type: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export class RunUploadStageLimitError extends Error {
  readonly code = "run_upload_stage_limit";
  readonly statusCode = 429;
  constructor() {
    super("Run upload staging capacity exceeded");
  }
}

export class RunUploadStageConflictError extends Error {
  readonly code = "run_upload_stage_conflict";
  readonly statusCode = 409;
  constructor() {
    super("Run upload staging association already has different content");
  }
}

export function createRunUploadStagingStore(input: { readonly globalMaxBytes: number }) {
  const { globalMaxBytes } = input;
  if (!Number.isSafeInteger(globalMaxBytes) || globalMaxBytes <= 0) {
    throw new TypeError("globalMaxBytes must be a positive safe integer");
  }
  const pg = isPostgresStorageBackend();
  const storageGeneration = currentStorageGeneration();

  return {
    async stage(request: {
      readonly authority: RunUploadAuthority;
      readonly target: RunUploadTarget;
      readonly mimeType: string;
      readonly data: Uint8Array;
    }): Promise<RunUploadStageResult> {
      const generation = storageGeneration;
      assertCurrentStorageGeneration(generation);
      const { authority: requestAuthority, data: requestData, mimeType, target: requestTarget } = request;
      const authority = copyRunUploadAuthority(requestAuthority);
      const target = { ...requestTarget };
      const data = Buffer.from(requestData);
      const { grant } = authority;
      const { staging } = grant;
      if (!(staging && Number.isSafeInteger(staging.maxBytes)) || staging.maxBytes <= 0 || !mimeType.trim()) {
        throw new RunUploadStageConflictError();
      }
      const stream = staging.selection.streams.find((item) => item.name === target.stream);
      const segments = decodePointer(target.jsonPath);
      const firstField = target.jsonPath === "@record" ? "blob_ref" : segments?.[0];
      if (
        !(stream && firstField) ||
        (stream.fields !== null && !stream.fields.includes(firstField) && !stream.requiredFields.includes(firstField))
      ) {
        throw new RunUploadStageConflictError();
      }
      const association = {
        connectionId: grant.connectionId,
        connectorId: grant.connectorId,
        generation: grant.generation,
        issuerEpoch: grant.issuerEpoch,
        jsonPath: target.jsonPath,
        ownerId: grant.ownerId,
        recordKey: target.recordKey,
        runId: grant.runId,
        stream: target.stream,
      };
      const associationJson = canonicalBindingJson(association);
      const stageId = createHash("sha256").update(associationJson, "utf8").digest("hex");
      const sha256 = createHash("sha256").update(data).digest("hex");
      const blobId = `blob_sha256_${sha256}`;
      const chargeBytes =
        data.byteLength + Buffer.byteLength(canonicalBindingJson({ ...association, mimeType }), "utf8");
      const result = {
        blob_id: blobId,
        mime_type: mimeType,
        sha256,
        size_bytes: data.byteLength,
      };

      return await withConnectorInstanceWrite(grant.connectionId, () =>
        pg
          ? withPostgresTransaction(
              async (client) => {
                await client.query("SELECT pg_advisory_xact_lock(7026418901321041)");
                assertCurrentStorageGeneration(generation);
                await assertPostgresRunUploadWithinTransaction(client, authority, target, "stage");
                return stagePostgres(
                  client,
                  association,
                  stageId,
                  blobId,
                  mimeType,
                  sha256,
                  data,
                  chargeBytes,
                  result,
                  staging.maxBytes,
                  globalMaxBytes,
                  generation
                );
              },
              { lockConnectorInstanceId: grant.connectionId }
            )
          : Promise.resolve(
              writeTransaction(() => {
                assertCurrentStorageGeneration(generation);
                if (!(getDb() as unknown as { inTransaction: boolean }).inTransaction) {
                  throw new Error("staging requires transaction");
                }
                assertSqliteRunUploadWithinTransaction(authority, target, "stage");
                return stageSqlite(
                  association,
                  stageId,
                  blobId,
                  mimeType,
                  sha256,
                  data,
                  chargeBytes,
                  result,
                  staging.maxBytes,
                  globalMaxBytes
                );
              })
            )
      );
    },
  };
}

function decodePointer(value: string): string[] | null {
  if (!value.startsWith("/") || value === "/") {
    return null;
  }
  try {
    return value
      .slice(1)
      .split("/")
      .map((part) => {
        if (INVALID_POINTER_ESCAPE.test(part)) {
          throw new Error("invalid pointer");
        }
        return part.replace(/~1/g, "/").replace(/~0/g, "~");
      });
  } catch {
    return null;
  }
}

function sameRetry(row: StageRow | undefined, blobId: string, mimeType: string, sha256: string, data: Buffer): boolean {
  return (
    !!row &&
    row.blob_id === blobId &&
    row.mime_type === mimeType &&
    row.sha256 === sha256 &&
    Number(row.size_bytes) === data.byteLength &&
    Buffer.from(row.data).equals(data)
  );
}

function stageSqlite(
  a: StageAssociation,
  stageId: string,
  blobId: string,
  mimeType: string,
  sha256: string,
  data: Buffer,
  charge: number,
  result: RunUploadStageResult,
  runMax: number,
  globalMax: number
): RunUploadStageResult {
  const key = [a.connectionId, a.runId, a.issuerEpoch, a.generation, a.stream, a.recordKey, a.jsonPath];
  const existing = getOne<StageRow>(referenceQueries.runUploadStageGet, key);
  if (existing) {
    if (!sameRetry(existing, blobId, mimeType, sha256, data)) {
      throw new RunUploadStageConflictError();
    }
    return result;
  }
  const run = getOne<{ charge_bytes: number }>(referenceQueries.runUploadStageSumRun, key.slice(0, 4));
  const global = getOne<{ charge_bytes: number }>(referenceQueries.runUploadStageSumGlobal, []);
  if (Number(run?.charge_bytes) + charge > runMax || Number(global?.charge_bytes) + charge > globalMax) {
    throw new RunUploadStageLimitError();
  }
  exec(referenceQueries.runUploadStageInsert, [
    stageId,
    blobId,
    a.ownerId,
    a.connectorId,
    a.connectionId,
    a.runId,
    a.issuerEpoch,
    a.generation,
    a.stream,
    a.recordKey,
    a.jsonPath,
    mimeType,
    sha256,
    data.byteLength,
    charge,
    data,
  ]);
  return result;
}

async function stagePostgres(
  client: PoolClient,
  a: StageAssociation,
  stageId: string,
  blobId: string,
  mimeType: string,
  sha256: string,
  data: Buffer,
  charge: number,
  result: RunUploadStageResult,
  runMax: number,
  globalMax: number,
  generation: number
): Promise<RunUploadStageResult> {
  const key = [a.connectionId, a.runId, a.issuerEpoch, a.generation, a.stream, a.recordKey, a.jsonPath];
  const {
    rows: [existing],
  } = await client.query<StageRow>(
    "SELECT blob_id, data, mime_type, sha256, size_bytes FROM connector_run_upload_stages WHERE connection_id=$1 AND run_id=$2 AND issuer_epoch=$3 AND generation=$4 AND stream=$5 AND record_key=$6 AND json_path=$7",
    key
  );
  if (existing) {
    if (!sameRetry(existing, blobId, mimeType, sha256, data)) {
      throw new RunUploadStageConflictError();
    }
    return result;
  }
  const {
    rows: [run],
  } = await client.query<{ charge_bytes: string | number }>(
    "SELECT COALESCE(SUM(charge_bytes), 0) AS charge_bytes FROM connector_run_upload_stages WHERE connection_id=$1 AND run_id=$2 AND issuer_epoch=$3 AND generation=$4",
    key.slice(0, 4)
  );
  const {
    rows: [global],
  } = await client.query<{ charge_bytes: string | number }>(
    "SELECT COALESCE(SUM(charge_bytes), 0) AS charge_bytes FROM connector_run_upload_stages"
  );
  if (Number(run?.charge_bytes) + charge > runMax || Number(global?.charge_bytes) + charge > globalMax) {
    throw new RunUploadStageLimitError();
  }
  assertCurrentStorageGeneration(generation);
  await client.query(
    "INSERT INTO connector_run_upload_stages (stage_id, blob_id, owner_id, connector_id, connection_id, run_id, issuer_epoch, generation, stream, record_key, json_path, mime_type, sha256, size_bytes, charge_bytes, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    [
      stageId,
      blobId,
      a.ownerId,
      a.connectorId,
      a.connectionId,
      a.runId,
      a.issuerEpoch,
      a.generation,
      a.stream,
      a.recordKey,
      a.jsonPath,
      mimeType,
      sha256,
      data.byteLength,
      charge,
      data,
    ]
  );
  return result;
}
