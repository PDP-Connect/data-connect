// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest, lexicalIndexBackfillForManifest } from "../server/search.ts";
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
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    version: "0.1.0",
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
          type: "object",
          properties: { id: { type: "string" }, subject: { type: "string" } },
          required: ["id", "subject"],
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
  };
}

async function seed(connectorId: string, instance: string, key = "k1") {
  const outcome = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: instance },
    {
      stream: "items",
      key,
      emitted_at: "2026-07-16T00:00:00.000Z",
      data: { id: key, subject: `canonical ${key}` },
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

function lexicalRows(instance: string) {
  return getDb()
    .prepare(
      "SELECT rowid, record_key, field, text FROM lexical_search_index " +
        "WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key, field, rowid",
    )
    .all(instance, "items");
}

function reset() {
  __setLexicalBackfillPhaseHookForTest(null);
  configureSemanticBackend(null);
  resetVectorIndexForTests();
  closeDb();
}

test("G1: lexical index-only cleanup debt is removed before dirty completion", {
  concurrency: false,
  timeout: 15000,
}, async (t) => {
  for (const removed of [false, true]) {
    await t.test(removed ? "removed stream" : "retained stream without lexical fields", async () => {
      initDb(":memory:");
      configureSemanticBackend(null);
      const connectorId = "gap-lex-meta";
      const instance = "cin_gap_lex_meta";
      const sibling = "cin_gap_lex_meta_sibling";
      const m = manifest(connectorId);
      try {
        await registerConnector(m);
        await seed(connectorId, instance);
        await seed(connectorId, sibling);
        for (const id of [instance, sibling]) {
          await lexicalIndexBackfillForManifest({
            manifest: {
              ...m,
              storage_binding: { connector_instance_id: id },
            },
          });
        }
        assert.equal(lexicalRows(instance).length, 1, "real index row must exist");
        const siblingBefore = lexicalRows(sibling);
        getDb()
          .prepare("DELETE FROM lexical_search_meta WHERE connector_instance_id = ? AND stream = ?")
          .run(instance, "items");
        const original = m.streams[0]!;
        const changed = {
          ...m,
          streams: [
            {
              ...original,
              name: removed ? "other" : "items",
              query: { search: {} },
            },
          ],
        };
        await registerConnector(changed, { backfillRetrievalIndexes: false });
        mark(connectorId, instance);
        const result = await reconcileSearchIndexDirtyScope(await scope(instance));
        assert.deepEqual(lexicalRows(instance), [], "meta absence must not hide physical cleanup debt");
        assert.equal(result.outcome, "converged");
        assert.equal(
          await isSearchIndexScopeDirty({
            connectorInstanceId: instance,
            stream: "items",
          }),
          false,
        );
        assert.deepEqual(lexicalRows(sibling), siblingBefore, "repair remains exact-instance scoped");
      } finally {
        reset();
      }
    });
  }
});

test("G1: a stream that never had lexical state is not cleaned on every pass", {
  concurrency: false,
  timeout: 15000,
}, async () => {
  initDb(":memory:");
  configureSemanticBackend(null);
  const connectorId = "gap-lex-never-indexed";
  const instance = "cin_gap_lex_never_indexed";
  const base = manifest(connectorId);
  const m = { ...base, streams: [{ ...base.streams[0]!, query: { search: {} } }] };
  const cleanups: string[] = [];
  try {
    await registerConnector(m);
    await seed(connectorId, instance);
    __setLexicalBackfillPhaseHookForTest(async (phase, info) => {
      if (phase === "before-stream-cleanup") cleanups.push(String(info?.stream));
    });
    for (let pass = 0; pass < 2; pass += 1) {
      await lexicalIndexBackfillForManifest({
        manifest: { ...m, storage_binding: { connector_instance_id: instance } },
      });
    }
    assert.deepEqual(cleanups, [], "no meta and no index rows means nothing to delete");
  } finally {
    reset();
  }
});

test("G1: reconciling a removed stream keeps the semantic index of a declared sibling stream", {
  concurrency: false,
  timeout: 15000,
}, async () => {
  initDb(":memory:");
  resetVectorIndexForTests("blob-flat");
  const backend = makeStubBackend({ dimensions: 8 });
  configureSemanticBackend(backend);
  const connectorId = "gap-lex-removed-semantic-sibling";
  const instance = "cin_gap_lex_removed_semantic_sibling";
  const semanticStream = (name: string) => ({
    ...manifest(connectorId, true).streams[0]!,
    name,
  });
  const both = { ...manifest(connectorId, true), streams: [semanticStream("items"), semanticStream("notes")] };
  const vectors = (stream: string) =>
    getDb()
      .prepare(
        "SELECT record_key FROM semantic_search_blob WHERE connector_instance_id = ? AND scope_key LIKE ? ORDER BY record_key"
      )
      .all(instance, `[${JSON.stringify(stream)},%`);
  try {
    await registerConnector(both);
    for (const stream of ["items", "notes"]) {
      const outcome = await ingestRecord(
        { connector_id: connectorId, connector_instance_id: instance },
        { data: { id: "k1", subject: `canonical ${stream}` }, emitted_at: "2026-07-16T00:00:00.000Z", key: "k1", stream },
        { deferIndexes: true }
      );
      assert.equal(outcome.accepted, true);
    }
    await semanticIndexBackfillForManifest({
      manifest: { ...both, storage_binding: { connector_instance_id: instance } },
      orphanStreamCleanup: false,
    });
    assert.equal(vectors("notes").length, 1, "the sibling must start with a real vector");
    await registerConnector({ ...both, streams: [semanticStream("notes")] }, { backfillRetrievalIndexes: false });
    mark(connectorId, instance);
    const result = await reconcileSearchIndexDirtyScope(await scope(instance));
    assert.equal(result.outcome, "converged");
    assert.deepEqual(vectors("items"), [], "the removed stream's vectors are cleaned");
    assert.equal(vectors("notes").length, 1, "a declared sibling stream must keep its semantic index");
  } finally {
    reset();
  }
});
