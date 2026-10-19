// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend } from "../server/search-semantic.ts";
import { listDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";

const RECORDS = 501;
const CONNECTOR_ID = "dcr-73-lexical-abort";
const INSTANCE_ID = "cin_dcr_73_lexical_abort";

function manifest() {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: CONNECTOR_ID,
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
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

test("reconcile abort stops lexical backfill at the next page boundary", {
  concurrency: false,
  timeout: 30_000,
}, async () => {
  initDb(":memory:");
  configureSemanticBackend(null);
  let releasePage!: () => void;
  let enterPage!: () => void;
  const pageBlocked = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  const pageEntered = new Promise<void>((resolve) => {
    enterPage = resolve;
  });
  const controller = new AbortController();
  let fetchedPages = 0;
  try {
    await registerConnector(manifest());
    for (let index = 0; index < RECORDS; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Seed ordered records for a deterministic page-boundary abort.
      await ingestRecord(
        { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID },
        {
          data: { id: `k${index}`, subject: `subject ${index}` },
          emitted_at: "2026-07-16T00:00:00.000Z",
          key: `k${index}`,
          stream: "items",
        },
        { deferIndexes: true }
      );
    }
    const scope = (await listDirtySearchIndexScopes(10)).find(
      (candidate) => candidate.connectorInstanceId === INSTANCE_ID && candidate.stream === "items"
    );
    assert.ok(scope, "fixture must leave one dirty lexical scope");
    __setLexicalBackfillPhaseHookForTest(async (phase) => {
      if (phase === "after-page-fetch") {
        fetchedPages += 1;
        if (fetchedPages === 1) {
          enterPage();
          await pageBlocked;
        }
      }
    });
    const reconcile = reconcileSearchIndexDirtyScope(scope, undefined, controller.signal);
    await pageEntered;
    controller.abort(new Error("shutdown"));
    releasePage();
    const result = await reconcile;
    const indexed = Number(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?")
        .get<{ n: number }>(INSTANCE_ID)?.n
    );
    assert.equal(result.outcome, "incomplete");
    assert.equal(fetchedPages, 1, "aborting after the first page must prevent fetching another page");
    assert.ok(indexed < RECORDS, `only the first page may be written after abort; indexed ${indexed}/${RECORDS}`);
  } finally {
    releasePage();
    __setLexicalBackfillPhaseHookForTest(null);
    configureSemanticBackend(null);
    closeDb();
  }
});
