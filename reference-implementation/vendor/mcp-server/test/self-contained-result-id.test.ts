// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer } from "../src/server.ts";

const FIRST_FETCH_ID_CIN_AAA = /first_fetch_id=cin_aaa\/orders:o1/;
const ID_CIN_AAA_ORDERS_O = /id=cin_aaa\/orders:o1/;
const ID_CIN_BBB_ORDERS_O = /id=cin_bbb\/orders:o9/;
const CONNECTION_ID = /connection_id=/;
const FIRST_FETCH_ID_S = /first_fetch_id=([^\s]+)/;
const FIRST_FETCH_ID = /first_fetch_id=/;
const CIN_AAA = /cin_aaa/;
const CIN_BBB = /cin_bbb/;
const ID_MESSAGES_M = /id=messages:m1/;

interface FetchCall {
  method: string;
  url: string;
}

function firstText(result: { [key: string]: unknown; content?: readonly unknown[] }): string {
  const first = result.content?.[0] as { text?: string; type?: string } | undefined;
  assert.equal(first?.type, "text", "first content block must be text");
  return first?.text ?? "";
}

// Self-contained search-result ids (`{connection_id}/{stream}:{record_id}`).
//
// Live finding (2026-06-09 ChatGPT retest of the 5-tool surface): search hits
// carried `id` = `stream:record_id` PLUS a separate `connection_id` field; on a
// multi-source hosted package, `fetch(id)` without `connection_id` returned a
// typed 409 `ambiguous_connection`. ChatGPT's rendered envelope buried the
// second field and its model never completed a fetch. OpenAI's search/fetch
// contract treats ids as single opaque handles — so the id must be
// self-contained.
//
// Canon rule (design-notes/full-context-refresh.md, 2026-06-01): journey tests
// consume ONLY what the model can see (`content[]` text), extract the next
// handle, and complete the workflow. The journey test below does exactly that
// against a multi-source fixture whose unscoped record reads 409.

const AMBIGUOUS_RECORD_ERROR = {
  error: {
    type: "invalid_request",
    code: "ambiguous_connection",
    message: "Record id 'o1' resolves to more than one connection under the caller's grant.",
    available_connections: [
      { connection_id: "cin_aaa", display_name: "laptop Amazon" },
      { connection_id: "cin_bbb", display_name: "example org Amazon" },
    ],
    retry_with: {
      field: "connection_id",
      guidance: "Retry with one of the listed connection_id values.",
    },
  },
};

// A fake multi-source RS: the same stream/record-key shape exists under two
// connections, and record fetches WITHOUT `connection_id` are ambiguous.
function makeMultiSourceFetch() {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? "GET" });

    if (url.pathname === "/v1/search") {
      if (url.searchParams.get("q") === "nothing") {
        return jsonResponse({
          object: "list",
          hits: [],
          meta: {
            package: {
              source_mix: [],
            },
          },
        });
      }
      return jsonResponse({
        object: "list",
        meta: {
          package: {
            source_mix: [
              { connection_id: "cin_aaa", connector_key: "amazon", display_name: "laptop Amazon", count: 1 },
              { connection_id: "cin_bbb", connector_key: "amazon", display_name: "example org Amazon", count: 1 },
            ],
          },
        },
        hits: [
          {
            stream: "orders",
            id: "o1",
            title: "Order o1 (laptop)",
            connection_id: "cin_aaa",
            connector_key: "amazon",
            display_name: "laptop Amazon",
            snippet: { text: "Pasta maker, $89." },
          },
          {
            stream: "orders",
            id: "o9",
            title: "Order o9 (example org)",
            connection_id: "cin_bbb",
            connector_key: "amazon",
            display_name: "example org Amazon",
            snippet: { text: "Pasta drying rack, $19." },
          },
        ],
      });
    }
    if (url.pathname === "/v1/streams/orders/records/o1") {
      const conn = url.searchParams.get("connection_id");
      if (!conn) {
        return new Response(JSON.stringify(AMBIGUOUS_RECORD_ERROR), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({
        id: "o1",
        stream: "orders",
        title: "Order o1 (laptop)",
        text: "Pasta maker, $89.",
        connection_id: conn,
        connector_key: "amazon",
      });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function connectClient(fakeFetch: typeof fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: "https://provider.test",
    accessToken: "scoped-token",
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "self-contained-id-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("multi-source search returns self-contained ids in structured results and content text", async () => {
  const { fetch } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: "search", arguments: { q: "pasta" } });
  assert.equal(result.isError, undefined);

  const structuredContent = result.structuredContent as { results: Array<{ connection_id?: string; id: string }> };
  const [first, second] = structuredContent.results;
  assert.ok(first && second, "search must return two results");
  assert.equal(first.id, "cin_aaa/orders:o1");
  assert.equal(second.id, "cin_bbb/orders:o9");
  // Machine envelope still carries the discrete source handles.
  assert.equal(first.connection_id, "cin_aaa");
  assert.equal(second.connection_id, "cin_bbb");

  // Model-visible text carries the complete handles, untruncated.
  const text = firstText(result);
  assert.match(text, FIRST_FETCH_ID_CIN_AAA);
  assert.match(text, ID_CIN_AAA_ORDERS_O);
  assert.match(text, ID_CIN_BBB_ORDERS_O);
  assert.ok(
    text.indexOf("first_fetch_id=cin_aaa/orders:o1") < text.indexOf("source_mix="),
    "first fetch handle must appear before verbose source metadata for clipped host previews"
  );
  // The connection is embedded in the id; it is not repeated as a second
  // model-carried field the host could bury.
  assert.doesNotMatch(text, CONNECTION_ID);

  await client.close();
  await server.close();
});

