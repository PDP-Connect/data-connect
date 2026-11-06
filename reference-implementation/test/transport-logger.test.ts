// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { __test, buildLogger, createApp } from "../server/transport.ts";

test("production logging does not resolve the optional pretty transport", () => {
  let resolutionAttempts = 0;
  const options = __test.makeLoggerOptions({
    nodeEnv: "production",
    prettyTransportAvailable: () => {
      resolutionAttempts += 1;
      return true;
    },
  });

  assert.equal(resolutionAttempts, 0);
  assert.equal(options.transport, undefined);
});

test("development logging falls back to JSON when pino-pretty is unavailable", () => {
  const options = __test.makeLoggerOptions({
    nodeEnv: "development",
    prettyTransportAvailable: () => false,
  });

  assert.equal(options.transport, undefined);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const logger = buildLogger({ prettyTransportAvailable: () => false });
    assert.equal(logger.level, "info");
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

// Exercise the real completion hook and Pino output; logger-option tests cannot
// detect an info-level completion emitted by the transport itself.
test("fast successful stream input and run polls emit one debug completion with correlation fields", async () => {
  const records: Record<string, unknown>[] = [];
  const logger = pino({ level: "debug" }, { write: (line) => records.push(JSON.parse(line)) });
  const { fastify } = createApp({ logger });
  fastify.addHook("onRequest", (_request, reply, done) => {
    Object.defineProperty(reply, "elapsedTime", { get: () => 999.5 });
    done();
  });
  const routes = [
    {
      method: "POST",
      path: "/_ref/run-interaction-streams/test/input",
      url: "/_ref/run-interaction-streams/:token/input",
    },
    { method: "GET", path: "/_ref/runs/test", url: "/_ref/runs/:runId" },
    { method: "GET", path: "/_ref/runs/test/timeline?limit=20", url: "/_ref/runs/:runId/timeline" },
  ] as const;
  try {
    for (const route of routes) {
      fastify.route({
        handler: (request, reply) =>
          reply
            .code(Number(request.headers["test-status"] ?? 200))
            .header("PDPP-Reference-Trace-Id", "trace-test")
            .send({ ok: true }),
        method: route.method,
        url: route.url,
      });
    }
    for (const route of routes) {
      for (const status of [200, 204, 302, 304]) {
        // biome-ignore lint/performance/noAwaitInLoops: Serial injection isolates each request's log output.
        const response = await fastify.inject({
          headers: { "request-id": "req-test", "test-status": String(status) },
          method: route.method,
          url: route.path,
        });
        assert.equal(response.statusCode, status);
        const completions = records.filter((entry) => entry.msg === "request completed");
        assert.equal(completions.length, 1, route.path);
        const [record] = completions;
        assert.ok(record);
        assert.equal(record.level, 20, route.path);
        assert.equal(record.req_id, "req-test");
        assert.equal(record.trace_id, "trace-test");
        assert.equal(record.method, route.method);
        assert.equal(record.url, route.path);
        assert.equal(record.statusCode, status);
        assert.equal(record.responseTime, 1000);
        records.length = 0;
      }
    }
    logger.level = "info";
    for (const route of routes) {
      // biome-ignore lint/performance/noAwaitInLoops: Serial injection isolates each request's log output.
      await fastify.inject({ method: route.method, url: route.path });
      assert.equal(records.length, 0, route.path);
    }
  } finally {
    await fastify.close();
  }
});

test("errors, slow requests, other methods and adjacent routes keep info completions", async () => {
  const records: Record<string, unknown>[] = [];
  const logger = pino({ level: "debug" }, { write: (line) => records.push(JSON.parse(line)) });
  const { fastify } = createApp({ logger });
  // Control elapsed time at the transport boundary, without a wall-clock sleep.
  fastify.addHook("onRequest", (request, reply, done) => {
    Object.defineProperty(reply, "elapsedTime", { get: () => Number(request.headers["test-elapsed-ms"] ?? 0) });
    done();
  });
  const routes = [
    {
      method: "POST",
      path: "/_ref/run-interaction-streams/test/input",
      url: "/_ref/run-interaction-streams/:token/input",
    },
    { method: "GET", path: "/_ref/runs/test", url: "/_ref/runs/:runId" },
    { method: "GET", path: "/_ref/runs/test/timeline", url: "/_ref/runs/:runId/timeline" },
    {
      method: "GET",
      path: "/_ref/run-interaction-streams/test/input",
      url: "/_ref/run-interaction-streams/:token/input",
    },
    { method: "POST", path: "/_ref/runs/test", url: "/_ref/runs/:runId" },
    {
      method: "POST",
      path: "/_ref/run-interaction-streams/test/viewport",
      url: "/_ref/run-interaction-streams/:token/viewport",
    },
    { method: "GET", path: "/_ref/runs/test/timeline/extra", url: "/_ref/runs/:runId/timeline/extra" },
  ] as const;
  try {
    for (const route of routes) {
      fastify.route({
        handler: (request, reply) => {
          if (request.headers["test-throw"]) {
            throw new Error("test handler failure");
          }
          return reply.code(Number(request.headers["test-status"] ?? 200)).send({ ok: true });
        },
        method: route.method,
        url: route.url,
      });
    }
    for (const route of routes) {
      for (const scenario of [
        { elapsed: 1000, status: 200 },
        { elapsed: 2000, status: 200 },
        { elapsed: 0, status: 400 },
        { elapsed: 0, status: 401 },
        { elapsed: 0, status: 403 },
        { elapsed: 0, status: 404 },
        { elapsed: 0, status: 429 },
        { elapsed: 0, status: 500 },
        { elapsed: 0, status: 503 },
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Serial injection isolates each request's log output.
        const response = await fastify.inject({
          headers: { "test-elapsed-ms": String(scenario.elapsed), "test-status": String(scenario.status) },
          method: route.method,
          url: route.path,
        });
        assert.equal(response.statusCode, scenario.status);
        const completions = records.filter((record) => record.msg === "request completed");
        assert.equal(completions.length, 1);
        assert.equal(
          completions[0]?.level,
          30,
          `${route.method} ${route.path} ${scenario.status} ${scenario.elapsed}ms`
        );
        records.length = 0;
      }
    }
    for (const route of routes.slice(3)) {
      // biome-ignore lint/performance/noAwaitInLoops: Serial injection isolates each request's log output.
      await fastify.inject({ method: route.method, url: route.path });
      assert.equal(records.find((record) => record.msg === "request completed")?.level, 30, route.path);
      records.length = 0;
    }
    for (const route of routes.slice(0, 3)) {
      // biome-ignore lint/performance/noAwaitInLoops: Serial injection isolates each request's log output.
      const response = await fastify.inject({ headers: { "test-throw": "1" }, method: route.method, url: route.path });
      assert.equal(response.statusCode, 500);
      assert.equal(records.find((record) => record.msg === "request completed")?.level, 30, route.path);
      records.length = 0;
    }
    const parseFailure = await fastify.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: routes[0].path,
    });
    assert.equal(parseFailure.statusCode, 400);
    assert.equal(records.find((record) => record.msg === "request completed")?.level, 30);
    records.length = 0;
    const headResponse = await fastify.inject({ method: "HEAD", url: "/_ref/runs/test" });
    assert.equal(headResponse.statusCode, 200);
    assert.equal(records.find((record) => record.msg === "request completed")?.level, 30);
    records.length = 0;
    // An unmatched route must still produce a visible error completion.
    await fastify.inject({ method: "POST", url: "/_ref/run-interaction-streams/test/input/extra" });
    assert.equal(records.find((record) => record.msg === "request completed")?.level, 30);
  } finally {
    await fastify.close();
  }
});
