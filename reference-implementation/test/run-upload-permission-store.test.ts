// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { writeTransaction } from "../lib/db.ts";
import {
  connectorInstanceAdvisoryLockKey,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { postgresPersistContentAddressedBlob } from "../server/postgres-records.ts";
import { closePostgresStorage, initPostgresStorage, withPostgresTransaction } from "../server/postgres-storage.ts";
import {
  assertSqliteRunUploadWithinTransaction,
  createRunUploadPermissionStore,
  type RunUploadAuthority,
  type RunUploadGrant,
  revokePostgresRunUploadWithinTransaction,
} from "../server/stores/run-upload-permission-store.ts";
import { bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const url = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
let dir: string;
before(async () => {
  if (url) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: url });
  } else {
    dir = mkdtempSync(join(tmpdir(), "upload-permission-"));
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
const store = () => createRunUploadPermissionStore();
async function admitted(id: string): Promise<RunUploadAuthority> {
  await seedBindingConnection(id);
  const { issuerEpoch } = await store().beginIssuerEpoch(id);
  return store().issue({
    associations: [
      {
        allJsonPointers: false,
        paths: ["@record", "/body"],
        recordKeys: "any",
        stream: "mail",
      },
    ],
    connectionId: id,
    connectorId: "binding-fixture-connector",
    expiresAt: Date.now() + 60_000,
    generation: 1,
    issuerEpoch,
    manifestSnapshot: { streams: [{ name: "mail" }] },
    ownerId: "owner_local",
    purpose: "blob-upload",
    runId: "run-1",
    selectionIdentity: "selected-mail",
    sourceSnapshot: { identity: "fixture-source" },
  });
}
function publish(
  authority: RunUploadAuthority,
  changes: Partial<{
    connectorId: string;
    connectionId: string;
    stream: string;
    recordKey: string;
    jsonPath: string;
  }> = {}
) {
  const target = {
    connectionId: authority.grant.connectionId,
    connectorId: authority.grant.connectorId,
    jsonPath: "/body",
    recordKey: "not-yet-recorded",
    stream: "mail",
    ...changes,
  };
  if (url) {
    return postgresPersistContentAddressedBlob({
      connectorId: target.connectorId,
      connectorInstanceId: target.connectionId,
      data: Buffer.from(target.connectionId),
      jsonPath: target.jsonPath,
      mimeType: "text/plain",
      recordKey: target.recordKey,
      requireConnectionAdmission: true,
      stream: target.stream,
      uploadAuthority: authority,
    });
  }
  // SQLite foundation proof only. Root must wire this exact synchronous participant into host blob transaction.
  return withConnectorInstanceWrite(target.connectionId, async () =>
    writeTransaction(() => {
      assertSqliteRunUploadWithinTransaction(authority, target);
      getDb()
        .prepare(
          "INSERT OR IGNORE INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES (?, ?, ?, ?, ?, 'text/plain', 1, ?, ?)"
        )
        .run(
          target.connectionId,
          target.connectorId,
          target.connectionId,
          target.stream,
          target.recordKey,
          target.connectionId,
          Buffer.from("x")
        );
      getDb()
        .prepare(
          "INSERT OR IGNORE INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          target.connectionId,
          target.connectorId,
          target.connectionId,
          target.stream,
          target.recordKey,
          target.jsonPath
        );
    })
  );
}
async function counts(id: string) {
  const [blobs] = await bindingQuery("SELECT count(*) AS n FROM blobs WHERE connector_instance_id = ?", [id]);
  const [bindings] = await bindingQuery("SELECT count(*) AS n FROM blob_bindings WHERE connector_instance_id = ?", [
    id,
  ]);
  return [Number(blobs?.n), Number(bindings?.n)];
}
const denied = (error: unknown) => error instanceof Error && (error as { code?: string }).code === "run_upload_denied";
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each case observes the preceding case's mutations to the same permission. */
function inOrder<T>(values: readonly T[], visit: (value: T) => Promise<void>): Promise<void> {
  return values.reduce(async (previous, value) => {
    await previous;
    await visit(value);
  }, Promise.resolve());
}

/** Yield between probes; callers retain their existing clock and failure bounds. */
async function pollUntil(ready: () => boolean | Promise<boolean>): Promise<void> {
  if (await ready()) {
    return;
  }
  await new Promise<void>((done) => setImmediate(done));
  return pollUntil(ready);
}

test("pre-RECORD bytes, duplicate publication, digest-only persistence, current grant independent of future approval", async () => {
  const a = await admitted("before-record");
  assert.deepEqual(await store().resolve(a.token), a);
  await publish(a);
  await publish(a);
  assert.deepEqual(await counts(a.grant.connectionId), [1, 1]);
  const [row] = await bindingQuery("SELECT * FROM connector_run_upload_permissions WHERE connection_id = ?", [
    a.grant.connectionId,
  ]);
  assert.equal(JSON.stringify(row).includes(a.token), false);
  assert.equal(
    (await bindingQuery("SELECT count(*) AS n FROM records WHERE connector_instance_id = ?", [a.grant.connectionId]))[0]
      ?.n,
    url ? "0" : 0
  );
  // No future-approval table read exists in this API; only a live grant mutation changes it.
});

test("validated upload waits; revoke commits first; no blob or binding publication", async () => {
  const a = await admitted("cancel-first");
  const validated = await store().resolve(a.token);
  const ready = barrier();
  const release = barrier();
  const queued = (async () => {
    ready.resolve();
    await release.promise;
    return publish(validated);
  })();
  await ready.promise;
  await store().revoke(a.grant);
  release.resolve();
  await assert.rejects(queued, denied);
  assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
  await store().revoke(a.grant);
  await assert.rejects(async () => store().issue(a.grant), denied);
});

test("publication commits first, then revoke preserves accounted prior publication", async () => {
  const a = await admitted("publish-first");
  await publish(a);
  await store().revoke(a.grant);
  await assert.rejects(publish(a), denied);
  assert.deepEqual(await counts(a.grant.connectionId), [1, 1]);
});

test("replacement and explicit restart epoch cannot revive stale authority or reset generation", async () => {
  const a = await admitted("replace");
  const next = await store().issue({
    ...a.grant,
    generation: 2,
    runId: "run-2",
  });
  await store().revoke(a.grant);
  await publish(next);
  await assert.rejects(publish(a), denied);
  const { issuerEpoch } = await store().beginIssuerEpoch(a.grant.connectionId);
  await assert.rejects(publish(next), denied);
  await assert.rejects(async () => store().issue({ ...a.grant, issuerEpoch }), denied);
  await assert.rejects(async () => store().issue({ ...next.grant, generation: 3 }), denied);
  const fresh = await store().issue({
    ...next.grant,
    generation: 3,
    issuerEpoch,
  });
  await publish(fresh);
});

test("scope, purpose, selected stream/key/path and corrupted persisted grant fail closed", async () => {
  const a = await admitted("scope");
  await seedBindingConnection("other-connection");
  await inOrder(
    ["ownerId", "connectorId", "connectionId", "runId", "issuerEpoch", "selectionIdentity", "purpose"] as const,
    async (field) => {
      await assert.rejects(
        async () =>
          publish({
            ...a,
            grant: { ...a.grant, [field]: "wrong" } as RunUploadGrant,
          }),
        denied
      );
    }
  );
  await inOrder(
    [{ stream: "other" }, { connectionId: "other-connection" }, { jsonPath: "/other" }],
    async (changes) => {
      await assert.rejects(publish(a, changes), denied);
    }
  );
  const exact = await store().issue({
    ...a.grant,
    associations: [
      {
        allJsonPointers: false,
        paths: ["@record"],
        recordKeys: ["only-key"],
        stream: "mail",
      },
    ],
    generation: 2,
  });
  await assert.rejects(publish(exact, { jsonPath: "@record", recordKey: "wrong" }), denied);
  await bindingQuery("UPDATE connector_run_upload_permissions SET grant_json = '{}' WHERE connection_id = ?", [
    a.grant.connectionId,
  ]);
  await assert.rejects(publish(exact), denied);
  assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
});

test("connection revoke/delete and ownership transfer prevent publication", async () => {
  await inOrder(["revoke", "delete", "transfer"], async (action) => {
    const a = await admitted(`connection-${action}`);
    if (action === "delete") {
      await bindingQuery("DELETE FROM connector_instances WHERE connector_instance_id = ?", [a.grant.connectionId]);
    } else if (action === "revoke") {
      await bindingQuery("UPDATE connector_instances SET status = 'revoked' WHERE connector_instance_id = ?", [
        a.grant.connectionId,
      ]);
    } else {
      await bindingQuery(
        "UPDATE connector_instances SET owner_subject_id = 'other-owner' WHERE connector_instance_id = ?",
        [a.grant.connectionId]
      );
    }
    await assert.rejects(publish(a));
    assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
  });
});

test("fault after authorization rolls back publication; ordinary PostgreSQL owner primitive remains optional", async () => {
  const a = await admitted("rollback");
  if (url) {
    await bindingQuery(
      "CREATE FUNCTION reject_upload_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$"
    );
    await bindingQuery(
      "CREATE TRIGGER reject_upload_binding BEFORE INSERT ON blob_bindings FOR EACH ROW EXECUTE FUNCTION reject_upload_binding()"
    );
    try {
      await assert.rejects(publish(a));
    } finally {
      await bindingQuery("DROP TRIGGER reject_upload_binding ON blob_bindings");
      await bindingQuery("DROP FUNCTION reject_upload_binding()");
    }
    assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
    await postgresPersistContentAddressedBlob({
      connectorId: a.grant.connectorId,
      connectorInstanceId: a.grant.connectionId,
      data: Buffer.from("ordinary"),
      mimeType: "text/plain",
      recordKey: "owner",
      stream: "mail",
    });
  } else {
    assert.throws(() =>
      writeTransaction(() => {
        assertSqliteRunUploadWithinTransaction(a, {
          connectionId: a.grant.connectionId,
          connectorId: a.grant.connectorId,
          jsonPath: "@record",
          recordKey: "key",
          stream: "mail",
        });
        getDb()
          .prepare("UPDATE connector_run_upload_permissions SET revoked = 1 WHERE connection_id = ?")
          .run(a.grant.connectionId);
        throw new Error("fixture rollback");
      })
    );
  }
  await publish(a);
});

test("database fence contention: revoke commits on separate client before actual writer checks", async () => {
  const a = await admitted("advisory-cancel");
  if (!url) {
    await store().revoke(a.grant);
    await assert.rejects(publish(a), denied);
    return;
  }
  const held = barrier();
  const release = barrier();
  let pid = 0;
  const holder = withPostgresTransaction(
    async (client) => {
      pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      await revokePostgresRunUploadWithinTransaction(client, a.grant);
      held.resolve();
      await release.promise;
    },
    { lockConnectorInstanceId: a.grant.connectionId }
  );
  await held.promise;
  const pending = publish(a);
  const settled = pending.then(
    () => null,
    (error: unknown) => error
  );
  const start = performance.now();
  try {
    await pollUntil(async () => {
      const [row] = await bindingQuery(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ? = ANY(pg_blocking_pids(pid))) AS waiting",
        [pid]
      );
      if (row?.waiting) {
        return true;
      }
      assert.ok(performance.now() - start < 1500, "actual writer must wait on separate-client advisory fence");
      return false;
    });
  } finally {
    release.resolve();
    await holder;
  }
  assert.ok(denied(await settled));
  assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
  assert.ok(connectorInstanceAdvisoryLockKey(a.grant.connectionId));
});

test("expiry is evaluated after waiting, using current wall time", async () => {
  const initial = await admitted("expiry");
  const a = await store().issue({
    ...initial.grant,
    expiresAt: Date.now() + 300,
    generation: 2,
  });
  const held = barrier();
  const release = barrier();
  let holderPid = 0;
  const holder = url
    ? withPostgresTransaction(
        async (client) => {
          const {
            rows: [row],
          } = await client.query("SELECT pg_backend_pid() AS pid");
          holderPid = Number(row?.pid);
          held.resolve();
          await release.promise;
        },
        { lockConnectorInstanceId: a.grant.connectionId }
      )
    : Promise.resolve();
  if (url) {
    await held.promise;
  }
  const waiting = url
    ? publish(a).then(
        () => null,
        (error: unknown) => error
      )
    : null;
  let queuedResult: unknown;
  try {
    if (url) {
      await pollUntil(async () => {
        const [row] = await bindingQuery(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ? = ANY(pg_blocking_pids(pid))) AS waiting, extract(epoch FROM clock_timestamp()) * 1000 AS observed_at",
          [holderPid]
        );
        assert.ok(
          Number(row?.observed_at) < a.grant.expiresAt,
          "actual writer must be observed waiting while the grant is still valid"
        );
        return Boolean(row?.waiting);
      });
    }
    await pollUntil(() => Date.now() > a.grant.expiresAt);
  } finally {
    release.resolve();
    await holder;
    if (waiting) {
      queuedResult = await waiting;
    }
  }
  if (waiting) {
    assert.ok(denied(queuedResult));
  } else {
    await assert.rejects(publish(a), denied);
  }
  assert.deepEqual(await counts(a.grant.connectionId), [0, 0]);
});