test("search to fetch journey completes from content[] text alone with ONE handle on a multi-source grant", async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const searchResult = await client.callTool({ name: "search", arguments: { q: "pasta" } });

  // Consume ONLY what the model can see: content[] text.
  const searchText = firstText(searchResult);
  const id = FIRST_FETCH_ID_S.exec(searchText)?.[1];
  assert.equal(id, "cin_aaa/orders:o1");

  // ONE opaque handle, no connection_id argument — the exact call shape the
  // live ChatGPT model produced when it failed against the old contract.
  const fetchResult = await client.callTool({ name: "fetch", arguments: { id } });
  assert.equal(
    fetchResult.isError,
    undefined,
    `single-handle fetch must succeed on a multi-source grant, got: ${firstText(fetchResult)}`
  );

  const document = JSON.parse(firstText(fetchResult));
  assert.equal(document.id, "cin_aaa/orders:o1", "document id must echo the self-contained handle");
  assert.equal(document.title, "Order o1 (laptop)");
  assert.equal(document.text, "Pasta maker, $89.");
  assert.equal(document.metadata.connection_id, "cin_aaa");

  // The embedded connection reached the RS as the canonical query param, so
  // the ambiguous_connection branch never fired.
  const recordCalls = calls.filter((entry) => entry.url.includes("/v1/streams/orders/records/o1"));
  assert.equal(recordCalls.length, 1);
  const [recordCall] = recordCalls;
  assert.ok(recordCall, "record fetch must be recorded");
  assert.equal(new URL(recordCall.url).searchParams.get("connection_id"), "cin_aaa");

  await client.close();
  await server.close();
});

test("zero-hit search does not invent a first fetch handle", async () => {
  const { fetch } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: "search", arguments: { q: "nothing" } });
  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { results: unknown[] };
  assert.deepEqual(structuredContent.results, []);
  assert.doesNotMatch(firstText(result), FIRST_FETCH_ID);

  await client.close();
  await server.close();
});

test("legacy stream:record_id ids keep their semantics: unscoped 409s, explicit connection_id scopes (backcompat)", async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  // Unscoped legacy id still surfaces the typed RS ambiguity envelope.
  const ambiguous = await client.callTool({ name: "fetch", arguments: { id: "orders:o1" } });
  assert.equal(ambiguous.isError, true);
  const ambiguousError = ambiguous.structuredContent as { error?: { code?: string } };
  assert.equal(ambiguousError.error?.code, "ambiguous_connection");

  // Legacy id + explicit connection_id argument is unchanged.
  const scoped = await client.callTool({
    name: "fetch",
    arguments: { id: "orders:o1", connection_id: "cin_aaa" },
  });
  assert.equal(scoped.isError, undefined);
  const scopedContent = scoped.structuredContent as { id?: string };
  assert.equal(scopedContent.id, "orders:o1", "legacy requests echo the legacy id");
  const scopedCall = calls
    .map((entry) => new URL(entry.url))
    .find((u) => u.pathname === "/v1/streams/orders/records/o1" && u.searchParams.get("connection_id") === "cin_aaa");
  assert.ok(scopedCall, "explicit connection_id must reach the RS");

  await client.close();
  await server.close();
});

