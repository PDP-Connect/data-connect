// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { runQuery } from "../cli/commands/query.ts";
import { PdppUsageError } from "../cli/lib/errors.ts";

test("legacy query commands send the opaque instance handle and preserve encoded keys", async () => {
  const originalFetch = globalThis.fetch;
  const calls: URL[] = [];
  const instanceId = "opaque/a+b?z=1";
  globalThis.fetch = (input) => {
    calls.push(new URL(input instanceof Request ? input.url : input));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "record", data: { id: "messages:a/b/🧭", instance_id: instanceId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };

  try {
    await runQuery(["streams", "--rs-url", "https://rs.test", "--token", "query-token", "--instance-id", instanceId]);
    await runQuery([
      "records",
      "messages",
      "--rs-url",
      "https://rs.test",
      "--token",
      "query-token",
      "--instance-id",
      instanceId,
    ]);
    await runQuery([
      "get",
      "messages",
      "messages:a/b/🧭",
      "--rs-url",
      "https://rs.test",
      "--token",
      "query-token",
      "--instance-id",
      instanceId,
    ]);

    assert.deepEqual(
      calls.map((url) => [url.pathname, url.searchParams.get("instance_id"), url.searchParams.has("connection_id")]),
      [
        ["/v1/streams", instanceId, false],
        ["/v1/streams/messages/records", instanceId, false],
        ["/v1/streams/messages/records/messages%3Aa%2Fb%2F%F0%9F%A7%AD", instanceId, false],
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy query rejects malformed or conflicting instance selectors before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = () => {
    fetchCount += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  try {
    for (const selectorArgs of [
      ["--instance-id", ""],
      ["--instance-id"],
      ["--instance-id", "opaque-a", "--instance-id", "opaque-b"],
    ]) {
      await assert.rejects(
        runQuery(["streams", "--rs-url", "https://rs.test", "--token", "query-token", ...selectorArgs]),
        PdppUsageError
      );
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
