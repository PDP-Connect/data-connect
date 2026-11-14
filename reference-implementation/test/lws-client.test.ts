import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { LwsClient, LwsPermissionError, LwsPreconditionFailed } from "../server/lws/lws-client.ts";
import { fakeLwsIdentity, startFakeLwsServer } from "./helpers/fake-lws-server.ts";

async function fixture(t: TestContext, pageSize = 1000) {
  let time = Date.now();
  const now = () => time;
  const server = await startFakeLwsServer({ pageSize, now });
  t.after(() => server.close());
  const identity = fakeLwsIdentity();
  server.registerIdentity(identity, [{ path: "/data/", read: true, write: true }]);
  const client = new LwsClient({ storageUrl: server.storageUrl, identity, now });
  return { server, identity, client, now, advance: (ms: number) => { time += ms; } };
}
const bytes = (value: string) => Buffer.from(value);
const tokenCalls = (requests: Array<{ path: string }>) => requests.filter((r) => r.path === "/.lws/token").length;

test("signed form exchange is cached, single-flight, and renewed inside 60 seconds", async (t) => {
  const { client, server, advance } = await fixture(t);
  const values = await Promise.all([client.token(), client.token(), client.token()]);
  assert.equal(new Set(values).size, 1);
  assert.equal(tokenCalls(server.requests), 1);
  advance(239_000);
  assert.equal(await client.token(), values[0]);
  advance(2_000);
  assert.notEqual(await client.token(), values[0]);
  assert.equal(tokenCalls(server.requests), 2);
});

test("fake verifies EdDSA signature instead of merely decoding claims", async (t) => {
  const { server, identity, now } = await fixture(t);
  const corrupt: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/.lws/token")) {
      const form = new URLSearchParams(String(init?.body));
      const parts = (form.get("subject_token") ?? "").split(".");
      parts[2] = Buffer.alloc(64).toString("base64url");
      form.set("subject_token", parts.join("."));
      return fetch(input, { ...init, body: form.toString() });
    }
    return fetch(input, init);
  };
  const client = new LwsClient({ storageUrl: server.storageUrl, identity, now, fetch: corrupt });
  await assert.rejects(client.token(), LwsPermissionError);
  const response = await fetch(server.storageUrl + ".lws/token", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 400);
});

test("create, read, replace and delete use content-derived strong ETags", async (t) => {
  const { client, server } = await fixture(t);
  assert.equal(await client.get("missing"), null);
  await client.ensureContainer("/data/");
  await client.ensureContainer("/data/");
  const first = await client.putIfAbsent("data/a", bytes("one\n"), "application/x-ndjson");
  assert.equal(await client.putIfMatch("data/a", bytes("one\n"), "application/x-ndjson", first), first);
  const loaded = await client.get("data/a");
  assert.equal(loaded?.contentType, "application/x-ndjson");
  assert.equal(Buffer.from(loaded?.body ?? []).toString(), "one\n");
  await assert.rejects(client.putIfAbsent("data/a", bytes("collision"), "text/plain"), LwsPreconditionFailed);
  const second = await client.putIfMatch("data/a", bytes("two"), "text/plain", first);
  assert.notEqual(second, first);
  await assert.rejects(client.putIfMatch("data/a", bytes("stale"), "text/plain", first), LwsPreconditionFailed);
  await assert.rejects(client.deleteIfMatch("data/a", first), LwsPreconditionFailed);
  await client.deleteIfMatch("data/a", second);
  assert.equal(server.inspect("/data/a"), undefined);
  await assert.rejects(client.putIfMatch("data/a", bytes("missing"), "text/plain", "*"), LwsPreconditionFailed);
});

test("fake reproduces 428 and weak-tag acceptance", async (t) => {
  const { client, server } = await fixture(t);
  const tag = await client.putIfAbsent("data/a", bytes("one"), "text/plain");
  const authorization = "Bearer " + await client.token();
  assert.equal((await fetch(server.storageUrl + "data/a", {
    method: "PUT", headers: { authorization }, body: "two",
  })).status, 428);
  assert.equal((await fetch(server.storageUrl + "data/a", {
    method: "PUT", headers: { authorization, "if-match": "W/" + tag }, body: "two",
  })).status, 204);
});