test("self-contained id plus matching connection_id argument is accepted", async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "cin_aaa/orders:o1", connection_id: "cin_aaa" },
  });
  assert.equal(result.isError, undefined);
  const call = calls.map((entry) => new URL(entry.url)).find((u) => u.pathname === "/v1/streams/orders/records/o1");
  assert.ok(call, "expected a matching call to RS");
  assert.equal(call.searchParams.get("connection_id"), "cin_aaa");

  await client.close();
  await server.close();
});

test("conflicting embedded and explicit connection ids are rejected with a typed error before any RS call", async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "cin_aaa/orders:o1", connection_id: "cin_bbb" },
  });
  assert.equal(result.isError, true);
  const structuredContent = result.structuredContent as { error?: { code?: string; message?: string } };
  assert.equal(structuredContent.error?.code, "conflicting_connection_id");
  assert.match(structuredContent.error?.message ?? "", CIN_AAA);
  assert.match(structuredContent.error?.message ?? "", CIN_BBB);
  assert.equal(
    calls.some((entry) => entry.url.includes("/v1/streams/")),
    false,
    "a conflicting handle pair must not reach the RS"
  );

  await client.close();
  await server.close();
});

test("self-contained ids reject path traversal and malformed segments before any RS call", async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  for (const id of [
    "cin_aaa/orders:../../etc/passwd",
    "../cin_aaa/orders:o1",
    "cin_aaa/",
    "/orders:o1",
    "cin_aaa/orders",
    "cin_aaa/extra/orders:o1",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: calls share one already-connected client/fake-RS across cases and must run in order to keep the stateful fixture's call recording and assertions deterministic; Promise.all would race the shared state.
    const result = await client.callTool({ name: "fetch", arguments: { id } });
    assert.equal(result.isError, true, `id ${JSON.stringify(id)} must be rejected`);
  }
  assert.equal(
    calls.some((entry) => entry.url.includes("/v1/streams/")),
    false,
    "malformed ids must never reach the RS"
  );

  await client.close();
  await server.close();
});

