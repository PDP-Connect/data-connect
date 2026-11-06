// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { exec, getOne, iterate, writeTransaction } from "../../lib/db.ts";
import { parseRunUploadSelection, type RunUploadSelection } from "../../runtime/run-upload-selection.ts";
import { withConnectorInstanceControlPlaneWrite } from "../connector-instance-write-coordinator.ts";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import { referenceQueries } from "../queries/index.ts";
import { canonicalBindingJson } from "./binding-json.ts";

const UPLOAD_TOKEN_PATTERN = /^ru_[A-Za-z0-9_-]{43}$/;

/** Trusted admission facts only. No HTTP caller may construct this input. */
export interface RunUploadGrant {
  /** Selected streams permit pre-RECORD keys. Paths are exact, or explicitly all JSON pointers. */
  readonly associations: readonly {
    readonly stream: string;
    readonly paths: readonly string[];
    readonly allJsonPointers: boolean;
    readonly recordKeys: "any" | readonly string[];
  }[];
  readonly connectionId: string;
  readonly connectorId: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly issuerEpoch: string;
  readonly manifestSnapshot: Readonly<Record<string, unknown>>;
  readonly ownerId: string;
  readonly purpose: "blob-upload";
  readonly runId: string;
  readonly selectionIdentity: string;
  readonly sourceSnapshot: Readonly<Record<string, unknown>>;
  /** Present only for the private staging participant; direct publication refuses it. */
  readonly staging?: {
    readonly selection: RunUploadSelection;
    readonly maxBytes: number;
  };
}

