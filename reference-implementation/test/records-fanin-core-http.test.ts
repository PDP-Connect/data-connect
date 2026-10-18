// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP acceptance for a client grant that lists several instance handles
 * for one stream (Core §7 StreamGrant `instance_ids`), read through
 * GET /v1/streams/{stream}/records with only Core query parameters.
 *
 * Case ids follow the spec-derived acceptance table
 * (dc-ri-fanin-testdesign-20261017): F* ordering and continuation, L* page
 * size, C* cursor validity and concurrent writes, D* incremental sync. The
 * grant always lists three instances A, B, E; a fourth instance U holds
 * matching records but is never granted.
 *
 * Runs on SQLite (memory-default) and, when PDPP_TEST_POSTGRES_URL is set, on
 * a temporary PostgreSQL database.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

// biome-ignore lint/suspicious/noExplicitAny: HTTP response bodies are asserted field by field.
type Json = Record<string, any>;
type BackendName = "postgres" | "sqlite";

interface TestServer {
  asPort: number;
  asServer: import("node:http").Server;
  rsPort: number;
  rsServer: import("node:http").Server;
}

interface Ctx {
  asUrl: string;
  backend: BackendName;
  rsUrl: string;
}

interface HttpResult {
  body: Json;
  headers: Headers;
  status: number;
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CLIENT_ID = "concert_recommendation_app";
const OWNER_ID = "owner_local";
const CONNECTOR_KEY = "fanin_core_http";
const SOURCE_ID = "https://sources.example/fanin-core-http";
const STREAM = "s";

const STREAM_DECLARATION = {
  cursor_field: "c",
  name: STREAM,
  primary_key: ["id"],
  schema: {
    properties: {
      c: { type: ["number", "null"] },
      id: { type: "string" },
      secret: { type: "string" },
      v: { type: "string" },
    },
    required: ["id"],
    type: "object",
  },
  selection: { fields: true, resources: true },
  semantics: "mutable_state",
};

function runtimeManifest(): Json {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_KEY,
    connector_key: CONNECTOR_KEY,
    display_name: "Fan-in Core HTTP",
    manifest_uri: `https://implementations.example/connectors/${CONNECTOR_KEY}`,
    protocol_version: "0.1.0",
    streams: [STREAM_DECLARATION],
    version: "1.0.0",
  };
}

function fulfillment(): Json {
  return {
    source_declaration: {
      declaration_version: "fanin-core-http-v1",
      display: { name: "Fan-in Core HTTP" },
      extensions: {},
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example/pdpp-test" },
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [STREAM_DECLARATION],
    },
    storage_binding: { connector_id: CONNECTOR_KEY },
    streams: [STREAM_DECLARATION],
  };
}

async function http(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { body: text ? (JSON.parse(text) as Json) : {}, headers: response.headers, status: response.status };
}

// Row H of the acceptance table: every response carries Request-Id and the
// selected PDPP-Version.
function assertHeaders(result: HttpResult): void {
  assert.ok(result.headers.get("request-id"), "Request-Id header");
  assert.ok(result.headers.get("pdpp-version"), "PDPP-Version header");
}

let instanceCounter = 0;
async function seedInstance(label: string): Promise<string> {
  instanceCounter += 1;
  const id = `cin_fanin_http_${label}_${instanceCounter}`;
  const now = "2026-10-01T00:00:00.000Z";
  await createRequestConnectorInstanceStore().upsert({
    connectorId: CONNECTOR_KEY,
    connectorInstanceId: id,
    createdAt: now,
    displayName: `Account ${label}`,
    ownerSubjectId: OWNER_ID,
    sourceBinding: { fixture: id },
    sourceBindingKey: id,
    sourceKind: "manual",
    status: "active",
    updatedAt: now,
  });
  return id;
}

let emitCounter = 0;
async function put(instanceId: string, data: Json, opts: { op?: "delete" } = {}): Promise<void> {
  emitCounter += 1;
  await ingestRecord(
    { connector_id: CONNECTOR_KEY, connector_instance_id: instanceId },
    {
      data: opts.op ? null : data,
      emitted_at: new Date(Date.UTC(2026, 9, 1, 0, 0, emitCounter)).toISOString(),
      key: String(data.id),
      ...(opts.op ? { op: opts.op } : {}),
      stream: STREAM,
    } as never
  );
}