test("hits without a connection keep plain stream:record_id ids", async () => {
  const calls: string[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const singleSourceFetch = async (urlInput: string | Request | URL) => {
    const url = new URL(urlInput.toString());
    calls.push(url.toString());
    if (url.pathname === "/v1/search") {
      return jsonResponse({ hits: [{ stream: "messages", id: "m1", title: "hi" }] });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  const { client, server } = await connectClient(singleSourceFetch);

  const result = await client.callTool({ name: "search", arguments: { q: "hi" } });
  const structuredContent = result.structuredContent as { results: Array<{ id?: string }> };
  assert.equal(structuredContent.results[0]?.id, "messages:m1");
  assert.match(firstText(result), ID_MESSAGES_M);

  await client.close();
  await server.close();
});

// Core #387 gives clients instance handles, not storage connection identifiers.
// #389 requires readers to tolerate unknown response members. This fixture
// refuses an unscoped fetch so the content-only journey proves identity survives.
function makePairwiseInstanceFetch() {
  const calls: FetchCall[] = [];
  const blobUrl = "https://provider.test/v1/blobs/blob-1?instance_id=inst_pairwise";
  const record = {
    object: "record",
    id: "o1",
    stream: "orders",
    instance_id: "inst_pairwise",
    emitted_at: "2026-10-10T00:00:00Z",
    data: {
      title: "Pairwise order",
      text: "Pasta maker",
      blob_ref: { blob_id: "blob-1", fetch_url: blobUrl },
    },
    future_member: { opaque: ["profile extension"] },
  };
  // biome-ignore lint/suspicious/useAwait: injected fetch contract requires Promise<Response>.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? "GET" });
    if (url.pathname === "/v1/search") {
      return jsonResponse({
        hits: [
          {
            id: "o1",
            stream: "orders",
            instance_id: "inst_pairwise",
            title: "Pairwise order",
          },
        ],
      });
    }
    if (url.pathname === "/v1/streams/orders/records") {
      return jsonResponse({
        object: "list",
        data: [record],
        has_more: false,
        future_envelope_member: { opaque: true },
      });
    }
    if (url.pathname === "/v1/streams/orders/records/o1") {
      if (url.searchParams.get("instance_id") !== "inst_pairwise" || url.searchParams.has("connection_id")) {
        return jsonResponse(
          {
            error: {
              type: "permission_error",
              code: "grant_invalid",
              message: "Instance handle required",
            },
          },
          { status: 403 },
        );
      }
      return jsonResponse(record);
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, calls, record, blobUrl };
}

test("pairwise instance search completes fetch and resource reads from one opaque content handle", async (t) => {
  const { fetch, calls } = makePairwiseInstanceFetch();
  const { client, server } = await connectClient(fetch);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const searchResult = await client.callTool({
    name: "search",
    arguments: { q: "pasta" },
  });
  const id = FIRST_FETCH_ID_S.exec(firstText(searchResult))?.[1];
  assert.ok(id);
  assert.ok(id.startsWith("pdpp://record/"), "pairwise identity requires an opaque record handle");
  const structured = searchResult.structuredContent as {
    results: Array<{ instance_id?: string; connection_id?: string }>;
  };
  assert.equal(structured.results[0]?.instance_id, "inst_pairwise");
  assert.equal(structured.results[0]?.connection_id, undefined);
  const fetchResult = await client.callTool({
    name: "fetch",
    arguments: { id },
  });
  assert.equal(fetchResult.isError, undefined, firstText(fetchResult));
  const document = JSON.parse(firstText(fetchResult));
  assert.equal(document.id, id);
  assert.equal(document.metadata.instance_id, "inst_pairwise");
  const ladder = (
    fetchResult.structuredContent as {
      content_ladder: { id: string; field_windows: Array<{ read: { args: { id: string } } }> };
    }
  ).content_ladder;
  assert.equal(ladder.id, id);
  assert.equal(ladder.field_windows[0]?.read.args.id, id);
  assert.equal(
    document.metadata.future_member,
    undefined,
    "unknown envelope extension is ignored by document projection",
  );
  assert.equal(new URL(document.url).searchParams.get("instance_id"), "inst_pairwise");
  const resource = await client.readResource({ uri: id });
  const content = resource.contents[0] as { text?: string };
  assert.equal(JSON.parse(content.text ?? "{}").instance_id, "inst_pairwise");
  const recordCalls = calls.map((call) => new URL(call.url)).filter((url) => url.pathname.endsWith("/records/o1"));
  assert.equal(recordCalls.length, 2);
  for (const url of recordCalls) {
    assert.equal(url.searchParams.get("instance_id"), "inst_pairwise");
    assert.equal(url.searchParams.has("connection_id"), false);
  }
});

test("instance-scoped query and explicit fetch preserve unknown members and blob fetch URLs", async (t) => {
  const { fetch, calls, record, blobUrl } = makePairwiseInstanceFetch();
  const { client, server } = await connectClient(fetch);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const queryResult = await client.callTool({
    name: "query_records",
    arguments: { stream: "orders", instance_id: "inst_pairwise" },
  });
  assert.equal(queryResult.isError, undefined, firstText(queryResult));
  const envelope = (
    queryResult.structuredContent as {
      data: { data: unknown[]; future_envelope_member?: unknown };
    }
  ).data;
  assert.deepEqual(envelope.data, [record]);
  assert.deepEqual(envelope.future_envelope_member, { opaque: true });
  assert.equal(record.data.blob_ref.fetch_url, blobUrl);
  assert.equal((envelope.data[0] as typeof record).data.blob_ref.fetch_url, blobUrl);
  const fetched = await client.callTool({
    name: "fetch",
    arguments: { id: "orders:o1", instance_id: "inst_pairwise" },
  });
  assert.equal(fetched.isError, undefined, firstText(fetched));
  assert.equal(
    (fetched.structuredContent as { metadata: { instance_id?: string } }).metadata.instance_id,
    "inst_pairwise",
  );
  assert.equal(
    new URL((fetched.structuredContent as { url: string }).url).searchParams.get("instance_id"),
    "inst_pairwise",
  );
  const recordCalls = calls.map((call) => new URL(call.url)).filter((url) => url.pathname.includes("/records"));
  assert.equal(recordCalls.length, 2);
  for (const url of recordCalls) {
    assert.equal(url.searchParams.get("instance_id"), "inst_pairwise");
    assert.equal(url.searchParams.has("connection_id"), false);
  }
});

test("fetch rejects conflicting instance handles and mixed connection selectors before an RS call", async (t) => {
  const { fetch, calls } = makePairwiseInstanceFetch();
  const { client, server } = await connectClient(fetch);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const id =
    "pdpp://record/" +
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "record",
        instance_id: "inst_pairwise",
        stream: "orders",
        record_id: "o1",
      }),
    ).toString("base64url");
  for (const args of [
    { id, instance_id: "inst_other" },
    { id, connection_id: "raw_connection" },
    { id: "raw_connection/orders:o1", instance_id: "inst_pairwise" },
    {
      id: "orders:o1",
      instance_id: "inst_pairwise",
      connection_id: "raw_connection",
    },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one recording client checks that no case reaches the RS.
    const result = await client.callTool({ name: "fetch", arguments: args });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error?: { code?: string } }).error?.code, "conflicting_instance_id");
  }
  assert.deepEqual(calls, []);
  const agreeing = await client.callTool({
    name: "fetch",
    arguments: { id, instance_id: "inst_pairwise" },
  });
  assert.equal(agreeing.isError, undefined, firstText(agreeing));
});

