// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: the Express-compat `res` shim in `server/transport.js` must
 * expose `header()` and `set()` as chainable aliases of `setHeader()`.
 *
 * Bug: the shim originally defined only `setHeader`. Handlers that used
 * Express idioms — `res.status(N).header('WWW-Authenticate', …).json(body)`
 * (notably the streaming-routes 401 path in `pdppError()`) — crashed with
 * `res.status(...).header is not a function`. Fastify's lifecycle then
 * converted the throw into a 500, masking the intended status.
 *
 * Fix: define `header(field, value)` (with object-form fan-out) and `set`
 * as a thin alias, both returning `this` so the call chain stays intact.
 *
 * Strategy: register tiny routes on a real `createApp()` instance, use
 * `res.status().header().json()` and `res.status().set().json()` chains,
 * and assert the response status / headers / body via `fastify.inject()`
 * (no port binding, no network).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CONTINUATION_HEADER_SLACK_BYTES, measureContinuation } from "../server/continuation-budget.ts";
import { createApp } from "../server/transport.ts";

interface ExpressShimResponse {
  header: (nameOrFields: string | Record<string, string>, value?: string) => ExpressShimResponse;
  json: (body: unknown) => ExpressShimResponse;
  set: (name: string, value: string) => ExpressShimResponse;
  status: (code: number) => ExpressShimResponse;
}

test("res.status(N).header(name, value).json(body) works and chains", async () => {
  const app = createApp();
  app.get("/header-chain", (_req: unknown, res: ExpressShimResponse) => {
    res.status(401).header("WWW-Authenticate", 'Bearer realm="pdpp"').json({ error: "invalid_token" });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: "GET", url: "/header-chain" });

  assert.equal(reply.statusCode, 401, "status() must propagate to the response");
  assert.equal(reply.headers["www-authenticate"], 'Bearer realm="pdpp"', "header() must set the response header");
  assert.deepEqual(JSON.parse(reply.body), { error: "invalid_token" });
});

test("res.status(N).set(name, value).json(body) works and chains", async () => {
  const app = createApp();
  app.get("/set-chain", (_req: unknown, res: ExpressShimResponse) => {
    res.status(403).set("X-Forbid-Reason", "no_grant").json({ error: "forbidden" });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: "GET", url: "/set-chain" });

  assert.equal(reply.statusCode, 403);
  assert.equal(reply.headers["x-forbid-reason"], "no_grant");
  assert.deepEqual(JSON.parse(reply.body), { error: "forbidden" });
});

test("res.header() accepts object form and sets all keys", async () => {
  const app = createApp();
  app.get("/header-object", (_req: unknown, res: ExpressShimResponse) => {
    res
      .status(200)
      .header({
        "X-One": "1",
        "X-Two": "2",
      })
      .json({ ok: true });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: "GET", url: "/header-object" });

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["x-one"], "1");
  assert.equal(reply.headers["x-two"], "2");
});

