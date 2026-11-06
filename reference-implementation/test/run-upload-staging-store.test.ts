// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { writeTransaction } from "../lib/db.ts";
import {
  __setConnectorInstanceWritePhaseHookForTest,
  withConnectorInstanceControlPlaneWrite,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { postgresPersistContentAddressedBlob } from "../server/postgres-records.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { bumpStorageGeneration } from "../server/storage-generation.ts";
import { canonicalBindingJson } from "../server/stores/binding-json.ts";
import {
  assertSqliteRunUploadWithinTransaction,
  createRunUploadPermissionStore,
} from "../server/stores/run-upload-permission-store.ts";
import { createRunUploadStagingStore } from "../server/stores/run-upload-staging-store.ts";
import { seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const STORAGE_GENERATION_CHANGED = /storage generation changed/;
const BLOB_ID_PATTERN = /^blob_sha256_[a-f0-9]{64}$/;

const url = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
let dir: string;
before(async () => {
  if (url) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: url });
  } else {
    dir = mkdtempSync(join(tmpdir(), "upload-staging-"));
    initDb(join(dir, "db.sqlite"));
  }
});
after(async () => {
  if (url) {
    await closePostgresStorage();
  } else {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

async function rows(sql: string, params: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  if (isPostgresStorageBackend()) {
    let parameterIndex = 0;
    return (
      await postgresQuery(
        sql.replaceAll("?", () => {
          parameterIndex += 1;
          return `$${parameterIndex}`;
        }),
        params
      )
    ).rows;
  }
  return getDb()
    .prepare(sql)
    .all(...params) as Record<string, unknown>[];
}

async function clearStages(): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery("DELETE FROM connector_run_upload_stages");
  } else {
    getDb().prepare("DELETE FROM connector_run_upload_stages").run();
  }
}

async function admitted(
  id: string,
  options: {
    generation?: number;
    maxBytes?: number;
    runId?: string;
    fields?: string[];
    paths?: string[];
  } = {}
) {
  await seedBindingConnection(id);
  const permissions = createRunUploadPermissionStore();
  const { issuerEpoch } = await permissions.beginIssuerEpoch(id);
  const authority = await permissions.issue({
    associations: [
      {
        allJsonPointers: false,
        paths: options.paths ?? ["/body", "/body_html"],
        recordKeys: "any",
        stream: "mail",
      },
    ],
    connectionId: id,
    connectorId: "binding-fixture-connector",
    expiresAt: Date.now() + 60_000,
    generation: options.generation ?? 1,
    issuerEpoch,
    manifestSnapshot: { streams: [{ name: "mail" }] },
    ownerId: "owner_local",
    purpose: "blob-upload",
    runId: options.runId ?? "run-stage-1",
    selectionIdentity: "selected-mail",
    sourceSnapshot: { identity: "fixture-source" },
    staging: {
      maxBytes: options.maxBytes ?? 4096,
      selection: {
        streams: [
          {
            consentTimeField: null,
            fields: options.fields ?? ["body", "body_html"],
            name: "mail",
            requiredFields: ["id"],
            resourceField: null,
            resources: null,
            timeRange: null,
          },
        ],
        version: 1,
      },
    },
  });
  return { authority, permissions };
}

function stageInput(
  authority: Awaited<ReturnType<typeof admitted>>["authority"],
  data: Uint8Array,
  recordKey = "k1",
  jsonPath = "/body"
) {
  return {
    authority,
    data,
    mimeType: "text/plain",
    target: {
      connectionId: authority.grant.connectionId,
      connectorId: authority.grant.connectorId,
      jsonPath,
      recordKey,
      stream: "mail",
    },
  };
}

test("stages bytes privately, returns SDK shape, and retries without a second charge", async () => {
  await clearStages();
  const { authority } = await admitted("stage-private");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  const data = Buffer.from("private body");
  const first = await store.stage(stageInput(authority, data));
  const second = await store.stage(stageInput(authority, data));
  assert.deepEqual(second, first);
  assert.match(first.blob_id, BLOB_ID_PATTERN);
  assert.equal(first.sha256, (await import("node:crypto")).createHash("sha256").update(data).digest("hex"));
  assert.equal(first.size_bytes, data.length);
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "1" : 1
  );
  assert.equal(
    (await rows("SELECT count(*) AS n FROM blobs WHERE connector_instance_id = ?", [authority.grant.connectionId]))[0]
      ?.n,
    url ? "0" : 0
  );
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM blob_bindings WHERE connector_instance_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "0" : 0
  );
  const [stored] = await rows("SELECT data FROM connector_run_upload_stages WHERE connection_id = ?", [
    authority.grant.connectionId,
  ]);
  assert.deepEqual(Buffer.from(stored?.data as Uint8Array), data);
});