/** Route resolves the bearer to trusted grant facts; writer rechecks every fact in its transaction. */
export interface RunUploadAuthority {
  readonly grant: RunUploadGrant;
  readonly token: string;
}
export interface RunUploadTarget {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly jsonPath: string;
  readonly recordKey: string;
  readonly stream: string;
}
interface Row {
  connection_id: string;
  generation: string | number;
  grant_json: string | null;
  issuer_epoch: string;
  revoked: number;
  token_digest: string | null;
}
export class RunUploadPermissionError extends Error {
  readonly code = "run_upload_denied";
  readonly statusCode = 403;
  constructor() {
    super("Run upload permission denied");
  }
}
function deny(): never {
  throw new RunUploadPermissionError();
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function path(value: unknown): value is string {
  return typeof value === "string" && (value === "@record" || value.startsWith("/"));
}
function snapshot(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function copyGrant(input: RunUploadGrant): RunUploadGrant {
  try {
    const grant = JSON.parse(canonicalBindingJson(input)) as RunUploadGrant;
    if (Object.hasOwn(grant, "staging")) {
      const { staging } = grant;
      if (!(staging && snapshot(staging) && Number.isSafeInteger(staging.maxBytes)) || staging.maxBytes <= 0) {
        deny();
      }
      parseRunUploadSelection(staging.selection);
    }
    if (
      grant.purpose !== "blob-upload" ||
      ![
        grant.ownerId,
        grant.connectorId,
        grant.connectionId,
        grant.runId,
        grant.issuerEpoch,
        grant.selectionIdentity,
      ].every(text) ||
      !Number.isSafeInteger(grant.generation) ||
      grant.generation < 0 ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= 0 ||
      !snapshot(grant.manifestSnapshot) ||
      !snapshot(grant.sourceSnapshot) ||
      !Array.isArray(grant.associations) ||
      !grant.associations.every(
        (a) =>
          text(a?.stream) &&
          Array.isArray(a.paths) &&
          a.paths.every(path) &&
          typeof a.allJsonPointers === "boolean" &&
          (a.recordKeys === "any" || (Array.isArray(a.recordKeys) && a.recordKeys.every(text)))
      )
    ) {
      deny();
    }
    return grant;
  } catch {
    return deny();
  }
}
/** Copy before coordinator/pool awaits. Never retain mutable request/admission aliases. */
export function copyRunUploadAuthority(input: RunUploadAuthority): RunUploadAuthority {
  if (!UPLOAD_TOKEN_PATTERN.test(input.token)) {
    deny();
  }
  return { grant: copyGrant(input.grant), token: input.token };
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
function sqliteRow(connectionId: string): Row | undefined {
  return (getOne(referenceQueries.runUploadGet, [connectionId]) as Row | null) ?? undefined;
}
async function postgresRow(client: PoolClient, connectionId: string): Promise<Row | undefined> {
  return (
    await client.query<Row>("SELECT * FROM connector_run_upload_permissions WHERE connection_id = $1", [connectionId])
  ).rows[0];
}
function check(
  row: Row | undefined,
  authority: RunUploadAuthority,
  target: RunUploadTarget,
  owner: unknown,
  connector: unknown,
  status: unknown,
  now: number,
  operation: "publish" | "stage"
): void {
  const grant = copyGrant(authority.grant);
  if (
    row?.revoked !== 0 ||
    !Number.isFinite(now) ||
    now >= grant.expiresAt ||
    row.connection_id !== grant.connectionId ||
    row.issuer_epoch !== grant.issuerEpoch ||
    Number(row.generation) !== grant.generation ||
    row.token_digest !== digest(authority.token) ||
    row.grant_json !== canonicalBindingJson(grant) ||
    (operation === "publish" && grant.staging !== undefined) ||
    (operation === "stage" && grant.staging === undefined) ||
    owner !== grant.ownerId ||
    connector !== grant.connectorId ||
    status === "revoked" ||
    status === "deleted" ||
    target.connectionId !== grant.connectionId ||
    target.connectorId !== grant.connectorId ||
    !text(target.recordKey) ||
    !path(target.jsonPath) ||
    !grant.associations.some(
      (a) =>
        a.stream === target.stream &&
        (a.paths.includes(target.jsonPath) || (a.allJsonPointers && target.jsonPath.startsWith("/"))) &&
        (a.recordKeys === "any" || a.recordKeys.includes(target.recordKey))
    )
  ) {
    deny();
  }
}
/** Synchronous participant: caller MUST hold instance coordinator and SQLite write transaction. */
export function assertSqliteRunUploadWithinTransaction(
  authority: RunUploadAuthority,
  target: RunUploadTarget,
  operation: "publish" | "stage" = "publish"
): void {
  if (!(getDb() as unknown as { inTransaction: boolean }).inTransaction) {
    deny();
  }
  const owner = getOne(referenceQueries.runUploadOwner, [target.connectionId]) as {
    owner_subject_id: string;
    connector_id: string;
    status: string;
  } | null;
  check(
    sqliteRow(target.connectionId),
    authority,
    target,
    owner?.owner_subject_id,
    owner?.connector_id,
    owner?.status,
    Date.now(),
    operation
  );
}
/** Same PoolClient and advisory transaction fence as publication; clock sampled AFTER lock wait. */
export async function assertPostgresRunUploadWithinTransaction(
  client: PoolClient,
  authority: RunUploadAuthority,
  target: RunUploadTarget,
  operation: "publish" | "stage" = "publish"
): Promise<void> {
  const copiedAuthority = copyRunUploadAuthority(authority);
  const copiedTarget = { ...target };
  const row = await postgresRow(client, copiedTarget.connectionId);
  const {
    rows: [owner],
  } = await client.query(
    "SELECT owner_subject_id, connector_id, status FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
    [copiedTarget.connectionId]
  );
  const {
    rows: [time],
  } = await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms");
  check(
    row,
    copiedAuthority,
    copiedTarget,
    owner?.owner_subject_id,
    owner?.connector_id,
    owner?.status,
    Number(time?.ms),
    operation
  );
}

/** Exact current grant revoke; stale cancellation cannot revoke its replacement. No flight row touched. */
export function revokeSqliteRunUploadWithinTransaction(
  scope: Pick<RunUploadGrant, "connectionId" | "issuerEpoch" | "generation" | "runId" | "ownerId">
): void {
  if (!(getDb() as unknown as { inTransaction: boolean }).inTransaction) {
    deny();
  }
  const row = sqliteRow(scope.connectionId);
  if (matches(row, scope)) {
    exec(referenceQueries.runUploadRevoke, [scope.connectionId]);
    exec(referenceQueries.runUploadStageDeleteGrant, [
      scope.ownerId,
      scope.connectionId,
      scope.runId,
      scope.issuerEpoch,
      scope.generation,
    ]);
  }
}
function matches(
  row: Row | undefined,
  scope: Pick<RunUploadGrant, "issuerEpoch" | "generation" | "runId" | "ownerId">
): boolean {
  if (!row?.grant_json) {
    return false;
  }
  try {
    const grant = copyGrant(JSON.parse(row.grant_json));
    return (
      row.issuer_epoch === scope.issuerEpoch &&
      Number(row.generation) === scope.generation &&
      grant.runId === scope.runId &&
      grant.ownerId === scope.ownerId
    );
  } catch {
    return deny();
  }
}
export async function revokePostgresRunUploadWithinTransaction(
  client: PoolClient,
  scope: Pick<RunUploadGrant, "connectionId" | "issuerEpoch" | "generation" | "runId" | "ownerId">
): Promise<void> {
  const copiedScope = { ...scope };
  if (matches(await postgresRow(client, copiedScope.connectionId), copiedScope)) {
    await client.query("UPDATE connector_run_upload_permissions SET revoked = 1 WHERE connection_id = $1", [
      copiedScope.connectionId,
    ]);
    await client.query(
      "DELETE FROM connector_run_upload_stages WHERE owner_id = $1 AND connection_id = $2 AND run_id = $3 AND issuer_epoch = $4 AND generation = $5",
      [
        copiedScope.ownerId,
        copiedScope.connectionId,
        copiedScope.runId,
        copiedScope.issuerEpoch,
        copiedScope.generation,
      ]
    );
  }
}

/** Internal runtime API. Startup rotates every retained connection before allowing admissions.
 * Epoch rotation invalidates all preceding controller incarnations; generation watermark never resets.
 * Future approval withdrawal deliberately has no API here: it is future admission policy, not live revoke.
 */
export function createRunUploadPermissionStore() {
  const pg = isPostgresStorageBackend();
  function fenced<T>(connectionId: string, sqlite: () => T, postgres: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!text(connectionId)) {
      return Promise.reject(new RunUploadPermissionError());
    }
    return withConnectorInstanceControlPlaneWrite(connectionId, () =>
      pg
        ? withPostgresTransaction(postgres, {
            lockConnectorInstanceId: connectionId,
          })
        : Promise.resolve(writeTransaction(sqlite))
    );
  }
  return {
    beginIssuerEpoch(connectionId: string): Promise<{ issuerEpoch: string; nextGeneration: number }> {
      const epoch = randomBytes(32).toString("base64url");
      return fenced(
        connectionId,
        () => {
          exec(referenceQueries.runUploadStageDeleteConnection, [connectionId]);
          exec(referenceQueries.runUploadEpoch, [connectionId, epoch]);
          return {
            issuerEpoch: epoch,
            nextGeneration: Number(sqliteRow(connectionId)?.generation) + 1,
          };
        },
        async (client) => {
          await client.query("DELETE FROM connector_run_upload_stages WHERE connection_id = $1", [connectionId]);
          await client.query(
            "INSERT INTO connector_run_upload_permissions (connection_id, issuer_epoch, generation, revoked) VALUES ($1, $2, -1, 1) ON CONFLICT(connection_id) DO UPDATE SET issuer_epoch = excluded.issuer_epoch, revoked = 1",
            [connectionId, epoch]
          );
          return {
            issuerEpoch: epoch,
            nextGeneration: Number((await postgresRow(client, connectionId))?.generation) + 1,
          };
        }
      );
    },
    issue(input: RunUploadGrant): Promise<RunUploadAuthority> {
      const grant = copyGrant(input);
      const token = `ru_${randomBytes(32).toString("base64url")}`;
      const payload = canonicalBindingJson(grant);
      function canIssue(row: Row | undefined, owner: unknown, connector: unknown, status: unknown, now: number): void {
        if (
          !row ||
          row.issuer_epoch !== grant.issuerEpoch ||
          !Number.isSafeInteger(Number(row.generation)) ||
          Number(row.generation) >= grant.generation ||
          owner !== grant.ownerId ||
          connector !== grant.connectorId ||
          status === "revoked" ||
          status === "deleted" ||
          !Number.isFinite(now) ||
          now >= grant.expiresAt
        ) {
          deny();
        }
      }
      return fenced(
        grant.connectionId,
        () => {
          const owner = getOne(referenceQueries.runUploadOwner, [grant.connectionId]) as {
            owner_subject_id: string;
            connector_id: string;
            status: string;
          } | null;
          canIssue(
            sqliteRow(grant.connectionId),
            owner?.owner_subject_id,
            owner?.connector_id,
            owner?.status,
            Date.now()
          );
          exec(referenceQueries.runUploadStageDeleteConnection, [grant.connectionId]);
          exec(referenceQueries.runUploadIssue, [grant.generation, digest(token), payload, grant.connectionId]);
          return { grant, token };
        },
        async (client) => {
          const {
            rows: [owner],
          } = await client.query(
            "SELECT owner_subject_id, connector_id, status FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
            [grant.connectionId]
          );
          const {
            rows: [time],
          } = await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms");
          canIssue(
            await postgresRow(client, grant.connectionId),
            owner?.owner_subject_id,
            owner?.connector_id,
            owner?.status,
            Number(time?.ms)
          );
          await client.query("DELETE FROM connector_run_upload_stages WHERE connection_id = $1", [grant.connectionId]);
          await client.query(
            "UPDATE connector_run_upload_permissions SET generation = $1, token_digest = $2, grant_json = $3, revoked = 0 WHERE connection_id = $4",
            [grant.generation, digest(token), payload, grant.connectionId]
          );
          return { grant, token };
        }
      );
    },
    /** Candidate resolution only, NOT publication authorization. Dedicated blob route only. */
    async resolve(token: string): Promise<RunUploadAuthority> {
      if (!UPLOAD_TOKEN_PATTERN.test(token)) {
        deny();
      }
      const row = pg
        ? (
            await postgresQuery<Row>("SELECT * FROM connector_run_upload_permissions WHERE token_digest = $1", [
              digest(token),
            ])
          ).rows[0]
        : (getOne(referenceQueries.runUploadResolve, [digest(token)]) as Row | null);
      if (!row?.grant_json || row.revoked !== 0) {
        deny();
      }
      try {
        const authority = copyRunUploadAuthority({
          grant: JSON.parse(row.grant_json),
          token,
        });
        if (row.issuer_epoch !== authority.grant.issuerEpoch || Number(row.generation) !== authority.grant.generation) {
          deny();
        }
        return authority;
      } catch {
        return deny();
      }
    },
    async retainedConnectionIds(): Promise<string[]> {
      const rows = pg
        ? (
            await postgresQuery<{ connection_id: string }>(
              "SELECT connection_id FROM connector_run_upload_permissions UNION SELECT connection_id FROM connector_run_upload_stages"
            )
          ).rows
        : Array.from(iterate<{ connection_id: string }>(referenceQueries.runUploadRetainedConnections, []));
      return rows.map((row) => row.connection_id);
    },
    revoke(
      input: Pick<RunUploadGrant, "connectionId" | "issuerEpoch" | "generation" | "runId" | "ownerId">
    ): Promise<void> {
      const scope = { ...input };
      return fenced(
        scope.connectionId,
        () => revokeSqliteRunUploadWithinTransaction(scope),
        (client) => revokePostgresRunUploadWithinTransaction(client, scope)
      );
    },
  };
}

/** Owner-authenticated record participant. No upload bearer is synthesized. */
function stagedRecordGrant(
  row: Row | undefined,
  ownerId: string | undefined,
  runId: string,
  connectionId: string,
  owner: unknown,
  connector: unknown,
  status: unknown,
  now: number
): RunUploadGrant | undefined {
  if (!row?.grant_json) {
    return undefined;
  }
  const grant = copyGrant(JSON.parse(row.grant_json));
  if (!grant.staging) {
    return undefined;
  }
  if (grant.runId !== runId) {
    deny();
  }
  if (
    !ownerId ||
    ownerId !== grant.ownerId ||
    owner !== ownerId ||
    connector !== grant.connectorId ||
    status === "revoked" ||
    status === "deleted" ||
    row.revoked !== 0 ||
    row.connection_id !== connectionId ||
    grant.connectionId !== connectionId ||
    grant.runId !== runId ||
    row.issuer_epoch !== grant.issuerEpoch ||
    Number(row.generation) !== grant.generation ||
    row.grant_json !== canonicalBindingJson(grant) ||
    !row.token_digest ||
    !Number.isFinite(now) ||
    now >= grant.expiresAt
  ) {
    deny();
  }
  return grant;
}
export function sqliteStagedRecordGrant(
  connectionId: string,
  runId: string,
  ownerId: string | undefined
): RunUploadGrant | undefined {
  if (!(getDb() as unknown as { inTransaction: boolean }).inTransaction) {
    deny();
  }
  const owner = getOne<{ owner_subject_id: string; connector_id: string; status: string }>(
    referenceQueries.runUploadOwner,
    [connectionId]
  );
  return stagedRecordGrant(
    sqliteRow(connectionId),
    ownerId,
    runId,
    connectionId,
    owner?.owner_subject_id,
    owner?.connector_id,
    owner?.status,
    Date.now()
  );
}
export async function postgresStagedRecordGrant(
  client: PoolClient,
  connectionId: string,
  runId: string,
  ownerId: string | undefined
): Promise<RunUploadGrant | undefined> {
  const {
    rows: [owner],
  } = await client.query(
    "SELECT owner_subject_id, connector_id, status FROM connector_instances WHERE connector_instance_id=$1 FOR UPDATE",
    [connectionId]
  );
  const {
    rows: [time],
  } = await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms");
  return stagedRecordGrant(
    await postgresRow(client, connectionId),
    ownerId,
    runId,
    connectionId,
    owner?.owner_subject_id,
    owner?.connector_id,
    owner?.status,
    Number(time?.ms)
  );
}
