// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";

const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
class ReferenceServerUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ReferenceServerUnreachableError";
  }
}
const api = (async () => {
  mock.module("./owner-token.ts", {
    exports: {
      getAsInternalUrl: () => "http://reference.invalid",
      ReferenceServerUnreachableError,
      withOwnerSessionCookie: async (init: RequestInit) => init,
    },
  });
  return await import("./operator-runs.ts");
})();

function respond(t: TestContext, status: number, body: unknown) {
  return t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  });
}

test("cancelRun posts the encoded run route and classifies the response", async (t) => {
  const { cancelRun } = await api;
  seen.length = 0;
  respond(t, 202, { status: "cancel_requested" });
  assert.deepEqual(await cancelRun("run/42"), { status: "cancel_requested" });
  assert.equal(String(seen[0]?.input), "http://reference.invalid/_ref/runs/run%2F42/cancel");
  assert.equal(seen[0]?.init?.method, "POST");
});

test("cancelRun propagates a reference-server transport error", async (t) => {
  const { cancelRun } = await api;
  const error = new Error("network down");
  t.mock.method(globalThis, "fetch", async () => { throw error; });
  await assert.rejects(cancelRun("run-1"), { name: "ReferenceServerUnreachableError" });
});

test("connection controls use encoded owner-session paths and classify bodies", async (t) => {
  const { deleteConnection, pauseConnection, purgeConnectionBrowserProfile, revokeConnection, resumeConnection } = await api;
  seen.length = 0;
  respond(t, 200, { status: "revoked" });
  assert.deepEqual(await revokeConnection("cin/a"), { status: "revoked" });
  assert.equal(String(seen.at(-1)?.input), "http://reference.invalid/_ref/connections/cin%2Fa/revoke");
  assert.equal(seen.at(-1)?.init?.method, "POST");

  respond(t, 200, { object: "owner_connection_pause" });
  assert.deepEqual(await pauseConnection("cin-1"), { status: "paused" });
  assert.equal(String(seen.at(-1)?.input), "http://reference.invalid/_ref/connections/cin-1/pause");

  respond(t, 200, { object: "owner_connection_resume" });
  assert.deepEqual(await resumeConnection("cin-1"), { status: "resumed" });
  assert.equal(String(seen.at(-1)?.input), "http://reference.invalid/_ref/connections/cin-1/resume");

  respond(t, 200, { deleted: true, deleted_record_count: 3 });
  assert.deepEqual(await deleteConnection("cin-1"), { status: "deleted", deletedRecordCount: 3 });
  assert.equal(String(seen.at(-1)?.input), "http://reference.invalid/_ref/connections/cin-1");
  assert.equal(seen.at(-1)?.init?.method, "DELETE");

  respond(t, 200, { profile_purge: { status: "purged" } });
  assert.deepEqual(await purgeConnectionBrowserProfile("cin-1"), {
    profilePurge: { status: "purged" },
    status: "purge_reported",
  });
  assert.equal(String(seen.at(-1)?.input), "http://reference.invalid/_ref/connections/cin-1/browser-profile/purge");
  assert.equal(seen.at(-1)?.init?.method, "POST");
});

test("display-name update sends PATCH JSON to the encoded connection path", async (t) => {
  const { setConnectionDisplayName } = await api;
  seen.length = 0;
  respond(t, 200, { ok: true });
  await setConnectionDisplayName("cin/1", "Primary Gmail");
  assert.equal(String(seen[0]?.input), "http://reference.invalid/_ref/connections/cin%2F1");
  assert.equal(seen[0]?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { display_name: "Primary Gmail" });
});

test("stream mint posts the encoded route and wire body", async (t) => {
  const { mintRunInteractionStream } = await api;
  seen.length = 0;
  respond(t, 200, { object: "run_interaction_stream", token: "stream-token" });
  await mintRunInteractionStream("run/1", { interactionId: "interaction-1", idempotencyKey: "attempt-1" });
  assert.equal(String(seen[0]?.input), "http://reference.invalid/_ref/runs/run%2F1/run-interaction-stream");
  assert.equal(seen[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
    interaction_id: "interaction-1",
    idempotency_key: "attempt-1",
  });
});

test("run-now helpers send options through connector and connection routes", async (t) => {
  const { runConnectionNow, runConnectorNow } = await api;
  const requests: Array<{ body: string | undefined; headers: Headers; method: string | undefined; path: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({
      body: init?.body?.toString(),
      headers: new Headers(init?.headers),
      method: init?.method,
      path: url.pathname,
    });
    return Response.json({ run_id: "run-1" });
  });

  await runConnectorNow("gmail");
  await runConnectorNow("gmail", { force: true });
  await runConnectionNow("cin/1", { runAdmission: "setup" });

  assert.deepEqual(requests.map(({ path, method, body }) => [path, method, body]), [
    ["/_ref/connectors/gmail/run", "POST", undefined],
    ["/_ref/connectors/gmail/run", "POST", '{"force":true}'],
    ["/_ref/connections/cin%2F1/run", "POST", '{"run_admission":"setup"}'],
  ]);
  assert.equal(requests[0]?.headers.has("content-type"), false);
  assert.equal(requests[1]?.headers.get("content-type"), "application/json");
  assert.equal(requests[2]?.headers.get("content-type"), "application/json");
});
