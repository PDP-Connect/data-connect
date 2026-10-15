// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real-Postgres proof that a scope-pinned reconcile (a) resumes a lexical
// rebuild after a failed batch without erasing completed rows, (b) leaves
// healthy sibling streams and other connector instances' lexical AND semantic
// indexes untouched, and (c) keeps the default full-manifest orphan cleanup for
// callers that did not opt out.
//
// Same-record reingest ("noop") is deliberately NOT index-silent in one case:
// ingest of an unchanged record whose index anchor is missing re-marks the
// scope dirty on purpose (self-heal). Tested in the sibling file's noop test
// for the anchored case; the missing-anchor repair is intentional healing.
//
// Run: PDPP_TEST_POSTGRES_URL=postgresql://... \
//   node --test --import tsx test/search-index-lexical-resume.postgres.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { lexicalIndexBackfillForManifest } from "../server/search.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import type { DirtySearchIndexScope } from "../server/stores/search-index-dirty-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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
const rec = (stream: string, key: string, subject: string, op: "delete" | "upsert" = "upsert") => ({
  data: { id: key, subject },
  emitted_at: "2026-08-09T00:00:00.000Z",
  key,
  op,
  stream,
});

async function lexicalRows(instance: string, stream: string) {
  const { rows } = await postgresQuery<{
    record_key: string;
    value: string;
    xmin: string;
  }>(
    `SELECT record_key, value, xmin::text AS xmin FROM lexical_search_index
     WHERE connector_instance_id = $1 AND stream = $2 ORDER BY record_key, field`,
    [instance, stream]
  );
  return rows;
}

async function semanticState(instance: string, keyPrefix: string, stream: string) {
  const blobs = await postgresQuery(
    `SELECT scope_key, record_key, xmin::text AS xmin FROM semantic_search_blob
     WHERE connector_instance_id = $1 AND record_key LIKE $2 ORDER BY scope_key, record_key`,
    [instance, `${keyPrefix}%`]
  );
  const meta = await postgresQuery(
    `SELECT stream, fields_fingerprint, updated_at, xmin::text AS xmin FROM semantic_search_meta
     WHERE connector_instance_id = $1 AND stream = $2`,
    [instance, stream]
  );
  return JSON.stringify({ blobs: blobs.rows, meta: meta.rows });
}

