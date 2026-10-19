// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Core §5 (Declaration acceptance): an accepted declaration is keyed by
 * its source identity and `declaration_version`. Different parsed content under
 * an accepted key is equivocation: the authorization server MUST reject it and
 * retain the previously accepted content. Identical parsed content is an
 * idempotent re-registration, and a different version is a new key.
 *
 * Drives the real `POST /connectors` + `GET /connectors/:id` pair.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function closeServer(server: StartedServer): Promise<unknown> {
  const closeOne = (httpServer: StartedServer["asServer"] | StartedServer["rsServer"]) =>
    new Promise<void>((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      if ("closeAllConnections" in httpServer && typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function manifest(version: string, streamName: string): Record<string, unknown> {
  return {
    capabilities: { human_interaction: ["credentials"] },
    connector_id: "eqv",
    connector_key: "eqv",
    display_name: "eqv",
    manifest_uri: "https://registry.pdpp.dev/connectors/eqv",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        coverage_strategy: "full_inventory",
        description: "d",
        freshness_strategy: "manual_as_of",
        incremental: true,
        name: streamName,
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version,
  };
}

async function withServer(run: (asUrl: string) => Promise<void>): Promise<void> {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  try {
    await run(`http://localhost:${server.asPort}`);
  } finally {
    await closeServer(server);
  }
}

function register(asUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function retainedStreamNames(asUrl: string): Promise<string[]> {
  const detail = await fetch(`${asUrl}/connectors/eqv`);
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as { streams: { name: string }[] };
  return body.streams.map((stream) => stream.name);
}

test("same key and version with different content is rejected and the first content is retained", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);

    const second = await register(asUrl, manifest("v1", "beta"));
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: { code: string } };
    assert.equal(body.error.code, "declaration_equivocation");

    assert.deepEqual(await retainedStreamNames(asUrl), ["alpha"]);
  });
});

test("same key and version with identical content is an idempotent re-registration", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
    // Key order is not content: the parsed manifest is what is compared.
    const reordered = Object.fromEntries(Object.entries(manifest("v1", "alpha")).reverse());
    assert.equal((await register(asUrl, reordered)).status, 201);
    assert.deepEqual(await retainedStreamNames(asUrl), ["alpha"]);
  });
});

test("a new version with different content is accepted", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
    assert.equal((await register(asUrl, manifest("v2", "beta"))).status, 201);
    assert.deepEqual(await retainedStreamNames(asUrl), ["beta"]);
  });
});

test("content accepted under an earlier version is retained after a newer version becomes current", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
    assert.equal((await register(asUrl, manifest("v2", "beta"))).status, 201);

    // v1 is no longer current, but its accepted content A is still protected.
    const conflicting = await register(asUrl, manifest("v1", "gamma"));
    assert.equal(conflicting.status, 409);
    assert.equal(((await conflicting.json()) as { error: { code: string } }).error.code, "declaration_equivocation");

    const { getAcceptedDeclarationDigest, connectorDeclarationDigest, normalizeConnectorManifestForStorage } =
      await import("../server/auth.ts");
    const acceptedA = connectorDeclarationDigest(normalizeConnectorManifestForStorage(manifest("v1", "alpha")).storedManifest);
    assert.equal(await getAcceptedDeclarationDigest("eqv", "v1"), acceptedA);

    // The same accepted content is still accepted (idempotent) after v2.
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
  });
});

/** Drops the retained history, as in a database that predates it: only the current manifest remains. */
async function forgetAcceptedHistory(): Promise<void> {
  const { isPostgresStorageBackend, postgresQuery } = await import("../server/postgres-storage.ts");
  if (isPostgresStorageBackend()) {
    await postgresQuery("DELETE FROM connector_accepted_declarations WHERE connector_id = $1", ["eqv"]);
    return;
  }
  const { getDb } = await import("../server/db.ts");
  getDb().prepare("DELETE FROM connector_accepted_declarations WHERE connector_id = ?").run("eqv");
}

test("a manifest stored before history was kept stays protected after a newer version replaces it", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
    await forgetAcceptedHistory();

    assert.equal((await register(asUrl, manifest("v2", "beta"))).status, 201);

    const conflicting = await register(asUrl, manifest("v1", "gamma"));
    assert.equal(conflicting.status, 409);
    assert.equal(((await conflicting.json()) as { error: { code: string } }).error.code, "declaration_equivocation");
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);
  });
});

test("a trusted internal publication replaces the accepted content for its version", async () => {
  await withServer(async (asUrl) => {
    assert.equal((await register(asUrl, manifest("v1", "alpha"))).status, 201);

    // Startup reconcile and the installer rewrite content under the same version.
    const { registerConnector } = await import("../server/auth.ts");
    await registerConnector(manifest("v1", "beta"), { replaceAcceptedDigest: true });
    assert.deepEqual(await retainedStreamNames(asUrl), ["beta"]);

    // The corrected content is not equivocation; the superseded content is.
    assert.equal((await register(asUrl, manifest("v1", "beta"))).status, 201);
    const stale = await register(asUrl, manifest("v1", "alpha"));
    assert.equal(stale.status, 409);
    assert.deepEqual(await retainedStreamNames(asUrl), ["beta"]);
  });
});

test("the declaration digest keeps an own __proto__ key as content", async () => {
  const { connectorDeclarationDigest } = await import("../server/auth.ts");
  const base = JSON.parse('{"connector_id":"eqv","version":"v1","extra":{"a":1}}');
  const withProto = JSON.parse('{"connector_id":"eqv","version":"v1","extra":{"a":1,"__proto__":{"b":2}}}');
  assert.notEqual(connectorDeclarationDigest(base), connectorDeclarationDigest(withProto));
});