test("404 under created folder and explicit 403 are permission errors", async (t) => {
  const { client, server, identity } = await fixture(t);
  await client.ensureContainer("data/");
  await assert.rejects(client.get("data/missing"), LwsPermissionError);
  server.registerIdentity(identity, [{ path: "/data/", read: false, write: false }]);
  await assert.rejects(client.get("data/"), LwsPermissionError);
  server.injectFailure({ method: "GET", path: "/elsewhere", kind: "status", status: 403 });
  await assert.rejects(client.get("elsewhere"), LwsPermissionError);
});

test("401 renews once and another 401 is terminal", async (t) => {
  const { client, server } = await fixture(t);
  await client.putIfAbsent("data/a", bytes("ok"), "text/plain");
  server.revokeTokens();
  assert.equal(Buffer.from((await client.get("data/a"))?.body ?? []).toString(), "ok");
  assert.equal(tokenCalls(server.requests), 2);
  server.injectFailure({ method: "GET", path: "/data/a", kind: "status", status: 401 });
  server.injectFailure({ method: "GET", path: "/data/a", kind: "status", status: 401 });
  await assert.rejects(client.get("data/a"), LwsPermissionError);
  assert.equal(tokenCalls(server.requests), 3);
});

test("pagination follows Link next without dropping content types", async (t) => {
  const { client } = await fixture(t, 1);
  await client.ensureContainer("data/");
  for (const name of ["a", "b", "c"]) await client.putIfAbsent("data/" + name, bytes(name), "application/x-ndjson");
  const items = [];
  for await (const item of client.list("data/")) items.push(item);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.format, "application/x-ndjson");
  assert.deepEqual(items.map((item) => new URL(item.id).pathname), ["/data/a", "/data/b", "/data/c"]);
});

test("500, 429 and dropped connections retry; 412 never retries", async (t) => {
  const { client, server } = await fixture(t);
  await client.token();
  server.injectFailure({ method: "PUT", path: "/data/a", kind: "status", status: 500 });
  server.injectFailure({ method: "PUT", path: "/data/a", kind: "status", status: 429 });
  server.injectFailure({ method: "PUT", path: "/data/a", kind: "drop" });
  await client.putIfAbsent("data/a", bytes("ok"), "text/plain");
  assert.equal(server.requests.filter((r) => r.method === "PUT" && r.path === "/data/a").length, 4);
  server.injectFailure({ method: "PUT", path: "/data/b", kind: "race", body: bytes("winner") });
  await assert.rejects(client.putIfAbsent("data/b", bytes("loser"), "text/plain"), LwsPreconditionFailed);
  assert.equal(server.requests.filter((r) => r.method === "PUT" && r.path === "/data/b").length, 1);
  assert.equal(Buffer.from(server.inspect("/data/b")?.body ?? []).toString(), "winner");
});

test("retry exhaustion makes four attempts without data writes", async (t) => {
  const { client, server } = await fixture(t);
  await client.token();
  for (let i = 0; i < 4; i++) server.injectFailure({ method: "PUT", path: "/data/a", kind: "status", status: 503 });
  await assert.rejects(client.putIfAbsent("data/a", bytes("no"), "text/plain"), /503/);
  assert.equal(server.requests.filter((r) => r.path === "/data/a").length, 4);
  assert.equal(server.inspect("/data/a"), undefined);
});

test("body cap rejects before even obtaining a token", async (t) => {
  const { server, identity } = await fixture(t);
  const client = new LwsClient({ storageUrl: server.storageUrl, identity, maxRequestBytes: 4 });
  await assert.rejects(client.putIfAbsent("data/a", bytes("12345"), "text/plain"), /maxRequestBytes/);
  assert.equal(server.requests.length, 0);
});