test("same association with different bytes fails explicitly; paths remain separate", async () => {
  await clearStages();
  const { authority } = await admitted("stage-conflict");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  await store.stage(stageInput(authority, Buffer.from("first")));
  await assert.rejects(
    store.stage(stageInput(authority, Buffer.from("second"))),
    (e: unknown) => (e as { code?: string }).code === "run_upload_stage_conflict"
  );
  await store.stage(stageInput(authority, Buffer.from("second"), "k1", "/body_html"));
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "2" : 2
  );
});

test("stages explicit @record attachment associations", async () => {
  await clearStages();
  const { authority } = await admitted("stage-attachment", {
    fields: ["body", "body_html", "blob_ref"],
    paths: ["@record", "/body", "/body_html"],
  });
  const result = await createRunUploadStagingStore({
    globalMaxBytes: 8192,
  }).stage(stageInput(authority, Buffer.from("attachment bytes"), "attachment-1", "@record"));
  assert.match(result.blob_id, BLOB_ID_PATTERN);
  assert.equal(
    (
      await rows("SELECT json_path FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.json_path,
    "@record"
  );
});

test("rejects @record attachment when blob_ref is outside selected fields", async () => {
  await clearStages();
  const { authority } = await admitted("stage-attachment-unselected", {
    paths: ["@record", "/body", "/body_html"],
  });
  await assert.rejects(
    createRunUploadStagingStore({ globalMaxBytes: 8192 }).stage(
      stageInput(authority, Buffer.from("attachment bytes"), "attachment-1", "@record")
    ),
    (error: unknown) => (error as { code?: string }).code === "run_upload_stage_conflict"
  );
});

test("constructor snapshots the trusted global budget", async () => {
  await clearStages();
  const { authority } = await admitted("stage-budget-snapshot");
  const options = { globalMaxBytes: 8192 };
  const store = createRunUploadStagingStore(options);
  options.globalMaxBytes = 1;
  await assert.doesNotReject(store.stage(stageInput(authority, Buffer.from("captured budget"))));
});

test("rejects staging after the store's captured storage generation is replaced", async () => {
  await clearStages();
  const { authority } = await admitted("stage-generation");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  bumpStorageGeneration();
  await assert.rejects(store.stage(stageInput(authority, Buffer.from("stale generation"))), STORAGE_GENERATION_CHANGED);
});

test("snapshots authority, target, and bytes before the connector fence wait", async () => {
  await clearStages();
  const { authority } = await admitted("stage-input-snapshot");
  let announce!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withConnectorInstanceControlPlaneWrite(authority.grant.connectionId, async () => {
    announce();
    await blocked;
  });
  await ready;
  const bytes = Buffer.from("original bytes");
  const request = stageInput(authority, bytes);
  const pending = createRunUploadStagingStore({ globalMaxBytes: 8192 }).stage(request);
  bytes.fill(0);
  request.target.recordKey = "changed-after-call";
  Object.assign(authority.grant, { ownerId: "changed-after-call" });
  release();
  await held;
  await pending;
  const stored = await rows("SELECT record_key, data FROM connector_run_upload_stages WHERE connection_id = ?", [
    "stage-input-snapshot",
  ]);
  assert.equal(stored[0]?.record_key, "k1");
  assert.deepEqual(Buffer.from(stored[0]?.data as Uint8Array), Buffer.from("original bytes"));
});

test("global budget serializes concurrent stages from separate connections", async () => {
  await clearStages();
  const left = await admitted("stage-race-a");
  const right = await admitted("stage-race-b");
  const data = Buffer.from("x");
  const association = (connectionId: string) => ({
    connectionId,
    connectorId: "binding-fixture-connector",
    generation: 1,
    issuerEpoch: left.authority.grant.issuerEpoch,
    jsonPath: "/body",
    mimeType: "text/plain",
    ownerId: "owner_local",
    recordKey: "k1",
    runId: "run-stage-1",
    stream: "mail",
  });
  const singleCharge = data.length + Buffer.byteLength(canonicalBindingJson(association("stage-race-a")), "utf8");
  const store = createRunUploadStagingStore({
    globalMaxBytes: singleCharge + 2,
  });
  const outcomes = await Promise.allSettled([
    store.stage(stageInput(left.authority, data)),
    store.stage(stageInput(right.authority, data)),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter(
      (result) => result.status === "rejected" && (result.reason as { code?: string }).code === "run_upload_stage_limit"
    ).length,
    1
  );
  assert.equal(
    (await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE run_id = ?", ["run-stage-1"]))[0]?.n,
    url ? "1" : 1
  );
});

test("run and global budgets reject immediately and preserve existing charges", async () => {
  await clearStages();
  const { authority } = await admitted("stage-run-limit", { maxBytes: 80 });
  const store = createRunUploadStagingStore({ globalMaxBytes: 4096 });
  await assert.rejects(
    store.stage(stageInput(authority, Buffer.alloc(100))),
    (e: unknown) => (e as { code?: string }).code === "run_upload_stage_limit"
  );
  const { authority: other } = await admitted("stage-global-limit");
  const tinyGlobal = createRunUploadStagingStore({ globalMaxBytes: 100 });
  await assert.rejects(
    tinyGlobal.stage(stageInput(other, Buffer.alloc(100))),
    (e: unknown) => (e as { code?: string }).code === "run_upload_stage_limit"
  );
});

test("revoke and epoch rotation clear exact old stages; staged grants cannot publish canonical blobs", async () => {
  await clearStages();
  const { authority, permissions } = await admitted("stage-lifecycle");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  await store.stage(stageInput(authority, Buffer.from("stage")));
  const denyPublish = () =>
    isPostgresStorageBackend()
      ? postgresPersistContentAddressedBlob({
          connectorId: authority.grant.connectorId,
          connectorInstanceId: authority.grant.connectionId,
          data: Buffer.from("canonical"),
          jsonPath: "/body",
          mimeType: "text/plain",
          recordKey: "k1",
          requireConnectionAdmission: true,
          stream: "mail",
          uploadAuthority: authority,
        })
      : withConnectorInstanceWrite(authority.grant.connectionId, async () =>
          writeTransaction(() =>
            assertSqliteRunUploadWithinTransaction(authority, {
              connectionId: authority.grant.connectionId,
              connectorId: authority.grant.connectorId,
              jsonPath: "/body",
              recordKey: "k1",
              stream: "mail",
            })
          )
        );
  await assert.rejects(denyPublish, (e: unknown) => (e as { code?: string }).code === "run_upload_denied");
  await permissions.revoke(authority.grant);
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "0" : 0
  );
});

test("higher generation clears old stages and stale revoke preserves replacement stage", async () => {
  await clearStages();
  const { authority, permissions } = await admitted("stage-replacement");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  await store.stage(stageInput(authority, Buffer.from("old")));
  const replacement = await permissions.issue({
    ...authority.grant,
    generation: 2,
    runId: "run-stage-2",
  });
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "0" : 0
  );
  await store.stage(stageInput(replacement, Buffer.from("new")));
  await permissions.revoke(authority.grant);
  assert.equal(
    (
      await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
        authority.grant.connectionId,
      ])
    )[0]?.n,
    url ? "1" : 1
  );
});

