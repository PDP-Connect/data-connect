// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { replay, startPermanentAudienceFixture } from "./helpers/mcp-existing-client-session.ts";
import { replayStoredSession } from "./mcp-stored-id-resolution.test.ts";

type JsonObject = Record<string, any>;
const A = "cin_mcp_contract_a";
const B = "cin_mcp_contract_b";
const MISSING_STORED_RESOURCE = /stored record resource URI did not resolve/;
const object = (value: unknown): JsonObject => (value ?? {}) as JsonObject;

// Only search ordering and the future child-selector interface are controlled.
// Record, resource, query and field reads still execute against the local server.
function controlSession(
  t: test.TestContext,
  options: { bFirst?: boolean; grants?: boolean; refusedResource?: string } = {}
) {
  const nativeFetch = globalThis.fetch;
  const calls: JsonObject[] = [];
  const searchIds: string[][] = [];
  const queryOwners = new Map<string, JsonObject>();
  let page: JsonObject | undefined;
  const respond = (body: JsonObject, headers?: Headers) =>
    new Response(JSON.stringify(body), { headers: headers ?? { "Content-Type": "application/json" }, status: 200 });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/mcp") || typeof init?.body !== "string") {
      return nativeFetch(url, init);
    }
    const message = JSON.parse(init.body) as JsonObject;
    let requestInit = init;
    const params = object(message.params);
    const args = object(params.arguments);
    if (message.method === "resources/read" && params.uri === options.refusedResource) {
      return Response.json({ id: message.id, jsonrpc: "2.0", result: { contents: [] } });
    }
    if (message.method === "tools/call") {
      calls.push(structuredClone(params));
      if (params.name === "query_records" && args.cursor) {
        const owner = queryOwners.get(args.cursor);
        assert(owner, "query continuation requires a producing request");
        assert.equal(args.connection_id, owner.connection_id, "query cursor must retain producing connection");
        assert.equal(args.grant_id, owner.grant_id, "query cursor must retain producing grant");
      }
      if (options.grants && params.name === "list_package_children") {
        const children = [A, B].map((connection_id) => ({ connection_id, grant_id: `grant-${connection_id}` }));
        return respond({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: JSON.stringify(children), type: "text" }],
            structuredContent: { children },
          },
        });
      }
      if (options.grants && ["query_records", "read_record_field"].includes(params.name)) {
        const connection =
          args.connection_id ??
          (typeof args.id === "string" && args.id.startsWith("pdpp://")
            ? JSON.parse(Buffer.from(String(args.id.split("/").at(-1)), "base64url").toString()).connection_id
            : String(args.id).split("/")[0]);
        assert.equal(args.grant_id, `grant-${connection}`, `${params.name} must retain producing grant`);
      }
      if (params.name === "search" && args.q === "pasta") {
        if (args.cursor) {
          assert(page, "follow-up search requires an initial page");
          return respond({ id: message.id, jsonrpc: "2.0", result: page });
        }
        // Ask the real server for the same complete result set, then vary order only.
        const response = await nativeFetch(url, {
          ...init,
          body: JSON.stringify({ ...message, params: { ...params, arguments: { limit: 100, q: "pasta" } } }),
        });
        const body = (await response.json()) as JsonObject;
        const result = object(body.result);
        const structured = object(result.structuredContent);
        const hits = [...structured.results] as JsonObject[];
        hits.sort((left, right) => {
          const first = options.bFirst ? B : A;
          return (
            Number(right.connection_id === first) - Number(left.connection_id === first) ||
            String(left.id).localeCompare(String(right.id))
          );
        });
        searchIds.push(hits.map((hit) => String(hit.id)));
        assert.equal(hits.length, 4, "search control must preserve all four real records");
        const makePage = (hit: JsonObject, cursor?: string) => ({
          ...result,
          structuredContent: {
            ...structured,
            data: { ...object(structured.data), next_cursor: cursor },
            next_cursor: cursor,
            results: [hit],
          },
        });
        const [firstHit, nextHit] = hits;
        assert(firstHit && nextHit);
        page = makePage(nextHit);
        return respond({ ...body, result: makePage(firstHit, "controlled-search-next") }, response.headers);
      }
      if (options.grants) {
        const { grant_id: _grant, ...nativeArgs } = args;
        message.params = { ...params, arguments: nativeArgs };
        requestInit = { ...init, body: JSON.stringify(message) };
      }
    }
    const response = await nativeFetch(url, requestInit);
    if (message.method === "tools/call" && params.name === "query_records" && !args.cursor) {
      const body = (await response.clone().json()) as JsonObject;
      const data = object(object(body.result).structuredContent);
      const cursor = object(data.data).next_cursor ?? data.next_cursor;
      if (typeof cursor === "string") {
        queryOwners.set(cursor, structuredClone(args));
      }
    }
    if (options.grants && message.method === "tools/list") {
      const body = (await response.json()) as JsonObject;
      for (const tool of body.result.tools) {
        tool.inputSchema.required = [...(tool.inputSchema.required ?? []), "grant_id"];
        tool.inputSchema.properties.grant_id = { type: "string" };
      }
      body.result.tools.push({
        annotations: { readOnlyHint: true },
        inputSchema: { properties: {}, type: "object" },
        name: "list_package_children",
      });
      return respond(body, response.headers);
    }
    return response;
  });
  return {
    calls,
    refuseResource: (uri: string) => {
      options.refusedResource = uri;
    },
    searchIds,
    setBFirst: () => {
      options.bFirst = true;
    },
  };
}

