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
