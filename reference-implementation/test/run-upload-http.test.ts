// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { RunUploadLifetime } from "../runtime/run-upload-lifetime.ts";
import { snapshotRunUploadSelection } from "../runtime/run-upload-selection.ts";
import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { initializeRunUploadIssuer } from "../server/run-upload-issuer.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import type { RunUploadAuthority } from "../server/stores/run-upload-permission-store.ts";
import { createRunUploadPermissionStore } from "../server/stores/run-upload-permission-store.ts";
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
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "attachments",
        primary_key: ["id"],
        schema: {
          properties: {
            blob_ref: {
              properties: {
                blob_id: { type: "string" },
                mime_type: { type: "string" },
                sha256: { type: "string" },
                size_bytes: { type: "integer" },
              },
              required: ["blob_id"],
              type: "object",
            },
            content_sha256: { type: "string" },
            date: { type: "string" },
            folder: { type: "string" },
            id: { type: "string" },
            size_bytes: { type: "integer" },
          },
          required: ["id"],
          type: "object",
        },
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
const bytes = Buffer.from("message body bytes from the shipped uploader", "utf8");
const parentAuthorityPattern = /parent owner authority/;
const retiredIssuerPattern = /retired/;
const closedPattern = /closed/;
const notPendingPattern = /not pending/;
const revokeFailedPattern = /revoke fence failed/;
const blobIdPattern = /^blob_sha256_[a-f0-9]{64}$/;
const uploaderModule = await import("../../node_modules/@pdpp/polyfill-connectors/src/reference-blob-uploader.js");
const makeReferenceBlobUploader: typeof import("../../node_modules/@pdpp/polyfill-connectors/src/reference-blob-uploader.js").makeReferenceBlobUploader =
  uploaderModule.makeReferenceBlobUploader;

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

