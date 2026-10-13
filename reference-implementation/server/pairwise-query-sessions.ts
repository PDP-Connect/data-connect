// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { getDb } from "./db.ts";
import { pairwiseInstanceIdentityEnabled } from "./pairwise-identity.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";

interface SessionQueryClient {
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
}

const PAGE_TTL_MS = 15 * 60 * 1000;
const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 1000;
const MAX_CHECKPOINTS = 1000;
const MAX_CHECKPOINTS_PER_CONTEXT = 16;
const MAX_CHECKPOINTS_PER_GRANT = 32;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONTEXT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
type TokenKind = "page" | "checkpoint";
interface Session {
  changesSince?: string;
  checkpointExpiresAt: number;
  checkpointIssued?: boolean;
  context: string;
  id: string;
  pageExpiresAt: number;
}
interface TokenPayload {
  changesSince?: string;
  context: string;
  expiresAt: number;
  id: string;
  kind: TokenKind;
  offset: number;
}
interface State extends Record<string, unknown> {
  data: unknown[];
  kind: TokenKind;
  offset: number;
  retention: PairwiseQueryRetention;
}
interface StoredState extends State {
  _pairwise_session: Session;
}
const sessions = new WeakMap<object, Session>();

function queryError(message: string, code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function limitFromEnvironment(name: string, maximum: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

export function assertPairwiseQuerySnapshotBytes(bytes: number): void {
  if (bytes > limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_SNAPSHOT_BYTES", MAX_SNAPSHOT_BYTES)) {
    throw queryError(
      "Query snapshot exceeds the per-query byte limit; narrow requested fields or select one authorized instance",
      "resource_limit"
    );
  }
}

async function issuerKey(): Promise<Buffer> {
  if (isPostgresStorageBackend()) {
    let [row] = (await postgresQuery<{ key: string }>("SELECT key FROM pairwise_query_issuer_key WHERE id=1")).rows;
    if (!row) {
      await postgresQuery("INSERT INTO pairwise_query_issuer_key(id,key) VALUES(1,$1) ON CONFLICT(id) DO NOTHING", [
        randomBytes(32).toString("base64url"),
      ]);
      [row] = (await postgresQuery<{ key: string }>("SELECT key FROM pairwise_query_issuer_key WHERE id=1")).rows;
    }
    if (!row) {
      throw new Error("Pairwise query issuer key unavailable");
    }
    return Buffer.from(row.key, "base64url");
  }
  const db = getDb();
  let row = db.prepare("SELECT key FROM pairwise_query_issuer_key WHERE id=1").get<{ key: string }>();
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO pairwise_query_issuer_key(id,key) VALUES(1,?)").run(
      randomBytes(32).toString("base64url")
    );
    row = db.prepare("SELECT key FROM pairwise_query_issuer_key WHERE id=1").get<{ key: string }>();
  }
  if (!row) {
    throw new Error("Pairwise query issuer key unavailable");
  }
  return Buffer.from(row.key, "base64url");
}

export interface PairwiseQueryScope {
  connectorInstanceId: string;
  stream: string;
}
export interface PairwiseQueryRetention {
  generations: Record<string, number>;
  grantDigest: string;
  grantId: string;
  scopes: PairwiseQueryScope[];
}
interface EpochRow extends Record<string, unknown> {
  generation: number | string;
  scope_key: string;
}

function scopeDefinitions(retention: PairwiseQueryRetention) {
  const pairs = retention.scopes.map((scope) => ({
    grant: "",
    instance: scope.connectorInstanceId,
    key: JSON.stringify(["pair", scope.connectorInstanceId, scope.stream]),
    stream: scope.stream,
  }));
  for (const instance of new Set(retention.scopes.map((scope) => scope.connectorInstanceId))) {
    pairs.push({ grant: "", instance, key: JSON.stringify(["instance", instance]), stream: "" });
  }
  if (retention.grantId) {
    pairs.push({
      grant: retention.grantId,
      instance: "",
      key: JSON.stringify(["grant", retention.grantId]),
      stream: "",
    });
  }
  return pairs.sort((a, b) => a.key.localeCompare(b.key));
}

