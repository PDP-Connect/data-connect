// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real-Postgres proof for the search-index reconcile retry churn:
//   1. a scope-pinned reconcile of stream A must not delete healthy sibling
//      stream B's lexical/semantic index (orphan cleanup used to enumerate
//      every stored stream against the one-stream pinned manifest);
//   2. repeated failed semantic attempts must leave already-built lexical rows
//      untouched (same xmin), including when two sibling scopes fail in turn;
//   3. a failure recorded after an operator parked a scope must not pull
//      next_attempt_at back in, and a persistent failure backs off beyond 600s;
//   4. a same-record reingest writes no index rows and does not re-dirty.
//
// Run: PDPP_TEST_POSTGRES_URL=postgresql://postgres:pw@%2Fpath%2Fto%2Fsock/pdpp_test \
//   node --test --import tsx test/search-index-reconcile-scope-isolation.postgres.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import {
  clearSearchIndexDirty,
  listDirtySearchIndexScopes,
  markSearchIndexDirtyPostgres,
  parkSearchIndexDirtyScope,
  rearmSearchIndexDirtyScope,
  recordSearchIndexDirtyFailure,
} from "../server/stores/search-index-dirty-store.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const OPERATOR_MIGRATION_FAILURE = /forced operator classification migration failure/;
const OPERATOR_OWNER_PASSWORD = "scope-isolation-owner-password";

function cookiePair(response: Response, name: string): string | null {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  return values.map((value) => value.split(";", 1)[0] ?? "").find((value) => value.startsWith(`${name}=`)) ?? null;
}

async function ownerSessionCookie(asUrl: string): Promise<string> {
  const landing = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = cookiePair(landing, "pdpp_owner_csrf");
  const html = await landing.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  const login = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrf,
      password: OPERATOR_OWNER_PASSWORD,
      return_to: "/",
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  const session = cookiePair(login, "pdpp_owner_session");
  assert.ok(session, `owner login failed with ${login.status}`);
  return session;
}

function streamDef(name: string, semantic: boolean) {
  return {
    name,
    primary_key: ["id"],
    query: {
      search: {
        lexical_fields: ["subject"],
        ...(semantic ? { semantic_fields: ["subject"] } : {}),
      },
    },
    schema: {
      properties: { id: { type: "string" }, subject: { type: "string" } },
      required: ["id", "subject"],
      type: "object",
    },
    selection: { fields: true, resources: true },
    semantics: "mutable_state",
  };
}

function manifestFor(connectorId: string, semantic: boolean) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [streamDef("alpha", semantic), streamDef("beta", semantic)],
    version: "0.1.0",
  };
}

const target = (connectorId: string, connectorInstanceId: string) => ({
  connector_id: connectorId,
  connector_instance_id: connectorInstanceId,
});
const rec = (stream: string, key: string, subject: string) => ({
  data: { id: key, subject },
  emitted_at: "2026-08-09T00:00:00.000Z",
  key,
  stream,
});

async function lexicalFingerprint(connectorInstanceId: string, stream: string): Promise<string> {
  const { rows } = await postgresQuery<{
    record_key: string;
    field: string;
    xmin: string;
  }>(
    `SELECT record_key, field, xmin::text AS xmin FROM lexical_search_index
     WHERE connector_instance_id = $1 AND stream = $2 ORDER BY record_key, field`,
    [connectorInstanceId, stream]
  );
  return JSON.stringify(rows);
}

async function scopeFor(connectorInstanceId: string, stream: string) {
  const scope = (await listDirtySearchIndexScopes(100_000)).find(
    (s) => s.connectorInstanceId === connectorInstanceId && s.stream === stream
  );
  assert.ok(scope, `scope ${stream} is dirty and eligible`);
  return scope;
}

/** Setup helper: the deferred inline indexer may already have converged the scope, so reconcile only if still dirty. */
async function settleScope(connectorInstanceId: string, stream: string) {
  const scope = (await listDirtySearchIndexScopes(100_000)).find(
    (s) => s.connectorInstanceId === connectorInstanceId && s.stream === stream
  );
  if (scope) {
    await reconcileSearchIndexDirtyScope(scope);
  }
}