async function mutate(sql: string, params: (string | number)[] = []): Promise<void> {
  if (isPostgresStorageBackend()) {
    let parameterIndex = 0;
    await postgresQuery(
      sql.replaceAll("?", () => {
        parameterIndex += 1;
        return `$${parameterIndex}`;
      }),
      params
    );
  } else {
    getDb()
      .prepare(sql)
      .run(...params);
  }
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

async function issueUploadToken(
  id: string,
  generation: number,
  expiresAt = Date.now() + 60_000,
  withStaging = false,
  recordKey = "message-1",
  subjectId = ownerId
) {
  const store = createRunUploadPermissionStore();
  const { issuerEpoch } = await store.beginIssuerEpoch(id);
  return store.issue({
    associations: [
      {
        allJsonPointers: false,
        paths: ["/body_text", "/body_html"],
        recordKeys: [recordKey],
        stream: "message_bodies",
      },
      { allJsonPointers: false, paths: ["@record"], recordKeys: ["attachment-1"], stream: "attachments" },
    ],
    connectionId: id,
    connectorId: manifest.connector_id,
    expiresAt,
    generation,
    issuerEpoch,
    manifestSnapshot: { streams: manifest.streams },
    ownerId: subjectId,
    purpose: "blob-upload",
    runId: `run-${id}`,
    selectionIdentity: "fixture-selected-streams",
    sourceSnapshot: (manifest as Record<string, unknown>).source_declaration as Record<string, unknown>,
    ...(withStaging
      ? {
          staging: {
            maxBytes: 4096,
            selection: {
              streams: [
                {
                  consentTimeField: "date",
                  fields: ["body_html", "body_text", "date", "folder", "id"],
                  name: "message_bodies",
                  requiredFields: ["id"],
                  resourceField: "folder",
                  resources: ["inbox"],
                  timeRange: { since: "2026-01-01", until: "2027-01-01" },
                },
                {
                  consentTimeField: "date",
                  fields: ["blob_ref", "content_sha256", "date", "folder", "id", "size_bytes"],
                  name: "attachments",
                  requiredFields: ["id"],
                  resourceField: "folder",
                  resources: ["inbox"],
                  timeRange: { since: "2026-01-01", until: "2027-01-01" },
                },
              ],
              version: 1,
            },
          },
        }
      : {}),
  });
}

async function verifyMissingStagingConfigFailsClosed(pg: boolean): Promise<void> {
  const attachment = pg
    ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
    : undefined;
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
    runUploadStagingGlobalMaxBytes: null,
  })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.ok(registered.ok, `missing-config manifest registration failed (${registered.status})`);
    const id = "cin_run_upload_http_missing_config";
    const missingOwner = "owner_upload_http_missing_config";
    await seedConnection(id, manifest.connector_id, missingOwner);
    const stagedGrant = await issueUploadToken(id, 1, Date.now() + 60_000, true, "message-1", missingOwner);
    await mutate(
      "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
      [id, manifest.connector_id, stagedGrant.grant.runId, new Date().toISOString()]
    );
    const response = await fetch(uploadUrl(rsUrl, { connector_instance_id: id }), {
      body: Buffer.from("must never reach canonical storage", "utf8"),
      headers: { Authorization: `Bearer ${stagedGrant.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "temporarily_unavailable");
    assert.deepEqual(await blobCounts(id), [0, 0]);
    await createRunUploadPermissionStore().revoke({
      connectionId: id,
      generation: stagedGrant.grant.generation,
      issuerEpoch: stagedGrant.grant.issuerEpoch,
      ownerId: missingOwner,
      runId: stagedGrant.grant.runId,
    });
    await mutate("DELETE FROM run_history WHERE connector_instance_id = ? AND run_id = ?", [
      id,
      stagedGrant.grant.runId,
    ]);
  } finally {
    await closeTestServer(server);
    if (pg) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
}

function uploadUrl(rsUrl: string, changes: Record<string, string> = {}): URL {
  const url = new URL("/v1/blobs", rsUrl);
  const query = {
    connector_id: manifest.connector_id,
    connector_instance_id: connectionId,
    json_path: "/body_text",
    record_key: "message-1",
    stream: "message_bodies",
    ...changes,
  };
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function blobCounts(id: string): Promise<[number, number]> {
  const [blobs] = await rows("SELECT count(*) AS n FROM blobs WHERE connector_instance_id = ?", [id]);
  const [bindings] = await rows("SELECT count(*) AS n FROM blob_bindings WHERE connector_instance_id = ?", [id]);
  return [Number(blobs?.n), Number(bindings?.n)];
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function forEachSequentially<T>(next: () => T | undefined, action: (item: T) => Promise<void>): Promise<void> {
  const item = next();
  if (item === undefined) {
    return;
  }
  await action(item);
  await forEachSequentially(next, action);
}

test("invalid run-upload global staging budgets reject before server startup", async () => {
  await assert.rejects(
    startServer({ runUploadStagingGlobalMaxBytes: 0 }),
    (error: unknown) => error instanceof TypeError && error.message.includes("positive safe integer")
  );
});

test("normal startup invalidates retained stages and orphan permissions on the same durable database", async (t) => {
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  const directory = mkdtempSync(join(tmpdir(), "upload-restart-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  async function start() {
    const attachment = pg
      ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
      : undefined;
    return startServer({
      asPort: 0,
      dbPath: join(directory, "durable.sqlite"),
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      storageBackend: pg ? "postgres" : "sqlite",
      ...(pg
        ? {
            databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
            testOnlyAlreadyAdmittedPostgresChildAttachment: attachment || "",
          }
        : {}),
    });
  }
  async function stop(server: TestServer) {
    await closeTestServer(server);
    if (pg) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
  const first = await start();
  const id = "cin_durable_upload_restart";
  let oldToken = "";
  let oldEpoch = "";
  let orphanEpoch = "";
  try {
    const registered = await fetch(`http://localhost:${first.asPort}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.ok(registered.ok);
    await seedConnection(id);
    const authority = await issueUploadToken(id, 8, Date.now() + 60_000, true);
    oldToken = authority.token;
    oldEpoch = authority.grant.issuerEpoch;
    await mutate(
      "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
      [id, manifest.connector_id, authority.grant.runId, new Date().toISOString()]
    );
    const upload = await fetch(uploadUrl(`http://localhost:${first.rsPort}`, { connector_instance_id: id }), {
      body: bytes,
      headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(upload.status, 200);
    assert.equal((await rows("SELECT * FROM connector_run_upload_stages WHERE connection_id = ?", [id])).length, 1);
    orphanEpoch = (await createRunUploadPermissionStore().beginIssuerEpoch("cin_orphan_upload_restart")).issuerEpoch;
  } finally {
    await stop(first);
  }
  const second = await start();
  try {
    await assert.rejects(createRunUploadPermissionStore().resolve(oldToken));
    assert.equal((await rows("SELECT * FROM connector_run_upload_stages WHERE connection_id = ?", [id])).length, 0);
    const [permission] = await rows("SELECT * FROM connector_run_upload_permissions WHERE connection_id = ?", [id]);
    assert.equal(Number(permission?.revoked), 1);
    assert.equal(Number(permission?.generation), 8);
    assert.notEqual(permission?.issuer_epoch, oldEpoch);
    const [orphan] = await rows("SELECT * FROM connector_run_upload_permissions WHERE connection_id = ?", [
      "cin_orphan_upload_restart",
    ]);
    assert.notEqual(orphan?.issuer_epoch, orphanEpoch);
    assert.equal(Number(orphan?.revoked), 1);
  } finally {
    await stop(second);
  }
});

test("run-upload HTTP preserves direct uploads and stages configured grants until accepted RECORD", async (t) => {
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  const attachment = pg
    ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
    : undefined;
  await verifyMissingStagingConfigFailsClosed(pg);
  const fixture = mkdtempSync(join(tmpdir(), "run-upload-child-"));
  t.after(() => rmSync(fixture, { force: true, recursive: true }));
  const connectorPath = join(fixture, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { makeReferenceBlobUploader } from ${JSON.stringify(new URL("../../node_modules/@pdpp/polyfill-connectors/src/reference-blob-uploader.js", import.meta.url).href)};
const input = createInterface({input:process.stdin});
for await (const line of input) {
  const start = JSON.parse(line);
  if (start.type !== 'START') continue;
  const token = process.env.PDPP_OWNER_TOKEN;
  if (!/^ru_[A-Za-z0-9_-]{43}$/.test(token)) throw Error('child authority is not narrow');
  for (const [path,method] of [
    ['/v1/state/'+process.env.PDPP_CONNECTOR_ID,'GET'],
    ['/v1/owner/connections/'+process.env.PDPP_CONNECTOR_INSTANCE_ID+'/reset-state','POST'],
    ['/v1/owner/credential/reveal','GET'],
    ['/v1/owner/connections/'+process.env.PDPP_CONNECTOR_INSTANCE_ID,'DELETE']
  ]) {
    const response = await fetch(process.env.PDPP_RS_URL+path,{method,headers:{Authorization:'Bearer '+token}});
    if (![401,403].includes(response.status)) throw Error('child reached owner route');
  }
  const uploader = makeReferenceBlobUploader({ownerToken:token,rsUrl:process.env.PDPP_RS_URL});
  const key = process.env.PDPP_RUN_ID.includes('negative') ? 'outside' : 'selected';
  const upload = () => uploader({connectorId:process.env.PDPP_CONNECTOR_ID,connectorInstanceId:process.env.PDPP_CONNECTOR_INSTANCE_ID,stream:'message_bodies',recordKey:key,jsonPath:'/body_text',mimeType:'text/plain',content:[Buffer.from('spawned SDK body')]});
  const first = await upload();
  const second = await upload();
  if (first.blob_id !== second.blob_id) throw Error('retry identity changed');
  const record = {type:'RECORD',emitted_at:new Date().toISOString(),stream:'message_bodies',key,data:{id:key,body_text:null}};
  console.log(JSON.stringify(record));
  console.log(JSON.stringify(record));
  console.log(JSON.stringify({type:'DONE',status:'succeeded',records_emitted:2}));
  input.close();
  break;
}
`
  );
  // startServer runs the real initPostgresStorage path with this runner-issued single-use attachment.
  const server = (await startServer({
    asPort: 0,
    connectorPathResolver: () => connectorPath,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    runUploadStagingGlobalMaxBytes: 1_000_000,
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
    assert.ok(
      registered.ok,
      `synthetic manifest registration failed (${registered.status}): ${await registered.text()}`
    );
    await seedConnection(connectionId);
    const ownerToken = await issueOwnerToken(asUrl);
    await t.test("normal controller spawned SDK upload promotes with parent owner and closes exact grant", async () => {
      const id = "cin_spawned_upload";
      await seedConnection(id);
      const runId = "run_spawned_upload_success";
      await server.controller.runNow(manifest.connector_id, {
        connectorInstanceId: id,
        ownerSubjectId: ownerId,
        ownerToken,
        resources: { message_bodies: ["selected"] },
        rsUrl,
        runId,
      });
      assert.equal(await server.controller.awaitRun(runId), "succeeded");
      assert.deepEqual(await blobCounts(id), [1, 1]);
      const [stored] = await rows("SELECT data FROM blobs WHERE connector_instance_id = ?", [id]);
      assert.equal(Buffer.from(stored?.data as Uint8Array).toString(), "spawned SDK body");
      const [permission] = await rows("SELECT revoked FROM connector_run_upload_permissions WHERE connection_id = ?", [
        id,
      ]);
      assert.equal(Number(permission?.revoked), 1);
      assert.equal((await rows("SELECT * FROM connector_run_upload_stages WHERE connection_id = ?", [id])).length, 0);
      await server.controller.runNow(manifest.connector_id, {
        connectorInstanceId: id,
        ownerSubjectId: ownerId,
        ownerToken,
        resources: { message_bodies: ["selected"] },
        rsUrl,
        runId: "run_spawned_upload_negative",
      });
      assert.equal(await server.controller.awaitRun("run_spawned_upload_negative"), "failed");
      assert.deepEqual(await blobCounts(id), [1, 1]);
      assert.equal((await rows("SELECT * FROM connector_run_upload_stages WHERE connection_id = ?", [id])).length, 0);
    });
    await t.test("static-secret parent-token alias refuses launch and closes issued authority", async () => {
      let closed = false;
      const lifetime = new RunUploadLifetime(
        (facts) =>
          Promise.resolve({
            grant: {
              ...facts,
              associations: [],
              expiresAt: Date.now() + 60_000,
              generation: 1,
              issuerEpoch: "e",
              purpose: "blob-upload",
              selectionIdentity: "s",
            },
            token: `ru_${"x".repeat(43)}`,
          }),
        () => {
          closed = true;
          return Promise.resolve();
        }
      );
      await assert.rejects(
        runConnector({
          admitRunConnection: () =>
            Promise.resolve({
              connectorId: manifest.connector_id,
              connectorInstanceId: connectionId,
              ownerSubjectId: ownerId,
            }),
          connectorId: manifest.connector_id,
          connectorInstanceId: connectionId,
          connectorPath,
          manifest,
          ownerSubjectId: ownerId,
          ownerToken,
          persistState: false,
          rsUrl,
          runUploadLifetime: lifetime,
          staticSecretEnv: { SYNTHETIC_SECRET: ownerToken },
        }),
        parentAuthorityPattern
      );
      assert.equal(closed, true);
    });
    await t.test(
      "issuer restart retires old controller and invalidates orphan rows with generation watermark",
      async () => {
        const factory = await initializeRunUploadIssuer(1000);
        const id = "cin_restart_upload";
        await seedConnection(id);
        const scope = {
          connectionId: id,
          connectorId: manifest.connector_id,
          expiresAt: Date.now() + 60_000,
          ownerId,
          runId: "run_restart",
        };
        const facts = {
          ...scope,
          manifestSnapshot: manifest,
          selection: snapshotRunUploadSelection({ streams: [{ name: "message_bodies" }] }, manifest),
          sourceSnapshot: {},
        };
        const old = factory(scope);
        const token = await old.issue(facts);
        const { grant } = await createRunUploadPermissionStore().resolve(token);
        const nextFactory = await initializeRunUploadIssuer(1000);
        await assert.rejects(createRunUploadPermissionStore().resolve(token));
        await assert.rejects(
          factory({ ...scope, runId: "stale" }).issue({ ...facts, runId: "stale" }),
          retiredIssuerPattern
        );
        const next = nextFactory({ ...scope, runId: "next" });
        const nextToken = await next.issue({ ...facts, runId: "next" });
        assert.ok((await createRunUploadPermissionStore().resolve(nextToken)).grant.generation > grant.generation);
        await old.close();
        await createRunUploadPermissionStore().resolve(nextToken);
        await next.close();
      }
    );
    const ownerState = await fetch(`${rsUrl}/v1/state/${manifest.connector_id}?connector_instance_id=${connectionId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerState.status, 200, `owner bearer must reach the real state route (${ownerState.status})`);
    // Issuance is deliberately after server startup; this test makes no lifecycle or controller claim.
    const issued = await issueUploadToken(connectionId, 1);
    const redProbe = await fetch(uploadUrl(rsUrl), {
      body: bytes,
      headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(redProbe.status, 200, `scoped run-upload bearer must publish before RECORD; got ${redProbe.status}`);
    const stateDenied = await fetch(`${rsUrl}/v1/state/${manifest.connector_id}`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert.ok(
      [401, 403].includes(stateDenied.status),
      `run-upload bearer reached owner state route (${stateDenied.status})`
    );
    const deniedPaths = [
      ["/v1/owner/connections/cin_run_upload_http/reset-state", "POST"],
      ["/v1/owner/connections/cin_run_upload_http", "DELETE"],
      ["/v1/owner/credential/reveal", "GET"],
    ] as const;
    let deniedPathIndex = 0;
    await forEachSequentially(
      () => {
        const path = deniedPaths[deniedPathIndex];
        deniedPathIndex += 1;
        return path;
      },
      async ([path, method]) => {
        const denied = await fetch(`${rsUrl}${path}`, {
          ...(method === "GET" ? {} : { body: "{}" }),
          headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" },
          method,
        });
        assert.ok([401, 403].includes(denied.status), `${method} ${path} returned ${denied.status}`);
      }
    );
    const uploader = makeReferenceBlobUploader({ ownerToken: issued.token, rsUrl });
    const uploaded = await uploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: connectionId,
      content: [bytes],
      jsonPath: "/body_text",
      mimeType: "text/plain",
      recordKey: "message-1",
      stream: "message_bodies",
    });
    assert.match(uploaded.blob_id, blobIdPattern);
    assert.equal(uploaded.sha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
    assert.equal(uploaded.size_bytes, bytes.byteLength);
    assert.deepEqual(await blobCounts(connectionId), [1, 1]);
    const [storedBlob] = await rows("SELECT data FROM blobs WHERE blob_id = ?", [uploaded.blob_id]);
    assert.deepEqual(Buffer.from(storedBlob?.data as Uint8Array), bytes);
    const [binding] = await rows(
      "SELECT blob_id, json_path, record_key, stream FROM blob_bindings WHERE connector_instance_id = ?",
      [connectionId]
    );
    assert.deepEqual(binding, {
      blob_id: uploaded.blob_id,
      json_path: "/body_text",
      record_key: "message-1",
      stream: "message_bodies",
    });

    const htmlUpload = await uploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: connectionId,
      content: [Buffer.from("<p>synthetic message body</p>")],
      jsonPath: "/body_html",
      mimeType: "text/html",
      recordKey: "message-1",
      stream: "message_bodies",
    });
    assert.match(htmlUpload.blob_id, blobIdPattern);
    assert.deepEqual(await blobCounts(connectionId), [2, 2]);

    const duplicate = await uploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: connectionId,
      content: [bytes],
      jsonPath: "/body_text",
      mimeType: "text/plain",
      recordKey: "message-1",
      stream: "message_bodies",
    });
    assert.equal(duplicate.blob_id, uploaded.blob_id);
    assert.deepEqual(await blobCounts(connectionId), [2, 2]);

    const attachmentUpload = await uploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: connectionId,
      content: [Buffer.from("synthetic attachment bytes")],
      mimeType: "application/octet-stream",
      recordKey: "attachment-1",
      stream: "attachments",
    });
    assert.match(attachmentUpload.blob_id, blobIdPattern);
    assert.deepEqual(await blobCounts(connectionId), [3, 3]);
    const [attachmentBinding] = await rows(
      "SELECT blob_id, json_path, record_key, stream FROM blob_bindings WHERE connector_instance_id = ? AND record_key = ?",
      [connectionId, "attachment-1"]
    );
    assert.deepEqual(attachmentBinding, {
      blob_id: attachmentUpload.blob_id,
      json_path: "@record",
      record_key: "attachment-1",
      stream: "attachments",
    });

    const stagedId = "cin_run_upload_http_staged";
    const stagedBytes = Buffer.from("private staged body bytes that were never canonically uploaded", "utf8");
    await seedConnection(stagedId);
    const stagedGrant = await issueUploadToken(stagedId, 1, Date.now() + 60_000, true);
    await mutate(
      "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
      [stagedId, manifest.connector_id, stagedGrant.grant.runId, new Date().toISOString()]
    );
    const stagedUploader = makeReferenceBlobUploader({ ownerToken: stagedGrant.token, rsUrl });
    const stagedRef = await stagedUploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: stagedId,
      content: [stagedBytes],
      jsonPath: "/body_text",
      mimeType: "text/plain",
      recordKey: "message-1",
      stream: "message_bodies",
    });
    assert.match(stagedRef.blob_id, blobIdPattern);
    assert.equal(
      stagedRef.sha256,
      (await import("node:crypto")).createHash("sha256").update(stagedBytes).digest("hex")
    );
    assert.equal(stagedRef.size_bytes, stagedBytes.byteLength);
    assert.deepEqual(await blobCounts(stagedId), [0, 0]);
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM records WHERE connector_instance_id = ?", [stagedId]))[0]?.n),
      0
    );
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id = ?", [stagedRef.blob_id]))[0]?.n),
      0
    );
    assert.equal(
      Number(
        (await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [stagedId]))[0]?.n
      ),
      1
    );
    const stagedRead = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(stagedRef.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}&connection_id=${encodeURIComponent(stagedId)}`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }
    );
    assert.equal(stagedRead.status, 404, `staged bytes must not be readable before RECORD (${stagedRead.status})`);
    const stagedRetry = await stagedUploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: stagedId,
      content: [stagedBytes],
      jsonPath: "/body_text",
      mimeType: "text/plain",
      recordKey: "message-1",
      stream: "message_bodies",
    });
    assert.equal(stagedRetry.blob_id, stagedRef.blob_id);
    assert.equal(
      Number(
        (await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [stagedId]))[0]?.n
      ),
      1
    );
    const stageConflict = await fetch(uploadUrl(rsUrl, { connector_instance_id: stagedId }), {
      body: Buffer.from("different content for the same run association"),
      headers: { Authorization: `Bearer ${stagedGrant.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(stageConflict.status, 409, "different retry bytes for one staged association must conflict");
    const stagedIngest = await fetch(
      `${rsUrl}/v1/ingest/message_bodies?connector_id=${encodeURIComponent(manifest.connector_id)}&connector_instance_id=${encodeURIComponent(stagedId)}&run_id=${encodeURIComponent(stagedGrant.grant.runId)}`,
      {
        body: `${JSON.stringify({ data: { body_text: null, date: "2026-06-01", folder: "inbox", id: "message-1" }, key: "message-1" })}\n`,
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
        method: "POST",
      }
    );
    assert.equal(stagedIngest.status, 200, `accepted owner RECORD returned ${stagedIngest.status}`);
    const stagedIngestBody = (await stagedIngest.json()) as { records_accepted?: number };
    assert.equal(stagedIngestBody.records_accepted, 1);
    assert.deepEqual(await blobCounts(stagedId), [1, 1]);
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id = ?", [stagedRef.blob_id]))[0]?.n),
      1
    );
    assert.equal(
      Number(
        (await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [stagedId]))[0]?.n
      ),
      0
    );
    const bodyNoop = await fetch(
      `${rsUrl}/v1/ingest/message_bodies?connector_id=${encodeURIComponent(manifest.connector_id)}&connector_instance_id=${encodeURIComponent(stagedId)}&run_id=${encodeURIComponent(stagedGrant.grant.runId)}`,
      {
        body: `${JSON.stringify({ data: { body_text: null, date: "2026-06-01", folder: "inbox", id: "message-1" }, key: "message-1" })}\n`,
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
        method: "POST",
      }
    );
    assert.equal(bodyNoop.status, 200);
    assert.deepEqual(await blobCounts(stagedId), [1, 1]);
    const attachmentBytes = Buffer.from("private staged attachment bytes", "utf8");
    const stagedAttachmentRef = await stagedUploader({
      connectorId: manifest.connector_id,
      connectorInstanceId: stagedId,
      content: [attachmentBytes],
      mimeType: "application/octet-stream",
      recordKey: "attachment-1",
      stream: "attachments",
    });
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id = ?", [stagedAttachmentRef.blob_id]))[0]?.n),
      0
    );
    assert.equal(
      Number(
        (await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [stagedId]))[0]?.n
      ),
      1
    );
    const attachmentRecord = {
      blob_ref: stagedAttachmentRef,
      content_sha256: stagedAttachmentRef.sha256,
      date: "2026-06-01",
      folder: "inbox",
      id: "attachment-1",
      size_bytes: stagedAttachmentRef.size_bytes,
    };
    const attachmentIngestUrl = `${rsUrl}/v1/ingest/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}&connector_instance_id=${encodeURIComponent(stagedId)}&run_id=${encodeURIComponent(stagedGrant.grant.runId)}`;
    const attachmentIngest = await fetch(attachmentIngestUrl, {
      body: `${JSON.stringify({ data: attachmentRecord, key: "attachment-1" })}\n`,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });
    assert.equal(attachmentIngest.status, 200, `accepted attachment RECORD returned ${attachmentIngest.status}`);
    assert.equal(((await attachmentIngest.json()) as { records_accepted?: number }).records_accepted, 1);
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id = ?", [stagedAttachmentRef.blob_id]))[0]?.n),
      1
    );
    const attachmentRead = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(stagedAttachmentRef.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}&connection_id=${encodeURIComponent(stagedId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(attachmentRead.status, 200);
    assert.deepEqual(Buffer.from(await attachmentRead.arrayBuffer()), attachmentBytes);
    const attachmentNoop = await fetch(attachmentIngestUrl, {
      body: `${JSON.stringify({ data: attachmentRecord, key: "attachment-1" })}\n`,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });
    assert.equal(attachmentNoop.status, 200);
    assert.equal(((await attachmentNoop.json()) as { records_accepted?: number }).records_accepted, 1);
    assert.equal(
      Number((await rows("SELECT count(*) AS n FROM blobs WHERE blob_id = ?", [stagedAttachmentRef.blob_id]))[0]?.n),
      1
    );

    const scopeNegativeCases = [
      { data: { body_text: null, date: "2026-06-01", folder: "trash", id: "negative-resource" }, id: "resource" },
      { data: { body_text: null, date: "2028-01-01", folder: "inbox", id: "negative-date" }, id: "date" },
      {
        data: { body_text: null, date: "2026-06-01", folder: "inbox", id: "negative-field", unselected: "secret" },
        id: "field",
      },
    ];
    let scopeNegativeIndex = 0;
    await forEachSequentially(
      () => {
        const item = scopeNegativeCases[scopeNegativeIndex];
        scopeNegativeIndex += 1;
        return item;
      },
      async ({ data, id: reason }) => {
        const negativeId = `cin_run_upload_http_scope_${reason}`;
        const recordKey = data.id;
        await seedConnection(negativeId);
        const negativeGrant = await issueUploadToken(negativeId, 1, Date.now() + 60_000, true, recordKey);
        await mutate(
          "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
          [negativeId, manifest.connector_id, negativeGrant.grant.runId, new Date().toISOString()]
        );
        const upload = await fetch(uploadUrl(rsUrl, { connector_instance_id: negativeId, record_key: recordKey }), {
          body: Buffer.from(`private ${reason} negative bytes`, "utf8"),
          headers: { Authorization: `Bearer ${negativeGrant.token}`, "Content-Type": "application/octet-stream" },
          method: "POST",
        });
        assert.equal(upload.status, 200);
        const ingest = await fetch(
          `${rsUrl}/v1/ingest/message_bodies?connector_id=${encodeURIComponent(manifest.connector_id)}&connector_instance_id=${encodeURIComponent(negativeId)}&run_id=${encodeURIComponent(negativeGrant.grant.runId)}`,
          {
            body: `${JSON.stringify({ data, key: recordKey })}\n`,
            headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
            method: "POST",
          }
        );
        assert.equal(ingest.status, 200);
        const result = (await ingest.json()) as { records_accepted?: number; records_rejected?: number };
        assert.equal(result.records_accepted, 0, `${reason} scope mismatch was accepted`);
        assert.equal(result.records_rejected, 1, `${reason} scope mismatch did not return a record failure`);
        assert.deepEqual(await blobCounts(negativeId), [0, 0]);
        assert.equal(
          Number(
            (
              await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [negativeId])
            )[0]?.n
          ),
          1
        );
        await createRunUploadPermissionStore().revoke({
          connectionId: negativeId,
          generation: negativeGrant.grant.generation,
          issuerEpoch: negativeGrant.grant.issuerEpoch,
          ownerId,
          runId: negativeGrant.grant.runId,
        });
        assert.deepEqual(await blobCounts(negativeId), [0, 0]);
        assert.equal(
          Number(
            (
              await rows("SELECT count(*) AS n FROM connector_run_upload_stages WHERE connection_id = ?", [negativeId])
            )[0]?.n
          ),
          0
        );
      }
    );

    const limitedId = "cin_run_upload_http_limited";
    await seedConnection(limitedId);
    const limitedGrant = await issueUploadToken(limitedId, 1, Date.now() + 60_000, true);
    await mutate(
      "INSERT INTO run_history (connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, attempt, scheduler_managed) VALUES (?, ?, '{}', 'running', 0, '[]', ?, ?, 1, TRUE)",
      [limitedId, manifest.connector_id, limitedGrant.grant.runId, new Date().toISOString()]
    );
    const limitedUpload = await fetch(uploadUrl(rsUrl, { connector_instance_id: limitedId }), {
      body: Buffer.alloc(4097, 0x61),
      headers: { Authorization: `Bearer ${limitedGrant.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(limitedUpload.status, 429);
    assert.equal(((await limitedUpload.json()) as { error?: { code?: string } }).error?.code, "run_upload_stage_limit");
    assert.deepEqual(await blobCounts(limitedId), [0, 0]);

    const beforeDenied = await blobCounts(connectionId);
    const deniedChanges = [
      { connector_instance_id: "cin_upload_wrong_instance" },
      { connector_id: "elsewhere" },
      { stream: "unselected-stream" },
      { json_path: "/not_selected" },
      { json_path: "/body_html", record_key: "other-record" },
      { record_key: "other-record" },
    ];
    let deniedChangeIndex = 0;
    await forEachSequentially(
      () => {
        const change = deniedChanges[deniedChangeIndex];
        deniedChangeIndex += 1;
        return change;
      },
      async (change) => {
        const denied = await fetch(uploadUrl(rsUrl, change), {
          body: bytes,
          headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/octet-stream" },
          method: "POST",
        });
        assert.ok(
          [401, 403, 404].includes(denied.status),
          `wrong upload scope ${JSON.stringify(change)} returned ${denied.status}`
        );
      }
    );
    assert.deepEqual(await blobCounts(connectionId), beforeDenied);
    await seedConnection("cin_upload_other_owner", manifest.connector_id, "owner_other");
    const wrongOwner = await fetch(uploadUrl(rsUrl, { connector_instance_id: "cin_upload_other_owner" }), {
      body: bytes,
      headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.ok([401, 403, 404].includes(wrongOwner.status), `wrong-owner upload returned ${wrongOwner.status}`);
    assert.deepEqual(await blobCounts("cin_upload_other_owner"), [0, 0]);

    const beforeQueuedRevoke = await blobCounts(connectionId);
    const writerEntered = deferred();
    const releaseWriter = deferred();
    __setConnectorInstanceWritePhaseHookForTest((stage, context): void | Promise<void> => {
      if (stage === "before_key_acquire" && context.connectorInstanceId === connectionId) {
        writerEntered.resolve();
        return releaseWriter.promise;
      }
    });
    let queuedUpload: Promise<Response> | undefined;
    try {
      queuedUpload = fetch(uploadUrl(rsUrl, { json_path: "/body_html", record_key: "message-1" }), {
        body: Buffer.from("upload racing committed revoke"),
        headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/octet-stream" },
        method: "POST",
      });
      const first = await Promise.race([
        writerEntered.promise.then(() => "writer-paused" as const),
        queuedUpload.then(() => "response-before-writer-hook" as const),
      ]);
      assert.equal(first, "writer-paused", "upload must reach the deterministic writer hook before revoke");
      await createRunUploadPermissionStore().revoke({
        connectionId,
        generation: issued.grant.generation,
        issuerEpoch: issued.grant.issuerEpoch,
        ownerId,
        runId: issued.grant.runId,
      });
      releaseWriter.resolve();
      const queuedResponse = await queuedUpload;
      assert.equal(
        queuedResponse.status,
        403,
        `queued upload after committed revoke returned ${queuedResponse.status}`
      );
      assert.deepEqual(await blobCounts(connectionId), beforeQueuedRevoke);
    } finally {
      releaseWriter.resolve();
      __setConnectorInstanceWritePhaseHookForTest(null);
      if (queuedUpload) {
        await Promise.allSettled([queuedUpload]);
      }
    }

    const ordinary = await fetch(uploadUrl(rsUrl, { record_key: "ordinary-owner-upload" }), {
      body: bytes,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.equal(ordinary.status, 200, `ordinary owner upload regressed (${ordinary.status})`);

    await createRunUploadPermissionStore().revoke({
      connectionId,
      generation: issued.grant.generation,
      issuerEpoch: issued.grant.issuerEpoch,
      ownerId,
      runId: issued.grant.runId,
    });
    const revoked = await fetch(uploadUrl(rsUrl), {
      body: bytes,
      headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.ok(revoked.status === 401 || revoked.status === 403, `revoked upload returned ${revoked.status}`);

    const expiredId = "cin_run_upload_http_expired";
    await seedConnection(expiredId);
    const expiry = Date.now() + 100;
    const expired = await issueUploadToken(expiredId, 1, expiry);
    await forEachSequentially(
      () => (Date.now() <= expiry ? 2 : undefined),
      async (interval) => {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    );
    const expiredResponse = await fetch(uploadUrl(rsUrl, { connector_instance_id: expiredId }), {
      body: bytes,
      headers: { Authorization: `Bearer ${expired.token}`, "Content-Type": "application/octet-stream" },
      method: "POST",
    });
    assert.ok(
      expiredResponse.status === 401 || expiredResponse.status === 403,
      `expired upload returned ${expiredResponse.status}`
    );
    assert.deepEqual(await blobCounts(expiredId), [0, 0]);
    const [record] = await rows("SELECT count(*) AS n FROM records WHERE connector_instance_id = ?", [connectionId]);
    assert.equal(Number(record?.n), 0);
  } finally {
    await closeTestServer(server);
    if (pg) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});

test("cancel before issue prevents issue; pending issue close waits for exact eventual revocation", async () => {
  const scope = { connectionId: "c", connectorId: "x", expiresAt: Date.now() + 60_000, ownerId: "o", runId: "r" };
  const grant = {
    ...scope,
    associations: [],
    generation: 1,
    issuerEpoch: "epoch",
    manifestSnapshot: {},
    purpose: "blob-upload" as const,
    selectionIdentity: "s",
    sourceSnapshot: {},
  };
  const authority = { grant, token: `ru_${"x".repeat(43)}` };
  const pending = deferred<RunUploadAuthority>();
  const revoke = deferred();
  let issueCalls = 0;
  let revoked: unknown;
  const lifetime = new RunUploadLifetime(
    () => {
      issueCalls += 1;
      return pending.promise;
    },
    async (value) => {
      revoked = value;
      await revoke.promise;
    }
  );
  const facts = { ...scope, manifestSnapshot: {}, selection: { streams: [], version: 1 as const }, sourceSnapshot: {} };
  const issuance = lifetime.issue(facts);
  let closed = false;
  const closing = lifetime.close().then(() => {
    closed = true;
  });
  pending.resolve(authority);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, false);
  revoke.resolve();
  await closing;
  await assert.rejects(issuance, closedPattern);
  assert.equal(revoked, grant);
  assert.equal(issueCalls, 1);
  const before = new RunUploadLifetime(
    () => Promise.reject(new Error("must not issue")),
    () => Promise.resolve()
  );
  await before.close();
  await assert.rejects(before.issue(facts), notPendingPattern);
});

test("failed upload close remains explicit and cannot claim revoked", async () => {
  const authority: RunUploadAuthority = {
    grant: {
      associations: [],
      connectionId: "c",
      connectorId: "x",
      expiresAt: Date.now() + 60_000,
      generation: 1,
      issuerEpoch: "epoch",
      manifestSnapshot: {},
      ownerId: "o",
      purpose: "blob-upload",
      runId: "r",
      selectionIdentity: "s",
      sourceSnapshot: {},
    },
    token: "unused",
  };
  const lifetime = new RunUploadLifetime(
    async () => authority,
    () => Promise.reject(new Error("revoke fence failed"))
  );
  await lifetime.issue({
    connectionId: "c",
    connectorId: "x",
    manifestSnapshot: {},
    ownerId: "o",
    runId: "r",
    selection: { streams: [], version: 1 },
    sourceSnapshot: {},
  });
  await assert.rejects(lifetime.close(), revokeFailedPattern);
  await assert.rejects(lifetime.close(), revokeFailedPattern);
});
