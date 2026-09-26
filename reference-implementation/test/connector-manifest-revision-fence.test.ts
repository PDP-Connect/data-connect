// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConnectorManifestForStorage, registerConnector } from "../server/auth.ts";
import {
  assertConnectorManifestStreamRevisionSync,
  assertConnectorManifestStreamRevisionWithClient,
  storedConnectorManifestRevision,
  storedConnectorManifestStreamRevision,
  withConnectorManifestDerivedWrite,
} from "../server/connector-manifest-write-fence.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { postgresBackfillRecordSortPositionsForManifest } from "../server/postgres-records.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import {
  __setIndexPublishPhaseHookForTest,
  backfillSqliteRecordSemanticTimesForManifest,
  ingestRecord,
  maintainRecordIndexes,
} from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest, lexicalIndexBackfillForManifest } from "../server/search.ts";
import {
  configureSemanticBackend,
  encodeScopeKey,
  makeStubBackend,
  semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const connectorId = "manifest-revision-fence";
const connectorInstanceId = "cin_manifest_revision_fence";
const stream = "items";
const MANIFEST_REVISION_CHANGED = /manifest revision changed/i;
const ACTIVE_ACTIVATION_STREAM_SHAPE = /stream shape while its installed activation is active/i;

function manifest(field: "subject" | "title") {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Manifest revision fence",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: stream,
        primary_key: ["id"],
        query: { search: { lexical_fields: [field] } },
        schema: {
          properties: { id: { type: "string" }, subject: { type: "string" }, title: { type: "string" } },
          required: ["id", "subject", "title"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: field === "subject" ? "1.0.0" : "2.0.0",
  };
}

function pinnedManifest(field: "subject" | "title") {
  return { ...manifest(field), storage_binding: { connector_instance_id: connectorInstanceId } };
}

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (!release) {
    throw new Error("Deferred release was not initialized");
  }
  return { promise, release };
}

function retrievalManifest(field: "subject" | "title") {
  const base = manifest(field);
  return {
    ...base,
    streams: base.streams.map((entry) => ({
      ...entry,
      query: { search: { lexical_fields: [field], semantic_fields: [field] } },
    })),
  };
}

async function assertStaleLexicalPageRejected(): Promise<void> {
  const entered = deferred();
  const resume = deferred();
  let held = false;
  try {
    await registerConnector(manifest("subject"), { backfillRetrievalIndexes: false });
    await ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      {
        data: { id: "one", subject: "old subject", title: "new title" },
        emitted_at: "2026-07-16T00:00:00.000Z",
        key: "one",
        stream,
      },
      { deferIndexes: true }
    );
    __setLexicalBackfillPhaseHookForTest(async (point) => {
      if (point === "before-instance-fence" && !held) {
        held = true;
        entered.release();
        await resume.promise;
      }
    });
    const stale = lexicalIndexBackfillForManifest({ manifest: pinnedManifest("subject") });
    await entered.promise;
    await registerConnector(manifest("title"), { backfillRetrievalIndexes: false });
    await lexicalIndexBackfillForManifest({ manifest: pinnedManifest("title") });
    const staleRejected = assert.rejects(stale, MANIFEST_REVISION_CHANGED);
    resume.release();
    await staleRejected;
    const rows = isPostgresStorageBackend()
      ? (
          await postgresQuery<{ field: string; text: string }>(
            "SELECT field, value AS text FROM lexical_search_index WHERE connector_instance_id=$1 AND stream=$2 ORDER BY field",
            [connectorInstanceId, stream]
          )
        ).rows
      : (getDb()
          .prepare(
            "SELECT field, text FROM lexical_search_index WHERE connector_instance_id=? AND stream=? ORDER BY field"
          )
          .all(connectorInstanceId, stream) as Array<{ field: string; text: string }>);
    assert.deepEqual(rows, [{ field: "title", text: "new title" }]);
  } finally {
    resume.release();
    __setLexicalBackfillPhaseHookForTest(null);
  }
}