test("query parser preserves nested Core guards and oversized HTTP requests fail clearly", async (t) => {
  const { parseReferenceQuery } = await import("../server/transport.ts");
  assert.deepEqual(parseReferenceQuery("filter[time][gte]=today&expand[]=books"), {
    expand: ["books"],
    filter: { time: { gte: "today" } },
  });
  assert.deepEqual(parseReferenceQuery("cursor=%FF&filter%5Bname%5D=%E0%A4%A"), {
    cursor: "%FF",
    filter: { name: "%E0%A4%A" },
  });
  assert.deepEqual(parseReferenceQuery("connector_id=first&cursor=%FF&connector_id=second&filter%5Bname%5D=%E0%A4%A"), {
    connector_id: ["first", "second"],
    cursor: "%FF",
    filter: { name: "%E0%A4%A" },
  });
  const bounded = parseReferenceQuery("expand[65]=books&filter[a][b][c][d][e][f][g][h][i]=deep");
  assert.deepEqual(bounded.expand, { "65": "books" });
  assert.deepEqual(bounded.filter, { a: { b: { c: { d: { e: { f: { g: { h: { "[i]": "deep" } } } } } } } } });
  assert.deepEqual(
    parseReferenceQuery(`connector_id=flat&${"x=1&".repeat(1001)}connector_id[nested]=other`).connector_id,
    { flat: ["flat"], nested: undefined },
    "mixed bracket scope remains invalid even beyond qs's parameterLimit"
  );
  const app = createApp();
  t.after(async () => {
    await app.fastify.close();
  });
  app.get("/query-proof", (req: { query: unknown }, res: { json: (body: unknown) => unknown }) => res.json(req.query));
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  assert.ok(address && typeof address !== "string");
  const nestedResponse = await fetch(
    `http://127.0.0.1:${address.port}/query-proof?expand[65]=books&filter[a][b][c][d][e][f][g][h][i]=deep`
  );
  assert.equal(nestedResponse.status, 200);
  assert.deepEqual(await nestedResponse.json(), bounded);
  const response = await fetch(`http://127.0.0.1:${address.port}/query-proof?connector_id=${"a".repeat(20_000)}`);
  assert.equal(response.status, 431, "Node's existing request-byte bound fails before query interpretation");
  assert.deepEqual(await response.json(), {
    error: "Request Header Fields Too Large",
    message: "Exceeded maximum allowed HTTP header size",
    statusCode: 431,
  });
});

// Continuation budget: a paged route reserves the next request's size before it reads a page.
const MEASURED_REQUEST = {
  httpVersion: "1.1",
  method: "GET",
  rawHeaders: ["Host", "127.0.0.1", "Cookie", "a=b"],
  url: "/_ref/connectors?limit=1",
};

test("continuation budget measures the request as received and removes the current cursor", () => {
  const first = measureContinuation({ cursorMaxLength: 1024, request: MEASURED_REQUEST });
  const encodedCursorName = "%63%75%72%73%6f%72";
  const later = measureContinuation({
    cursorMaxLength: 1024,
    request: { ...MEASURED_REQUEST, url: `${MEASURED_REQUEST.url}&${encodedCursorName}=%72%63%73%31${"%41".repeat(300)}` },
  });
  assert.equal(first.fits, true);
  assert.equal(first.headerBytes, "Host: 127.0.0.1\r\nCookie: a=b\r\n".length);
  assert.deepEqual(later, first, "page 1 and a later page, however the client encodes the cursor, get the same answer");
  assert.equal(first.reserveBytes, 1 + 18 + 1 + 3 * 1024, "the reserve is the worst-case encoded cursor parameter");
});

test("continuation budget refuses when the request plus the reserve passes the server's own header limit", () => {
  const tight = { ...MEASURED_REQUEST, socket: { server: { maxHeaderSize: 3000 } } };
  assert.equal(measureContinuation({ cursorMaxLength: 1024, request: tight }).fits, false);
  assert.equal(measureContinuation({ cursorMaxLength: 1024, request: tight }).limit, 3000);
  const roomy = { ...MEASURED_REQUEST, socket: { server: { maxHeaderSize: 4096 } } };
  assert.equal(measureContinuation({ cursorMaxLength: 1024, request: roomy }).fits, true);
  const cookie = `a=${"x".repeat(16_384 - CONTINUATION_HEADER_SLACK_BYTES - 3 * 1024)}`;
  assert.equal(
    measureContinuation({ cursorMaxLength: 1024, request: { ...MEASURED_REQUEST, rawHeaders: ["Cookie", cookie] } }).fits,
    false
  );
});

test("continuation budget fails closed when the request cannot be measured", () => {
  assert.throws(() => measureContinuation({ cursorMaxLength: 1024, request: undefined }), /raw request is unavailable/);
  assert.throws(
    () => measureContinuation({ cursorMaxLength: 1024, request: { ...MEASURED_REQUEST, httpVersion: "2.0" } }),
    /HTTP 2\.0/
  );
});
