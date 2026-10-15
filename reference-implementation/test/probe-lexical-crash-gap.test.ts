// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Probe: does startup LEXICAL backfill detect a record that was durably
// written but never got its index maintenance run (crash-abandoned)?
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord, ingestRecords } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest, lexicalIndexBackfillForManifest } from "../server/search.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { markSearchIndexDirtySqlite } from "../server/stores/search-index-dirty-store.ts";

function target(connectorInstanceId: string) {
  return { connector_id: "crash-gap-lex", connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-07-16T00:00:00.000Z",
    key,
    stream,
  };
}

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: "crash-gap-lex",
  display_name: "Crash gap lexical probe",
  manifest_uri: "https://registry.pdpp.dev/connectors/crash-gap-lex",
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
      semantics: "append_only",
    },
  ],
  version: "0.1.0",
};

// A SEPARATE manifest object (never passed to registerConnector, which
// rejects unknown fields) pinning storage_binding.connector_instance_id to
// the SAME id `ingestRecord` writes to below. Without this,
// resolveLexicalBackfillConnectorInstanceIds falls back to
// listActiveOwnerBindingsForConnectors (no owner binding exists for a raw
// direct-ingest probe) and then to the synthetic default account instance
// id -- a DIFFERENT (empty) scope than the one this probe actually wrote to,
// so the drift-check would trivially report "in sync" against zero records
// and prove nothing about the real comparison logic. Production callers
// reach this same pinned path via a real owner binding or an explicit
// storage_binding; this is the narrowest way to exercise the identical code
// path (`search.ts` reads `manifest.storage_binding?.connector_instance_id`
// as a plain property, independent of registerConnector's schema gate).
const backfillManifest = { ...baseManifest, storage_binding: { connector_instance_id: "cin_crash_gap_lex_a" } };
const LATER_PAGE_FAILURE = /injected later-page failure/;

test("PROBE: startup lexical backfill catches a record whose index maintenance never ran", async () => {
  initDb(":memory:");
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k1", "indexed normally"));
    await lexicalIndexBackfillForManifest({ manifest: backfillManifest });

    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k2", "never indexed"), {
      deferIndexes: true,
    });

    const metaBefore = getDb()
      .prepare("SELECT * FROM lexical_search_meta WHERE connector_instance_id = ?")
      .all("cin_crash_gap_lex_a");
    console.log("meta before second backfill:", metaBefore);
    const recordsCount = getDb()
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0")
      .get("cin_crash_gap_lex_a", "items");
    console.log("live records count:", recordsCount);

    await lexicalIndexBackfillForManifest({ manifest: backfillManifest });

    const rows = getDb()
      .prepare("SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = ?")
      .all("cin_crash_gap_lex_a") as { record_key: string }[];
    const keys = [...new Set(rows.map((r) => r.record_key))].sort();
    console.log("lexical indexed keys after second startup backfill:", keys);
    assert.deepEqual(keys, ["k1", "k2"], "lexical startup backfill should have caught the crash-abandoned record k2");
  } finally {
    closeDb();
  }
});