const NEXT_FIELD_READ_ARGS = /next read_record_field args=(.+)/;
const FIELD_EXCERPT = /excerpt/;

test("instance search evidence supports field reads, paging, and field-window resources without connection selectors", async (t) => {
  const calls: URL[] = [];
  // biome-ignore lint/suspicious/useAwait: injected fetch requires Promise<Response>.
  const fetch = async (input: string | Request | URL) => {
    const url = new URL(input.toString());
    calls.push(url);
    if (url.pathname === "/v1/search") {
      return jsonResponse({
        hits: [
          {
            id: "o1",
            stream: "orders",
            instance_id: "inst_pairwise",
            evidence_excerpts: [{ field_path: "text", preview_text: "excerpt", truncated: true }],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/field-window")) {
      if (url.searchParams.get("instance_id") !== "inst_pairwise" || url.searchParams.has("connection_id")) {
        return jsonResponse({ error: { code: "wrong_identity" } }, { status: 403 });
      }
      return jsonResponse({
        object: "field_window",
        stream: "orders",
        record_id: "o1",
        instance_id: "inst_pairwise",
        field: { path: "text", type: "string" },
        window: {
          text: "excerpt",
          start_chars: 0,
          end_chars: 7,
          total_chars: 14,
          limit_chars: 7,
          complete: false,
          next_offset_chars: 7,
          previous_offset_chars: null,
        },
      });
    }
    return new Response(null, { status: 404 });
  };
  const { client, server } = await connectClient(fetch);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const search = await client.callTool({ name: "search", arguments: { q: "excerpt" } });
  const id = FIRST_FETCH_ID_S.exec(firstText(search))?.[1];
  assert.ok(id);
  const ladder = (
    search.structuredContent as {
      content_ladder: {
        records: Array<{ id: string; field_windows: Array<{ read: { args: Record<string, unknown> } }> }>;
      };
    }
  ).content_ladder.records[0];
  assert.ok(ladder);
  assert.equal(ladder.id, id);
  const evidenceArgs = ladder.field_windows[0]?.read.args;
  assert.ok(evidenceArgs);
  assert.equal(evidenceArgs.id, id);
  const read = await client.callTool({ name: "read_record_field", arguments: { ...evidenceArgs, limit_chars: 7 } });
  assert.equal(read.isError, undefined, firstText(read));
  const record = (read.structuredContent as { record: { id: string; instance_id?: string; connection_id?: string } })
    .record;
  assert.equal(record.instance_id, "inst_pairwise");
  assert.equal(record.connection_id, undefined);
  assert.equal(record.id, id);
  const next = NEXT_FIELD_READ_ARGS.exec(firstText(read))?.[1];
  assert.ok(next);
  const paged = await client.callTool({ name: "read_record_field", arguments: JSON.parse(next) });
  assert.equal(paged.isError, undefined, firstText(paged));
  const resourceUri =
    "pdpp://field-window/" +
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "field-window",
        instance_id: "inst_pairwise",
        stream: "orders",
        record_id: "o1",
        field_path: "text",
        offset_chars: 7,
      }),
    ).toString("base64url");
  const resource = await client.readResource({ uri: resourceUri });
  assert.match((resource.contents[0] as { text: string }).text, FIELD_EXCERPT);
  const explicit = await client.callTool({
    name: "read_record_field",
    arguments: { instance_id: "inst_pairwise", stream: "orders", record_id: "o1", field_path: "text" },
  });
  assert.equal(explicit.isError, undefined, firstText(explicit));
  const conflicting = await client.callTool({
    name: "read_record_field",
    arguments: { instance_id: "inst_pairwise", connection_id: "raw_connection", stream: "orders", record_id: "o1", field_path: "text" },
  });
  assert.equal(conflicting.isError, true);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/field-window")).length, 4);
  for (const url of calls.filter((item) => item.pathname.endsWith("/field-window"))) {
    assert.equal(url.searchParams.get("instance_id"), "inst_pairwise");
    assert.equal(url.searchParams.has("connection_id"), false);
  }
});
