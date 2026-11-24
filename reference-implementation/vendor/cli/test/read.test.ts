// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getPdppCacheLayout, writePdppSecretFile } from "../src/cache-layout.ts";
import { runCli } from "../src/index.ts";
import { buildReadRequest, runRead } from "../src/read/commands.ts";

const PROVIDER = "https://provider.test";

test("read help advertises grant-scoped read commands", async () => {
  const captured = captureIo();
  const code = await runCli(["read", "--help"], captured.io);

  assert.equal(code, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read schema/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read streams/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read query-records/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read fetch/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read search/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read aggregate/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout(), /read schema .*--stream <name>.*--connection-id <cin>/s);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(captured.stdout(), /connector-instance-id/);
});

test("read schema maps compact stream and connection selectors through cached grant", async () => {
  const cacheRoot = await makeCredentialCache("schema-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract; async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/schema");
    assert.equal(url.searchParams.get("view"), "compact");
    assert.equal(url.searchParams.get("stream"), "messages");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.equal(init.headers.Authorization, "Bearer schema-token");

    return jsonResponse(200, {
      object: "schema",
      detail: "compact",
      connectors: [{ stream_count: 1, streams: [{ name: "messages" }] }],
    });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      [
        "read",
        "schema",
        PROVIDER,
        "--view",
        "compact",
        "--stream",
        "messages",
        "--connection-id",
        "cin_slack",
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(captured.stdout()).detail, "compact");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(captured.stdout(), /schema-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read query-records uses cached grant, builds query params, and writes warnings to stderr", async () => {
  const cacheRoot = await makeCredentialCache("query-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract; async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/streams/messages/records");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.getAll("fields").join(","), "id,text");
    assert.equal(url.searchParams.get("count"), "exact");
    assert.equal(url.searchParams.get("filter[sent_at][gte]"), "2026-01-01T00:00:00Z");
    assert.equal(init.headers.Authorization, "Bearer query-token");

    return jsonResponse(200, {
      object: "list",
      data: [{ id: "m1", text: "hello" }],
      meta: { warnings: [{ code: "count_downgraded", message: "exact count unavailable" }] },
    });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      [
        "read",
        "query-records",
        PROVIDER,
        "messages",
        "--connection-id",
        "cin_slack",
        "--limit",
        "1",
        "--fields",
        "id,text",
        "--count",
        "exact",
        "--filter-json",
        '{"sent_at":{"gte":"2026-01-01T00:00:00Z"}}',
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, [{ id: "m1", text: "hello" }]);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(captured.stderr(), /warning: count_downgraded/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(captured.stdout(), /query-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read fetch forwards projection fields through cached grant", async () => {
  const cacheRoot = await makeCredentialCache("fetch-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/streams/messages/records/messages%3Am1");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.equal(url.searchParams.getAll("fields").join(","), "id,sent_at");
    assert.equal(init.headers.Authorization, "Bearer fetch-token");

    return jsonResponse(200, { object: "record", data: { id: "messages:m1", sent_at: "2026-06-09T00:00:00Z" } });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      [
        "read",
        "fetch",
        PROVIDER,
        "messages",
        "messages:m1",
        "--connection-id",
        "cin_slack",
        "--fields",
        "id,sent_at",
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, { id: "messages:m1", sent_at: "2026-06-09T00:00:00Z" });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read field-window forwards bounded field reads through cached grant", async () => {
  const cacheRoot = await makeCredentialCache("field-window-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/streams/messages/records/messages%3Am1/field-window");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.equal(url.searchParams.get("field"), "text");
    assert.equal(url.searchParams.get("q"), "Hyperlane");
    assert.equal(url.searchParams.get("offset_chars"), "0");
    assert.equal(url.searchParams.get("limit_chars"), "512");
    assert.equal(url.searchParams.get("before_chars"), "100");
    assert.equal(url.searchParams.get("after_chars"), "200");
    assert.equal(init.headers.Authorization, "Bearer field-window-token");

    return jsonResponse(200, {
      object: "field_window",
      data: {
        text: "bounded Hyperlane evidence",
        window: { complete: false, next_offset_chars: 512 },
      },
    });
  };

  const captured = captureIo();
  try {
    const code = await runCli(
      [
        "read",
        "field-window",
        PROVIDER,
        "messages",
        "messages:m1",
        "--field",
        "text",
        "--q",
        "Hyperlane",
        "--offset-chars",
        "0",
        "--limit-chars",
        "512",
        "--before-chars",
        "100",
        "--after-chars",
        "200",
        "--connection-id",
        "cin_slack",
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(captured.stdout()).data.text, "bounded Hyperlane evidence");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(captured.stdout(), /field-window-token/);
    assert.equal(captured.stderr(), "");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read search routes modes and stream scopes through cached grant", async () => {
  const cacheRoot = await makeCredentialCache("search-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/search/hybrid");
    assert.equal(url.searchParams.get("q"), "pdpp");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.deepEqual(url.searchParams.getAll("streams"), ["messages", "channels"]);
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(init.headers.Authorization, "Bearer search-token");

    return jsonResponse(200, { object: "search_result_list", data: [{ id: "messages:m1" }] });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      [
        "read",
        "search",
        PROVIDER,
        "pdpp",
        "--mode",
        "hybrid",
        "--streams",
        "messages,channels",
        "--connection-id",
        "cin_slack",
        "--limit",
        "3",
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, [{ id: "messages:m1" }]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read search preserves bounded evidence descriptors and read continuation in JSON", async () => {
  const cacheRoot = await makeCredentialCache("evidence-token");
  const originalFetch = globalThis.fetch;
  const hit = {
    id: "cin_slack/messages:m1",
    stream: "messages",
    record_key: "m1",
    connection_id: "cin_slack",
    snippet: { field: "text", text: "…Hyperlane…" },
    evidence_excerpts: [
      {
        object: "evidence_excerpt",
        field_path: "text",
        preview_text: "…using Hyperlane or LayerZero?…",
        truncated: true,
        provenance: "lexical_match",
        read: {
          object: "field_window_read",
          method: "GET",
          route: "/v1/streams/messages/records/m1/field-window",
          stream: "messages",
          record_id: "m1",
          field: "text",
          connection_id: "cin_slack",
        },
      },
    ],
  };
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input) => {
    assert.equal(new URL(input).pathname, "/v1/search");
    return jsonResponse(200, { object: "search_result_list", data: [hit] });
  };

  try {
    const captured = captureIo();
    const code = await runCli(["read", "search", PROVIDER, "Hyperlane", "--cache-root", cacheRoot], captured.io);

    assert.equal(code, 0);
    // The CLI must NOT strip the evidence descriptor — a CLI user inspecting a
    // search result gets the bounded preview AND the read continuation needed
    // to follow it, matching MCP/REST parity.
    const [record] = JSON.parse(captured.stdout()).data;
    const [excerpt] = record.evidence_excerpts;
    assert.equal(excerpt.preview_text, "…using Hyperlane or LayerZero?…");
    assert.equal(excerpt.truncated, true);
    assert.equal(excerpt.read.route, "/v1/streams/messages/records/m1/field-window");
    assert.equal(excerpt.read.field, "text");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read commands reject owner-token flags without sending a request", async () => {
  const cacheRoot = await makeCredentialCache("client-read-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.searchParams.has("owner_token"), false);
    assert.equal(init.headers.Authorization, "Bearer client-read-token");

    return jsonResponse(200, { object: "schema", connectors: [] });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      ["read", "schema", PROVIDER, "--owner-token", "owner-secret", "--cache-root", cacheRoot],
      captured.io
    );

    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(captured.stderr()).param, "owner-token");
    assert.ok(!captured.stderr().includes("owner-secret"));
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(captured.stdout(), /owner-secret|client-read-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read aggregate builds group_by_time aggregate requests from cached grant", async () => {
  const cacheRoot = await makeCredentialCache("aggregate-token");
  const calls: { url: URL; init: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, "/v1/streams/messages/aggregate");
    assert.equal(url.searchParams.get("connection_id"), "cin_slack");
    assert.equal(url.searchParams.get("metric"), "count");
    assert.equal(url.searchParams.get("group_by_time"), "sent_at");
    assert.equal(url.searchParams.get("granularity"), "day");
    assert.equal(init.headers.Authorization, "Bearer aggregate-token");

    return jsonResponse(200, { object: "aggregation", metric: "count", value: 12 });
  };

  try {
    const captured = captureIo();
    const code = await runCli(
      [
        "read",
        "aggregate",
        PROVIDER,
        "messages",
        "--metric",
        "count",
        "--group-by-time",
        "sent_at",
        "--granularity",
        "day",
        "--connection-id",
        "cin_slack",
        "--cache-root",
        cacheRoot,
      ],
      captured.io
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(captured.stdout()).value, 12);
    assert.equal(captured.stderr(), "");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

// Response shapes follow server/request-helpers.ts and the canonical list envelope.
for (const format of ["json", "jsonl", "table"]) {
  for (const allowPartial of [false, true]) {
    test(`partial_results preserves rows in ${format}, allow-partial=${allowPartial}`, async () => {
      await withReadResponse({ data: [{ id: "returned-row" }], meta: { warnings: [{ code: "partial_results" }] } },
        ["--format", format, "--data", ...(allowPartial ? ["--allow-partial"] : [])], (code, captured) => {
          assert.equal(code, allowPartial ? 0 : 7);
          assert.ok(captured.stdout().includes("returned-row"));
          assert.ok(captured.stderr().includes(allowPartial ? "partial_results" : "incomplete_results"));
          if (format === "json" && !allowPartial) assert.equal(JSON.parse(captured.stderr()).code, "incomplete_results");
        });
    });
  }
}

for (const format of ["json", "jsonl", "table"]) {
  for (const allowPartial of [false, true]) {
    for (const nextCursor of [undefined, "next-page"]) {
      test(`has_more in ${format}, allow-partial=${allowPartial}, cursor=${nextCursor}`, async () => {
        await withReadResponse({ data: [{ id: "returned-row" }], has_more: true, next_cursor: nextCursor },
          ["--format", format, ...(allowPartial ? ["--allow-partial"] : [])], (code, captured) => {
            assert.equal(code, nextCursor || allowPartial ? 0 : 7);
            assert.ok(captured.stdout().includes("returned-row"));
            if (nextCursor) assert.ok(captured.stdout().includes(nextCursor));
            else assert.ok(captured.stderr().includes("incomplete_results"));
          });
      });
    }
  }
}

for (const [command, args, flags] of [
  ["schema", [], {}], ["streams", [], {}], ["query-records", ["messages"], {}],
  ["fetch", ["messages", "id"], {}], ["field-window", ["messages", "id"], { field: "text" }],
  ["search", ["query"], {}], ["aggregate", ["messages"], { metric: "count" }],
]) {
  test(`${command} forwards explicit source selectors and rejects unknown flags`, () => {
    const selectors = command === "search" ? { "connection-id": "cin_two" } : { "connector-id": "chat", "connection-id": "cin_two" };
    const url = new URL(buildReadRequest(command, args, { ...flags, ...selectors }, PROVIDER).url);
    assert.equal(url.searchParams.get("connector_id"), command === "search" ? null : "chat");
    assert.equal(url.searchParams.get("connection_id"), "cin_two");
    if (command === "search") {
      assert.throws(() => buildReadRequest(command, args, { "connector-id": "chat" }, PROVIDER),
        (error) => error.details.param === "connector-id");
    }
    assert.throws(() => buildReadRequest(command, args, { ...flags, typo: "ignored" }, PROVIDER),
      (error) => error.details.param === "typo" && error.message.includes("Valid flags:"));
  });
}

test("inline selector values preserve equals signs", async () => {
  await withReadResponse({ data: [] }, ["--connection-id=opaque=connection"], (code, _captured, url) => {
    assert.equal(code, 0);
    assert.equal(url.searchParams.get("connection_id"), "opaque=connection");
  });
});

test("read rejects command-specific unknown flags before fetching or loading credentials", async () => {
  const captured = captureIo();
  assert.equal(await runCli(["read", "query-records", PROVIDER, "messages", "--q", "ignored"], captured.io), 2);
  const error = JSON.parse(captured.stderr());
  assert.equal(error.code, "invalid_argument");
  assert.equal(error.param, "q");
  assert.ok(error.message.includes("--q"));
  assert.ok(error.message.includes("--connector-id"));
});

test("read query-records passes both explicit source selectors unchanged", async () => {
  await withReadResponse({ data: [] }, ["--connector-id", "https://registry.test/connectors/chat", "--connection-id", "cin_two"],
    (code, _captured, url) => {
      assert.equal(code, 0);
      assert.equal(url.searchParams.get("connector_id"), "https://registry.test/connectors/chat");
      assert.equal(url.searchParams.get("connection_id"), "cin_two");
    });
});

for (const [status, expected] of [[401, 3], [403, 4], [400, 1]]) {
  test(`read HTTP ${status} preserves typed diagnostics and Request-Id`, async () => {
    const choices = [{ connector_id: "chat", connection_id: "cin_one" }, { connector_id: "chat", connection_id: "cin_two" }];
    await withReadResponse({ error: { code: "ambiguous_connection", message: "Choose a connection", param: "connection_id", available_connections: choices } },
      [], (code, captured) => {
        assert.equal(code, expected);
        assert.deepEqual(JSON.parse(captured.stderr()), { code: "ambiguous_connection", message: "Choose a connection", status,
          param: "connection_id", request_id: "req_fixture", retryable: false, available_connections: choices });
      }, status);
  });
}

test("read text errors list available choices on one line", async () => {
  await withReadResponse({ error: { code: "ambiguous_connection", message: "Choose", available_connections: [{ connection_id: "cin_two" }] } },
    ["--format", "table"], (code, captured) => {
      assert.equal(code, 1);
      assert.ok(captured.stderr().includes("cin_two"));
      assert.ok(captured.stderr().includes("req_fixture"));
      assert.equal(captured.stderr().trim().split("\n").length, 1);
    }, 400);
});

test("read network failures have a distinct retryable diagnostic", async () => {
  await withReadResponse(null, [], (code, captured) => {
    assert.equal(code, 6);
    assert.equal(JSON.parse(captured.stderr()).code, "network_error");
    assert.equal(JSON.parse(captured.stderr()).retryable, true);
  });
});

test("read response-body network failures have the network exit code", async () => {
  const cacheRoot = await makeCredentialCache("fixture-token");
  try {
    const captured = captureIo();
    const code = await runRead(["streams", PROVIDER, "--cache-root", cacheRoot], captured.io, async () => ({
      status: 200,
      text: async () => { throw new Error("response interrupted"); },
    }));
    assert.equal(code, 6);
    assert.equal(JSON.parse(captured.stderr()).code, "network_error");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

async function withReadResponse(body, flags, check, status = 200) {
  const cacheRoot = await makeCredentialCache("fixture-token");
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(input);
    if (body === null) throw new Error("connection reset");
    return new Response(JSON.stringify(body), { status, headers: { "Request-Id": "req_fixture" } });
  };
  try {
    const captured = captureIo();
    const code = await runCli(["read", "query-records", PROVIDER, "messages", "--cache-root", cacheRoot, ...flags], captured.io);
    check(code, captured, requestedUrl);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

async function makeCredentialCache(accessToken) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "pdpp-cli-read-"));
  const layout = getPdppCacheLayout(cacheRoot);
  writePdppSecretFile(
    layout.credentialFile(PROVIDER),
    `${JSON.stringify(
      {
        provider_url: PROVIDER,
        authorization_server: PROVIDER,
        scope: "pdpp:read",
        client: { client_id: "test-client" },
        credential: { access_token: accessToken, token_type: "Bearer" },
        created_at: "2026-06-08T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );
  return cacheRoot;
}

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function jsonResponse(status, body) {
  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") {
          return "application/json";
        }
        return null;
      },
    },
    // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
    async text() {
      return JSON.stringify(body);
    },
  };
}