test("SQLite: lexical reconcile repairs same-key same-count text drift after deferred maintenance", async () => {
  initDb(":memory:");
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k1", "canonical A"));
    await ingestRecord(target("cin_crash_gap_lex_sibling"), record("items", "k1", "sibling healthy"));
    await lexicalIndexBackfillForManifest({ manifest: backfillManifest });
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: "cin_crash_gap_lex_sibling" } },
    });
    const siblingRowBefore = getDb()
      .prepare(
        "SELECT rowid, text FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get("cin_crash_gap_lex_sibling", "k1", "subject") as { rowid: number; text: string };
    await runSearchIndexDirtyReconcileRound();

    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k1", "canonical B"), { deferIndexes: true });
    // Model the durable write transaction's dirty mark surviving a failure
    // before deferred index maintenance completes.
    markSearchIndexDirtySqlite(
      { connectorId: "crash-gap-lex", connectorInstanceId: "cin_crash_gap_lex_a", stream: "items" },
      new Date().toISOString()
    );
    getDb()
      .prepare(
        "UPDATE search_index_dirty SET attempts = 0, next_attempt_at = NULL WHERE connector_instance_id = ? AND stream = ?"
      )
      .run("cin_crash_gap_lex_a", "items");
    const round = await runSearchIndexDirtyReconcileRound();

    assert.equal(round.succeeded, 1, "reconcile should prove and clear the changed generation");

    const values = getDb()
      .prepare("SELECT text FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?")
      .all("cin_crash_gap_lex_a", "k1", "subject") as { text: string }[];
    assert.deepEqual(
      values.map((row) => row.text),
      ["canonical B"]
    );
    const siblingRowAfter = getDb()
      .prepare(
        "SELECT rowid, text FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get("cin_crash_gap_lex_sibling", "k1", "subject") as { rowid: number; text: string };
    assert.deepEqual(siblingRowAfter, siblingRowBefore, "repair must not rewrite a healthy sibling instance");

    markSearchIndexDirtySqlite(
      { connectorId: "crash-gap-lex", connectorInstanceId: "cin_crash_gap_lex_a", stream: "items" },
      new Date().toISOString()
    );
    getDb()
      .prepare(
        "UPDATE search_index_dirty SET attempts = 0, next_attempt_at = NULL WHERE connector_instance_id = ? AND stream = ?"
      )
      .run("cin_crash_gap_lex_a", "items");
    const noOpBefore = getDb()
      .prepare(
        "SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get("cin_crash_gap_lex_a", "k1", "subject") as { rowid: number };
    assert.equal((await runSearchIndexDirtyReconcileRound()).succeeded, 1);
    const noOpAfter = getDb()
      .prepare(
        "SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get("cin_crash_gap_lex_a", "k1", "subject") as { rowid: number };
    assert.equal(noOpAfter.rowid, noOpBefore.rowid, "an in-sync dirty reconcile must not rewrite lexical rows");
  } finally {
    closeDb();
  }
});

test("SQLite: retry after a later-page failure preserves completed lexical rows", async () => {
  initDb(":memory:");
  const connectorInstanceId = "cin_crash_gap_lex_resume";
  try {
    await registerConnector(baseManifest);
    await ingestRecords(
      target(connectorInstanceId),
      Array.from({ length: 501 }, (_, i) => record("items", `k${String(i).padStart(4, "0")}`, `value ${i}`))
    );
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: connectorInstanceId } },
    });
    getDb()
      .prepare("DELETE FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .run(connectorInstanceId, "k0500");
    const rowidBefore = getDb()
      .prepare(
        "SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get(connectorInstanceId, "k0000", "subject") as { rowid: number };

    let fetchedPages = 0;
    __setLexicalBackfillPhaseHookForTest((point) => {
      if (point === "after-page-fetch") {
        fetchedPages += 1;
        if (fetchedPages === 2) {
          throw new Error("injected later-page failure");
        }
      }
    });
    await assert.rejects(
      lexicalIndexBackfillForManifest({
        manifest: { ...baseManifest, storage_binding: { connector_instance_id: connectorInstanceId } },
      }),
      LATER_PAGE_FAILURE
    );
    __setLexicalBackfillPhaseHookForTest(null);
    const rowidAfterFailure = getDb()
      .prepare(
        "SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get(connectorInstanceId, "k0000", "subject") as { rowid: number };
    assert.equal(
      rowidAfterFailure.rowid,
      rowidBefore.rowid,
      "the completed first page must remain intact after the later-page failure"
    );

    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: connectorInstanceId } },
    });
    const rowidAfterRetry = getDb()
      .prepare(
        "SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ? AND field = ?"
      )
      .get(connectorInstanceId, "k0000", "subject") as { rowid: number };
    assert.equal(rowidAfterRetry.rowid, rowidBefore.rowid, "retry must leave unchanged completed rows untouched");
    assert.equal(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?")
        .get(connectorInstanceId)?.n,
      501
    );
  } finally {
    __setLexicalBackfillPhaseHookForTest(null);
    closeDb();
  }
});

test("SQLite reconcile rejects duplicate lexical pairs that hide a missing canonical pair", async () => {
  initDb(":memory:");
  const connectorInstanceId = "cin_crash_gap_lex_duplicate_identity";
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target(connectorInstanceId), record("items", "A", "value A"));
    await ingestRecord(target(connectorInstanceId), record("items", "B", "value B"));
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: connectorInstanceId } },
    });
    const indexed = getDb()
      .prepare(
        "SELECT rowid, record_key, field, text FROM lexical_search_index WHERE connector_instance_id = ? AND stream = ? ORDER BY rowid"
      )
      .all(connectorInstanceId, "items") as { rowid: number; record_key: string; field: string; text: string }[];
    assert.equal(indexed.length, 2);
    getDb().prepare("DELETE FROM lexical_search_index WHERE rowid = ?").run(indexed[1]?.rowid);
    getDb()
      .prepare(
        "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?, ?)"
      )
      .run("crash-gap-lex", connectorInstanceId, "items", "A", "subject", "value A");
    markSearchIndexDirtySqlite(
      { connectorId: "crash-gap-lex", connectorInstanceId, stream: "items" },
      new Date().toISOString()
    );
    getDb()
      .prepare(
        "UPDATE search_index_dirty SET attempts = 0, next_attempt_at = NULL WHERE connector_instance_id = ? AND stream = ?"
      )
      .run(connectorInstanceId, "items");

    const round = await runSearchIndexDirtyReconcileRound();
    const actual = getDb()
      .prepare(
        "SELECT record_key, field, text FROM lexical_search_index WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key, field"
      )
      .all(connectorInstanceId, "items");
    assert.deepEqual(actual, [
      { field: "subject", record_key: "A", text: "value A" },
      { field: "subject", record_key: "B", text: "value B" },
    ]);
    assert.equal(round.succeeded, 1);
  } finally {
    closeDb();
  }
});