export async function preparePairwiseQueryScopes(retention: PairwiseQueryRetention): Promise<void> {
  const definitions = scopeDefinitions(retention);
  for (const scope of definitions) {
    if (isPostgresStorageBackend()) {
      // biome-ignore lint/performance/noAwaitInLoops: scope registration precedes the authoritative read transaction.
      await postgresQuery(
        "INSERT INTO pairwise_query_scope_epochs(scope_key,connector_instance_id,stream,grant_id,generation) VALUES($1,$2,$3,$4,0) ON CONFLICT(scope_key) DO NOTHING",
        [scope.key, scope.instance, scope.stream, scope.grant]
      );
    } else {
      getDb()
        .prepare(
          "INSERT OR IGNORE INTO pairwise_query_scope_epochs(scope_key,connector_instance_id,stream,grant_id,generation) VALUES(?,?,?,?,0)"
        )
        .run(scope.key, scope.instance, scope.stream, scope.grant);
    }
  }
}

async function scopeVersions(
  retention: PairwiseQueryRetention,
  client?: SessionQueryClient
): Promise<Record<string, number>> {
  const keys = scopeDefinitions(retention).map((scope) => scope.key);
  const sql = "SELECT scope_key,generation FROM pairwise_query_scope_epochs WHERE scope_key";
  const rows = isPostgresStorageBackend()
    ? ((
        await (client
          ? client.query(`${sql}=ANY($1::text[])`, [keys])
          : postgresQuery(`${sql}=ANY($1::text[])`, [keys]))
      ).rows as EpochRow[])
    : getDb()
        .prepare(`${sql} IN (${keys.map(() => "?").join(",")})`)
        .all<EpochRow>(...keys);
  return Object.fromEntries(rows.map((row) => [row.scope_key, Number(row.generation)]));
}

async function assertGrantActive(retention: PairwiseQueryRetention, client?: SessionQueryClient): Promise<void> {
  if (!retention.grantId) {
    return;
  }
  const row = isPostgresStorageBackend()
    ? ((
        await (client
          ? client.query("SELECT status FROM grants WHERE grant_id=$1", [retention.grantId])
          : postgresQuery("SELECT status FROM grants WHERE grant_id=$1", [retention.grantId]))
      ).rows[0] as { status: string } | undefined)
    : getDb().prepare("SELECT status FROM grants WHERE grant_id=?").get<{ status: string }>(retention.grantId);
  if (row?.status !== "active") {
    throw queryError("Grant has been revoked", "grant_revoked");
  }
}

export async function capturePairwiseQueryScopes(retention: PairwiseQueryRetention): Promise<void> {
  retention.generations = await scopeVersions(retention);
  await assertGrantActive(retention);
}

async function lockScopes(client: SessionQueryClient, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    // biome-ignore lint/performance/noAwaitInLoops: all writers acquire scope locks in the same order.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`pairwise-query-scope:${key}`]);
  }
}

function assertScopeVersions(retention: PairwiseQueryRetention, current: Record<string, number>): void {
  if (scopeDefinitions(retention).some((scope) => current[scope.key] !== retention.generations[scope.key])) {
    throw queryError(
      "Query data changed during collection; restart pagination using the original changes_since value, or restart a plain list without a cursor",
      "query_capacity_exceeded"
    );
  }
}

function assertGrantActiveSqlite(retention: PairwiseQueryRetention): void {
  if (
    retention.grantId &&
    getDb().prepare("SELECT status FROM grants WHERE grant_id=?").get<{ status: string }>(retention.grantId)?.status !==
      "active"
  ) {
    throw queryError("Grant has been revoked", "grant_revoked");
  }
}

function assertScopeVersionsSqlite(retention: PairwiseQueryRetention): void {
  const current = Object.fromEntries(
    scopeDefinitions(retention).map((scope) => [
      scope.key,
      getDb()
        .prepare("SELECT generation FROM pairwise_query_scope_epochs WHERE scope_key=?")
        .get<{ generation: number }>(scope.key)?.generation,
    ])
  );
  assertGrantActiveSqlite(retention);
  assertScopeVersions(retention, current as Record<string, number>);
}

function tokenEncryptionKey(key: Buffer): Buffer {
  return createHmac("sha256", key).update("pairwise-query-token-aead-v2").digest();
}

