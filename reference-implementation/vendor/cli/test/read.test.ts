// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getPdppCacheLayout, writePdppSecretFile } from "../src/cache-layout.ts";
import { runCli } from "../src/index.ts";
import { buildReadRequest, runRead } from "../src/read/commands.ts";
import { PdppUsageError } from "../src/ref/errors.ts";

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
  assert.match(captured.stdout(), /read schema .*--stream <name>.*--instance-id <handle>/s);
  assert.match(captured.stdout(), /--connection-id and --connector-instance-id are deprecated aliases/s);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
});

test("read selectors send opaque public instance handles on every read surface", async () => {
  const cacheRoot = await makeCredentialCache("pairwise-token");
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  const opaqueHandle = "opaque/a+b?z=1";
  globalThis.fetch = (input) => {
    const url = new URL(input);
    requests.push(url);
    return Promise.resolve(jsonResponse(200, { object: "list", data: [], instance_id: opaqueHandle }));
  };

  const cases = [
    { args: ["schema", PROVIDER], path: "/v1/schema" },
    { args: ["streams", PROVIDER], path: "/v1/streams" },
    { args: ["query-records", PROVIDER, "messages"], path: "/v1/streams/messages/records" },
    { args: ["fetch", PROVIDER, "messages", "messages:a/b/🧭"], path: "/v1/streams/messages/records/messages%3Aa%2Fb%2F%F0%9F%A7%AD" },
    {
      args: ["field-window", PROVIDER, "messages", "messages:a/b/🧭", "--field", "text"],
      path: "/v1/streams/messages/records/messages%3Aa%2Fb%2F%F0%9F%A7%AD/field-window",
    },
    { args: ["search", PROVIDER, "hello"], path: "/v1/search" },
    { args: ["search", PROVIDER, "hello", "--mode", "lexical"], path: "/v1/search" },
    { args: ["search", PROVIDER, "hello", "--mode", "semantic"], path: "/v1/search/semantic" },
    { args: ["search", PROVIDER, "hello", "--mode", "hybrid"], path: "/v1/search/hybrid" },
    { args: ["aggregate", PROVIDER, "messages", "--metric", "count"], path: "/v1/streams/messages/aggregate" },
  ];

  try {
    for (const { args, path } of cases) {
      const captured = captureIo();
      const code = await runCli(
        ["read", ...args, "--instance-id", opaqueHandle, "--cache-root", cacheRoot],
        captured.io
      );
      assert.equal(code, 0, args.join(" "));
      assert.equal(requests.at(-1)?.pathname, path, args.join(" "));
      assert.deepEqual(requests.at(-1)?.searchParams.getAll("instance_id"), [opaqueHandle], args.join(" "));
      assert.match(requests.at(-1)?.search ?? "", /instance_id=opaque%2Fa%2Bb%3Fz%3D1/, args.join(" "));
      assert.equal(requests.at(-1)?.searchParams.has("connection_id"), false, args.join(" "));
      if (args[0] === "fetch") {
        assert.equal(JSON.parse(captured.stdout()).instance_id, opaqueHandle);
      }
    }
    assert.equal(requests.length, cases.length);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read compatibility selectors map opaque handles to the instance_id wire parameter", async () => {
  const cacheRoot = await makeCredentialCache("selector-alias-token");
  const originalFetch = globalThis.fetch;
  const handles = ["legacy/connection+handle", "legacy/connector+handle"];
  const requests: URL[] = [];
  globalThis.fetch = (input) => {
    requests.push(new URL(input));
    return Promise.resolve(jsonResponse(200, { object: "list", data: [] }));
  };

  try {
    for (const [flag, handle] of [["--connection-id", handles[0]], ["--connector-instance-id", handles[1]]]) {
      await runCli(["read", "streams", PROVIDER, flag, handle, "--cache-root", cacheRoot], captureIo().io);
    }
    assert.deepEqual(requests.map((url) => url.searchParams.get("instance_id")), handles);
    assert.equal(requests.every((url) => !url.searchParams.has("connection_id")), true);
    assert.equal(requests.every((url) => !url.searchParams.has("connector_instance_id")), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("equals-form instance selector flags preserve equals bytes in opaque handles", async () => {
  const cacheRoot = await makeCredentialCache("equals-selector-token");
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  const handle = "opaque/a+b?z=1==";
  globalThis.fetch = (input) => {
    requests.push(new URL(input));
    return Promise.resolve(jsonResponse(200, { object: "list", data: [] }));
  };
  try {
    for (const flag of ["--instance-id", "--connection-id", "--connector-instance-id"]) {
      await runRead(["streams", PROVIDER, `${flag}=${handle}`, "--cache-root", cacheRoot], captureIo().io);
      assert.deepEqual(requests.at(-1)?.searchParams.getAll("instance_id"), [handle], flag);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("read selectors reject malformed or conflicting values before credential lookup or fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = () => {
    fetchCount += 1;
    return Promise.resolve(jsonResponse(200, {}));
  };

  const invalid = [
    ["read", "streams", PROVIDER, "--instance-id", "", "--cache-root", "/missing-cache"],
    ["read", "streams", PROVIDER, "--instance-id", "--cache-root", "/missing-cache"],
    ["read", "streams", PROVIDER, "--instance-id", "opaque-a", "--connection-id", "opaque-b", "--cache-root", "/missing-cache"],
    ["read", "streams", PROVIDER, "--instance-id", "opaque-a", "--instance-id", "opaque-b", "--cache-root", "/missing-cache"],
  ];

  try {
    for (const argv of invalid) {
      await assert.rejects(
        runRead(argv.slice(1), captureIo().io),
        (error) => error instanceof PdppUsageError && /selector|instance handle/i.test(error.message),
        JSON.stringify(argv)
      );
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read request builder rejects array-valued instance selectors with a usage error", () => {
  assert.throws(
    () => buildReadRequest("streams", [], { "instance-id": ["opaque-a", "opaque-b"] } as never, PROVIDER),
    PdppUsageError
  );
});

test("read sends the public instance selector through a local HTTP server with the cached grant", async () => {
  const requests: { url: URL; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    requests.push({ url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [], instance_id: "opaque/local-http-handle" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const providerUrl = `http://127.0.0.1:${address.port}`;
  const cacheRoot = await makeCredentialCache("local-http-token", providerUrl);

  try {
    const captured = captureIo();
    const code = await runCli(
      ["read", "streams", providerUrl, "--instance-id", "opaque/local-http-handle", "--cache-root", cacheRoot],
      captured.io
    );
    assert.equal(code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url.pathname, "/v1/streams");
    assert.equal(requests[0]?.url.searchParams.get("instance_id"), "opaque/local-http-handle");
    assert.equal(requests[0]?.authorization, "Bearer local-http-token");
    assert.equal(JSON.parse(captured.stdout()).instance_id, "opaque/local-http-handle");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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

test("read commands ignore owner-token flags and use cached client grant only", async () => {
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

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
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
    assert.equal(url.searchParams.get("instance_id"), "cin_slack");
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

async function makeCredentialCache(accessToken, providerUrl = PROVIDER) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "pdpp-cli-read-"));
  const layout = getPdppCacheLayout(cacheRoot);
  writePdppSecretFile(
    layout.credentialFile(providerUrl),
    `${JSON.stringify(
      {
        provider_url: providerUrl,
        authorization_server: providerUrl,
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