test("SQLite reconcile removes duplicate candidates beyond one bounded lookup page", async () => {
  initDb(":memory:");
  const connectorInstanceId = "cin_crash_gap_lex_many_duplicates";
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target(connectorInstanceId), record("items", "A", "canonical"));
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: connectorInstanceId } },
    });
    const insert = getDb().prepare(
      "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?, ?)"
    );
    getDb().transaction(() => {
      for (let i = 0; i < 1005; i += 1) {
        insert.run("crash-gap-lex", connectorInstanceId, "items", "A", "subject", i === 1004 ? "stale" : "canonical");
      }
    })();
    markSearchIndexDirtySqlite(
      { connectorId: "crash-gap-lex", connectorInstanceId, stream: "items" },
      new Date().toISOString()
    );
    getDb()
      .prepare(
        "UPDATE search_index_dirty SET attempts = 0, next_attempt_at = NULL WHERE connector_instance_id = ? AND stream = ?"
      )
      .run(connectorInstanceId, "items");

    const round = await runSearchIndexDirtyReconcileRound();
    const rows = getDb()
      .prepare(
        "SELECT record_key, field, text FROM lexical_search_index WHERE connector_instance_id = ? AND stream = ?"
      )
      .all(connectorInstanceId, "items");
    assert.equal(round.succeeded, 1);
    assert.deepEqual(rows, [{ field: "subject", record_key: "A", text: "canonical" }]);
  } finally {
    closeDb();
  }
});

test("SQLite stale lexical prune cannot delete a sibling row that reuses a stale rowid", async () => {
  initDb(":memory:");
  const staleInstance = "cin_crash_gap_lex_prune_stale";
  const siblingInstance = "cin_crash_gap_lex_prune_sibling";
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target(staleInstance), record("items", "stale", "stale"));
    await ingestRecord(target(siblingInstance), record("items", "sibling", "healthy"));
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: staleInstance } },
    });
    await lexicalIndexBackfillForManifest({
      manifest: { ...baseManifest, storage_binding: { connector_instance_id: siblingInstance } },
    });
    const stale = getDb()
      .prepare("SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .get(staleInstance, "stale") as { rowid: number };
    const sibling = getDb()
      .prepare("SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .get(siblingInstance, "sibling") as { rowid: number };
    getDb()
      .prepare("UPDATE records SET deleted = 1 WHERE connector_instance_id = ? AND record_key = ?")
      .run(staleInstance, "stale");
    getDb()
      .prepare(
        "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?, ?)"
      )
      .run("crash-gap-lex", staleInstance, "items", "orphan", "subject", "orphan");
    const orphan = getDb()
      .prepare("SELECT rowid FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .get(staleInstance, "orphan") as { rowid: number };
    getDb().prepare("DELETE FROM lexical_search_index WHERE rowid = ?").run(sibling.rowid);
    markSearchIndexDirtySqlite(
      { connectorId: "crash-gap-lex", connectorInstanceId: staleInstance, stream: "items" },
      new Date().toISOString()
    );
    getDb()
      .prepare(
        "UPDATE search_index_dirty SET attempts = 0, next_attempt_at = NULL WHERE connector_instance_id = ? AND stream = ?"
      )
      .run(staleInstance, "items");
    let replaced = false;
    __setLexicalBackfillPhaseHookForTest((point) => {
      if (point === "after-stale-page-check" && !replaced) {
        replaced = true;
        getDb()
          .prepare("UPDATE records SET deleted = 0, record_json = ? WHERE connector_instance_id = ? AND record_key = ?")
          .run(JSON.stringify({ id: "stale", subject: "resurrected" }), staleInstance, "stale");
        getDb().prepare("UPDATE lexical_search_index SET text = ? WHERE rowid = ?").run("resurrected", stale.rowid);
        getDb().prepare("DELETE FROM lexical_search_index WHERE rowid = ?").run(orphan.rowid);
        getDb()
          .prepare(
            "INSERT INTO lexical_search_index(rowid, connector_id, connector_instance_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?, ?, ?)"
          )
          .run(orphan.rowid, "crash-gap-lex", siblingInstance, "items", "sibling", "subject", "healthy");
      }
    });
    await runSearchIndexDirtyReconcileRound();
    assert.equal(replaced, true, "the stale-row delete must cross the injected pre-fence interleaving");
    const restored = getDb()
      .prepare("SELECT rowid, text FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .get(staleInstance, "stale") as { rowid: number; text: string } | undefined;
    assert.deepEqual(restored, { rowid: stale.rowid, text: "resurrected" });
    const siblingAfter = getDb()
      .prepare("SELECT rowid, text FROM lexical_search_index WHERE connector_instance_id = ? AND record_key = ?")
      .get(siblingInstance, "sibling") as { rowid: number; text: string } | undefined;
    assert.deepEqual(siblingAfter, { rowid: orphan.rowid, text: "healthy" });
  } finally {
    __setLexicalBackfillPhaseHookForTest(null);
    closeDb();
  }
});