test("a staged upload queued before committed revoke cannot retain bytes", async () => {
  await clearStages();
  const { authority, permissions } = await admitted("stage-queued-revoke");
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  __setConnectorInstanceWritePhaseHookForTest((point, context): void | Promise<void> => {
    if (point === "before_key_acquire" && context.connectorInstanceId === authority.grant.connectionId) {
      announce();
      return blocked;
    }
  });
  const pending = createRunUploadStagingStore({ globalMaxBytes: 8192 }).stage(
    stageInput(authority, Buffer.from("queued bytes"))
  );
  try {
    const reached = await Promise.race([entered.then(() => "entered"), pending.then(() => "committed")]);
    assert.equal(reached, "entered", "stage must reach the observed pre-fence point before revoke");
    await permissions.revoke(authority.grant);
    release();
    await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "run_upload_denied");
    const [count] = await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
      authority.grant.connectionId,
    ]);
    assert.equal(Number(count?.n), 0, "committed revoke must prevent the queued stage insert");
  } finally {
    release();
    __setConnectorInstanceWritePhaseHookForTest(null);
    await Promise.allSettled([pending]);
  }
});

test("failed stage insertion rolls back retained bytes and retry reserves once", async () => {
  await clearStages();
  const { authority } = await admitted("stage-insert-fault");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  if (url) {
    await postgresQuery(
      "CREATE FUNCTION stage_insert_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stage insert fault'; END $$"
    );
    await postgresQuery(
      "CREATE TRIGGER stage_insert_fault AFTER INSERT ON connector_run_upload_stages FOR EACH ROW EXECUTE FUNCTION stage_insert_fault()"
    );
  } else {
    getDb().exec(
      "CREATE TRIGGER stage_insert_fault AFTER INSERT ON connector_run_upload_stages BEGIN SELECT RAISE(ABORT, 'stage insert fault'); END"
    );
  }
  try {
    await assert.rejects(store.stage(stageInput(authority, Buffer.from("rollback bytes"))), (error: unknown) => {
      const { code } = error as { code?: string };
      return code === "P0001" || code === "SQLITE_CONSTRAINT_TRIGGER";
    });
    const [count] = await rows(
      "SELECT count(*) AS n, COALESCE(SUM(charge_bytes), 0) AS charge FROM connector_run_upload_stages"
    );
    assert.equal(Number(count?.n), 0, "insert failure must retain no stage row");
    assert.equal(Number(count?.charge), 0, "insert failure must retain no reserved bytes");
  } finally {
    if (url) {
      await postgresQuery("DROP TRIGGER stage_insert_fault ON connector_run_upload_stages");
      await postgresQuery("DROP FUNCTION stage_insert_fault()");
    } else {
      getDb().exec("DROP TRIGGER stage_insert_fault");
    }
  }
  const first = await store.stage(stageInput(authority, Buffer.from("rollback bytes")));
  const second = await store.stage(stageInput(authority, Buffer.from("rollback bytes")));
  assert.deepEqual(first, second);
  const [count] = await rows("SELECT count(*) AS n FROM connector_run_upload_stages");
  assert.equal(Number(count?.n), 1, "successful retry must reserve only one stage row");
});

