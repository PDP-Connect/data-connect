// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A connector child gets a run-scoped credential that can do one thing:
// upload blobs for its own connector instance while its run is live. The
// owner bearer never reaches the child. These tests pin the credential's
// lifecycle (controller), its route scope (server), and its rejection on every
// other route.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRunBlobUploadCredentialRegistry } from "../server/run-blob-upload-credentials.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-05-18T12:00:00.000Z";
const OWNER = "owner_local";

// ---------------------------------------------------------------------------
// Controller lifecycle: minted at admission, revoked at run end.
// ---------------------------------------------------------------------------

function freshDb(t: TestContext) {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), "pdpp-run-blob-cred-"));
  t.after(() => {
    try {
      __resetControllerInteractionStateForTests();
      closeDb();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
  initDb(join(dir, "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
}

const CONTROLLER_MANIFEST = {
  connector_id: "amazon",
  name: "Amazon",
  streams: [
    {
      name: "order_items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

test("controller mints a run credential bound to the run's connection and revokes it when the run ends", async (t) => {
  freshDb(t);
  const registry = createRunBlobUploadCredentialRegistry();
  const seen: Array<{
    liveBinding: ReturnType<typeof registry.verify>;
    ownerToken: string;
    token: string | null | undefined;
  }> = [];
  const controller = createController({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? "cin_default",
        ownerSubjectId: ownerSubjectId ?? OWNER,
      }),
    blobUploadCredentialHooks: registry,
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => undefined, warn: () => undefined },
    ownerSubjectId: OWNER,
    runConnectorImpl: (opts: RuntimeRunConnectorOptions) => {
      seen.push({
        liveBinding: opts.blobUploadToken ? registry.verify(opts.blobUploadToken) : null,
        ownerToken: opts.ownerToken,
        token: opts.blobUploadToken,
      });
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
  });

  for (const runId of ["run_blob_cred_1", "run_blob_cred_2"]) {
    await controller.runNow("amazon", {
      connectorInstanceId: "cin_blob_cred",
      manifest: CONTROLLER_MANIFEST,
      ownerToken: "owner-bearer-for-the-parent",
      runId,
    });
    await controller.drainActiveRuns(1000);
  }

  assert.equal(seen.length, 2);
  const [first, second] = seen;
  assert.ok(first?.token && second?.token, "each admitted run gets a credential");
  assert.notEqual(first.token, second.token, "credentials are per run");
  assert.notEqual(first.token, first.ownerToken, "the credential is not the owner bearer");
  for (const [entry, runId] of [
    [first, "run_blob_cred_1"],
    [second, "run_blob_cred_2"],
  ] as const) {
    assert.deepEqual(entry.liveBinding, {
      connectorId: "amazon",
      connectorInstanceId: "cin_blob_cred",
      ownerSubjectId: OWNER,
      runId,
    });
  }
  // Both runs have ended: neither credential verifies any more.
  assert.equal(registry.verify(first.token), null);
  assert.equal(registry.verify(second.token), null);
});

test("controller without credential hooks gives the child no blob credential", async (t) => {
  freshDb(t);
  const tokens: Array<string | null | undefined> = [];
  const controller = createController({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? "cin_default",
        ownerSubjectId: ownerSubjectId ?? OWNER,
      }),
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => undefined, warn: () => undefined },
    ownerSubjectId: OWNER,
    runConnectorImpl: (opts: RuntimeRunConnectorOptions) => {
      tokens.push(opts.blobUploadToken);
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
  });
  await controller.runNow("amazon", {
    connectorInstanceId: "cin_blob_cred",
    manifest: CONTROLLER_MANIFEST,
    ownerToken: "owner-bearer-for-the-parent",
    runId: "run_blob_cred_none",
  });
  await controller.drainActiveRuns(1000);
  assert.deepEqual(tokens, [null]);
});

// ---------------------------------------------------------------------------
// Route scope: the credential works on POST /v1/blobs for its own instance only.
// ---------------------------------------------------------------------------

async function seedSpotify(asUrl: string): Promise<string> {
  const manifest: { connector_id: string } = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  const canonicalId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
  const store = createSqliteConnectorInstanceStore();
  for (const [id, key] of [
    ["cin_spotify_work", "acct_work"],
    ["cin_spotify_personal", "acct_personal"],
  ] as const) {
    await store.upsert({
      connectorId: canonicalId,
      connectorInstanceId: id,
      createdAt: NOW,
      displayName: id,
      ownerSubjectId: OWNER,
      sourceBinding: { account_hint: key },
      sourceBindingKey: key,
      sourceKind: "account",
      updatedAt: NOW,
    });
  }
  return manifest.connector_id;
}

function uploadBlob(rsUrl: string, token: string, connectorId: string, instanceId: string | null) {
  const instance = instanceId ? `&connector_instance_id=${encodeURIComponent(instanceId)}` : "";
  return fetch(
    `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}${instance}&stream=top_artists&record_key=artist_blob`,
    {
      body: "blob bytes",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      method: "POST",
    }
  );
}

test("run credential uploads blobs for its own connector instance only, and is rejected elsewhere", async () => {
  const registry = createRunBlobUploadCredentialRegistry();
  const server = (await startServer({
    asPort: 0,
    blobUploadCredentials: registry,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  }));
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const connectorId = await seedSpotify(asUrl);
    const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;

    const token = "run-credential-for-work-instance";
    registry.register({
      connectorId: canonicalId,
      connectorInstanceId: "cin_spotify_work",
      ownerSubjectId: OWNER,
      runId: "run_route_1",
      token,
    });

    // Accepted: own connector (canonical or URL form) and own instance.
    const ok = await uploadBlob(rsUrl, token, canonicalId, "cin_spotify_work");
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { blob_id: string; object: string };
    assert.equal(okBody.object, "blob");
    assert.equal((await uploadBlob(rsUrl, token, connectorId, "cin_spotify_work")).status, 200);

    // Rejected: another instance of the same connector.
    assert.equal((await uploadBlob(rsUrl, token, canonicalId, "cin_spotify_personal")).status, 403);
    // Rejected: no instance named (the credential is bound to one).
    assert.equal((await uploadBlob(rsUrl, token, canonicalId, null)).status, 403);
    // Rejected: another connector, even with the bound instance id.
    assert.equal((await uploadBlob(rsUrl, token, "gmail", "cin_spotify_work")).status, 403);

    // Rejected on every other route: it is an unknown bearer there.
    const bearer = { Authorization: `Bearer ${token}` };
    const ownerReads = [
      `${rsUrl}/v1/schema`,
      `${rsUrl}/v1/streams`,
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(canonicalId)}&connector_instance_id=cin_spotify_work`,
      `${rsUrl}/v1/blobs/${encodeURIComponent(okBody.blob_id)}?connector_id=${encodeURIComponent(canonicalId)}&connector_instance_id=cin_spotify_work`,
      `${rsUrl}/v1/state/${encodeURIComponent(canonicalId)}?connector_instance_id=cin_spotify_work`,
      `${rsUrl}/v1/owner/connections`,
    ];
    for (const url of ownerReads) {
      const resp = await fetch(url, { headers: bearer });
      assert.equal(resp.status, 401, `${url} must reject the run credential`);
    }
    const ingest = await fetch(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(canonicalId)}&connector_instance_id=cin_spotify_work`,
      {
        body: `${JSON.stringify({ data: { id: "a", name: "a" }, key: "a" })}\n`,
        headers: { ...bearer, "Content-Type": "application/x-ndjson" },
        method: "POST",
      }
    );
    assert.equal(ingest.status, 401);

    // Revoked at run end: the same request now fails.
    registry.revoke({ runId: "run_route_1" });
    assert.equal((await uploadBlob(rsUrl, token, canonicalId, "cin_spotify_work")).status, 401);
  } finally {
    await closeTestServer(server);
  }
});

test("a credential from an earlier run stays rejected after a later run starts for the same instance", async () => {
  const registry = createRunBlobUploadCredentialRegistry();
  const server = (await startServer({
    asPort: 0,
    blobUploadCredentials: registry,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  }));
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const connectorId = await seedSpotify(asUrl);
    const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
    const binding = { connectorId: canonicalId, connectorInstanceId: "cin_spotify_work", ownerSubjectId: OWNER };

    registry.register({ ...binding, runId: "run_a", token: "token-run-a" });
    assert.equal((await uploadBlob(rsUrl, "token-run-a", canonicalId, "cin_spotify_work")).status, 200);
    registry.revoke({ runId: "run_a" });
    registry.register({ ...binding, runId: "run_b", token: "token-run-b" });

    assert.equal((await uploadBlob(rsUrl, "token-run-a", canonicalId, "cin_spotify_work")).status, 401);
    assert.equal((await uploadBlob(rsUrl, "token-run-b", canonicalId, "cin_spotify_work")).status, 200);
  } finally {
    await closeTestServer(server);
  }
});
