// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { postgresLexicalIndexPublishWithClient, postgresSemanticIndexPublishWithClient } from "../server/postgres-search.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "semantic-churn-fixture";
const INSTANCE_ID = "cin_semantic_churn_fixture";
const STREAM = "messages";
const RECORD_KEY = "rec-1";
const BODY_SCOPE_KEY = JSON.stringify([STREAM, "body"]);
const SUBJECT_SCOPE_KEY = JSON.stringify([STREAM, "subject"]);
const SUMMARY_SCOPE_KEY = JSON.stringify([STREAM, "summary"]);

interface SemanticEntry {
  scopeKey: string;
  vector: number[];
}

async function publishForStream(stream: string, entries: readonly SemanticEntry[]): Promise<void> {
  await withPostgresTransaction((client) =>
    postgresSemanticIndexPublishWithClient(client, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      entries: entries.map((entry) => ({ ...entry, recordKey: RECORD_KEY })),
      recordKey: RECORD_KEY,
      stream,
    })
  );
}

async function publish(entries: readonly SemanticEntry[]): Promise<void> {
  await publishForStream(STREAM, entries);
}

interface SemanticRow {
  ctid: string;
  embedding: string;
  scopeKey: string;
}

async function semanticRows(): Promise<SemanticRow[]> {
  const result = await postgresQuery<SemanticRow>(
    `SELECT ctid::text AS ctid, embedding::text AS embedding, scope_key AS "scopeKey"
     FROM semantic_search_blob
     WHERE connector_instance_id = $1 AND record_key = $2
     ORDER BY scope_key`,
    [INSTANCE_ID, RECORD_KEY]
  );
  return result.rows;
}

async function publishBothDerivedIndexes(): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await postgresLexicalIndexPublishWithClient(client, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      fields: { body: "a stable body", subject: "a stable subject" },
      recordKey: RECORD_KEY,
      stream: STREAM,
    });
    await postgresSemanticIndexPublishWithClient(client, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      entries: [{ recordKey: RECORD_KEY, scopeKey: BODY_SCOPE_KEY, vector: [0.25, 0.75] }],
      recordKey: RECORD_KEY,
      stream: STREAM,
    });
  });
}

function rowForScope(rows: readonly SemanticRow[], scopeKey: string): SemanticRow {
  const row = rows.find((candidate) => candidate.scopeKey === scopeKey);
  assert.ok(row, `fixture must contain ${scopeKey}`);
  return row;
}

if (POSTGRES_URL) {
  test("semantic publish writes only changed scopes and reconciles stale scopes", async () => {
    const databaseName = `pdpp_semantic_churn_${Date.now().toString(36)}`;
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });

        await publish([{ scopeKey: BODY_SCOPE_KEY, vector: [0.25, 0.75] }]);
        const initialBody = rowForScope(await semanticRows(), BODY_SCOPE_KEY);

        await publish([{ scopeKey: BODY_SCOPE_KEY, vector: [0.25, 0.75] }]);
        assert.deepEqual(
          rowForScope(await semanticRows(), BODY_SCOPE_KEY),
          initialBody,
          "identical embeddings must leave their physical rows untouched"
        );

        await publish([{ scopeKey: BODY_SCOPE_KEY, vector: [0.5, 0.5] }]);
        const changedBody = rowForScope(await semanticRows(), BODY_SCOPE_KEY);
        assert.notEqual(changedBody.ctid, initialBody.ctid, "changed embeddings must update their row");
        assert.notEqual(changedBody.embedding, initialBody.embedding, "changed embeddings must persist their value");

        await publish([
          { scopeKey: BODY_SCOPE_KEY, vector: [0.5, 0.5] },
          { scopeKey: SUBJECT_SCOPE_KEY, vector: [0.25, 0.75] },
        ]);
        const withSubject = await semanticRows();
        assert.equal(
          rowForScope(withSubject, BODY_SCOPE_KEY).ctid,
          changedBody.ctid,
          "adding a scope must not rewrite equal existing scopes"
        );

        await publish([
          { scopeKey: BODY_SCOPE_KEY, vector: [0.5, 0.5] },
          { scopeKey: SUMMARY_SCOPE_KEY, vector: [0.25, 0.75] },
        ]);
        const reconciled = await semanticRows();
        assert.equal(reconciled.length, 2, "stale scopes must be removed and new scopes inserted");
        assert.equal(
          rowForScope(reconciled, BODY_SCOPE_KEY).ctid,
          changedBody.ctid,
          "removing a different scope must not rewrite equal existing scopes"
        );
        assert.equal(
          reconciled.some((row) => row.scopeKey === SUBJECT_SCOPE_KEY),
          false,
          "removed scopes must not remain indexed"
        );
        assert.ok(reconciled.some((row) => row.scopeKey === SUMMARY_SCOPE_KEY), "new scopes must be indexed");

        await publish([]);
        assert.deepEqual(await semanticRows(), [], "an empty publish must remove all semantic scopes for the record");

        const wildcardStream = "a%b";
        const literalStream = "axb";
        const wildcardScopeKey = JSON.stringify([wildcardStream, "body"]);
        const literalScopeKey = JSON.stringify([literalStream, "body"]);
        await publishForStream(wildcardStream, [{ scopeKey: wildcardScopeKey, vector: [0.25, 0.75] }]);
        await publishForStream(literalStream, [{ scopeKey: literalScopeKey, vector: [0.5, 0.5] }]);
        await publishForStream(wildcardStream, []);
        assert.ok(
          (await semanticRows()).some((row) => row.scopeKey === literalScopeKey),
          "a stream name containing SQL LIKE wildcards must not delete another stream's scope"
        );
      }
    );
  });

  test("N identical derived-index reconciliation publishes leave dead-tuple pressure and relation size bounded", async () => {
    const databaseName = `pdpp_derived_index_bloat_${Date.now().toString(36)}`;
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await publishBothDerivedIndexes();
        const before = await postgresQuery<{ bytes: string; relname: string }>(
          `SELECT relname, pg_relation_size(relid)::text AS bytes
             FROM pg_stat_user_tables
            WHERE relname = ANY($1::text[])
            ORDER BY relname`,
          [["lexical_search_index", "semantic_search_blob"]]
        );

        for (let attempt = 0; attempt < 20; attempt += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: each transaction is one production reconciliation publish.
          await publishBothDerivedIndexes();
        }
        await postgresQuery("ANALYZE lexical_search_index", []);
        await postgresQuery("ANALYZE semantic_search_blob", []);
        const after = await postgresQuery<{ bytes: string; n_dead_tup: string; n_live_tup: string; relname: string }>(
          `SELECT relname, n_live_tup::text, n_dead_tup::text, pg_relation_size(relid)::text AS bytes
             FROM pg_stat_user_tables
            WHERE relname = ANY($1::text[])
            ORDER BY relname`,
          [["lexical_search_index", "semantic_search_blob"]]
        );

        assert.equal(after.rows.length, 2, "fixture must measure both derived Postgres relations");
        for (const row of after.rows) {
          const baseline = before.rows.find((candidate) => candidate.relname === row.relname);
          assert.ok(baseline, `fixture captured ${row.relname} before repeated publishes`);
          const live = Number(row.n_live_tup);
          const dead = Number(row.n_dead_tup);
          assert.ok(dead / Math.max(live, 1) <= 0.1, `${row.relname} dead/live ratio stays under 10% after 20 no-op publishes`);
          assert.ok(
            Number(row.bytes) <= Number(baseline.bytes) + 8192,
            `${row.relname} stays within one Postgres page of its initial relation size`
          );
        }
      }
    );
  });
} else {
  test("semantic index write-elision (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
