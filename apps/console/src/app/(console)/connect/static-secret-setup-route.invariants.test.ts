// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

let requestPath = "";
const api = (async () => {
  mock.module("server-only", { exports: {} });
  mock.module("../lib/owner-token.ts", {
    exports: {
      getAsInternalUrl: () => "http://reference.invalid",
      getOwnerToken: async () => "test-owner-token",
      ReferenceServerUnreachableError: class extends Error {},
      ResourceServerHttpError: class extends Error {},
      withOwnerSessionCookie: async (init: RequestInit) => init,
    },
  });
  mock.module("../lib/verify-session.ts", { exports: { verifyDashboardSession: async () => {} } });
  return await import("../lib/ref-client.ts");
})();

test("getStaticSecretSetup requests and returns the encoded setup endpoint", async (t) => {
  const { getStaticSecretSetup } = await api;
  const setup = { object: "static_secret_setup", display_name: "Test", credential_kind: "api_key" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requestPath = String(input);
    return new Response(JSON.stringify(setup), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  });
  assert.deepEqual(await getStaticSecretSetup("connector/a"), setup);
  assert.equal(requestPath, "http://reference.invalid/_ref/connectors/connector%2Fa/static-secret-setup");
});

test("source: mounted route registers the static-secret setup endpoint", async () => {
  const riRoute = await readFile(
    new URL("../../../../../../reference-implementation/server/routes/ref-static-secret-draft-connection.ts", import.meta.url),
    "utf8"
  );
  assert.match(riRoute, /app\.get\(\s*"\/_ref\/connectors\/:connectorId\/static-secret-setup"/);
  assert.match(riRoute, /res\.status\(200\)\.json\(setup\)/);
});