test("stored session replay preserves captured IDs when the same search records change order", async (t) => {
  const fixture = await startPermanentAudienceFixture();
  try {
    const control = controlSession(t);
    const first = await replay(fixture.rsUrl, fixture.package, "package");
    const saved = structuredClone(object(first.session).storedIds);
    control.calls.length = 0;
    control.setBFirst();
    const second = await replay(fixture.rsUrl, fixture.package, "package", saved);
    const [originalOrder, replayOrder] = control.searchIds;
    assert(originalOrder && replayOrder);
    assert.deepEqual([...originalOrder].sort(), [...replayOrder].sort());
    assert.notEqual(originalOrder[0], replayOrder[0]);
    assert.equal(object(second.session).fetchMetadataConnectionId, B);
    const fetches = control.calls.filter((call) => call.name === "fetch");
    assert.deepEqual(
      fetches.slice(0, -2).map((call) => call.arguments.id),
      saved.fetchIds
    );
    const firstContinuation = control.calls.findIndex(
      (call) => call.name === "read_record_field" && call.arguments.cursor
    );
    assert(firstContinuation > 0);
    assert.deepEqual(
      control.calls
        .slice(0, firstContinuation)
        .filter((call) => call.name === "read_record_field")
        .map((call) => call.arguments.id),
      saved.readIds
    );
    assert.deepEqual(object(second.session).storedIds, saved);
    assert.deepEqual(object(first.session).storedIds, saved, "replay must not mutate the original capture");
  } finally {
    await fixture.close();
  }
});

test("B-first search retains the query connection and grant through pagination", async (t) => {
  const fixture = await startPermanentAudienceFixture();
  try {
    const control = controlSession(t, { bFirst: true, grants: true });
    const result = await replay(fixture.rsUrl, fixture.package, "package");
    assert.equal(object(result.session).queryRecordConnectionId, B);
    const queries = control.calls.filter((call) => call.name === "query_records" && call.arguments.cursor);
    assert.equal(queries.length, 1);
    const [continuation] = queries;
    assert(continuation);
    assert.equal(continuation.arguments.connection_id, B);
    assert.equal(continuation.arguments.grant_id, `grant-${B}`);
  } finally {
    await fixture.close();
  }
});

