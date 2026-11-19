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

test("a write is read only after the session check, only as exact JSON, and only up to the size limit", async () => {
  const { POST, MAX_BODY_BYTES } = await load();
  const fetchMock = upstream(() => data({ done: true }));
  const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
  try {
    signedIn = false;
    const unread = call("POST", "/drafts", { origin: "http://console.test", type: "application/json", body: big });
    const anonymous = await POST(unread);
    assert.equal(anonymous.status, 401);
    assert.equal(unread.bodyUsed, false, "no session: the body is never read");
    signedIn = true;
    const lookalike = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/jsonp", body: "{}" }));
    assert.equal(lookalike.status, 415);
    const tooBig = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/json", body: big }));
    assert.equal(tooBig.status, 413);
    assert.equal(fetchMock.mock.callCount(), 0, "none of those reached the service");
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const streamed = await POST(new Request("http://console.test/api/reachability/drafts", {
      method: "POST",
      headers: { host: "console.test", origin: "http://console.test", "content-type": "application/json" },
      body: endless,
      duplex: "half",
    } as RequestInit));
    assert.equal(streamed.status, 413, "a body with no declared length is cut off at the limit");
    assert.ok(pulled <= MAX_BODY_BYTES / (16 * 1024) + 2, "reading stopped near the limit");
    const broken = await POST(new Request("http://console.test/api/reachability/drafts", {
      method: "POST",
      headers: { host: "console.test", origin: "http://console.test", "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("sender went away")); } }),
      duplex: "half",
    } as RequestInit));
    assert.equal(broken.status, 400, "a failed read is not reported as too large");
    const withCharset = await POST(call("POST", "/drafts", { origin: "http://console.test", type: "application/json; charset=utf-8", body: "{}" }));
    assert.equal(withCharset.status, 200);
  } finally {
    signedIn = true;
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