function encodeToken(session: Session, kind: TokenKind, offset: number, key: Buffer): string {
  const payload: TokenPayload = {
    context: session.context,
    ...(kind === "page" && session.changesSince !== undefined ? { changesSince: session.changesSince } : {}),
    expiresAt: kind === "checkpoint" ? session.checkpointExpiresAt : session.pageExpiresAt,
    id: session.id,
    kind,
    offset: kind === "checkpoint" ? 0 : offset,
  };
  const prefix = kind === "checkpoint" ? "pqc2" : "pqp2";
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(key), nonce);
  cipher.setAAD(Buffer.from(prefix));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `${prefix}.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

function decodeToken(token: string, key: Buffer): TokenPayload {
  try {
    const [prefix, body, extra] = token.split(".");
    if (!body || extra !== undefined || (prefix !== "pqp2" && prefix !== "pqc2")) {
      throw new Error("Malformed query cursor");
    }
    const sealed = Buffer.from(body, "base64url");
    if (sealed.length <= 28 || sealed.toString("base64url") !== body) {
      throw new Error("Malformed encrypted query cursor");
    }
    const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(key), sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(prefix));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    const payload = JSON.parse(plaintext.toString()) as TokenPayload;
    if (
      typeof payload.id !== "string" ||
      !SESSION_ID_PATTERN.test(payload.id) ||
      typeof payload.context !== "string" ||
      !CONTEXT_DIGEST_PATTERN.test(payload.context) ||
      (payload.changesSince !== undefined && typeof payload.changesSince !== "string") ||
      payload.kind !== (prefix === "pqc2" ? "checkpoint" : "page") ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset < 0 ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= 0 ||
      (payload.kind === "checkpoint" && payload.offset !== 0)
    ) {
      throw new Error("Query cursor payload is invalid");
    }
    return payload;
  } catch (error) {
    throw queryError("Cursor is invalid", "invalid_cursor", error);
  }
}

function checkpointOnly(json: string): string {
  const state = JSON.parse(json) as StoredState;
  return JSON.stringify({ ...state, data: [], kind: "checkpoint", offset: 0 });
}

function assertAdmission(count: number, bytes: number, incomingBytes: number): void {
  if (
    count >= limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_SESSIONS", MAX_SESSIONS) ||
    bytes + incomingBytes > limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_BYTES", MAX_RETAINED_BYTES)
  ) {
    throw queryError("Retained query capacity is full; retry after active sessions expire", "query_capacity_exceeded");
  }
}

interface CheckpointRow extends Record<string, unknown> {
  byte_count: number | string;
  context_digest: string;
  grant_digest: string;
  page_expires_at: number | string;
  token: string;
}

function checkpointEvictions(rows: CheckpointRow[]): CheckpointRow[] {
  const contextsSeen = new Set<string>();
  const grantsSeen = new Set<string>();
  const grantNewest: CheckpointRow[] = [];
  const contextNewest: CheckpointRow[] = [];
  const history: CheckpointRow[] = [];
  for (const row of rows) {
    if (contextsSeen.has(row.context_digest)) {
      history.push(row);
    } else {
      contextsSeen.add(row.context_digest);
      if (grantsSeen.has(row.grant_digest)) {
        contextNewest.push(row);
      } else {
        grantsSeen.add(row.grant_digest);
        grantNewest.push(row);
      }
    }
  }
  const contexts = new Map<string, number>();
  const grants = new Map<string, number>();
  const expired: CheckpointRow[] = [];
  let count = 0;
  let bytes = 0;
  for (const row of [...grantNewest, ...contextNewest, ...history]) {
    const inContext = contexts.get(row.context_digest) ?? 0;
    const inGrant = grants.get(row.grant_digest) ?? 0;
    const size = Number(row.byte_count);
    if (
      count >= limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS", MAX_CHECKPOINTS) ||
      inContext >=
        limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS_PER_CONTEXT", MAX_CHECKPOINTS_PER_CONTEXT) ||
      inGrant >= limitFromEnvironment("PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS_PER_GRANT", MAX_CHECKPOINTS_PER_GRANT) ||
      bytes + size > MAX_CHECKPOINT_BYTES
    ) {
      expired.push(row);
    } else {
      contexts.set(row.context_digest, inContext + 1);
      grants.set(row.grant_digest, inGrant + 1);
      count += 1;
      bytes += size;
    }
  }
  return expired;
}

const CHECKPOINT_ROWS_SQL =
  "SELECT token,context_digest,grant_digest,page_expires_at,checkpoint_bytes AS byte_count FROM pairwise_query_sessions WHERE checkpoint_issued=1 ORDER BY checkpoint_issued_at DESC,token DESC";
function trimCheckpointHistorySqlite(): void {
  const db = getDb();
  for (const row of checkpointEvictions(db.prepare(CHECKPOINT_ROWS_SQL).all<CheckpointRow>())) {
    if (Number(row.page_expires_at) > 0) {
      db.prepare("UPDATE pairwise_query_sessions SET checkpoint_issued=0 WHERE token=?").run(row.token);
    } else {
      db.prepare("DELETE FROM pairwise_query_sessions WHERE token=?").run(row.token);
    }
  }
}
async function trimCheckpointHistoryPostgres(client: SessionQueryClient): Promise<void> {
  const { rows } = await client.query(CHECKPOINT_ROWS_SQL);
  for (const row of checkpointEvictions(rows as CheckpointRow[])) {
    // biome-ignore lint/performance/noAwaitInLoops: quota pruning is atomic with admission and issuance.
    await client.query(
      Number(row.page_expires_at) > 0
        ? "UPDATE pairwise_query_sessions SET checkpoint_issued=0 WHERE token=$1"
        : "DELETE FROM pairwise_query_sessions WHERE token=$1",
      [row.token]
    );
  }
}
async function lockQuotaMutationRows(
  client: SessionQueryClient,
  target: string,
  values: readonly unknown[]
): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT token FROM pairwise_query_sessions WHERE checkpoint_issued=1 OR (${target}) ORDER BY token FOR UPDATE`,
    values
  );
  return (rows as { token: string }[]).map((row) => row.token);
}

