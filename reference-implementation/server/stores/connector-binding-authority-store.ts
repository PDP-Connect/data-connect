// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import type { BindingAuthorityRecord } from "../../runtime/binding-authority.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "../postgres-storage.ts";
import { BindingJsonError, canonicalBindingJson as canonicalJson } from "./binding-json.ts";

const RECORD_VERSION = 1;
export const BINDING_AUTHORITY_MAX_BYTES = 1024 * 1024;
const LIFECYCLES = new Set(["granted", "unsupported", "denied", "unavailable", "revoked", "optional_not_granted"]);
const COVERAGES = new Set(["enforced", "recorded", "not_observable"]);

type ErrorCode =
  | "record_invalid"
  | "record_oversize"
  | "record_conflict"
  | "namespace_denied"
  | "version_unsupported"
  | "storage_error";

/** Messages never include rejected payloads, database details or resource identities. */
export class BindingAuthorityStoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, options?: ErrorOptions) {
    super(`Binding authority store: ${code}`, options);
    this.name = "BindingAuthorityStoreError";
    this.code = code;
  }
}

export interface BindingAuthorityKey {
  readonly connectionId: string;
  readonly ownerId: string;
  readonly runId: string;
}

export interface BindingAuthorityPut extends BindingAuthorityKey {
  readonly policyIdentity: string;
  readonly record: BindingAuthorityRecord;
}

export interface StoredBindingAuthority extends BindingAuthorityPut {
  readonly recordedAt: string;
  readonly recordVersion: 1;
}

/**
 * Trusted runtime callers only. Persists an initial before-egress snapshot, not
 * a terminal observation or an approval. Does not authenticate humans, verify
 * fact truth, grant resources, recompute policy or mark anything enforced.
 * Future adapters must sanitize non-secret resource identities BEFORE building
 * the snapshot: no credentials, copied resources, tokens or capability URLs.
 * No retention policy exists; only connection deletion cascades these records.
 */
export interface ConnectorBindingAuthorityStore {
  get: (key: BindingAuthorityKey) => Promise<StoredBindingAuthority | null>;
  put: (input: BindingAuthorityPut) => Promise<void>;
}

export interface BindingAuthorityRow {
  connection_id: string;
  owner_id: string;
  payload_json: string;
  policy_identity: string;
  record_version: number;
  recorded_at: string;
  run_id: string;
}

function invalid(): never {
  throw new BindingAuthorityStoreError("record_invalid");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function validateKey(key: BindingAuthorityKey): void {
  if (!(identity(key.ownerId) && identity(key.connectionId) && identity(key.runId))) {
    invalid();
  }
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function optional(value: Record<string, unknown>, key: string, accepts: (entry: unknown) => boolean): boolean {
  return !Object.hasOwn(value, key) || accepts(value[key]);
}

function optionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => optional(value, key, (entry) => typeof entry === "string"));
}

function validAuthorization(value: unknown): boolean {
  return (
    object(value) &&
    ["accessIdentity", "accessRevision", "channel", "connectionId", "instanceKey", "ownerId", "policyIdentity"].every(
      (key) => identity(value[key])
    ) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.revoked === "boolean"
  );
}

function validChannel(value: unknown): boolean {
  return (
    object(value) &&
    identity(value.name) &&
    typeof value.coverage === "string" &&
    COVERAGES.has(value.coverage) &&
    typeof value.resolutionPresent === "boolean" &&
    typeof value.weakerCoverageAuthorized === "boolean" &&
    optional(value, "observedAttempts", strings) &&
    optional(value, "authorization", validAuthorization)
  );
}

function validInstance(value: unknown): boolean {
  return (
    object(value) &&
    identity(value.instanceKey) &&
    identity(value.kind) &&
    typeof value.required === "boolean" &&
    (value.requestedReach === "full_kind_reach" || value.requestedReach === "declared_constraints") &&
    typeof value.lifecycle === "string" &&
    LIFECYCLES.has(value.lifecycle) &&
    object(value.requestedDeclaration) &&
    optionalStrings(value, ["handleIdentity", "mechanism", "mechanismVersion"]) &&
    optional(value, "effectiveConstraints", object) &&
    optional(value, "remainingAmbientAccess", strings) &&
    Array.isArray(value.channels) &&
    value.channels.every(validChannel)
  );
}