test("saved B field handles retain their grant through continuation when scoped connection is A", async (t) => {
  const fixture = await startPermanentAudienceFixture();
  try {
    const control = controlSession(t, { grants: true });
    const saved = object(object(await replay(fixture.rsUrl, fixture.package, "package")).session).storedIds;
    saved.readIds = [`${B}/documents:record-2`];
    control.calls.length = 0;
    await replay(fixture.rsUrl, fixture.package, "package", saved);
    const continuations = control.calls.filter(
      (call) => call.name === "read_record_field" && call.arguments.id === saved.readIds[0] && call.arguments.cursor
    );
    assert(continuations.length > 0);
    assert(continuations.every((call) => call.arguments.grant_id === `grant-${B}`));
  } finally {
    await fixture.close();
  }
});

test("saved fetch and read lists are replayed exactly without unioning resource URIs", async (t) => {
  const fixture = await startPermanentAudienceFixture();
  try {
    const control = controlSession(t);
    const captured = await replay(fixture.rsUrl, fixture.package, "package");
    const saved = structuredClone(object(captured.session).storedIds);
    saved.fetchIds = [saved.fetchId];
    saved.readIds = [saved.fetchId];
    saved.readArgsList = [];
    const original = structuredClone(saved);
    control.calls.length = 0;
    const result = await replay(fixture.rsUrl, fixture.package, "package", saved);
    const fetches = control.calls.filter((call) => call.name === "fetch");
    assert.deepEqual(
      fetches.slice(0, -2).map((call) => call.arguments.id),
      original.fetchIds
    );
    const firstContinuation = control.calls.findIndex(
      (call) => call.name === "read_record_field" && call.arguments.cursor
    );
    assert.deepEqual(
      control.calls
        .slice(0, firstContinuation)
        .filter((call) => call.name === "read_record_field")
        .map((call) => call.arguments.id),
      original.readIds
    );
    assert.deepEqual(object(result.session).storedIds, original);
    assert.deepEqual(saved, original, "empty saved window args must remain unmodified");
  } finally {
    await fixture.close();
  }
});

test("P4 comparison accepts reordered real search discoveries while replaying captured handles", async (t) => {
  const fixture = await startPermanentAudienceFixture();
  try {
    const control = controlSession(t);
    const base = await replay(fixture.rsUrl, fixture.package, "package");
    const captured = { session: { ...object(base.session), storedIds: object(object(base.session).storedIds) } };
    const saved = structuredClone(captured.session.storedIds);
    control.setBFirst();
    await replayStoredSession(fixture.rsUrl, fixture.package, "package", captured);
    assert.deepEqual(captured.session.storedIds, saved);
    const [originalOrder, replayOrder] = control.searchIds;
    assert(originalOrder && replayOrder);
    assert.deepEqual([...originalOrder].sort(), [...replayOrder].sort());
    assert.notEqual(originalOrder[0], replayOrder[0]);
    const savedUris = saved.recordUris as string[];
    const [savedUri] = savedUris;
    assert(savedUri);
    control.refuseResource(savedUri);
    await assert.rejects(
      replayStoredSession(fixture.rsUrl, fixture.package, "package", captured),
      MISSING_STORED_RESOURCE,
      "P4 must still reject a captured resource URI that no longer resolves"
    );
  } finally {
    await fixture.close();
  }
});

const INVALID_FIELD_READ = /field (read|window)|read_record_field/;
const CHANGED_RESOURCE = /captured resource|resource (record|content)/;