interface RetainedPageRow extends Record<string, unknown> {
  checkpoint_issued: boolean | number;
  state_json: string;
  token: string;
}
function mutationScope(filter: SessionFilter) {
  if (filter.grantId !== undefined) {
    return { grant: filter.grantId, instance: "", key: JSON.stringify(["grant", filter.grantId]), stream: "" };
  }
  if (filter.connectorInstanceId !== undefined) {
    return {
      grant: "",
      instance: filter.connectorInstanceId,
      key: JSON.stringify(
        filter.stream === undefined
          ? ["instance", filter.connectorInstanceId]
          : ["pair", filter.connectorInstanceId, filter.stream]
      ),
      stream: filter.stream ?? "",
    };
  }
  return null;
}
interface SessionFilter {
  connectorInstanceId?: string;
  grantId?: string;
  stream?: string;
}
function filterSql(filter: SessionFilter, postgres: boolean, epochs: boolean) {
  const values: string[] = [];
  const clauses: string[] = [];
  const add = (column: string, value: string) => {
    values.push(value);
    clauses.push(`${column}=${postgres ? `$${values.length}` : "?"}`);
  };
  if (filter.grantId !== undefined) {
    add("grant_id", filter.grantId);
  } else if (epochs) {
    clauses.push("grant_id=''");
  }
  if (filter.connectorInstanceId !== undefined) {
    add("connector_instance_id", filter.connectorInstanceId);
  }
  if (filter.stream !== undefined) {
    add("stream", filter.stream);
  }
  return { values, where: clauses.length ? clauses.join(" AND ") : "1=1" };
}
function matchingPagesSql(filter: SessionFilter, postgres: boolean) {
  if (filter.grantId !== undefined) {
    return {
      sql: `SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE grant_id=${postgres ? "$1" : "?"}`,
      values: [filter.grantId],
    };
  }
  const { where, values } = filterSql(filter, postgres, false);
  return {
    sql: `SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE page_expires_at>0 AND token IN (SELECT token FROM pairwise_query_session_scopes WHERE ${where})`,
    values,
  };
}
function clearPageSqlite(row: RetainedPageRow): void {
  const db = getDb();
  if (row.checkpoint_issued) {
    const json = checkpointOnly(row.state_json);
    db.prepare("UPDATE pairwise_query_sessions SET state_json=?,page_expires_at=0,byte_count=? WHERE token=?").run(
      json,
      Buffer.byteLength(json),
      row.token
    );
  } else {
    db.prepare("DELETE FROM pairwise_query_sessions WHERE token=?").run(row.token);
  }
}
async function clearPagePostgres(row: RetainedPageRow, client: SessionQueryClient): Promise<void> {
  if (row.checkpoint_issued) {
    const json = checkpointOnly(row.state_json);
    await client.query(
      "UPDATE pairwise_query_sessions SET state_json=$1,page_expires_at=0,byte_count=$2 WHERE token=$3",
      [json, Buffer.byteLength(json), row.token]
    );
  } else {
    await client.query("DELETE FROM pairwise_query_sessions WHERE token=$1", [row.token]);
  }
}
export function invalidatePairwiseQuerySessionsSqlite(filter: SessionFilter = {}): void {
  const db = getDb();
  const query = matchingPagesSql(filter, false);
  const rows = db.prepare(query.sql).all<RetainedPageRow>(...query.values);
  if (!(pairwiseInstanceIdentityEnabled() || rows.length)) {
    return;
  }
  const scope = mutationScope(filter);
  if (scope) {
    db.prepare(
      "INSERT OR IGNORE INTO pairwise_query_scope_epochs(scope_key,connector_instance_id,stream,grant_id,generation) VALUES(?,?,?,?,0)"
    ).run(scope.key, scope.instance, scope.stream, scope.grant);
  }
  const epochFilter = filterSql(filter, false, true);
  const epochs = db
    .prepare(`SELECT scope_key FROM pairwise_query_scope_epochs WHERE ${epochFilter.where} ORDER BY scope_key`)
    .all<{ scope_key: string }>(...epochFilter.values);
  if (!(rows.length || epochs.length)) {
    return;
  }
  db.transaction(() => {
    for (const row of epochs) {
      db.prepare("UPDATE pairwise_query_scope_epochs SET generation=generation+1 WHERE scope_key=?").run(row.scope_key);
    }
    if (filter.grantId === undefined) {
      for (const row of rows) {
        clearPageSqlite(row);
      }
    } else {
      db.prepare("DELETE FROM pairwise_query_sessions WHERE grant_id=?").run(filter.grantId);
    }
  })();
}
export async function invalidatePairwiseQuerySessionsPostgres(
  filter: SessionFilter = {},
  client?: SessionQueryClient
): Promise<void> {
  const invalidate = async (transaction: SessionQueryClient) => {
    const query = matchingPagesSql(filter, true);
    const { rows } = await transaction.query(query.sql, query.values);
    if (!(pairwiseInstanceIdentityEnabled() || rows.length)) {
      return;
    }
    const scope = mutationScope(filter);
    if (scope) {
      await transaction.query(
        "INSERT INTO pairwise_query_scope_epochs(scope_key,connector_instance_id,stream,grant_id,generation) VALUES($1,$2,$3,$4,0) ON CONFLICT(scope_key) DO NOTHING",
        [scope.key, scope.instance, scope.stream, scope.grant]
      );
    }
    const epochFilter = filterSql(filter, true, true);
    const { rows: epochs } = await transaction.query(
      `SELECT scope_key FROM pairwise_query_scope_epochs WHERE ${epochFilter.where} ORDER BY scope_key`,
      epochFilter.values
    );
    const keys = (epochs as { scope_key: string }[]).map((row) => row.scope_key);
    if (!(rows.length || keys.length)) {
      return;
    }
    await lockScopes(transaction, keys);
    for (const key of keys) {
      // biome-ignore lint/performance/noAwaitInLoops: scope mutation shares the source deletion transaction.
      await transaction.query("UPDATE pairwise_query_scope_epochs SET generation=generation+1 WHERE scope_key=$1", [
        key,
      ]);
    }
    // Reload after scope locks: an admission that preceded erasure must also be purged.
    const { rows: lockedRows } = await transaction.query(`${query.sql} ORDER BY token FOR UPDATE`, query.values);
    if (filter.grantId !== undefined) {
      await transaction.query("DELETE FROM pairwise_query_sessions WHERE grant_id=$1", [filter.grantId]);
      return;
    }
    for (const row of lockedRows as RetainedPageRow[]) {
      // biome-ignore lint/performance/noAwaitInLoops: targeted erasure completes before commit.
      await clearPagePostgres(row, transaction);
    }
  };
  if (client) {
    await invalidate(client);
  } else {
    await withPostgresTransaction(invalidate);
  }
}
export async function invalidatePairwiseQuerySessions(filter: SessionFilter = {}): Promise<void> {
  if (isPostgresStorageBackend()) {
    await invalidatePairwiseQuerySessionsPostgres(filter);
  } else {
    invalidatePairwiseQuerySessionsSqlite(filter);
  }
}
export async function sweepPairwiseQuerySessions(): Promise<void> {
  const now = Date.now();
  const eligible = "expires_at <= $1 OR (page_expires_at>0 AND page_expires_at <= $1)";
  if (isPostgresStorageBackend()) {
    const hasExpired =
      (await postgresQuery(`SELECT 1 FROM pairwise_query_sessions WHERE ${eligible} LIMIT 1`, [now])).rows.length > 0;
    if (!(hasExpired || checkpointEvictions((await postgresQuery<CheckpointRow>(CHECKPOINT_ROWS_SQL)).rows).length)) {
      return;
    }
    await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pairwise-query-admission',0))");
      const lockedTokens = await lockQuotaMutationRows(
        client,
        `token IN (SELECT token FROM pairwise_query_sessions WHERE ${eligible} ORDER BY expires_at,token LIMIT 100)`,
        [now]
      );
      const { rows } = await client.query<RetainedPageRow & { expires_at: string }>(
        `SELECT token,state_json,checkpoint_issued,expires_at FROM pairwise_query_sessions WHERE (${eligible}) AND token=ANY($2::text[]) ORDER BY expires_at,token LIMIT 100`,
        [now, lockedTokens]
      );
      for (const row of rows) {
        if (Number(row.expires_at) <= now) {
          // biome-ignore lint/performance/noAwaitInLoops: each maintenance transaction handles at most 100 expired rows.
          await client.query("DELETE FROM pairwise_query_sessions WHERE token=$1", [row.token]);
        } else {
          await clearPagePostgres(row, client);
        }
      }
      await trimCheckpointHistoryPostgres(client);
    });
  } else {
    const db = getDb();
    if (
      !(
        db
          .prepare(
            "SELECT 1 FROM pairwise_query_sessions WHERE expires_at <= ? OR (page_expires_at>0 AND page_expires_at <= ?) LIMIT 1"
          )
          .get(now, now) || checkpointEvictions(db.prepare(CHECKPOINT_ROWS_SQL).all<CheckpointRow>()).length
      )
    ) {
      return;
    }
    db.transaction(() => {
      const rows = db
        .prepare(
          "SELECT token,state_json,checkpoint_issued,expires_at FROM pairwise_query_sessions WHERE expires_at <= ? OR (page_expires_at>0 AND page_expires_at <= ?) ORDER BY expires_at,token LIMIT 100"
        )
        .all<RetainedPageRow & { expires_at: number }>(now, now);
      for (const row of rows) {
        if (row.expires_at <= now) {
          db.prepare("DELETE FROM pairwise_query_sessions WHERE token=?").run(row.token);
        } else {
          clearPageSqlite(row);
        }
      }
      trimCheckpointHistorySqlite();
    }).immediate();
  }
}

