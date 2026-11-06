// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { ingestRecord } from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { createRunUploadPermissionStore } from "../server/stores/run-upload-permission-store.ts";
import { createRunUploadStagingStore } from "../server/stores/run-upload-staging-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

type TestServer = Awaited<ReturnType<typeof startServer>>;

const manifest = withFixtureSourceDeclaration(
  {
    connector_id: "run-upload-http-fixture",
    display_name: "Run upload HTTP fixture",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "message_bodies",
        primary_key: ["id"],
        schema: {
          properties: {
            body_html: { type: "string" },
            body_text: { type: "string" },
            date: { type: "string" },
            folder: { type: "string" },
            id: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resource_field: "folder", resources: true },
        semantics: "mutable_state",
      },
      {
        name: "attachments",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resource_field: "folder", resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  },
  { sourceId: "https://fixtures.pdpp.test/sources/run-upload-http" }
);

const ownerId = "owner_upload_http";
const connectionId = "cin_run_upload_http";
async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "pdpp_cli";
  const deviceResponse = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = (await deviceResponse.json()) as { device_code: string; user_code: string };
  assert.equal(deviceResponse.status, 200);
  const approved = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: ownerId, user_code: device.user_code }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(approved.ok);
  const tokenResponse = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = (await tokenResponse.json()) as { access_token: string };
  assert.equal(tokenResponse.status, 200);
  return token.access_token;
}

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

