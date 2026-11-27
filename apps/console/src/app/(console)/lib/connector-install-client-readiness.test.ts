// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

// The client reads the owner session and token before it calls the server;
// replace those so a test controls only the server's answer.
let loaded: Promise<typeof import("./connector-install-client.ts")> | null = null;

function load() {
  loaded ??= (async () => {
    mock.module("server-only", { namedExports: {} });
    mock.module(new URL("./verify-session.ts", import.meta.url).href, {
      namedExports: { verifyDashboardSession: async () => undefined },
    });
    mock.module(new URL("./owner-token.ts", import.meta.url).href, {
      namedExports: {
        getOwnerToken: async () => "token",
        getRsInternalUrl: () => "http://rs.invalid",
        ReferenceServerUnreachableError: class extends Error {},
        ResourceServerHttpError: class extends Error {},
      },
    });
    return import("./connector-install-client.ts");
  })();
  return loaded;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function verdict(connectorKey: string, action: string, reason: string) {
  return { action, browser_bound: true, connector_key: connectorKey, detail: null, reason };
}

function serverAnswers(data: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data, object: "connector_browser_enrollment_readiness" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })) as typeof fetch;
}

test("the verdict for the requested connector is used even when another connector's comes first", async () => {
  const { getConnectorReadiness } = await load();
  serverAnswers([verdict("github", "unavailable", "not_browser_bound"), verdict("linkedin", "connect", "runnable")]);
  const readiness = await getConnectorReadiness("linkedin");
  assert.equal(readiness?.connectorKey, "linkedin");
  assert.equal(readiness?.action, "connect");
});

test("a registry-shaped connector id matches the server's canonical key", async () => {
  const { getConnectorReadiness } = await load();
  serverAnswers([verdict("github", "unavailable", "not_browser_bound"), verdict("linkedin", "connect", "runnable")]);
  const readiness = await getConnectorReadiness("https://registry.pdpp.dev/connectors/linkedin");
  assert.equal(readiness?.connectorKey, "linkedin");
});

test("no verdict is returned when none of the entries is for the requested connector", async () => {
  const { getConnectorReadiness } = await load();
  serverAnswers([verdict("github", "connect", "runnable")]);
  assert.equal(await getConnectorReadiness("linkedin"), null);
});
