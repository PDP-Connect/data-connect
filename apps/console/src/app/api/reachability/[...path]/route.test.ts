// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";

let signedIn = true;
let bearerReads = 0;
mock.module(new URL("../../../(console)/lib/owner-token.ts", import.meta.url).href, {
  namedExports: {
    readDashboardOwnerSession: async () => signedIn,
    getRsInternalUrl: () => "http://fixture.invalid",
    getOwnerToken: async () => {
      bearerReads++;
      return "fixture-owner-credential";
    },
  },
});
const load = () => import("./route.ts");

const call = (method: "GET" | "POST", path: string, init: { origin?: string; type?: string; body?: string } = {}) =>
  new Request(`http://console.test/api/reachability${path}`, {
    method,
    headers: {
      host: "console.test",
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.type ? { "content-type": init.type } : {}),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
const upstream = (answer: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init));
const data = (value: unknown) => new Response(JSON.stringify({ data: value }), { status: 200 });

test("a signed-in read reaches the service with the bearer the browser never sees", async () => {
  const { GET } = await load();
  const seen: { url: string; auth: string | undefined }[] = [];
  const fetchMock = upstream((url, init) => {
    seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
    return data({ providers: [] });
  });
  try {
    const response = await GET(call("GET", "/drafts/a%2Fb?providerId=p"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true, data: { providers: [] } });
    assert.deepEqual(seen, [
      { url: "http://fixture.invalid/v1/owner/reachability/drafts/a%2Fb?providerId=p", auth: "Bearer fixture-owner-credential" },
    ]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("without an owner session nothing is forwarded and the browser is told to sign in", async () => {
  const { GET, POST } = await load();
  signedIn = false;
  bearerReads = 0;
  const fetchMock = upstream(() => {
    throw new Error("Unexpected forwarding");
  });
  try {
    const read = await GET(call("GET", "/catalog"));
    assert.equal(read.status, 401);
    const write = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/json", body: "{}" }));
    assert.equal(write.status, 401);
    assert.equal(bearerReads, 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    signedIn = true;
    fetchMock.mock.restore();
  }
});

test("a write must come from this console's own pages, as JSON", async () => {
  const { POST } = await load();
  const fetchMock = upstream(() => data({ done: true }));
  try {
    const noOrigin = await POST(call("POST", "/drafts", { type: "application/json", body: "{}" }));
    assert.equal(noOrigin.status, 403);
    const elsewhere = await POST(call("POST", "/drafts", { origin: "http://other.test", type: "application/json", body: "{}" }));
    assert.equal(elsewhere.status, 403);
    const form = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "text/plain", body: "{}" }));
    assert.equal(form.status, 415);
    const notObject = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/json", body: "[1]" }));
    assert.equal(notObject.status, 400);
    assert.equal(fetchMock.mock.callCount(), 0, "none of those reached the service");
    const own = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/json", body: '{"providerId":"p"}' }));
    assert.equal(own.status, 200);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a path outside the remote access family is refused before the service is called", async () => {
  const { GET } = await load();
  const fetchMock = upstream(() => {
    throw new Error("Unexpected forwarding");
  });
  try {
    const response = await GET(call("GET", "/%2e%2e/password"));
    assert.equal(response.status, 400);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a slow catalog read does not hold up the request sent after it", async () => {
  const { GET } = await load();
  const gate: { release: () => void } = { release: () => undefined };
  const fetchMock = upstream(async (url) => {
    if (url.endsWith("/catalog")) await new Promise<void>((resolve) => (gate.release = resolve));
    return data(url);
  });
  try {
    const slow = GET(call("GET", "/catalog"));
    const quick = await GET(call("GET", "/state"));
    assert.equal(quick.status, 200, "/state answered while /catalog was still open");
    gate.release();
    assert.equal((await slow).status, 200);
  } finally {
    fetchMock.mock.restore();
  }
});