async function seedConnection(id: string, connectorId = manifest.connector_id, owner = ownerId): Promise<void> {
  const now = new Date().toISOString();
  const store = isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId: id,
    createdAt: now,
    displayName: "Synthetic upload connection",
    ownerSubjectId: owner,
    sourceBinding: { kind: "test_account", label: id },
    sourceBindingKey: id,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

type Data = Record<string, unknown>;
async function sequential<T>(values: readonly T[], action: (value: T) => Promise<void>): Promise<void> {
  await values.reduce(async (previous, value) => {
    await previous;
    await action(value);
  }, Promise.resolve());
}
async function mutate(sql: string, params: (string | number)[] = []): Promise<void> {
  if (isPostgresStorageBackend()) {
    let i = 0;
    await postgresQuery(
      sql.replaceAll("?", () => {
        i += 1;
        return `$${i}`;
      }),
      params
    );
  } else {
    getDb()
      .prepare(sql)
      .run(...params);
  }
}

test("private stages settle only with actual accepted owner records", async (t) => {
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  const attachment = pg
    ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
    : undefined;
  // startServer runs the real initPostgresStorage path with this runner-issued single-use attachment.
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    storageBackend: pg ? "postgres" : "sqlite",
    ...(pg
      ? {
          databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
          testOnlyAlreadyAdmittedPostgresChildAttachment: attachment || "",
        }
      : {}),
    reconcilePolyfillManifests: false,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.ok(registered.ok, `synthetic manifest registration failed (${registered.status})`);
    await seedConnection(connectionId);
    const ownerToken = await issueOwnerToken(asUrl);
    const ownerState = await fetch(`${rsUrl}/v1/state/${manifest.connector_id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerState.status, 200, `owner bearer must reach the real state route (${ownerState.status})`);

    let sequence = 0;
    async function fixture(paths = ["/body_text"], stream = "message_bodies", content?: string) {
      sequence += 1;
      const id = `promotion-${sequence}`;
      await seedConnection(id);
      const permissions = createRunUploadPermissionStore();
      const { issuerEpoch } = await permissions.beginIssuerEpoch(id);
      const authority = await permissions.issue({
        associations: [{ allJsonPointers: false, paths, recordKeys: "any", stream }],
        connectionId: id,
        connectorId: manifest.connector_id,
        expiresAt: Date.now() + 60_000,
        generation: 1,
        issuerEpoch,
        manifestSnapshot: { streams: manifest.streams },
        ownerId,
        purpose: "blob-upload",
        runId: `run-${id}`,
        selectionIdentity: "fixture",
        sourceSnapshot: {},
        staging: {
          maxBytes: 4096,
          selection: {
            streams: [
              {
                consentTimeField: "date",
                fields: ["body_text", "blob_ref", "folder", "date"],
                name: stream,
                requiredFields: ["id"],
                resourceField: "folder",
                resources: ["inbox"],
                timeRange: { since: "2026-01-01", until: "2027-01-01" },
              },
            ],
            version: 1,
          },
        },
      });
      await mutate(
        "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
        [id, manifest.connector_id, authority.grant.runId, new Date().toISOString()]
      );
      const ref = await createRunUploadStagingStore({ globalMaxBytes: 1_000_000 }).stage({
        authority,
        data: Buffer.from(content ?? `private-${id}`),
        mimeType: "text/plain",
        target: {
          connectionId: id,
          connectorId: manifest.connector_id,
          jsonPath: paths[0] || "@record",
          recordKey: "k",
          stream,
        },
      });
      const data: Data = { body_text: null, date: "2026-06-01", folder: "inbox", id: "k" };
      async function send(values: Data[] = [data], token = ownerToken, runId: string | null = authority.grant.runId) {
        const query = new URLSearchParams({ connector_id: manifest.connector_id, connector_instance_id: id });
        if (runId) {
          query.set("run_id", runId);
        }
        const response = await fetch(`${rsUrl}/v1/ingest/${stream}?${query}`, {
          body: values.map((value) => JSON.stringify({ data: value, key: "k" })).join("\n"),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
          method: "POST",
        });
        const body = (await response.json()) as Record<string, unknown>;
        return { body, response };
      }
      async function counts() {
        const tableNames = ["blobs", "blob_bindings", "connector_run_upload_stages", "records"];
        const resultCounts: number[] = [];
        await tableNames.reduce(async (previous, table) => {
          await previous;
          const column = table === "connector_run_upload_stages" ? "connection_id" : "connector_instance_id";
          resultCounts.push(Number((await rows(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`, [id]))[0]?.n));
        }, Promise.resolve());
        return resultCounts;
      }
      return { authority, counts, data, id, permissions, ref, send, stream };
    }
    await t.test(
      "body null and resource field distinct from key promote via real owner NDJSON; noop charges once",
      async () => {
        const f = await fixture();
        assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
        const first = await f.send();
        assert.equal(first.response.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.records_accepted, 1, JSON.stringify(first.body));
        assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
        assert.equal((await f.send()).body.records_accepted, 1);
        assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
        assert.equal(
          Number(
            (
              await rows("SELECT blob_count FROM retained_size_stream WHERE connector_instance_id=? AND stream=?", [
                f.id,
                f.stream,
              ])
            )[0]?.blob_count
          ),
          1
        );
      }
    );
    await sequential(
      [
        ["resource", { folder: "outside" }],
        ["date", { date: "2025-01-01" }],
        ["field", { secret: true }],
      ] as const,
      async ([name, change]) => {
        await t.test(`actual ${name} scope is rechecked`, async () => {
          const f = await fixture();
          const result = await f.send([{ ...f.data, ...change }]);
          assert.equal(result.body.records_rejected, 1, JSON.stringify(result.body));
          assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
        });
      }
    );
    await t.test("attachment reference digest and size must agree; valid reference settles", async () => {
      const f = await fixture(["@record"], "attachments");
      f.data.body_text = undefined;
      await sequential(
        [
          { ...f.ref, blob_id: "wrong" },
          { ...f.ref, sha256: "wrong" },
          { ...f.ref, size_bytes: 999 },
        ],
        async (ref) => {
          assert.equal((await f.send([{ ...f.data, blob_ref: ref }])).body.records_rejected, 1);
          assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
        }
      );
      assert.equal((await f.send([{ ...f.data, blob_ref: f.ref }])).body.records_accepted, 1);
      assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
    });
    await t.test("no-run owner and delete never adopt private stages; accepted unchanged later settles", async () => {
      const f = await fixture();
      assert.equal((await f.send(undefined, ownerToken, null)).body.records_accepted, 1);
      assert.deepEqual(await f.counts(), [0, 0, 1, 1]);
      assert.equal((await f.send()).body.records_accepted, 1);
      assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
      const d = await fixture();
      await ingestRecord(
        { connectorId: manifest.connector_id, connectorInstanceId: d.id },
        { key: "k", op: "delete", stream: d.stream },
        { authenticatedOwnerSubjectId: ownerId, runId: d.authority.grant.runId }
      );
      assert.deepEqual(await d.counts(), [0, 0, 1, 0]);
    });
    await t.test("narrow bearer rejected; owner substitution and missing trusted subject refused", async () => {
      const f = await fixture();
      assert.ok([401, 403].includes((await f.send(undefined, f.authority.token)).response.status));
      await sequential([undefined, "other-owner"], async (subject) => {
        await assert.rejects(
          ingestRecord(
            { connectorId: manifest.connector_id, connectorInstanceId: f.id },
            { data: f.data, key: "k", stream: f.stream },
            { runId: f.authority.grant.runId, ...(subject ? { authenticatedOwnerSubjectId: subject } : {}) }
          )
        );
      });
      assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
    });
    await t.test("revoked, expired, epoch and generation mismatches refuse canonical effects", async () => {
      await sequential(["revoked=1", "generation=generation+1", "issuer_epoch='wrong'"], async (fault) => {
        const f = await fixture();
        await mutate(`UPDATE connector_run_upload_permissions SET ${fault} WHERE connection_id=?`, [f.id]);
        assert.equal((await f.send()).body.records_rejected, 1);
        assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
      });
      const f = await fixture();
      const grant = { ...f.authority.grant, expiresAt: 1 };
      const { canonicalBindingJson } = await import("../server/stores/binding-json.ts");
      await mutate("UPDATE connector_run_upload_permissions SET grant_json=? WHERE connection_id=?", [
        canonicalBindingJson(grant),
        f.id,
      ]);
      assert.equal((await f.send()).body.records_rejected, 1);
      assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
    });
    await t.test("two lines retain per-record acceptance and scope rejection", async () => {
      const f = await fixture();
      const result = await f.send([f.data, { ...f.data, folder: "outside" }]);
      assert.equal(result.body.records_accepted, 1, JSON.stringify(result.body));
      assert.equal(result.body.records_rejected, 1);
      assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
    });
    await t.test("missing staged permission and unsupported or absent body field leave bytes private", async () => {
      const f = await fixture();
      await mutate("DELETE FROM connector_run_upload_permissions WHERE connection_id=?", [f.id]);
      assert.equal((await f.send()).body.records_rejected, 1);
      assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
      const g = await fixture();
      const { body_text: omitted, ...withoutBody } = g.data;
      assert.equal(omitted, null);
      assert.equal((await g.send([withoutBody])).body.records_rejected, 1);
      assert.deepEqual(await g.counts(), [0, 0, 1, 0]);
    });
    await t.test("replacement cannot authorize old running run; revocation removes private bytes", async () => {
      const f = await fixture();
      await f.permissions.issue({ ...f.authority.grant, generation: 2, runId: "replacement" });
      assert.equal((await f.send()).body.records_rejected, 1);
      assert.deepEqual(await f.counts(), [0, 0, 0, 0]);
      const g = await fixture();
      await g.permissions.revoke(g.authority.grant);
      assert.equal((await g.send()).body.records_rejected, 1);
      assert.deepEqual(await g.counts(), [0, 0, 0, 0]);
    });
    await t.test(
      "ordinary owner ingest ignores prior unstaged grants, including revoked and rotated rows",
      async () => {
        await sequential(["active", "revoked", "rotated"] as const, async (state) => {
          const f = await fixture();
          const { staging, ...unstaged } = f.authority.grant;
          assert.ok(staging);
          const epoch = await f.permissions.beginIssuerEpoch(f.id);
          const prior = await f.permissions.issue({
            ...unstaged,
            generation: epoch.nextGeneration,
            issuerEpoch: epoch.issuerEpoch,
          });
          if (state === "revoked") {
            await f.permissions.revoke(prior.grant);
          } else if (state === "rotated") {
            await f.permissions.beginIssuerEpoch(f.id);
          }
          const laterRunId = `later-${f.authority.grant.runId}`;
          await mutate("UPDATE run_history SET status='succeeded' WHERE run_id=?", [f.authority.grant.runId]);
          await mutate(
            "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
            [f.id, manifest.connector_id, laterRunId, new Date().toISOString()]
          );
          const result = await f.send(undefined, ownerToken, laterRunId);
          assert.equal(result.body.records_accepted, 1, `${state}: ${JSON.stringify(result.body)}`);
          assert.deepEqual(await f.counts(), [0, 0, 0, 1]);
        });
      }
    );
    await t.test("a different admitted run cannot adopt an earlier staged grant", async () => {
      const f = await fixture();
      const laterRunId = `later-${f.authority.grant.runId}`;
      await mutate("UPDATE run_history SET status='succeeded' WHERE run_id=?", [f.authority.grant.runId]);
      await mutate(
        "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
        [f.id, manifest.connector_id, laterRunId, new Date().toISOString()]
      );
      const result = await f.send(undefined, ownerToken, laterRunId);
      assert.equal(result.body.records_rejected, 1, JSON.stringify(result.body));
      assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
    });
    await t.test("shared hash reuse retains other binding and charges each binding once", async () => {
      const f = await fixture(["/body_text"], "message_bodies", "shared-promotion-content");
      const g = await fixture(["/body_text"], "message_bodies", "shared-promotion-content");
      assert.equal(f.ref.blob_id, g.ref.blob_id);
      assert.equal((await f.send()).body.records_accepted, 1);
      assert.equal((await g.send()).body.records_accepted, 1);
      assert.equal(Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id=?", [f.ref.blob_id]))[0]?.n), 1);
      assert.equal(
        Number((await rows("SELECT count(*) AS n FROM blob_bindings WHERE blob_id=?", [f.ref.blob_id]))[0]?.n),
        2
      );
      await mutate("DELETE FROM blob_bindings WHERE connector_instance_id=?", [f.id]);
      await mutate("DELETE FROM blobs WHERE blob_id=? AND NOT EXISTS (SELECT 1 FROM blob_bindings WHERE blob_id=?)", [
        f.ref.blob_id,
        f.ref.blob_id,
      ]);
      assert.equal(
        Number((await rows("SELECT count(*) AS n FROM blob_bindings WHERE connector_instance_id=?", [g.id]))[0]?.n),
        1
      );
      assert.equal(Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id=?", [g.ref.blob_id]))[0]?.n), 1);
    });
    await sequential(["blobs", "records"], async (table) => {
      await t.test(`${table} insert failure leaves stage private and retry settles once`, async () => {
        const f = await fixture();
        if (pg) {
          await postgresQuery(
            "CREATE FUNCTION promotion_insert_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced insert failure'; END $$"
          );
          await postgresQuery(
            `CREATE TRIGGER promotion_insert_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION promotion_insert_fail()`
          );
        } else {
          await mutate(
            `CREATE TRIGGER promotion_insert_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`
          );
        }
        try {
          const failed = await f.send();
          assert.ok(failed.response.status >= 400);
          assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
        } finally {
          await mutate(pg ? `DROP TRIGGER promotion_insert_fail ON ${table}` : "DROP TRIGGER promotion_insert_fail");
          if (pg) {
            await postgresQuery("DROP FUNCTION promotion_insert_fail()");
          }
        }
        assert.equal((await f.send()).body.records_accepted, 1);
        assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
      });
    });
    await t.test("record accounting failure rolls back publication and stage consumption", async () => {
      const f = await fixture();
      if (pg) {
        await postgresQuery(
          "CREATE FUNCTION promotion_count_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.record_count > OLD.record_count THEN RAISE EXCEPTION 'forced record accounting failure'; END IF; RETURN NEW; END $$"
        );
        await postgresQuery(
          "CREATE TRIGGER promotion_count_fail BEFORE UPDATE ON retained_size_stream FOR EACH ROW EXECUTE FUNCTION promotion_count_fail()"
        );
      } else {
        await mutate(
          "CREATE TRIGGER promotion_count_fail BEFORE UPDATE ON retained_size_stream WHEN NEW.record_count > OLD.record_count BEGIN SELECT RAISE(ABORT, 'forced record accounting failure'); END"
        );
      }
      try {
        const failed = await f.send();
        assert.ok(failed.response.status >= 400);
        assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
      } finally {
        await mutate(
          pg ? "DROP TRIGGER promotion_count_fail ON retained_size_stream" : "DROP TRIGGER promotion_count_fail"
        );
        if (pg) {
          await postgresQuery("DROP FUNCTION promotion_count_fail()");
        }
      }
      assert.equal((await f.send()).body.records_accepted, 1);
      assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
      assert.equal(
        Number(
          (
            await rows("SELECT record_count FROM retained_size_stream WHERE connector_instance_id=? AND stream=?", [
              f.id,
              f.stream,
            ])
          )[0]?.record_count
        ),
        1
      );
    });
    await t.test("binding failure rolls back record, blob, accounting and consumption; retry settles", async () => {
      const f = await fixture();
      if (pg) {
        await postgresQuery(
          "CREATE FUNCTION promotion_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced binding failure'; END $$"
        );
        await postgresQuery(
          "CREATE TRIGGER promotion_fail BEFORE INSERT ON blob_bindings FOR EACH ROW EXECUTE FUNCTION promotion_fail()"
        );
      } else {
        await mutate(
          "CREATE TRIGGER promotion_fail BEFORE INSERT ON blob_bindings BEGIN SELECT RAISE(ABORT, 'forced binding failure'); END"
        );
      }
      try {
        await f.send();
        assert.deepEqual(await f.counts(), [0, 0, 1, 0]);
        assert.equal(
          (await rows("SELECT blob_count FROM retained_size_stream WHERE connector_instance_id=?", [f.id])).length,
          0
        );
      } finally {
        await mutate(pg ? "DROP TRIGGER promotion_fail ON blob_bindings" : "DROP TRIGGER promotion_fail");
        if (pg) {
          await postgresQuery("DROP FUNCTION promotion_fail()");
        }
      }
      assert.equal((await f.send()).body.records_accepted, 1);
      assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
    });
  } finally {
    await closeTestServer(server);
    if (pg) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});