test("SQLite: a stale lexical page cannot overwrite the index after manifest B publishes", async () => {
  initDb(":memory:");
  try {
    await assertStaleLexicalPageRejected();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a stale lexical page cannot overwrite the index after manifest B publishes", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertStaleLexicalPageRejected();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

async function assertStaleSemanticPageRejected(): Promise<void> {
  const entered = deferred();
  const resume = deferred();
  const stub = makeStubBackend({ dimensions: 8 });
  configureSemanticBackend({
    ...stub,
    embedDocument: async (value) => {
      if (value === "old subject") {
        entered.release();
        await resume.promise;
      }
      return stub.embedDocument(value);
    },
  });
  const semanticManifest = (field: "subject" | "title") => ({
    ...manifest(field),
    streams: manifest(field).streams.map((entry) => ({
      ...entry,
      query: { search: { semantic_fields: [field] } },
    })),
  });
  try {
    await registerConnector(semanticManifest("subject"), { backfillRetrievalIndexes: false });
    await ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      {
        data: { id: "one", subject: "old subject", title: "new title" },
        emitted_at: "2026-07-16T00:00:00.000Z",
        key: "one",
        stream,
      },
      { deferIndexes: true }
    );
    const stale = semanticIndexBackfillForManifest({ manifest: semanticManifest("subject") });
    await entered.promise;
    await registerConnector(semanticManifest("title"), { backfillRetrievalIndexes: false });
    await semanticIndexBackfillForManifest({ manifest: semanticManifest("title") });
    const staleRejected = assert.rejects(stale, MANIFEST_REVISION_CHANGED);
    resume.release();
    await staleRejected;
    const scopeKeys = isPostgresStorageBackend()
      ? (
          await postgresQuery<{ scope_key: string }>(
            "SELECT scope_key FROM semantic_search_blob WHERE connector_instance_id=$1 ORDER BY scope_key",
            [connectorInstanceId]
          )
        ).rows.map((row) => row.scope_key)
      : (
          getDb()
            .prepare(
              "SELECT scope_key FROM semantic_search_blob WHERE connector_instance_id=? UNION SELECT scope_key FROM semantic_search_rowid WHERE connector_instance_id=? ORDER BY scope_key"
            )
            .all(connectorInstanceId, connectorInstanceId) as Array<{ scope_key: string }>
        ).map((row) => row.scope_key);
    assert.deepEqual(scopeKeys, [encodeScopeKey(stream, "title")]);
  } finally {
    resume.release();
    configureSemanticBackend(null);
  }
}

test("SQLite: a stale semantic page cannot overwrite the index after manifest B publishes", async () => {
  initDb(":memory:");
  try {
    await assertStaleSemanticPageRejected();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a stale semantic page cannot overwrite the index after manifest B publishes", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_semantic_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertStaleSemanticPageRejected();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

function recordRepairManifest(field: "subject" | "title") {
  const current = manifest(field);
  return {
    ...current,
    streams: current.streams.map((entry) => ({
      ...entry,
      consent_time_field: field,
      cursor_field: field,
      schema: {
        ...entry.schema,
        properties: {
          ...entry.schema.properties,
          subject: { format: "date-time", type: "string" },
          title: { format: "date-time", type: "string" },
        },
      },
    })),
  };
}

async function seedRecordRepairA(): Promise<{
  a: ReturnType<typeof recordRepairManifest>;
  b: ReturnType<typeof recordRepairManifest>;
}> {
  const a = recordRepairManifest("subject");
  const b = recordRepairManifest("title");
  await registerConnector(a, { backfillRetrievalIndexes: false });
  await ingestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    {
      data: { id: "one", subject: "2026-01-01T00:00:00.000Z", title: "2026-02-01T00:00:00.000Z" },
      emitted_at: "2026-03-01T00:00:00.000Z",
      key: "one",
      stream,
    },
    { deferIndexes: true }
  );
  await registerConnector(b, { backfillRetrievalIndexes: false });
  return { a, b };
}

test("SQLite: stale record-column repair cannot overwrite manifest B", async () => {
  initDb(":memory:");
  try {
    const { a, b } = await seedRecordRepairA();
    await backfillSqliteRecordSemanticTimesForManifest(b);
    await assert.rejects(backfillSqliteRecordSemanticTimesForManifest(a), MANIFEST_REVISION_CHANGED);
    const row = getDb()
      .prepare("SELECT semantic_time FROM records WHERE connector_instance_id=? AND stream=?")
      .get<{ semantic_time: string }>(connectorInstanceId, stream);
    assert.equal(row?.semantic_time, "2026-02-01T00:00:00.000Z");
  } finally {
    closeDb();
  }
});

test("PostgreSQL: stale record-column repair cannot overwrite manifest B", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_record_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const { a } = await seedRecordRepairA();
        await assert.rejects(postgresBackfillRecordSortPositionsForManifest(a), MANIFEST_REVISION_CHANGED);
        const row = await postgresQuery<{ cursor_value: string }>(
          "SELECT cursor_value FROM records WHERE connector_instance_id=$1 AND stream=$2",
          [connectorInstanceId, stream]
        );
        assert.equal(row.rows[0]?.cursor_value, "2026-02-01T00:00:00.000Z");
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

async function assertManifestDerivedWriteRejectedAfterManifestBPublishes(): Promise<void> {
  const a = manifest("subject");
  const b = manifest("title");
  await registerConnector(a, { backfillRetrievalIndexes: false });
  const expectedRevision = storedConnectorManifestRevision(normalizeConnectorManifestForStorage(a).storedManifest);
  await registerConnector(b, { backfillRetrievalIndexes: false });
  await assert.rejects(
    withConnectorManifestDerivedWrite(connectorId, expectedRevision, {
      postgres: async (client) => {
        await client.query("SELECT 1");
      },
      sqlite: () => {
        getDb().prepare("SELECT 1").get();
      },
    }),
    MANIFEST_REVISION_CHANGED
  );
}

test("SQLite: a stale derived write cannot commit after manifest B publishes", async () => {
  initDb(":memory:");
  try {
    await assertManifestDerivedWriteRejectedAfterManifestBPublishes();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a stale derived write cannot commit after manifest B publishes", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_derived_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertManifestDerivedWriteRejectedAfterManifestBPublishes();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

async function assertRefreshPolicyOnlyUpdateKeepsStreamRevision(): Promise<void> {
  const a = manifest("subject");
  await registerConnector(a, { backfillRetrievalIndexes: false });
  const expectedRevision = storedConnectorManifestStreamRevision(normalizeConnectorManifestForStorage(a).storedManifest);
  await registerConnector(
    {
      ...a,
      capabilities: {
        ...a.capabilities,
        refresh_policy: { rationale: "daily sync", recommended_mode: "manual" },
      },
    },
    { backfillRetrievalIndexes: false }
  );
  if (isPostgresStorageBackend()) {
    await withPostgresTransactionForManifestStreamRevision(expectedRevision);
  } else {
    assertConnectorManifestStreamRevisionSync(connectorId, expectedRevision);
  }
}

async function withPostgresTransactionForManifestStreamRevision(expectedRevision: string): Promise<void> {
  await postgresQuery("BEGIN");
  try {
    await assertConnectorManifestStreamRevisionWithClient(
      {
        query: (text: string, values?: readonly unknown[]) => postgresQuery(text, values ? [...values] : undefined),
      } as Parameters<typeof assertConnectorManifestStreamRevisionWithClient>[0],
      connectorId,
      expectedRevision
    );
  } finally {
    await postgresQuery("ROLLBACK");
  }
}

test("SQLite: a refresh-policy-only manifest update preserves the stream-shape revision", async () => {
  initDb(":memory:");
  try {
    await assertRefreshPolicyOnlyUpdateKeepsStreamRevision();
  } finally {
    closeDb();
  }
});

async function assertLiveIndexWriterFencedByManifestRevision(): Promise<void> {
  const entered = deferred();
  const resume = deferred();
  let paused = false;
  configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
  try {
    await registerConnector(retrievalManifest("subject"), { backfillRetrievalIndexes: false });
    __setIndexPublishPhaseHookForTest(async (point: string) => {
      if (point === "before-publish-transaction" && !paused) {
        paused = true;
        entered.release();
        await resume.promise;
      }
    });
    const ingest = await ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      {
        data: { id: "one", subject: "old subject", title: "new title" },
        emitted_at: "2026-07-16T00:00:00.000Z",
        key: "one",
        stream,
      }
    );
    assert.equal(ingest.changed, true);
    await entered.promise;
    const current = retrievalManifest("title");
    await registerConnector(current, { backfillRetrievalIndexes: false });
    await maintainRecordIndexes(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      {
        data: { id: "one", subject: "old subject", title: "new title" },
        emitted_at: "2026-07-16T00:00:00.000Z",
        key: "one",
        stream,
      },
      ingest.version ?? 1
    );
    resume.release();
    await ingest;
    const lexical = isPostgresStorageBackend()
      ? (
          await postgresQuery<{ field: string }>(
            "SELECT field FROM lexical_search_index WHERE connector_instance_id=$1 AND stream=$2 ORDER BY field",
            [connectorInstanceId, stream]
          )
        ).rows
      : getDb()
          .prepare("SELECT field FROM lexical_search_index WHERE connector_instance_id=? AND stream=? ORDER BY field")
          .all<{ field: string }>(connectorInstanceId, stream);
    const semanticScopes = isPostgresStorageBackend()
      ? (
          await postgresQuery<{ scope_key: string }>(
            "SELECT scope_key FROM semantic_search_blob WHERE connector_instance_id=$1 ORDER BY scope_key",
            [connectorInstanceId]
          )
        ).rows
      : getDb()
          .prepare(
            "SELECT scope_key FROM semantic_search_blob WHERE connector_instance_id=? UNION SELECT scope_key FROM semantic_search_rowid WHERE connector_instance_id=? ORDER BY scope_key"
          )
          .all<{ scope_key: string }>(connectorInstanceId, connectorInstanceId);
    assert.deepEqual(lexical, [{ field: "title" }]);
    assert.deepEqual(
      semanticScopes.map((row) => row.scope_key),
      [encodeScopeKey(stream, "title")]
    );
  } finally {
    resume.release();
    __setIndexPublishPhaseHookForTest(null);
    configureSemanticBackend(null);
  }
}

test("SQLite: delayed live lexical and semantic maintenance cannot publish after manifest B", async () => {
  initDb(":memory:");
  try {
    await assertLiveIndexWriterFencedByManifestRevision();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: delayed live lexical and semantic maintenance cannot publish after manifest B", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_live_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertLiveIndexWriterFencedByManifestRevision();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

test("SQLite: stale semantic backfill checks its manifest before vector-index initialization", async () => {
  initDb(":memory:");
  const stub = makeStubBackend({ dimensions: 8 });
  let dimensionsRead = false;
  configureSemanticBackend({
    ...stub,
    dimensions: () => {
      dimensionsRead = true;
      throw new Error("stale semantic backfill initialized the vector index");
    },
  });
  const a = retrievalManifest("subject");
  const b = retrievalManifest("title");
  try {
    await registerConnector(a, { backfillRetrievalIndexes: false });
    await ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      { data: { id: "one", subject: "old subject", title: "new title" }, key: "one", stream },
      { deferIndexes: true }
    );
    await registerConnector(b, { backfillRetrievalIndexes: false });
    await assert.rejects(semanticIndexBackfillForManifest({ manifest: a }), MANIFEST_REVISION_CHANGED);
    assert.equal(dimensionsRead, false);
  } finally {
    configureSemanticBackend(null);
    closeDb();
  }
});

async function seedActiveActivationForManifest(value: Record<string, unknown>): Promise<void> {
  const stored = normalizeConnectorManifestForStorage(value).storedManifest;
  const canonical = JSON.stringify(stored, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, candidate[key]])
    );
  });
  const activationId = `sha256:${"a".repeat(64)}`;
  const attemptId = `attempt_${connectorId}`;
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,updated_at)
       VALUES($1,'active',$2,$3,$4,$5,$6,'test')`,
      [
        connectorId,
        JSON.stringify({ connectorId, manifest: stored }),
        canonical,
        storedConnectorManifestRevision(stored),
        activationId,
        attemptId,
      ]
    );
  } else {
    getDb()
      .prepare(
        `INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,updated_at)
       VALUES(?,'active',?,?,?,?,?,'test')`
      )
      .run(
        connectorId,
        JSON.stringify({ connectorId, manifest: stored }),
        canonical,
        storedConnectorManifestRevision(stored),
        activationId,
        attemptId
      );
  }
}

async function assertActiveActivationRejectsStreamShapeChangesButAllowsRefreshPolicy(): Promise<void> {
  const a = manifest("subject");
  await registerConnector(a, { backfillRetrievalIndexes: false });
  await seedActiveActivationForManifest(a);
  const policyOnly = {
    ...a,
    capabilities: {
      ...a.capabilities,
      refresh_policy: { rationale: "daily sync", recommended_mode: "manual" },
    },
  };
  await registerConnector(policyOnly, { backfillRetrievalIndexes: false });
  const changedShape = {
    ...policyOnly,
    streams: [...policyOnly.streams, { ...policyOnly.streams[0], name: "extra" }],
  };
  await assert.rejects(
    registerConnector(changedShape, { backfillRetrievalIndexes: false }),
    ACTIVE_ACTIVATION_STREAM_SHAPE
  );
  const persisted = await getCurrentManifest();
  assert.equal((persisted.streams as unknown[]).length, 1);
}

async function getCurrentManifest(): Promise<Record<string, unknown>> {
  if (isPostgresStorageBackend()) {
    const row = await postgresQuery<{ manifest: Record<string, unknown> }>(
      "SELECT manifest FROM connectors WHERE connector_id=$1",
      [connectorId]
    );
    return row.rows[0]?.manifest ?? {};
  }
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  return row ? (JSON.parse(row.manifest) as Record<string, unknown>) : {};
}

test("SQLite: active installed connectors allow refresh-policy updates but reject stream-shape changes", async () => {
  initDb(":memory:");
  try {
    await assertActiveActivationRejectsStreamShapeChangesButAllowsRefreshPolicy();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: active installed connectors allow refresh-policy updates but reject stream-shape changes", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_shape_revision_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertActiveActivationRejectsStreamShapeChangesButAllowsRefreshPolicy();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