test("fake drops oversized bodies without an HTTP status", async (t) => {
  const server = await startFakeLwsServer({ maxRequestBytes: 1024 });
  t.after(() => server.close());
  const identity = fakeLwsIdentity();
  server.registerIdentity(identity, [{ path: "/data/", read: true, write: true }]);
  const client = new LwsClient({ storageUrl: server.storageUrl, identity });
  const authorization = "Bearer " + await client.token();
  await assert.rejects(fetch(server.storageUrl + "data/large", {
    method: "PUT", headers: { authorization, "if-none-match": "*" }, body: Buffer.alloc(2048),
  }));
  assert.equal(server.inspect("/data/large"), undefined);
});

test("conditional probe validates collision, stale update/delete, missing If-Match", async (t) => {
  const { client, server } = await fixture(t);
  await client.probeConditionalRequests("data/");
  const items = [];
  for await (const item of client.list("data/")) items.push(item);
  assert.deepEqual(items, []);
  assert.ok(server.requests.some((r) => r.method === "DELETE"));
});

test("cross-origin and cyclic pagination cannot leak credentials", async (t) => {
  const { server, identity } = await fixture(t);
  for (const next of ["http://example.invalid/steal", "/data/"]) {
    const seen: string[] = [];
    const injected: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/data/")) return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/lws+json", link: "<" + next + '>; rel="next"' },
      });
      return fetch(input, init);
    };
    const client = new LwsClient({ storageUrl: server.storageUrl, identity, fetch: injected });
    await assert.rejects(async () => { for await (const item of client.list("data/")) void item; }, /escapes|cycle/);
    assert.ok(seen.every((url) => !url.includes("example.invalid")));
  }
});

test("invalid identity and path traversal fail before data access", async (t) => {
  const { server, identity } = await fixture(t);
  assert.throws(() => new LwsClient({ storageUrl: server.storageUrl, identity: { did: identity.did, seed: new Uint8Array(31) } }), /32-byte/);
  assert.throws(() => new LwsClient({ storageUrl: server.storageUrl, identity: { did: "did:key:wrong", seed: identity.seed } }), /DID/);
  const client = new LwsClient({ storageUrl: server.storageUrl, identity });
  await assert.rejects(client.get("../secret"), /relative path/);
  await assert.rejects(client.get("%2e%2e/secret"), /relative path/);
  await assert.rejects(client.get("https://example.invalid/secret"), /escapes/);
  assert.equal(server.requests.length, 0);
});

test("wrong conditional success status and malformed token replies fail closed", async (t) => {
  const { server, identity } = await fixture(t);
  const wrongStatus: typeof fetch = async (input, init) => {
    if (init?.method === "PUT") return new Response(null, { status: 204, headers: { etag: '"wrong"' } });
    return fetch(input, init);
  };
  const client = new LwsClient({ storageUrl: server.storageUrl, identity, fetch: wrongStatus });
  await assert.rejects(client.putIfAbsent("data/a", bytes("new"), "text/plain"), /PUT status/);
  const invalidToken: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/.lws/token")) return new Response(JSON.stringify({ access_token: "synthetic", token_type: "Bearer", expires_in: -1 }));
    return fetch(input, init);
  };
  await assert.rejects(new LwsClient({ storageUrl: server.storageUrl, identity, fetch: invalidToken }).token(), /token response/);
});

test("conditional probe rejects a backend that accepts an unguarded overwrite", async (t) => {
  const { server, identity } = await fixture(t);
  const bypass: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "PUT" && !headers.has("if-match") && !headers.has("if-none-match")) {
      return new Response(null, { status: 204, headers: { etag: '"not-tested"' } });
    }
    return fetch(input, init);
  };
  const client = new LwsClient({ storageUrl: server.storageUrl, identity, fetch: bypass });
  await assert.rejects(client.probeConditionalRequests("data/"), /require If-Match/);
});
