// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

let requestUrl = "";
const client = (async () => {
  mock.module("server-only", { namedExports: {} });
  mock.module("./owner-token.ts", {
    namedExports: {
      getOwnerToken: async () => "owner-token",
      getRsInternalUrl: () => "http://resource.invalid",
    },
  });
  mock.module("./verify-session.ts", { namedExports: { verifyDashboardSession: async () => {} } });
  return await import("./rs-client.ts");
})();

test("listOwnerConnectorTemplates calls the registered owner template path", async () => {
  const { listOwnerConnectorTemplates } = await client;
  const templates = [{ connector_id: "gmail", display_name: "Gmail" }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ data: templates }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  assert.deepEqual(await listOwnerConnectorTemplates(), templates);
  assert.equal(requestUrl, "http://resource.invalid/v1/owner/connector-templates");
});

test("source: owner template route registers the client path", async () => {
  const routeSource = await readFile(
    new URL("../../../../../../reference-implementation/server/routes/owner-connector-templates.ts", import.meta.url),
    "utf8"
  );
  assert.match(routeSource, /app\.get\(\s*"\/v1\/owner\/connector-templates"/);
});

test("source: stream mint route registers the operator client path", async () => {
  const routeSource = await readFile(
    new URL("../../../../../../reference-implementation/server/streaming/routes.ts", import.meta.url),
    "utf8"
  );
  assert.match(routeSource, /app\.post\("\/_ref\/runs\/:runId\/run-interaction-stream"/);
});