async function currentScope(connectorId: string, instance: string, stream: string): Promise<DirtySearchIndexScope> {
  const { rows } = await postgresQuery<{ revision: string; marked_at: string }>(
    "SELECT revision::text AS revision, marked_at FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
    [instance, stream]
  );
  assert.ok(rows[0], `dirty row for ${instance}/${stream}`);
  return {
    connectorId,
    connectorInstanceId: instance,
    markedAt: rows[0].marked_at,
    revision: Number(rows[0].revision),
    stream,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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

  test("a failed lexical batch keeps completed batches (stable xmin); retry fixes changed/deleted rows and writes nothing else", async () => {
    configureSemanticBackend(null);
    const connectorId = "lex-resume";
    const instance = "cin_lex_resume";
    await registerConnector(manifestFor(connectorId, false));
    const TOTAL = 1100; // pages of 500: [1..500] [501..1000] [1001..1100]
    for (let i = 1; i <= TOTAL; i += 1) {
      const key = `k${String(i).padStart(4, "0")}`;
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest, one durable transaction per record.
      await ingestRecord(target(connectorId, instance), rec("alpha", key, `subject ${key}`), { deferIndexes: true });
    }
    await postgresQuery(`CREATE OR REPLACE FUNCTION lex_resume_poison() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected batch failure'; END; $$ LANGUAGE plpgsql`);
    await postgresQuery(`CREATE TRIGGER lex_resume_poison BEFORE INSERT ON lexical_search_index
      FOR EACH ROW WHEN (NEW.record_key = 'k0700') EXECUTE FUNCTION lex_resume_poison()`);
    const failed = await reconcileSearchIndexDirtyScope(await currentScope(connectorId, instance, "alpha"));
    assert.equal(failed.outcome, "failed");
    const afterFailure = await lexicalRows(instance, "alpha");
    assert.equal(afterFailure.length, 500, "page 1 survived; failed page 2 rolled back; nothing wiped");
    await postgresQuery("DROP TRIGGER lex_resume_poison ON lexical_search_index");

    // Between attempts: one value changes (already-indexed page), one record is deleted.
    await ingestRecord(target(connectorId, instance), rec("alpha", "k0001", "changed value"), { deferIndexes: true });
    await ingestRecord(target(connectorId, instance), rec("alpha", "k0002", "x", "delete"), { deferIndexes: true });

    const ok = await reconcileSearchIndexDirtyScope(await currentScope(connectorId, instance, "alpha"));
    assert.equal(ok.outcome, "converged");
    const final = await lexicalRows(instance, "alpha");
    assert.equal(final.length, TOTAL - 1);
    assert.equal(final.find((r) => r.record_key === "k0001")?.value, "changed value");
    assert.equal(
      final.find((r) => r.record_key === "k0002"),
      undefined,
      "deleted record's row pruned"
    );
    const before = new Map(afterFailure.map((r) => [r.record_key, r.xmin]));
    for (const row of final) {
      if (before.has(row.record_key) && row.record_key !== "k0001") {
        assert.equal(row.xmin, before.get(row.record_key), `${row.record_key} rewritten by retry`);
      }
    }
  });

  test("healthy sibling stream and another instance keep lexical rows, semantic vectors and meta when one scope is reconciled", async () => {
    const connectorId = "lex-sibling-semantic";
    const one = "cin_lex_sib_one";
    const two = "cin_lex_sib_two";
    configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
    await registerConnector(manifestFor(connectorId, true));
    for (const instance of [one, two]) {
      for (const stream of ["alpha", "beta"]) {
        const prefix = stream === "alpha" ? "a" : "b";
        // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest.
        await ingestRecord(target(connectorId, instance), rec(stream, `${prefix}1`, `${stream} ${instance} one`), {
          deferIndexes: true,
        });
        await reconcileSearchIndexDirtyScope(await currentScope(connectorId, instance, stream));
      }
    }
    const guarded = async () => ({
      alphaTwo: [await lexicalRows(two, "alpha"), await semanticState(two, "a", "alpha")],
      betaOne: [await lexicalRows(one, "beta"), await semanticState(one, "b", "beta")],
      betaTwo: [await lexicalRows(two, "beta"), await semanticState(two, "b", "beta")],
    });
    const before = await guarded();
    assert.ok(
      (before.betaOne[0]?.length ?? 0) > 0 && JSON.parse(before.betaOne[1] as string).blobs.length > 0,
      "fixture has vectors"
    );

    await ingestRecord(target(connectorId, one), rec("alpha", "a2", "alpha one two"), { deferIndexes: true });
    const outcome = await reconcileSearchIndexDirtyScope(await currentScope(connectorId, one, "alpha"));
    const failure = await postgresQuery<{ last_error: string | null }>(
      "SELECT last_error FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
      [one]
    );
    assert.equal(outcome.outcome, "converged", failure.rows[0]?.last_error ?? "no failure evidence");
    assert.deepEqual(await guarded(), before, "sibling stream and other instance untouched (xmin-identical)");
    const alphaOne = await semanticState(one, "a", "alpha");
    assert.ok(
      JSON.parse(alphaOne).blobs.some((b: { record_key: string }) => b.record_key === "a2"),
      "alpha itself converged"
    );

    // Noop semantic: re-reconciling an already-converged scope writes no vector rows.
    const stable = await semanticState(one, "a", "alpha");
    await postgresQuery(
      "UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1 AND stream = 'alpha'",
      [one]
    );
    await reconcileSearchIndexDirtyScope(await currentScope(connectorId, one, "alpha"));
    assert.equal(await semanticState(one, "a", "alpha"), stable, "noop semantic reconcile: identical xmin/meta");
    configureSemanticBackend(null);
  });

  test("control: lexicalIndexBackfillForManifest with default options still drops streams the full manifest no longer names", async () => {
    configureSemanticBackend(null);
    const connectorId = "lex-default-cleanup";
    const instance = "cin_lex_default_cleanup";
    await registerConnector(manifestFor(connectorId, false));
    for (const stream of ["alpha", "beta"]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest.
      await ingestRecord(target(connectorId, instance), rec(stream, "k1", `${stream} text`));
    }
    await settle();
    assert.ok((await lexicalRows(instance, "beta")).length > 0);
    const manifest = {
      ...manifestFor(connectorId, false),
      storage_binding: { connector_instance_id: instance },
      streams: [streamDef("alpha", false)],
    };
    await lexicalIndexBackfillForManifest({ manifest } as never);
    assert.equal((await lexicalRows(instance, "beta")).length, 0, "default (full-manifest) orphan cleanup unchanged");
    assert.ok((await lexicalRows(instance, "alpha")).length > 0);
  });
} else {
  test("lexical resume / semantic isolation -- SKIPPED (set PDPP_TEST_POSTGRES_URL to run)", () => {
    // Opt-in Postgres-profile test, per this repo's convention.
  });
}