async function retainSnapshot(state: StoredState, json: string, bytes: number, expiresAt: number): Promise<void> {
  const now = Date.now();
  const session = state._pairwise_session;
  const pageExpiresAt = state.kind === "checkpoint" ? 0 : session.pageExpiresAt;
  const issued = state.kind === "checkpoint" ? 1 : 0;
  const checkpointBytes = typeof state.changes_since === "string" ? Buffer.byteLength(checkpointOnly(json)) : 0;
  const { retention } = state;
  const values = [
    session.id,
    json,
    expiresAt,
    pageExpiresAt,
    bytes,
    session.context,
    now,
    retention.grantId,
    retention.grantDigest,
    issued,
    checkpointBytes,
  ];
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await lockScopes(
        client,
        scopeDefinitions(retention).map((scope) => scope.key)
      );
      await assertGrantActive(retention, client);
      assertScopeVersions(retention, await scopeVersions(retention, client));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pairwise-query-admission',0))");
      await lockQuotaMutationRows(client, "expires_at <= $1 OR (page_expires_at>0 AND page_expires_at <= $1)", [now]);
      await client.query("DELETE FROM pairwise_query_sessions WHERE expires_at <= $1", [now]);
      const { rows: expired } = await client.query<RetainedPageRow>(
        "SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE page_expires_at>0 AND page_expires_at <= $1",
        [now]
      );
      for (const row of expired) {
        // biome-ignore lint/performance/noAwaitInLoops: reclamation is atomic with admission.
        await clearPagePostgres(row, client);
      }
      const [total] = (
        await client.query<{ count: string; bytes: string }>(
          "SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM pairwise_query_sessions WHERE page_expires_at>0"
        )
      ).rows;
      if (pageExpiresAt > 0) {
        assertAdmission(Number(total?.count ?? 0), Number(total?.bytes ?? 0), bytes);
      }
      await client.query(
        "INSERT INTO pairwise_query_sessions(token,state_json,expires_at,page_expires_at,byte_count,context_digest,created_at,grant_id,grant_digest,checkpoint_issued,checkpoint_bytes,checkpoint_issued_at) VALUES($1,$2,$3,$4,$5,$6,GREATEST($7,(SELECT COALESCE(MAX(created_at),0)+1 FROM pairwise_query_sessions)),$8,$9,$10,$11,CASE WHEN $10=1 THEN GREATEST($12,(SELECT COALESCE(MAX(checkpoint_issued_at),0)+1 FROM pairwise_query_sessions)) ELSE 0 END)",
        [...values, now]
      );
      for (const scope of retention.scopes) {
        // biome-ignore lint/performance/noAwaitInLoops: binding metadata shares the admission transaction.
        await client.query(
          "INSERT INTO pairwise_query_session_scopes(token,connector_instance_id,stream) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [session.id, scope.connectorInstanceId, scope.stream]
        );
      }
      await trimCheckpointHistoryPostgres(client);
    });
  } else {
    const db = getDb();
    db.transaction(() => {
      assertScopeVersionsSqlite(retention);
      db.prepare("DELETE FROM pairwise_query_sessions WHERE expires_at <= ?").run(now);
      const expired = db
        .prepare(
          "SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE page_expires_at>0 AND page_expires_at <= ?"
        )
        .all<RetainedPageRow>(now);
      for (const row of expired) {
        clearPageSqlite(row);
      }
      const total = db
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM pairwise_query_sessions WHERE page_expires_at>0"
        )
        .get<{ count: number; bytes: number }>();
      if (pageExpiresAt > 0) {
        assertAdmission(total?.count ?? 0, total?.bytes ?? 0, bytes);
      }
      db.prepare(
        "INSERT INTO pairwise_query_sessions(token,state_json,expires_at,page_expires_at,byte_count,context_digest,created_at,grant_id,grant_digest,checkpoint_issued,checkpoint_bytes,checkpoint_issued_at) VALUES(?,?,?,?,?,?,MAX(?,(SELECT COALESCE(MAX(created_at),0)+1 FROM pairwise_query_sessions)),?,?,?,?,CASE WHEN ?=1 THEN MAX(?,(SELECT COALESCE(MAX(checkpoint_issued_at),0)+1 FROM pairwise_query_sessions)) ELSE 0 END)"
      ).run(...values, issued, now);
      for (const scope of retention.scopes) {
        db.prepare(
          "INSERT OR IGNORE INTO pairwise_query_session_scopes(token,connector_instance_id,stream) VALUES(?,?,?)"
        ).run(session.id, scope.connectorInstanceId, scope.stream);
      }
      trimCheckpointHistorySqlite();
    }).immediate();
  }
}