for (const corruption of ["empty second handle", "corrupt saved window"] as const) {
  test(`saved field replay rejects ${corruption}`, async (t) => {
    const fixture = await startPermanentAudienceFixture();
    try {
      const base = await replay(fixture.rsUrl, fixture.client, "client");
      const saved = object(object(base.session).storedIds);
      assert.equal(saved.readIds.length, 2);
      assert(String(saved.readIds[1]).startsWith("pdpp://record/"));
      const [windowArgs] = saved.readArgsList;
      assert(windowArgs);
      const nativeFetch = globalThis.fetch;
      let changed = 0;
      t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        const response = await nativeFetch(url, init);
        if (!String(url).endsWith("/mcp") || typeof init?.body !== "string") {
          return response;
        }
        const request = JSON.parse(init.body) as JsonObject;
        const args = object(request.params?.arguments);
        if (request.params?.name !== "read_record_field") {
          return response;
        }
        const emptySecond = corruption === "empty second handle" && args.id === saved.readIds[1] && !args.cursor;
        const corruptWindow =
          corruption === "corrupt saved window" &&
          args.id === windowArgs.id &&
          args.limit_chars === windowArgs.limit_chars &&
          args.offset_chars === windowArgs.offset_chars;
        if (!(emptySecond || corruptWindow)) {
          return response;
        }
        changed += 1;
        const body = (await response.json()) as JsonObject;
        if (emptySecond) {
          body.result = { content: [{ text: "successful empty read", type: "text" }], structuredContent: {} };
        } else {
          body.result.structuredContent.window.text = "corrupted saved field text";
        }
        return Response.json(body, { headers: response.headers });
      });
      await assert.rejects(replay(fixture.rsUrl, fixture.client, "client", saved), INVALID_FIELD_READ);
      assert.equal(changed, 1, "negative control must corrupt only its targeted saved read");
    } finally {
      await fixture.close();
    }
  });
}

for (const tokenKind of ["client", "package"] as const) {
  for (const corruption of ["record sibling", "field-window sibling", "record MIME"] as const) {
    test(`P4 rejects ${tokenKind} saved resource with ${corruption}`, async (t) => {
      const fixture = await startPermanentAudienceFixture();
      try {
        const token = fixture[tokenKind];
        const base = await replay(fixture.rsUrl, token, tokenKind);
        const session = object(base.session);
        const saved = object(session.storedIds);
        const originalUri = (
          corruption === "field-window sibling" ? saved.fieldWindowUris : saved.recordUris
        )[0] as string;
        assert(originalUri);
        const prefix = corruption === "field-window sibling" ? "pdpp://field-window/" : "pdpp://record/";
        const payload = JSON.parse(Buffer.from(originalUri.slice(prefix.length), "base64url").toString()) as JsonObject;
        const siblingId = String(payload.record_id).endsWith("-page")
          ? String(payload.record_id).slice(0, -5)
          : `${payload.record_id}-page`;
        const siblingUri = `${prefix}${Buffer.from(JSON.stringify({ ...payload, record_id: siblingId })).toString("base64url")}`;
        const nativeFetch = globalThis.fetch;
        let changed = 0;
        t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
          if (!String(url).endsWith("/mcp") || typeof init?.body !== "string") {
            return nativeFetch(url, init);
          }
          const request = JSON.parse(init.body) as JsonObject;
          if (request.method !== "resources/read" || request.params.uri !== originalUri) {
            return nativeFetch(url, init);
          }
          const response = await nativeFetch(url, {
            ...init,
            body: JSON.stringify({
              ...request,
              params: { uri: corruption === "record MIME" ? originalUri : siblingUri },
            }),
          });
          const body = (await response.json()) as JsonObject;
          if (corruption !== "record MIME") {
            assert(
              body.result.contents.some((part: JsonObject) => String(part.text).includes(siblingId)),
              "control must use real sibling content"
            );
          }
          for (const part of body.result.contents) {
            part.uri = originalUri;
            if (corruption === "record MIME") {
              part.mimeType = "text/plain";
            }
          }
          changed += 1;
          return Response.json(body, { headers: response.headers });
        });
        await assert.rejects(
          replayStoredSession(fixture.rsUrl, token, tokenKind, { session: { ...session, storedIds: saved } }),
          CHANGED_RESOURCE
        );
        assert(changed > 0);
      } finally {
        await fixture.close();
      }
    });
  }
}
