// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { lexicalIndexBackfillForManifest } from "../server/search.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
  isSearchIndexScopeDirty,
  listDirtySearchIndexScopes,
  markSearchIndexDirtyPostgres,
} from "../server/stores/search-index-dirty-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function manifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        query: { search: { lexical_fields: ["subject"] } },
        schema: {
          properties: { id: { type: "string" }, subject: { type: "string" } },
          required: ["id", "subject"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

async function seed(connectorId: string, instance: string) {
  const result = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: instance },
    {
      data: { id: "k1", subject: "canonical" },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key: "k1",
      stream: "items",
    },
    { deferIndexes: true },
  );
  assert.equal(result.accepted, true);
}

async function getScope(instance: string) {
  const scope = (await listDirtySearchIndexScopes(100)).find(
    (candidate) => candidate.connectorInstanceId === instance && candidate.stream === "items",
  );
  assert.ok(scope);
  return scope;
}

test("G1 PostgreSQL: metadata-less lexical cleanup repairs only the exact connection", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  timeout: 60_000,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_search_reconcile_g1_${process.pid}_${Date.now().toString(36)}`,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        const runCase = async (removed: boolean) => {
          const connectorId = removed ? "gap-g1-removed" : "gap-g1-retained";
          const instance = `${connectorId}-instance`;
          const sibling = `${connectorId}-sibling`;
          const original = manifest(connectorId);
          await registerConnector(original);
          await seed(connectorId, instance);
          await seed(connectorId, sibling);
          await lexicalIndexBackfillForManifest({
            manifest: {
              ...original,
              storage_binding: { connector_instance_id: instance },
            },
          });
          await lexicalIndexBackfillForManifest({
            manifest: {
              ...original,
              storage_binding: { connector_instance_id: sibling },
            },
          });
          const siblingBefore = await postgresQuery(
            "SELECT record_key, field, value FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'items' ORDER BY record_key, field",
            [sibling],
          );
          await postgresQuery("DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = 'items'", [
            instance,
          ]);
          const [sourceStream] = original.streams;
          assert.ok(sourceStream);
          const changed = {
            ...original,
            streams: [
              {
                ...sourceStream,
                name: removed ? "other" : "items",
                query: { search: {} },
              },
            ],
          };
          await registerConnector(changed, {
            backfillRetrievalIndexes: false,
          });
          await withPostgresTransaction(async (client) => {
            await markSearchIndexDirtyPostgres(
              client,
              {
                connectorId,
                connectorInstanceId: instance,
                stream: "items",
              },
              "2026-07-16T00:00:00.000Z",
            );
          });
          const result = await reconcileSearchIndexDirtyScope(await getScope(instance));
          const rows = await postgresQuery(
            "SELECT record_key, field, value FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'items' ORDER BY record_key, field",
            [instance],
          );
          assert.deepEqual(rows.rows, [], "metadata absence must not hide physical cleanup debt");
          assert.equal(result.outcome, "converged");
          assert.equal(
            await isSearchIndexScopeDirty({
              connectorInstanceId: instance,
              stream: "items",
            }),
            false,
          );
          const siblingAfter = await postgresQuery(
            "SELECT record_key, field, value FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'items' ORDER BY record_key, field",
            [sibling],
          );
          assert.deepEqual(siblingAfter.rows, siblingBefore.rows, "repair remains exact-instance scoped");
        };
        await runCase(false);
        await runCase(true);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    },
  );
});