async function markCheckpointIssued(state: State, session: Session): Promise<void> {
  const { retention } = state;
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await lockScopes(
        client,
        scopeDefinitions(retention).map((scope) => scope.key)
      );
      await assertGrantActive(retention, client);
      assertScopeVersions(retention, await scopeVersions(retention, client));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pairwise-query-admission',0))");
      await lockQuotaMutationRows(client, "token=$1", [session.id]);
      const [row] = (
        await client.query<{ state_json: string; checkpoint_issued: number; checkpoint_issued_at: string }>(
          "SELECT state_json,checkpoint_issued,checkpoint_issued_at FROM pairwise_query_sessions WHERE token=$1",
          [session.id]
        )
      ).rows;
      if (!row || (JSON.parse(row.state_json) as State).kind !== "page") {
        throw queryError("Page snapshot is unavailable; restart the query", "invalid_cursor");
      }
      if (!row.checkpoint_issued && Number(row.checkpoint_issued_at) !== 0) {
        throw queryError("Page snapshot can no longer issue a checkpoint; restart pagination", "invalid_cursor");
      }
      if (!row.checkpoint_issued) {
        await client.query(
          "UPDATE pairwise_query_sessions SET checkpoint_issued=1,checkpoint_issued_at=GREATEST($2,(SELECT COALESCE(MAX(checkpoint_issued_at),0)+1 FROM pairwise_query_sessions)) WHERE token=$1",
          [session.id, Date.now()]
        );
      }
      await trimCheckpointHistoryPostgres(client);
    });
  } else {
    const db = getDb();
    db.transaction(() => {
      assertScopeVersionsSqlite(retention);
      const row = db
        .prepare("SELECT state_json,checkpoint_issued,checkpoint_issued_at FROM pairwise_query_sessions WHERE token=?")
        .get<{ state_json: string; checkpoint_issued: number; checkpoint_issued_at: number }>(session.id);
      if (!row || (JSON.parse(row.state_json) as State).kind !== "page") {
        throw queryError("Page snapshot is unavailable; restart the query", "invalid_cursor");
      }
      if (!row.checkpoint_issued && row.checkpoint_issued_at !== 0) {
        throw queryError("Page snapshot can no longer issue a checkpoint; restart pagination", "invalid_cursor");
      }
      if (!row.checkpoint_issued) {
        db.prepare(
          "UPDATE pairwise_query_sessions SET checkpoint_issued=1,checkpoint_issued_at=MAX(?,(SELECT COALESCE(MAX(checkpoint_issued_at),0)+1 FROM pairwise_query_sessions)) WHERE token=?"
        ).run(Date.now(), session.id);
      }
      trimCheckpointHistorySqlite();
    }).immediate();
  }
  session.checkpointIssued = true;
}