async function revisionOf(instance: string): Promise<number> {
  const { rows } = await postgresQuery<{ revision: string }>(
    "SELECT revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
    [instance]
  );
  return Number(rows[0]?.revision);
}

class FailingEmbedError extends Error {}
function failingBackend() {
  const stub = makeStubBackend({ dimensions: 8 });
  return {
    ...stub,
    embedDocument: () => Promise.reject(new FailingEmbedError("transformer_deadline")),
  };
}

if (POSTGRES_URL) {
  test.before(async () => {
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
  });
  test.after(async () => {
    configureSemanticBackend(null);
    await closePostgresStorage();
    closeDb();
  });

  test("Postgres bootstrap classifies legacy dirty scopes only with the column add and rolls back a failed add", async () => {
    const autoInstance = "cin_pg_retry_migration_auto";
    const unknownInstance = "cin_pg_retry_migration_unknown";
    await postgresQuery("DELETE FROM search_index_dirty WHERE connector_instance_id = ANY($1::text[])", [
      [autoInstance, unknownInstance],
    ]);
    await postgresQuery("ALTER TABLE search_index_dirty DROP COLUMN operator_parked");
    await postgresQuery(`
      CREATE FUNCTION reject_search_index_dirty_classification() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.connector_instance_id = '${unknownInstance}' THEN
          RAISE EXCEPTION 'forced operator classification migration failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_search_index_dirty_classification
      BEFORE UPDATE ON search_index_dirty
      FOR EACH ROW EXECUTE FUNCTION reject_search_index_dirty_classification();
    `);
    await postgresQuery(
      "INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, attempts, next_attempt_at, revision) VALUES ($1, 'migration', 'items', 1, $2, 10, NULL, 10), ($3, 'migration', 'items', 1, $2, 10, '2099-01-01T00:00:00.000Z', 10)",
      [autoInstance, "2026-10-15T00:00:00.000Z", unknownInstance]
    );

    try {
      await assert.rejects(bootstrapPostgresSchema(), OPERATOR_MIGRATION_FAILURE);
      const afterFailure = await postgresQuery<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'search_index_dirty' AND column_name = 'operator_parked'"
      );
      assert.equal(afterFailure.rows[0]?.count, "0", "failed add and classification leave no success-shaped column");
    } finally {
      await postgresQuery("DROP TRIGGER IF EXISTS reject_search_index_dirty_classification ON search_index_dirty");
      await postgresQuery("DROP FUNCTION IF EXISTS reject_search_index_dirty_classification()");
    }

    await bootstrapPostgresSchema();
    const migrated = await postgresQuery<{
      connector_instance_id: string;
      operator_parked: number | null;
    }>(
      "SELECT connector_instance_id, operator_parked FROM search_index_dirty WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
      [[autoInstance, unknownInstance]]
    );
    assert.deepEqual(migrated.rows, [
      { connector_instance_id: autoInstance, operator_parked: 0 },
      { connector_instance_id: unknownInstance, operator_parked: null },
    ]);

    await postgresQuery(
      "UPDATE search_index_dirty SET operator_parked = NULL, next_attempt_at = NULL WHERE connector_instance_id = $1",
      [unknownInstance]
    );
    await bootstrapPostgresSchema();
    const restarted = await postgresQuery<{ operator_parked: number | null }>(
      "SELECT operator_parked FROM search_index_dirty WHERE connector_instance_id = $1",
      [unknownInstance]
    );
    assert.equal(restarted.rows[0]?.operator_parked, null, "a later bootstrap does not reinterpret unknown intent");
    assert.ok(
      !(await listDirtySearchIndexScopes(100)).some((scope) => scope.connectorInstanceId === unknownInstance),
      "unknown intent remains ineligible until an explicit operator rearm"
    );
    const unknownKey = {
      connectorInstanceId: unknownInstance,
      stream: "items",
    };
    assert.equal(await recordSearchIndexDirtyFailure(unknownKey, 10, "unknown failure"), false);
    assert.equal(await clearSearchIndexDirty(unknownKey, 10, new Date().toISOString()), false);
    await postgresQuery("DELETE FROM search_index_dirty WHERE connector_instance_id = ANY($1::text[])", [
      [autoInstance, unknownInstance],
    ]);
  });

  test("Postgres changed ingest clears only automatic backoff; no-op, park, and unknown state remain fenced", async () => {
    configureSemanticBackend(null);
    const connectorId = "scope-iso-retry-control";
    const instance = "cin_scope_iso_retry_control";
    const key = { connectorInstanceId: instance, stream: "alpha" };
    await registerConnector(manifestFor(connectorId, false));
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "first"), { deferIndexes: true });
    const initialRevision = await revisionOf(instance);
    assert.equal(await recordSearchIndexDirtyFailure(key, initialRevision, "automatic failure"), true);
    const afterFailure = await postgresQuery<{
      attempts: number;
      next_attempt_at: string | null;
      operator_parked: number | null;
      revision: string;
    }>(
      "SELECT attempts, next_attempt_at, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    const [failed] = afterFailure.rows;
    assert.ok(failed?.next_attempt_at);
    assert.equal(failed?.operator_parked, 0);

    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "first"), { deferIndexes: true });
    const afterNoop = await postgresQuery(
      "SELECT attempts, next_attempt_at, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.deepEqual(afterNoop.rows, [failed], "genuine no-op ingest preserves revision and retry state");

    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "changed"), { deferIndexes: true });
    const changed = await postgresQuery<{
      attempts: number;
      dirty: number;
      next_attempt_at: string | null;
      operator_parked: number | null;
      revision: string;
    }>(
      "SELECT attempts, dirty, next_attempt_at, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.deepEqual(changed.rows[0], {
      attempts: 0,
      dirty: 1,
      next_attempt_at: null,
      operator_parked: 0,
      revision: String(initialRevision + 1),
    });
    assert.equal(await recordSearchIndexDirtyFailure(key, initialRevision, "stale failure"), false);
    assert.equal(await clearSearchIndexDirty(key, initialRevision, new Date().toISOString()), false);

    const beforePark = Number(changed.rows[0]?.revision);
    assert.equal(await parkSearchIndexDirtyScope(key), true);
    const parkedRevision = await revisionOf(instance);
    assert.equal(parkedRevision, beforePark + 1);
    assert.equal(await recordSearchIndexDirtyFailure(key, beforePark, "pre-park failure"), false);
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "park survives ingest"), {
      deferIndexes: true,
    });
    const parkedAfterIngest = await postgresQuery<{
      attempts: number;
      dirty: number;
      next_attempt_at: string | null;
      operator_parked: number | null;
      revision: string;
    }>(
      "SELECT attempts, dirty, next_attempt_at, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.deepEqual(parkedAfterIngest.rows[0], {
      attempts: 0,
      dirty: 1,
      next_attempt_at: null,
      operator_parked: 1,
      revision: String(parkedRevision + 1),
    });
    assert.ok(!(await listDirtySearchIndexScopes(100)).some((scope) => scope.connectorInstanceId === instance));

    await postgresQuery(
      "UPDATE search_index_dirty SET attempts = 7, next_attempt_at = NULL, operator_parked = NULL WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    const unknownRevision = await revisionOf(instance);
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "unknown survives ingest"), {
      deferIndexes: true,
    });
    const unknown = await postgresQuery<{
      attempts: number;
      operator_parked: number | null;
      revision: string;
    }>(
      "SELECT attempts, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.deepEqual(unknown.rows[0], {
      attempts: 7,
      operator_parked: null,
      revision: String(unknownRevision + 1),
    });
    assert.ok(!(await listDirtySearchIndexScopes(100)).some((scope) => scope.connectorInstanceId === instance));
    const latestRevision = Number(unknown.rows[0]?.revision);
    assert.equal(await recordSearchIndexDirtyFailure(key, latestRevision, "unknown failure"), false);
    assert.equal(await clearSearchIndexDirty(key, latestRevision, new Date().toISOString()), false);
    assert.equal(await rearmSearchIndexDirtyScope(key), true);
    const rearmed = await postgresQuery<{
      attempts: number;
      dirty: number;
      next_attempt_at: string | null;
      operator_parked: number;
      revision: string;
    }>(
      "SELECT attempts, dirty, next_attempt_at, operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.deepEqual(rearmed.rows[0], {
      attempts: 0,
      dirty: 1,
      next_attempt_at: null,
      operator_parked: 0,
      revision: String(latestRevision + 1),
    });
    assert.ok(
      (await listDirtySearchIndexScopes(100)).some((scope) => scope.connectorInstanceId === instance),
      "explicit rearm makes this dirty scope eligible for guarded reconciliation"
    );
  });

  test("Postgres same-millisecond marks advance revision and fence stale clear and failure", async () => {
    const connectorId = "scope-iso-same-millisecond";
    const instance = "cin_scope_iso_same_millisecond";
    const key = { connectorInstanceId: instance, stream: "alpha" };
    const markedAt = "2026-10-15T00:00:00.000Z";
    await withPostgresTransaction(async (client) => {
      await markSearchIndexDirtyPostgres(client, { ...key, connectorId }, markedAt);
      await markSearchIndexDirtyPostgres(client, { ...key, connectorId }, markedAt);
    });
    const revision = await revisionOf(instance);
    assert.equal(revision, 2, "both marks advance the generation despite a timestamp collision");
    assert.equal(await clearSearchIndexDirty(key, 1, "2026-10-15T00:00:01.000Z"), false);
    assert.equal(await recordSearchIndexDirtyFailure(key, 1, "stale failure"), false);
    assert.equal(await clearSearchIndexDirty(key, revision, "2026-10-15T00:00:02.000Z"), true);
    await postgresQuery("DELETE FROM search_index_dirty WHERE connector_instance_id = $1", [instance]);
  });

  test("scope-pinned reconcile of one stream preserves a healthy sibling stream's lexical index and meta", async () => {
    configureSemanticBackend(null);
    const connectorId = "scope-iso-sibling";
    const instance = "cin_scope_iso_sibling";
    await registerConnector(manifestFor(connectorId, false));
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "alpha one"));
    await ingestRecord(target(connectorId, instance), rec("beta", "b1", "beta one"));
    await new Promise((r) => setTimeout(r, 300));
    // Drain both scopes so both are converged and the sibling is healthy.
    for (const stream of ["alpha", "beta"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture steps; each depends on the previous one.
      await settleScope(instance, stream);
    }
    const betaBefore = await lexicalFingerprint(instance, "beta");
    assert.notEqual(betaBefore, "[]", "beta has lexical rows before alpha is reconciled");
    const metaBefore = await postgresQuery(
      "SELECT 1 FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = 'beta'",
      [instance]
    );
    assert.equal(metaBefore.rows.length, 1);

    // Dirty ONLY alpha, then reconcile ONLY alpha.
    await ingestRecord(target(connectorId, instance), rec("alpha", "a2", "alpha two"), { deferIndexes: true });
    await reconcileSearchIndexDirtyScope(await scopeFor(instance, "alpha"));

    assert.equal(await lexicalFingerprint(instance, "beta"), betaBefore, "beta lexical rows untouched (same xmin)");
    const metaAfter = await postgresQuery(
      "SELECT 1 FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = 'beta'",
      [instance]
    );
    assert.equal(metaAfter.rows.length, 1, "beta lexical meta preserved");
    assert.ok((await lexicalFingerprint(instance, "alpha")).includes("a2"), "alpha picked up its new record");
  });

  test("two sibling scopes whose semantic half keeps failing do not rewrite each other's lexical rows", async () => {
    const connectorId = "scope-iso-churn";
    const instance = "cin_scope_iso_churn";
    configureSemanticBackend(null);
    await registerConnector(manifestFor(connectorId, true));
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "alpha one"), { deferIndexes: true });
    await ingestRecord(target(connectorId, instance), rec("beta", "b1", "beta one"), { deferIndexes: true });
    configureSemanticBackend(failingBackend() as never);

    // First attempt per scope builds lexical, then fails on semantic.
    const first = new Map<string, string>();
    for (const stream of ["alpha", "beta"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture steps; each depends on the previous one.
      const outcome = await reconcileSearchIndexDirtyScope(await scopeFor(instance, stream));
      assert.equal(outcome.outcome, "failed");
      first.set(stream, await lexicalFingerprint(instance, stream));
      assert.notEqual(first.get(stream), "[]");
    }
    // Retries: lexical work is complete and must stay byte-for-byte untouched.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const stream of ["alpha", "beta"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture steps; each depends on the previous one.
        const outcome = await reconcileSearchIndexDirtyScope(
          (await scopeFor(instance, stream).catch(() => null as never)) ?? {
            connectorId,
            connectorInstanceId: instance,
            markedAt: "",
            revision: 1,
            stream,
          }
        );
        assert.equal(outcome.outcome, "failed");
        assert.equal(
          await lexicalFingerprint(instance, stream),
          first.get(stream),
          `${stream} lexical rows rewritten by retry ${attempt + 1}`
        );
      }
    }
    configureSemanticBackend(null);
  });

  test("a failure recorded on a parked scope keeps the park; persistent failure backs off beyond 600s; rearm restores retry", async () => {
    const connectorId = "scope-iso-backoff";
    const instance = "cin_scope_iso_backoff";
    configureSemanticBackend(null);
    await registerConnector(manifestFor(connectorId, false));
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "alpha one"), { deferIndexes: true });
    const key = { connectorInstanceId: instance, stream: "alpha" };
    const PARK = "2099-01-01T00:00:00.000Z";
    await postgresQuery(
      "UPDATE search_index_dirty SET next_attempt_at = $3 WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha", PARK]
    );
    await recordSearchIndexDirtyFailure(key, await revisionOf(instance), "in-flight failure after park");
    const parked = await postgresQuery<{ next_attempt_at: string }>(
      "SELECT next_attempt_at FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.equal(parked.rows[0]?.next_attempt_at, PARK, "in-flight failure must not pull a park back in");

    await postgresQuery(
      "UPDATE search_index_dirty SET attempts = 60, next_attempt_at = NULL WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    const before = Date.now();
    await recordSearchIndexDirtyFailure(key, await revisionOf(instance), "persistent failure");
    const row = await postgresQuery<{
      next_attempt_at: string;
      attempts: number;
    }>("SELECT next_attempt_at, attempts FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2", [
      instance,
      "alpha",
    ]);
    const delaySeconds = (Date.parse(row.rows[0]?.next_attempt_at as string) - before) / 1000;
    assert.ok(delaySeconds > 3600, `attempt ${row.rows[0]?.attempts} backs off ${delaySeconds}s, expected > 3600s`);

    await rearmSearchIndexDirtyScope(key);
    const rearmed = await postgresQuery<{
      next_attempt_at: string | null;
      attempts: number;
      dirty: number;
    }>(
      "SELECT next_attempt_at, attempts, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [instance, "alpha"]
    );
    assert.equal(rearmed.rows[0]?.next_attempt_at, null);
    assert.equal(rearmed.rows[0]?.attempts, 0);
    assert.equal(rearmed.rows[0]?.dirty, 1, "rearm never clears a dirty generation");
  });

  test("same-record reingest writes no lexical rows and does not re-dirty the scope", async () => {
    const connectorId = "scope-iso-noop";
    const instance = "cin_scope_iso_noop";
    configureSemanticBackend(null);
    await registerConnector(manifestFor(connectorId, false));
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "alpha one"));
    await new Promise((r) => setTimeout(r, 300));
    await settleScope(instance, "alpha");
    const lexBefore = await lexicalFingerprint(instance, "alpha");
    const dirtyBefore = await postgresQuery<{
      revision: string;
      dirty: number;
    }>(
      "SELECT revision::text AS revision, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
      [instance]
    );
    await ingestRecord(target(connectorId, instance), rec("alpha", "a1", "alpha one"));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await lexicalFingerprint(instance, "alpha"), lexBefore, "lexical rows untouched by noop reingest");
    const dirtyAfter = await postgresQuery<{ revision: string; dirty: number }>(
      "SELECT revision::text AS revision, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
      [instance]
    );
    assert.deepEqual(dirtyAfter.rows, dirtyBefore.rows, "no revision bump / re-dirty on noop reingest");
  });

  test("Postgres owner route parks and rearms an encoded retired dirty scope", async () => {
    const oldDatabaseUrl = process.env.PDPP_DATABASE_URL;
    const oldStorageBackend = process.env.PDPP_STORAGE_BACKEND;
    const connectorId = "scope-iso-owner-route";
    const connectorInstanceId = "cin_scope_iso_owner_route";
    const stream = "retired stream/1";
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
    process.env.PDPP_STORAGE_BACKEND = "postgres";
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_owner_search_index_${process.pid}_${Date.now().toString(36)}`,
      },
      async (databaseUrl) => {
        process.env.PDPP_DATABASE_URL = databaseUrl;
        const server = await startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          dbPath: ":memory:",
          ownerAuthPassword: OPERATOR_OWNER_PASSWORD,
          ownerAuthSubjectId: "owner_local",
          quiet: true,
          rsPort: 0,
        });
        try {
          await registerConnector(manifestFor(connectorId, false));
          await createPostgresConnectorInstanceStore().upsert({
            connectorId,
            connectorInstanceId,
            createdAt: "2026-10-15T00:00:00.000Z",
            displayName: "Postgres owner route",
            ownerSubjectId: "owner_local",
            sourceBinding: { account: "owner-route" },
            sourceBindingKey: "owner-route",
            sourceKind: "account",
            status: "active",
            updatedAt: "2026-10-15T00:00:00.000Z",
          });
          await withPostgresTransaction((client) =>
            markSearchIndexDirtyPostgres(
              client,
              { connectorId, connectorInstanceId, stream },
              "2026-10-15T00:00:00.000Z"
            )
          );
          const asUrl = `http://localhost:${server.asPort}`;
          const cookie = await ownerSessionCookie(asUrl);
          const encodedStream = encodeURIComponent(stream);
          const park = await fetch(
            `${asUrl}/_ref/connections/${connectorInstanceId}/search-index/${encodedStream}/park`,
            { headers: { Cookie: cookie }, method: "POST" }
          );
          assert.equal(park.status, 200);
          const parked = await postgresQuery<{
            operator_parked: number;
            revision: string;
          }>(
            "SELECT operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
            [connectorInstanceId, stream]
          );
          assert.deepEqual(parked.rows, [{ operator_parked: 1, revision: "2" }]);
          const rearm = await fetch(
            `${asUrl}/_ref/connections/${connectorInstanceId}/search-index/${encodedStream}/rearm`,
            { headers: { Cookie: cookie }, method: "POST" }
          );
          assert.equal(rearm.status, 200);
          const rearmed = await postgresQuery<{
            operator_parked: number;
            revision: string;
          }>(
            "SELECT operator_parked, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
            [connectorInstanceId, stream]
          );
          assert.deepEqual(rearmed.rows, [{ operator_parked: 0, revision: "3" }]);
        } finally {
          server.schedulerManager?.stop?.();
          await Promise.allSettled([
            new Promise((resolve) => server.asServer.close(resolve)),
            new Promise((resolve) => server.rsServer.close(resolve)),
          ]);
        }
      }
    );
    if (oldDatabaseUrl === undefined) delete process.env.PDPP_DATABASE_URL;
    else process.env.PDPP_DATABASE_URL = oldDatabaseUrl;
    if (oldStorageBackend === undefined) delete process.env.PDPP_STORAGE_BACKEND;
    else process.env.PDPP_STORAGE_BACKEND = oldStorageBackend;
  });
} else {
  test("search-index reconcile scope isolation -- SKIPPED (set PDPP_TEST_POSTGRES_URL to run)", () => {
    // Opt-in Postgres-profile test, per this repo's convention.
  });
}