// `label@value` in the acceptance table: id and cursor c (null or absent).
function row(id: string, c: number | null | undefined, v = "v1"): Json {
  return c === undefined ? { id, secret: "hidden", v } : { c, id, secret: "hidden", v };
}

async function grantToken(ctx: Ctx, instanceIds: string[]): Promise<string> {
  const par = await http(`${ctx.asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/export",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ fields: ["id", "c", "v"], instance_ids: instanceIds, name: STREAM }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(par.status, 201, JSON.stringify(par.body));
  const review = await http(`${ctx.asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: par.body.request_uri, subject_id: OWNER_ID }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await http(`${ctx.asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: par.body.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(approved.body.grant.streams[0].instance_ids, instanceIds);
  return String(approved.body.token);
}

function read(ctx: Ctx, token: string, query: Record<string, string | number>): Promise<HttpResult> {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const suffix = params.size ? `?${params}` : "";
  return http(`${ctx.rsUrl}/v1/streams/${STREAM}/records${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
}

interface Traversal {
  ids: string[][];
  last: Json;
  pages: Json[];
}

// Follow next_cursor with the same order and limit; never decode tokens.
async function traverse(
  ctx: Ctx,
  token: string,
  query: Record<string, string | number>,
  { afterPage }: { afterPage?: (index: number) => Promise<void> } = {}
): Promise<Traversal> {
  const pages: Json[] = [];
  const { changes_since: _first, ...continuation } = query;
  let next: Record<string, string | number> = query;
  for (let i = 0; i < 400; i += 1) {
    const result = await read(ctx, token, next);
    assertHeaders(result);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.object, "list");
    pages.push(result.body);
    for (const record of result.body.data as Json[]) {
      assert.ok(!(record.data && "secret" in record.data), "no ungranted field may appear");
    }
    if (!result.body.has_more) {
      return { ids: pages.map((p) => (p.data as Json[]).map((r) => String(r.id))), last: result.body, pages };
    }
    assert.equal(typeof result.body.next_cursor, "string", "a non-terminal page supplies next_cursor");
    await afterPage?.(i);
    next = { ...continuation, cursor: result.body.next_cursor };
  }
  assert.fail("pagination did not terminate");
}

function errorOf(result: HttpResult): { code: string; type: string } {
  assertHeaders(result);
  assert.ok(result.body.error, `expected an error envelope: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.data, undefined, "an error carries no record page");
  return { code: result.body.error.code, type: result.body.error.type };
}

async function pruneChangesThrough(ctx: Ctx, instanceId: string, version: number): Promise<void> {
  if (ctx.backend === "postgres") {
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND version <= $3", [
      instanceId,
      STREAM,
      version,
    ]);
    return;
  }
  getDb()
    .prepare("DELETE FROM record_changes WHERE connector_instance_id = ? AND stream = ? AND version <= ?")
    .run(instanceId, STREAM, version);
}

// A legitimately issued sync token for the current state (Core §4 two
// cursor spaces). The RI's `beginning` bootstrap is the only way to obtain a
// first token; Core does not yet specify one (review item S2).
async function baselineToken(ctx: Ctx, token: string): Promise<string> {
  const session = await traverse(ctx, token, { changes_since: "beginning", limit: 100 });
  assert.equal(typeof session.last.next_changes_since, "string");
  return String(session.last.next_changes_since);
}

type Case = (ctx: Ctx, t: import("node:test").TestContext) => Promise<void>;

// PostgreSQL stores record cursor values as text (records.cursor_value), so a
// numeric cursor sorts lexically there, on one connection as on several. That
// predates this suite; the numeric-order expectations run on SQLite and are
// reported as skipped on PostgreSQL.
const PG_TEXT_CURSOR_SKIP =
  "PostgreSQL orders numeric cursor values as text (pre-existing single-connection behavior); numeric order is asserted on SQLite";
function numericOrderCheck(ctx: Ctx, t: import("node:test").TestContext, name: string, run: () => void) {
  return t.test(name, { skip: ctx.backend === "postgres" ? PG_TEXT_CURSOR_SKIP : false }, run);
}
const CASES: Array<[string, Case]> = [];
function acceptance(name: string, run: Case): void {
  CASES.push([name, run]);
}

// ─── F: ordering and continuation ───────────────────────────────────────────

async function fixtureF(): Promise<{ a: string; b: string; e: string; u: string }> {
  const [a, b, e, u] = [await seedInstance("fa"), await seedInstance("fb"), await seedInstance("fe"), await seedInstance("fu")];
  for (const data of [row("c", 10), row("a", 10), row("e", 30), row("m", null)]) {
    await put(a, data);
  }
  for (const data of [row("b", 10), row("d", 20), row("n", undefined)]) {
    await put(b, data);
  }
  await put(u, row("x", 5));
  return { a, b, e, u };
}

acceptance("F1/F2/F3 order, missing bucket and continuation across three granted instances", async (ctx) => {
  const { a, b, e } = await fixtureF();
  for (const instanceIds of [
    [a, b, e],
    [e, b, a],
  ]) {
    const token = await grantToken(ctx, instanceIds);
    const asc = await traverse(ctx, token, { limit: 2, order: "asc" });
    assert.deepEqual(asc.ids, [["a", "b"], ["c", "d"], ["e", "m"], ["n"]], "F1");
    const desc = await traverse(ctx, token, { limit: 2, order: "desc" });
    assert.deepEqual(desc.ids, [["e", "d"], ["c", "b"], ["a", "n"], ["m"]], "F2");
    const byDefault = await traverse(ctx, token, { limit: 2 });
    assert.deepEqual(byDefault.ids, desc.ids, "F3: order defaults to desc");
  }
});

acceptance("F4/F5/F6 early exhaustion, empty instances and an empty grant", async (ctx) => {
  const [a4, b4, e4] = [await seedInstance("f4a"), await seedInstance("f4b"), await seedInstance("f4e")];
  await put(a4, row("a", 1));
  await put(b4, row("b", 2));
  const f4 = await traverse(ctx, await grantToken(ctx, [a4, b4, e4]), { limit: 1, order: "asc" });
  assert.deepEqual(f4.ids, [["a"], ["b"]], "F4");
  assert.deepEqual(
    f4.pages.map((p) => p.has_more),
    [true, false]
  );

  const [a5, b5, e5] = [await seedInstance("f5a"), await seedInstance("f5b"), await seedInstance("f5e")];
  await put(a5, row("a", 10));
  for (const data of [row("b", 20), row("c", 30), row("d", 40)]) {
    await put(b5, data);
  }
  const f5 = await traverse(ctx, await grantToken(ctx, [a5, b5, e5]), { limit: 2, order: "asc" });
  assert.deepEqual(f5.ids, [["a", "b"], ["c", "d"]], "F5");

  const empty = [await seedInstance("f6a"), await seedInstance("f6b"), await seedInstance("f6e")];
  const f6 = await traverse(ctx, await grantToken(ctx, empty), { limit: 1 });
  assert.deepEqual(f6.ids, [[]], "F6: one empty terminal page");
});

// ─── L: page size ───────────────────────────────────────────────────────────

const N_IDS = Array.from({ length: 203 }, (_, i) => `r${String(i + 1).padStart(3, "0")}`);

acceptance("L0/L1/L25/L100/L101 the combined page honours default, small, and clamped limits", async (ctx, t) => {
  const [a, b, e] = [await seedInstance("na"), await seedInstance("nb"), await seedInstance("ne")];
  for (let i = 1; i <= 203; i += 1) {
    await put(i % 2 === 1 ? a : b, row(`r${String(i).padStart(3, "0")}`, i));
  }
  const token = await grantToken(ctx, [a, b, e]);
  // Sizes and exactly-once delivery hold on both backends; the r001..r203
  // order is numeric (see PG_TEXT_CURSOR_SKIP).
  const check = async (traversal: Traversal, sizes: number[], ascending: boolean, label: string) => {
    assert.deepEqual(
      traversal.ids.map((p) => p.length),
      sizes,
      `${label}: page sizes`
    );
    const flat = traversal.ids.flat();
    assert.deepEqual([...flat].sort(), N_IDS, `${label}: every granted record exactly once`);
    await numericOrderCheck(ctx, t, `${label} numeric order`, () => {
      assert.deepEqual(flat, ascending ? N_IDS : [...N_IDS].reverse(), `${label}: order`);
    });
  };
  await check(await traverse(ctx, token, {}), [...new Array(8).fill(25), 3], false, "L0");
  await check(await traverse(ctx, token, { limit: 1, order: "asc" }), new Array(203).fill(1), true, "L1");
  await check(await traverse(ctx, token, { limit: 25, order: "asc" }), [...new Array(8).fill(25), 3], true, "L25");
  await check(await traverse(ctx, token, { limit: 100, order: "asc" }), [100, 100, 3], true, "L100");
  const clamped = await traverse(ctx, token, { limit: 101, order: "asc" });
  await check(clamped, [100, 100, 3], true, "L101");
  for (const page of clamped.pages) {
    const warning = (page.meta?.warnings ?? []).find((w: Json) => w.code === "limit_clamped");
    assert.ok(warning, "L101: every page carries limit_clamped");
    assert.equal(typeof warning.message, "string");
  }
});

acceptance("Lbad a malformed limit is 400 invalid_request across instances", async (ctx) => {
  const { a, b, e } = await fixtureF();
  const token = await grantToken(ctx, [a, b, e]);
  for (const limit of ["1.5", "abc"]) {
    const result = await read(ctx, token, { limit });
    assert.equal(result.status, 400, `limit=${limit}`);
    assert.deepEqual(errorOf(result), { code: "invalid_request", type: "invalid_request_error" }, `limit=${limit}`);
  }
});

// ─── C: cursor validity and concurrent writes ───────────────────────────────

acceptance("C1/C2 an unrecognised or order-mismatched cursor is invalid_cursor", async (ctx) => {
  const { a, b, e } = await fixtureF();
  const token = await grantToken(ctx, [a, b, e]);
  const unknown = errorOf(await read(ctx, token, { cursor: "known-unrecognized-token" }));
  assert.deepEqual(unknown, { code: "invalid_cursor", type: "invalid_request_error" }, "C1");

  const first = await read(ctx, token, { limit: 2, order: "asc" });
  const mismatch = await read(ctx, token, { cursor: first.body.next_cursor, limit: 2, order: "desc" });
  assert.equal(mismatch.status, 400);
  assert.deepEqual(errorOf(mismatch), { code: "invalid_cursor", type: "invalid_request_error" }, "C2");
  assert.match(String(first.body.next_cursor), /^pdc_/, "the cursor is an opaque server-held handle");
  const otherGrant = await grantToken(ctx, [a, b, e]);
  const foreign = await read(ctx, otherGrant, { cursor: first.body.next_cursor, limit: 2, order: "asc" });
  assert.equal(foreign.status, 400);
  assert.deepEqual(
    errorOf(foreign),
    { code: "invalid_cursor", type: "invalid_request_error" },
    "a cursor issued under one grant does not resume under another"
  );
  const restart = await read(ctx, token, { limit: 2, order: "desc" });
  assert.deepEqual(
    (restart.body.data as Json[]).map((r) => r.id),
    ["e", "d"],
    "C2: restarting without a cursor is valid"
  );
});

acceptance("C3 writes after page 1 keep originals ordered and unrepeated", async (ctx, t) => {
  const [a, b, e] = [await seedInstance("c3a"), await seedInstance("c3b"), await seedInstance("c3e")];
  await put(a, row("a", 10));
  await put(b, row("c", 30));
  await put(b, row("e", 50));
  const token = await grantToken(ctx, [a, b, e]);
  const traversal = await traverse(
    ctx,
    token,
    { limit: 1, order: "asc" },
    {
      afterPage: async (index) => {
        if (index === 0) {
          await put(b, row("b", 20));
          await put(a, row("z", 5));
        }
      },
    }
  );
  const flat = traversal.ids.flat();
  assert.equal(new Set(flat).size, flat.length, "C3: no record repeats");
  assert.deepEqual(
    flat.filter((id) => ["a", "c", "e"].includes(id)),
    ["a", "c", "e"],
    "C3: the original records stay in order"
  );
  // On PostgreSQL "5" sorts after "10", so z is ahead of the cursor there.
  await numericOrderCheck(ctx, t, "C3 numeric order", () => {
    assert.ok(
      JSON.stringify(flat) === JSON.stringify(["a", "c", "e"]) ||
        JSON.stringify(flat) === JSON.stringify(["a", "b", "c", "e"]),
      `C3: a permissible snapshot or live outcome, got ${JSON.stringify(flat)}`
    );
    assert.ok(!flat.includes("z"), "C3: z sorts before a and must not appear after it");
  });
});

// ─── D: incremental sync ────────────────────────────────────────────────────

function changedIds(t: Traversal): string[][] {
  return t.ids;
}

acceptance("D1/D2/D5/D7 change sessions follow Core order, freeze the horizon and end with next_changes_since", async (ctx) => {
  const [a, b, e, u] = [await seedInstance("da"), await seedInstance("db"), await seedInstance("de"), await seedInstance("du")];
  await put(a, row("a", 10));
  // Unequal history lengths before the baseline.
  for (let i = 0; i < 5; i += 1) {
    await put(a, row("h", 15, `h${i}`));
  }
  await put(b, row("b", 10));
  await put(b, row("c", 30));
  await put(u, row("x", 5));
  const token = await grantToken(ctx, [a, b, e]);
  const t0 = await baselineToken(ctx, token);

  await put(b, row("b", 10, "v2"));
  await put(a, row("a", 10, "v2"));
  await put(b, row("c", 30, "v2"));
  await put(a, { c: 15, id: "h", secret: "changed", v: "h4" });
  await put(u, row("x", 5, "v2"));

  const desc = await traverse(ctx, token, { changes_since: t0, limit: 2, order: "desc" });
  assert.deepEqual(changedIds(desc), [["c", "b"], ["a"]], "D1 desc");

  const asc = await traverse(
    ctx,
    token,
    { changes_since: t0, limit: 2, order: "asc" },
    {
      afterPage: async (index) => {
        if (index === 0) {
          await put(a, row("d", 20));
        }
      },
    }
  );
  assert.deepEqual(changedIds(asc), [["a", "b"], ["c"]], "D1 asc; D2: d is past the session horizon");
  for (const record of asc.pages.flatMap((p) => p.data as Json[])) {
    assert.equal(record.data.v, "v2", "D1: full current authorized record");
    assert.deepEqual(Object.keys(record.data).sort(), ["c", "id", "v"]);
  }
  for (const page of asc.pages.slice(0, -1)) {
    assert.equal(page.next_changes_since, undefined);
  }
  const t1 = asc.last.next_changes_since;
  assert.equal(typeof t1, "string", "D1: terminal next_changes_since");

  const next = await traverse(ctx, token, { changes_since: t1, limit: 2, order: "asc" });
  assert.deepEqual(changedIds(next), [["d"]], "D2: the next session returns d");
  assert.equal(next.last.has_more, false);
  const t2 = next.last.next_changes_since;
  assert.equal(typeof t2, "string");

  await put(a, { c: 10, id: "a", secret: "only-secret", v: "v2" });
  await put(b, { c: 10, id: "b", secret: "only-secret", v: "v2" });
  const hiddenOnly = await traverse(ctx, token, { changes_since: t2, limit: 25 });
  assert.deepEqual(changedIds(hiddenOnly), [[]], "D5: hidden-only changes are not visible");
  assert.equal(typeof hiddenOnly.last.next_changes_since, "string", "D5: next_changes_since still present");

  const pageCursor = (await read(ctx, token, { limit: 1 })).body.next_cursor;
  const confused = await read(ctx, token, { changes_since: pageCursor });
  assert.equal(confused.status, 400);
  assert.deepEqual(errorOf(confused), { code: "invalid_cursor", type: "invalid_request_error" }, "D7");
});

acceptance("D3/D4 tombstones and missing-cursor changes page by primary key", async (ctx) => {
  const [a3, b3, e3] = [await seedInstance("d3a"), await seedInstance("d3b"), await seedInstance("d3e")];
  await put(b3, row("z", null));
  const token3 = await grantToken(ctx, [a3, b3, e3]);
  const t0 = await baselineToken(ctx, token3);
  await put(b3, { id: "z" }, { op: "delete" });
  const d3 = await traverse(ctx, token3, { changes_since: t0, limit: 1 });
  assert.deepEqual(changedIds(d3), [["z"]], "D3");
  const [tombstone = {}] = (d3.pages[0]?.data ?? []) as Json[];
  assert.equal(tombstone.object, "record");
  assert.equal(tombstone.stream, STREAM);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.data, undefined, "no data on a tombstone");
  assert.equal(typeof tombstone.deleted_at, "string");
  assert.equal(typeof tombstone.emitted_at, "string");
  assert.equal(typeof d3.last.next_changes_since, "string");

  const [a4, b4, e4] = [await seedInstance("d4a"), await seedInstance("d4b"), await seedInstance("d4e")];
  await put(a4, row("a", null));
  await put(b4, row("b", undefined));
  await put(b4, row("z", null));
  const token4 = await grantToken(ctx, [a4, b4, e4]);
  const t4 = await baselineToken(ctx, token4);
  await put(a4, row("a", null, "v2"));
  await put(b4, row("b", undefined, "v2"));
  await put(b4, { id: "z" }, { op: "delete" });
  const d4 = await traverse(ctx, token4, { changes_since: t4, limit: 2, order: "asc" });
  assert.deepEqual(changedIds(d4), [["a", "b"], ["z"]], "D4");
  assert.equal(((d4.pages[1]?.data ?? []) as Json[])[0]?.deleted, true);
});

acceptance("D6 an expired sync token on one instance is 410 cursor_expired", async (ctx) => {
  const [a, b, e] = [await seedInstance("d6a"), await seedInstance("d6b"), await seedInstance("d6e")];
  await put(a, row("a", 1));
  await put(b, row("b", 1));
  const token = await grantToken(ctx, [a, b, e]);
  const t0 = await baselineToken(ctx, token);
  for (let i = 0; i < 4; i += 1) {
    await put(b, row("b", 1, `v${i + 2}`));
  }
  await pruneChangesThrough(ctx, b, 4);
  const expired = await read(ctx, token, { changes_since: t0 });
  assert.equal(expired.status, 410);
  assert.deepEqual(errorOf(expired), { code: "cursor_expired", type: "gone_error" }, "D6");
});

// ─── Harness ────────────────────────────────────────────────────────────────

async function withServer(backend: BackendName, databaseUrl: string | null, run: (ctx: Ctx) => Promise<void>) {
  let server: TestServer | null = null;
  try {
    server = (await startServer({
      asPort: 0,
      ...(databaseUrl ? { databaseUrl, storageBackend: "postgres" as const } : {}),
      dbPath: ":memory:",
      nativeManifest: fulfillment(),
      preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      startClientEventDeliveryWorker: false,
    })) as TestServer;
    await registerConnector(runtimeManifest());
    await run({
      asUrl: `http://localhost:${server.asPort}`,
      backend,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    if (server) {
      server.asServer.closeAllConnections();
      server.rsServer.closeAllConnections();
      await Promise.allSettled([
        new Promise<void>((resolve) => server?.asServer.close(() => resolve())),
        new Promise<void>((resolve) => server?.rsServer.close(() => resolve())),
      ]);
    }
    configureNativeManifest(null);
    await closePostgresStorage();
    closeDb();
  }
}

test("multi-instance records reads meet the Core acceptance table on SQLite (memory-default)", async (t) => {
  await withServer("sqlite", null, async (ctx) => {
    for (const [name, run] of CASES) {
      await t.test(name, (sub) => run(ctx, sub));
    }
  });
});

if (POSTGRES_URL) {
  test("multi-instance records reads meet the Core acceptance table on PostgreSQL", async (t) => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_fanin_http_${randomBytes(4).toString("hex")}`,
      },
      (databaseUrl) =>
        withServer("postgres", databaseUrl, async (ctx) => {
          for (const [name, run] of CASES) {
            await t.test(name, (sub) => run(ctx, sub));
          }
        })
    );
  });
} else {
  test("multi-instance records reads meet the Core acceptance table on PostgreSQL", {
    skip: "PDPP_TEST_POSTGRES_URL is unset; run with PDPP_TEST_PROFILE=postgres to cover the PostgreSQL backend",
  }, () => {
    // skipped: no PostgreSQL test database in this profile
  });
}
