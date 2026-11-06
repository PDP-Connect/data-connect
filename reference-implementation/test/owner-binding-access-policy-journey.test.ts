// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { createConnectorBindingAccessPolicyStore } from "../server/stores/connector-binding-access-policy-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { policyAction, preparedAccess, weakAck } from "./helpers/binding-access-policy-fixture.ts";
import { bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { approveClientGrant, issueOwnerToken } from "./helpers/binding-owner-auth.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
test("real owner bearer reads prepared facts, confirms exact subset, refuses stale/rejected/foreign access, withdraws without resource claims", async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  }
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    storageBackend: POSTGRES_URL ? "postgres" : "sqlite",
    ...(POSTGRES_URL ? { databaseUrl: POSTGRES_URL } : {}),
  });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    await seedBindingConnection("http-policy");
    await seedBindingConnection("http-policy-foreign", "other-owner");
    const store = createConnectorBindingAccessPolicyStore();
    const snapshot = preparedAccess("http-policy");
    const proposal = await store.propose({
      baseEpoch: 0,
      baseRevision: 0,
      provenance: { preparedBy: "trusted fixture" },
      snapshot,
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const otherToken = await issueOwnerToken(asUrl, "other-owner");
    const base = "/v1/owner/connections/http-policy/binding-access-policy";
    const proposalPath = `${base}/proposals/${proposal.proposalId}`;
    const request = async (path: string, token?: string, requestBody?: unknown) => {
      const response = await fetch(`${rsUrl}${path}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        method: requestBody === undefined ? "GET" : "POST",
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response;
    };
    assert.equal((await request(base)).status, 401);
    await Promise.all(
      [
        base,
        proposalPath,
        base.replace("http-policy/", "http-policy-foreign/"),
        base.replace("http-policy/", "missing/"),
      ].map(async (path) => {
        const denied = await request(path, otherToken);
        if (path.includes("http-policy-foreign")) {
          assert.equal(denied.status, 200);
          return;
        }
        assert.equal(denied.status, 404);
        const message = JSON.stringify(await denied.json());
        assert.equal(message.includes("/fixture/selected"), false);
        assert.equal(message.includes(ownerToken), false);
      })
    );
    const read = await request(proposalPath, ownerToken);
    assert.equal(read.status, 200);
    const displayed = (await read.json()) as {
      proposal: { snapshot: unknown; snapshotDigest: string };
      active: unknown;
    };
    assert.deepEqual(displayed.proposal.snapshot, snapshot);
    assert.equal(displayed.proposal.snapshotDigest, proposal.snapshotDigest);
    assert.equal(displayed.active, null);
    assert.deepEqual(await store.resolve(snapshot), []);
    const body = {
      acknowledgments: weakAck(snapshot),
      baseEpoch: proposal.baseEpoch,
      revision: proposal.revision,
      snapshotDigest: proposal.snapshotDigest,
    };
    assert.equal(
      (await request(`${proposalPath}/confirm`, ownerToken, { ...body, ownerId: "other-owner" })).status,
      400
    );
    assert.equal((await request(`${proposalPath}/confirm`, otherToken, body)).status, 404);
    assert.equal(
      (await request(`${proposalPath}/confirm`, ownerToken, { ...body, snapshotDigest: "0".repeat(64) })).status,
      409
    );
    assert.equal(
      (
        await request(`${proposalPath}/confirm`, ownerToken, {
          ...body,
          acknowledgments: [{ ...weakAck(snapshot)[0], channel: "wrong" }],
        })
      ).status,
      400
    );
    const confirm = await request(`${proposalPath}/confirm`, ownerToken, body);
    assert.equal(confirm.status, 200);
    const confirmed = (await confirm.json()) as { confirmedAt: string; snapshot: unknown };
    assert.deepEqual(confirmed.snapshot, snapshot);
    assert.equal((await store.resolve(snapshot)).length, 1);
    const replay = await request(`${proposalPath}/confirm`, ownerToken, body);
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { confirmedAt: string }).confirmedAt, confirmed.confirmedAt);
    assert.equal((await request(`${proposalPath}/confirm`, ownerToken, { ...body, acknowledgments: [] })).status, 409);
    const withdrawal = await request(`${proposalPath}/withdraw`, ownerToken, {
      baseEpoch: 1,
      revision: body.revision,
      snapshotDigest: body.snapshotDigest,
    });
    assert.equal(withdrawal.status, 200);
    assert.deepEqual(await store.resolve(snapshot), []);
    assert.equal((await request(`${proposalPath}/confirm`, ownerToken, body)).status, 409);
    const state = await store.read(snapshot);
    const rejected = await store.propose({
      baseEpoch: state.epoch,
      baseRevision: state.revision,
      provenance: {},
      snapshot,
    });
    const rejectBody = {
      baseEpoch: rejected.baseEpoch,
      revision: rejected.revision,
      snapshotDigest: rejected.snapshotDigest,
    };
    const rejectPath = `${base}/proposals/${rejected.proposalId}`;
    assert.equal((await request(`${rejectPath}/reject`, ownerToken, rejectBody)).status, 200);
    assert.equal(
      (await request(`${rejectPath}/confirm`, ownerToken, { ...rejectBody, acknowledgments: weakAck(snapshot) }))
        .status,
      409
    );
    // Authenticate a real grant bearer through the existing PAR/consent flow.
    const manifest = JSON.parse(
      readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")
    ) as { connector_id: string; streams: { name: string }[] };
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    const connectorId = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorId);
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: "owner_local",
    });
    const [stream] = manifest.streams;
    assert.ok(stream);
    const grantToken = await approveClientGrant(
      asUrl,
      manifest.connector_id,
      stream.name,
      namespace.connectorInstanceId
    );
    assert.equal((await request(base, grantToken)).status, 403);
    assert.equal((await request(`${proposalPath}/confirm`, grantToken, body)).status, 403);
    // A body cannot manufacture authoritative prepared facts: no proposal POST route.
    const publicWriter = await fetch(`${rsUrl}${base}/proposals`, {
      body: JSON.stringify({ snapshot }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(publicWriter.status, 404);
    await bindingQuery("UPDATE connector_binding_access_policies SET snapshot_json = ? WHERE connection_id = ?", [
      "fixture-private-marker{",
      snapshot.connectionId,
    ]);
    assert.equal((await request(proposalPath, otherToken)).status, 404);
    const corrupt = await request(proposalPath, ownerToken);
    assert.equal(corrupt.status, 500);
    const message = JSON.stringify(await corrupt.json());
    assert.equal(message.includes("fixture-private-marker"), false);
    assert.equal(message.includes(ownerToken), false);
    assert.equal(message.includes(policyAction(proposal).proposalId), false);
  } finally {
    await closeTestServer(server);
    if (POSTGRES_URL) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});
