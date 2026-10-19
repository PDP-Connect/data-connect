// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
  configureSemanticBackend,
  makeStubBackend,
  resetVectorIndexForTests,
  semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";
import {
  isSearchIndexScopeDirty,
  listDirtySearchIndexScopes,
  markSearchIndexDirtySqlite,
} from "../server/stores/search-index-dirty-store.ts";

function manifest(connectorId: string, semantic = false) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: "https://sources.example/" + connectorId,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        query: {
          search: semantic
            ? { lexical_fields: ["subject"], semantic_fields: ["subject"] }
            : { lexical_fields: ["subject"] },
        },
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

async function seed(connectorId: string, instance: string, key = "k1") {
  const outcome = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: instance },
    {
      data: { id: key, subject: "canonical " + key },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key,
      stream: "items",
    },
    { deferIndexes: true },
  );
  assert.equal(outcome.accepted, true);
}

function mark(connectorId: string, instance: string) {
  markSearchIndexDirtySqlite(
    { connectorId, connectorInstanceId: instance, stream: "items" },
    "2026-07-16T00:00:00.000Z",
  );
}

async function scope(instance: string) {
  const result = (await listDirtySearchIndexScopes(100)).find(
    (s) => s.connectorInstanceId === instance && s.stream === "items",
  );
  assert.ok(result, "fixture must have an eligible dirty scope");
  return result;
}

function reset() {
  configureSemanticBackend(null);
  resetVectorIndexForTests();
  closeDb();
}

test("G2: backend-unavailable vector-only cleanup debt cannot be acknowledged", {
  concurrency: false,
  timeout: 15_000,
}, async () => {
  initDb(":memory:");
  resetVectorIndexForTests("blob-flat");
  const backend = makeStubBackend({ dimensions: 8 });
  configureSemanticBackend(backend);
  const connectorId = "gap-sem-meta";
  const instance = "cin_gap_sem_meta";
  const m = manifest(connectorId, true);
  try {
    await registerConnector(m);
    await seed(connectorId, instance);
    await semanticIndexBackfillForManifest({
      manifest: { ...m, storage_binding: { connector_instance_id: instance } },
      orphanStreamCleanup: false,
    });
    const vectors = () =>
      getDb()
        .prepare("SELECT record_key FROM semantic_search_blob WHERE connector_instance_id = ? ORDER BY record_key")
        .all(instance);
    assert.equal(vectors().length, 1, "must exercise actual persisted vector debt");
    getDb().prepare("DELETE FROM semantic_search_meta WHERE connector_instance_id = ?").run(instance);
    getDb().prepare("DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = ?").run(instance);
    await registerConnector(manifest(connectorId), {
      backfillRetrievalIndexes: false,
    });
    configureSemanticBackend(null);
    mark(connectorId, instance);
    const observed = await scope(instance);
    const result = await reconcileSearchIndexDirtyScope(observed);
    assert.equal(result.outcome, "failed", "cleanup remains unproven without a backend");
    assert.equal(
      await isSearchIndexScopeDirty({
        connectorInstanceId: instance,
        stream: "items",
      }),
      true,
    );
    assert.equal(vectors().length, 1, "the unavailable pass must not claim absent vectors");
    configureSemanticBackend(backend);
    assert.equal((await reconcileSearchIndexDirtyScope(observed)).outcome, "converged");
    assert.deepEqual(vectors(), []);
    assert.equal(
      await isSearchIndexScopeDirty({
        connectorInstanceId: instance,
        stream: "items",
      }),
      false,
    );
  } finally {
    reset();
  }
});