function validateInput(value: BindingAuthorityPut): void {
  validateKey(value);
  const record: unknown = value.record;
  if (
    !(
      identity(value.policyIdentity) &&
      object(record) &&
      record.ownerId === value.ownerId &&
      record.connectionId === value.connectionId &&
      record.runId === value.runId &&
      record.policyIdentity === value.policyIdentity &&
      Array.isArray(record.instances) &&
      record.instances.every(validInstance)
    )
  ) {
    invalid();
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function encodeBindingAuthority(input: BindingAuthorityPut): string {
  // Copy synchronously before the first await; callers retain no mutable alias.
  const payload = canonicalJson(input.record);
  validateInput({ ...input, record: JSON.parse(payload) as BindingAuthorityRecord });
  return payload;
}

function decode(row: BindingAuthorityRow, key: BindingAuthorityKey): StoredBindingAuthority {
  if (row.record_version !== RECORD_VERSION) {
    throw new BindingAuthorityStoreError("version_unsupported");
  }
  if (
    row.owner_id !== key.ownerId ||
    row.connection_id !== key.connectionId ||
    row.run_id !== key.runId ||
    typeof row.recorded_at !== "string" ||
    !Number.isFinite(Date.parse(row.recorded_at))
  ) {
    invalid();
  }
  let record: BindingAuthorityRecord;
  try {
    if (Buffer.byteLength(row.payload_json) > BINDING_AUTHORITY_MAX_BYTES) {
      invalid();
    }
    record = JSON.parse(row.payload_json) as BindingAuthorityRecord;
  } catch {
    invalid();
  }
  const input = { ...key, policyIdentity: row.policy_identity, record };
  encodeBindingAuthority(input);
  return freezeDeep({ ...input, recordedAt: row.recorded_at, recordVersion: RECORD_VERSION });
}

function sameRecord(row: BindingAuthorityRow, key: BindingAuthorityKey, payload: string): void {
  const current = decode(row, key);
  if (canonicalJson(current.record) !== payload) {
    throw new BindingAuthorityStoreError("record_conflict");
  }
}

/** Shared namespace/replay decisions, applied only under each backend's real transaction lock. */
function namespaceAvailable(actualOwner: string | undefined, key: BindingAuthorityKey, writing: boolean): boolean {
  if (actualOwner === key.ownerId) {
    return true;
  }
  if (writing) {
    throw new BindingAuthorityStoreError("namespace_denied");
  }
  return false;
}

export function replayBindingAuthority(
  row: BindingAuthorityRow | undefined,
  key: BindingAuthorityKey,
  payload: string | undefined
): StoredBindingAuthority | null {
  if (payload === undefined) {
    return row?.owner_id === key.ownerId ? decode(row, key) : null;
  }
  if (row) {
    if (row.owner_id !== key.ownerId) {
      throw new BindingAuthorityStoreError("record_conflict");
    }
    sameRecord(row, key, payload);
  }
  return null;
}

async function boundedErrors<T>(step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof BindingJsonError) {
      throw new BindingAuthorityStoreError(error.code, { cause: error });
    }
    if (error instanceof BindingAuthorityStoreError) {
      throw error;
    }
  }
  throw new BindingAuthorityStoreError("storage_error");
}

export function createConnectorBindingAuthorityStore(): ConnectorBindingAuthorityStore {
  // Fixed SQL with bound values; physical key is one connection + run even if ownership changes.
  const sqlite = (key: BindingAuthorityKey, payload?: string, policyIdentity?: string): StoredBindingAuthority | null =>
    writeTransaction(() => {
      const [owner] = [
        ...iterateDynamicSqlAcknowledged<{ owner_subject_id: string }>(
          "SELECT owner_subject_id FROM connector_instances WHERE connector_instance_id = ?",
          [key.connectionId]
        ),
      ];
      if (!namespaceAvailable(owner?.owner_subject_id, key, payload !== undefined)) {
        return null;
      }
      const [row] = [
        ...iterateDynamicSqlAcknowledged<BindingAuthorityRow>(
          "SELECT * FROM connector_binding_authority_runs WHERE connection_id = ? AND run_id = ?",
          [key.connectionId, key.runId]
        ),
      ];
      if (row || payload === undefined) {
        return replayBindingAuthority(row, key, payload);
      }
      execDynamicSqlAcknowledged(
        "INSERT INTO connector_binding_authority_runs (owner_id, connection_id, run_id, policy_identity, record_version, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          key.ownerId,
          key.connectionId,
          key.runId,
          policyIdentity ?? null,
          RECORD_VERSION,
          new Date().toISOString(),
          payload,
        ]
      );
      return null;
    });
  const postgres = (
    key: BindingAuthorityKey,
    payload?: string,
    policyIdentity?: string
  ): Promise<StoredBindingAuthority | null> =>
    withPostgresTransaction(async (client) => {
      // Row locks serialize puts and block ownership changes/deletion until commit.
      // SHARE on reads gives the namespace check and payload read one linearization point.
      const owner = await client.query<{ owner_subject_id: string }>(
        payload === undefined
          ? "SELECT owner_subject_id FROM connector_instances WHERE connector_instance_id = $1 FOR SHARE"
          : "SELECT owner_subject_id FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
        [key.connectionId]
      );
      if (!namespaceAvailable(owner.rows[0]?.owner_subject_id, key, payload !== undefined)) {
        return null;
      }
      const found = await client.query<BindingAuthorityRow>(
        "SELECT * FROM connector_binding_authority_runs WHERE connection_id = $1 AND run_id = $2",
        [key.connectionId, key.runId]
      );
      const [row] = found.rows;
      if (row || payload === undefined) {
        return replayBindingAuthority(row, key, payload);
      }
      await client.query(
        "INSERT INTO connector_binding_authority_runs (owner_id, connection_id, run_id, policy_identity, record_version, recorded_at, payload_json) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          key.ownerId,
          key.connectionId,
          key.runId,
          policyIdentity ?? null,
          RECORD_VERSION,
          new Date().toISOString(),
          payload,
        ]
      );
      return null;
    });
  const access = isPostgresStorageBackend() ? postgres : sqlite;
  return {
    get: (input) =>
      boundedErrors(() => {
        validateKey(input);
        const key = { connectionId: input.connectionId, ownerId: input.ownerId, runId: input.runId };
        return access(key);
      }),
    put: (input) =>
      boundedErrors(async () => {
        const payload = encodeBindingAuthority(input);
        const key = { connectionId: input.connectionId, ownerId: input.ownerId, runId: input.runId };
        await access(key, payload, input.policyIdentity);
      }),
  };
}