export async function savePairwiseQueryState(value: object, tokenKind?: TokenKind): Promise<string> {
  const state = value as State;
  const kind = tokenKind ?? state.kind;
  const key = await issuerKey();
  let session = sessions.get(state);
  if (!session) {
    const now = Date.now();
    session = {
      context: createHash("sha256").update(String(state.context)).digest("hex"),
      ...(typeof state.changes_since === "string" ? { changesSince: state.changes_since } : {}),
      checkpointExpiresAt: now + CHECKPOINT_TTL_MS,
      checkpointIssued: kind === "checkpoint",
      id: randomBytes(32).toString("base64url"),
      pageExpiresAt: now + PAGE_TTL_MS,
    };
    const stored: StoredState = {
      ...state,
      _pairwise_session: session,
      ...(kind === "checkpoint" ? { data: [], kind, offset: 0 } : {}),
    };
    const json = JSON.stringify(stored);
    const bytes = Buffer.byteLength(json);
    assertPairwiseQuerySnapshotBytes(bytes);
    const expiresAt =
      kind === "checkpoint" || typeof state.changes_since === "string"
        ? session.checkpointExpiresAt
        : session.pageExpiresAt;
    await retainSnapshot(stored, json, bytes, expiresAt);
    sessions.set(state, session);
  }
  if (kind === "checkpoint" && !session.checkpointIssued) {
    await markCheckpointIssued(state, session);
  }
  return encodeToken(session, kind, state.offset, key);
}