test("failed generation replacement retains the prior grant and private bytes atomically", async () => {
  await clearStages();
  const { authority, permissions } = await admitted("stage-issue-rollback");
  const store = createRunUploadStagingStore({ globalMaxBytes: 8192 });
  await store.stage(stageInput(authority, Buffer.from("original stage")));
  if (url) {
    await postgresQuery(
      "CREATE FUNCTION stage_issue_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stage issue fault'; END $$"
    );
    await postgresQuery(
      "CREATE TRIGGER stage_issue_fault BEFORE UPDATE ON connector_run_upload_permissions FOR EACH ROW EXECUTE FUNCTION stage_issue_fault()"
    );
  } else {
    getDb().exec(
      "CREATE TRIGGER stage_issue_fault BEFORE UPDATE ON connector_run_upload_permissions BEGIN SELECT RAISE(ABORT, 'stage issue fault'); END"
    );
  }
  try {
    await assert.rejects(
      permissions.issue({ ...authority.grant, generation: 2, runId: "replacement-rejected" }),
      (error: unknown) => {
        const { code } = error as { code?: string };
        return code === "P0001" || code === "SQLITE_CONSTRAINT_TRIGGER";
      }
    );
    const retained = await permissions.resolve(authority.token);
    assert.equal(
      retained.grant.generation,
      authority.grant.generation,
      "failed issue must retain the previous permission generation"
    );
    const [count] = await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [
      authority.grant.connectionId,
    ]);
    assert.equal(Number(count?.n), 1, "failed issue must roll back deletion of the previous private stage");
    await assert.doesNotReject(store.stage(stageInput(authority, Buffer.from("original stage"))));
  } finally {
    if (url) {
      await postgresQuery("DROP TRIGGER stage_issue_fault ON connector_run_upload_permissions");
      await postgresQuery("DROP FUNCTION stage_issue_fault()");
    } else {
      getDb().exec("DROP TRIGGER stage_issue_fault");
    }
  }
});