async function reclaimExpiredSession(payload: TokenPayload): Promise<void> {
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pairwise-query-admission',0))");
      await lockQuotaMutationRows(client, "token=$1", [payload.id]);
      if (payload.kind === "page" && payload.changesSince !== undefined) {
        const [row] = (
          await client.query<RetainedPageRow>(
            "SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE token=$1",
            [payload.id]
          )
        ).rows;
        if (row) {
          await clearPagePostgres(row, client);
        }
      } else {
        await client.query("DELETE FROM pairwise_query_sessions WHERE token=$1", [payload.id]);
      }
      await trimCheckpointHistoryPostgres(client);
    });
  } else {
    const db = getDb();
    db.transaction(() => {
      if (payload.kind === "page" && payload.changesSince !== undefined) {
        const row = db
          .prepare("SELECT token,state_json,checkpoint_issued FROM pairwise_query_sessions WHERE token=?")
          .get<RetainedPageRow>(payload.id);
        if (row) {
          clearPageSqlite(row);
        }
      } else {
        db.prepare("DELETE FROM pairwise_query_sessions WHERE token=?").run(payload.id);
      }
      trimCheckpointHistorySqlite();
    }).immediate();
  }
}

export async function loadPairwiseQueryState(
  token: string,
  expected?: { context: string; kind: TokenKind; changesSince?: string | undefined }
): Promise<unknown> {
  const payload = decodeToken(token, await issuerKey());
  if (
    expected &&
    (payload.kind !== expected.kind ||
      payload.context !== createHash("sha256").update(expected.context).digest("hex") ||
      (payload.kind === "page" && payload.changesSince !== expected.changesSince))
  ) {
    throw queryError("Cursor does not match this query context", "invalid_cursor");
  }
  if (payload.expiresAt <= Date.now()) {
    await reclaimExpiredSession(payload);
    throw queryError(
      "Cursor has expired; restart the session",
      payload.kind === "checkpoint" ? "cursor_expired" : "invalid_cursor"
    );
  }
  const row = isPostgresStorageBackend()
    ? (
        await postgresQuery<{ state_json: string; checkpoint_issued: number }>(
          "SELECT state_json,checkpoint_issued FROM pairwise_query_sessions WHERE token=$1",
          [payload.id]
        )
      ).rows[0]
    : getDb()
        .prepare("SELECT state_json,checkpoint_issued FROM pairwise_query_sessions WHERE token=?")
        .get<{ state_json: string; checkpoint_issued: number }>(payload.id);
  if (payload.kind === "checkpoint" && !row?.checkpoint_issued) {
    throw queryError("Checkpoint state is unavailable or expired; restart from beginning", "cursor_expired");
  }
  if (!row) {
    return null;
  }
  const { _pairwise_session: session, ...state } = JSON.parse(row.state_json) as StoredState;
  session.checkpointIssued = Boolean(row.checkpoint_issued);
  if (
    payload.id !== session.id ||
    payload.expiresAt !== (payload.kind === "checkpoint" ? session.checkpointExpiresAt : session.pageExpiresAt) ||
    (payload.kind === "page" && (state.kind !== "page" || payload.offset > state.data.length)) ||
    (payload.kind === "checkpoint" && typeof state.changes_since !== "string")
  ) {
    return null;
  }
  state.kind = payload.kind;
  state.offset = payload.offset;
  if (payload.kind === "checkpoint") {
    state.data = [];
  }
  sessions.set(state, session);
  return state;
}
