// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Core list-records conformance for a grant that lists more than one
 * instance handle (Core §7 StreamGrant `instance_ids`; §8 List records).
 *
 * Covers the multi-binding fan-in defects D2-D5 from the 2026-10-17
 * RI-vs-Core review, plus the missing-cursor DESC ordering defect:
 *
 *   - D2: `limit` bounds the combined page (default 25, max 100).
 *   - D3: records follow the `(cursor_field, primary_key)` order the same
 *     backend uses for one connection; missing cursor values sort last in
 *     both directions.
 *   - D4: a truncated page carries `next_cursor`, and following it with only
 *     Core parameters visits every record exactly once.
 *   - D5: `changes_since` works across connections, pages stay anchored to the
 *     horizon chosen on page 1, and the terminal page carries a
 *     `next_changes_since` that keeps each connection's progress separately.
 *
 * Every case runs on SQLite (memory-default) and, when
 * PDPP_TEST_POSTGRES_URL is set, on a temporary PostgreSQL database. The
 * ordering oracle is the backend itself: the same rows stored under one
 * connection and read through the single-binding path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord, queryRecords, queryRecordsAcrossBindings } from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

type Json = Record<string, unknown>;
interface ListPage {
  data: Json[];
  has_more: boolean;
  meta?: { warnings?: Json[]; [key: string]: unknown };
  next_changes_since?: string;
  next_cursor?: string | null;
  object: string;
}
interface Binding {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
}
interface Backend {
  name: "postgres" | "sqlite";
  pruneChangesThrough(instanceId: string, stream: string, version: number): Promise<void>;
  seedInstance(connectorId: string, instanceId: string, displayName: string): Promise<void>;
}

const EVENTS = "events";
const NOTES = "notes";
const COUNTERS = "counters";

function manifestFor(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Fan-in Core conformance",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: "occurred_at",
        cursor_field: "occurred_at",
        name: EVENTS,
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            occurred_at: { format: "date-time", type: "string" },
            secret: { type: "string" },
            title: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        cursor_field: "updated_at",
        name: NOTES,
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            updated_at: { format: "date-time", type: ["string", "null"] },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        cursor_field: "seq",
        name: COUNTERS,
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, seq: { type: "integer" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

const STREAM_FIELDS: Record<string, string[]> = {
  [COUNTERS]: ["id", "seq"],
  [EVENTS]: ["id", "occurred_at", "title", "secret"],
  [NOTES]: ["id", "title", "updated_at"],
};

let caseCounter = 0;

interface Fixture {
  bindings: Binding[];
  connectorId: string;
  grant: (stream: string, opts?: { fields?: string[]; instances?: string[] }) => Json;
  ingest: (instanceId: string, stream: string, data: Json, opts?: { emittedAt?: string; op?: string }) => Promise<void>;
  instance: (label: string) => string;
  manifest: ReturnType<typeof manifestFor>;
}

// One connector per case keeps cases independent inside one database.
async function fixture(backend: Backend, labels: string[]): Promise<Fixture> {
  caseCounter += 1;
  const connectorId = `fanin-core-${backend.name}-${caseCounter}`;
  const manifest = manifestFor(connectorId);
  await registerConnector(manifest);
  const instance = (label: string) => `cin_${connectorId.replaceAll("-", "_")}_${label}`;
  const bindings: Binding[] = [];
  for (const label of labels) {
    const instanceId = instance(label);
    await backend.seedInstance(connectorId, instanceId, `Account ${label}`);
    bindings.push({ connectorId, connectorInstanceId: instanceId, displayName: `Account ${label}` });
  }
  return {
    bindings,
    connectorId,
    grant: (stream, opts = {}) => ({
      streams: [
        {
          fields: opts.fields ?? STREAM_FIELDS[stream],
          instance_ids: opts.instances ?? bindings.map((b) => b.connectorInstanceId),
          name: stream,
        },
      ],
    }),
    ingest: async (instanceId, stream, data, opts = {}) => {
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: instanceId },
        {
          data: opts.op === "delete" ? null : data,
          emitted_at: opts.emittedAt ?? "2026-10-01T00:00:00.000Z",
          key: String(data.id),
          ...(opts.op ? { op: opts.op } : {}),
          stream,
        } as never
      );
    },
    instance,
    manifest,
  };
}

function fanIn(f: Fixture, bindings: Binding[], stream: string, grant: Json, params: Json): Promise<ListPage> {
  return queryRecordsAcrossBindings(
    bindings as never,
    stream,
    grant as never,
    params as never,
    f.manifest as never
  ) as unknown as Promise<ListPage>;
}

function single(f: Fixture, instanceId: string, stream: string, params: Json): Promise<ListPage> {
  return queryRecords(
    { connector_id: f.connectorId, connector_instance_id: instanceId },
    stream,
    f.grant(stream, { instances: [instanceId] }) as never,
    params as never,
    f.manifest as never
  ) as unknown as Promise<ListPage>;
}

async function traverse(
  read: (params: Json) => Promise<ListPage>,
  params: Json,
  { maxPages = 50, between }: { maxPages?: number; between?: (pageIndex: number) => Promise<void> } = {}
): Promise<ListPage[]> {
  const pages: ListPage[] = [];
  let next: Json = params;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await read(next);
    pages.push(page);
    if (!page.has_more) {
      assert.equal(page.next_cursor ?? undefined, undefined, "a final page must not carry next_cursor");
      return pages;
    }
    assert.equal(typeof page.next_cursor, "string", "has_more=true must carry next_cursor (Core §4, §8)");
    if (between) {
      await between(i);
    }
    const { changes_since: _ignored, ...rest } = next;
    next = { ...rest, cursor: page.next_cursor };
  }
  assert.fail(`pagination did not terminate within ${maxPages} pages`);
}

// `connection_id` + record id is the record identity under fan-in.
function identities(pages: ListPage[]): string[] {
  return pages.flatMap((page) => page.data.map((r) => `${String(r.connection_id)}/${String(r.id)}`));
}

function ids(pages: ListPage[]): string[] {
  return pages.flatMap((page) => page.data.map((r) => String(r.id)));
}

function assertNoDuplicates(values: string[], message: string): void {
  assert.equal(new Set(values).size, values.length, `${message}: ${JSON.stringify(values)}`);
}

function iso(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
}

async function expectCode(promise: Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code, `${message}: ${String((err as Error).message)}`);
    return true;
  });
}

// Store `rows` under a third connection and read them through the
// single-binding path: that is the backend's own (cursor_field, primary_key)
// order, which the fan-in merge must reproduce.
async function singleBindingOracle(
  backend: Backend,
  f: Fixture,
  stream: string,
  rows: Json[],
  order: "asc" | "desc"
): Promise<string[]> {
  const oracleInstance = f.instance(`oracle_${order}`);
  await backend.seedInstance(f.connectorId, oracleInstance, "Oracle");
  for (const row of rows) {
    await f.ingest(oracleInstance, stream, row);
  }
  const pages = await traverse((p) => single(f, oracleInstance, stream, p), { limit: 100, order });
  return ids(pages);
}

type Case = (backend: Backend) => Promise<void>;

const CASES: Array<[string, Case]> = [];
function fanInCase(name: string, run: Case): void {
  CASES.push([name, run]);
}

// ─── D2/D3/D4: records list ─────────────────────────────────────────────────

fanInCase("D3/D4 interleaved connections page in global order with a selector-free next_cursor", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  const [a, b] = f.bindings.map((x) => x.connectorInstanceId) as [string, string];
  const rows: Array<[string, Json]> = [
    [a, { id: "a1", occurred_at: iso(1), title: "a1" }],
    [b, { id: "b2", occurred_at: iso(2), title: "b2" }],
    [a, { id: "a3", occurred_at: iso(3), title: "a3" }],
    [b, { id: "b4", occurred_at: iso(4), title: "b4" }],
    [a, { id: "a5", occurred_at: iso(5), title: "a5" }],
    [b, { id: "b6", occurred_at: iso(6), title: "b6" }],
  ];
  for (const [instanceId, data] of rows) {
    await f.ingest(instanceId, EVENTS, data);
  }
  const grant = f.grant(EVENTS);
  for (const order of ["asc", "desc"] as const) {
    const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, grant, p), { limit: 2, order });
    const expected =
      order === "asc" ? ["a1", "b2", "a3", "b4", "a5", "b6"] : ["b6", "a5", "b4", "a3", "b2", "a1"];
    assert.deepEqual(ids(pages), expected, `${order} fan-in order`);
    assert.deepEqual(
      pages.map((p) => p.data.length),
      [2, 2, 2],
      `${order}: every page holds exactly limit records`
    );
    // Resolver order and completion order must not change the traversal.
    const reversed = await traverse((p) => fanIn(f, [...f.bindings].reverse(), EVENTS, grant, p), {
      limit: 2,
      order,
    });
    assert.deepEqual(ids(reversed), expected, `${order}: binding enumeration order must not matter`);
    assert.deepEqual(
      reversed.map((p) => p.next_cursor ?? null),
      pages.map((p) => p.next_cursor ?? null),
      `${order}: the same position yields the same cursor`
    );
    assert.deepEqual(
      ids(pages),
      await singleBindingOracle(
        backend,
        f,
        EVENTS,
        rows.map(([, data]) => data),
        order
      ),
      `${order}: fan-in order equals the backend's single-binding order`
    );
  }
});

fanInCase("D2/D4 two exhausted 80-record connections page as 100 then 60 at limit=100", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (const binding of f.bindings) {
    for (let i = 0; i < 80; i += 1) {
      await f.ingest(binding.connectorInstanceId, EVENTS, {
        id: `${binding.connectorInstanceId.slice(-1)}${String(i).padStart(3, "0")}`,
        occurred_at: iso(i),
        title: "t",
      });
    }
  }
  const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, f.grant(EVENTS), p), { limit: 100 });
  assert.deepEqual(
    pages.map((p) => p.data.length),
    [100, 60]
  );
  assert.equal(pages[0]?.has_more, true, "both local pages were exhausted, but 60 records remain globally");
  const all = identities(pages);
  assert.equal(all.length, 160);
  assertNoDuplicates(all, "no record may repeat");
  for (const page of pages) {
    const warnings = (page.meta?.warnings ?? []).map((w) => w.code);
    assert.ok(!warnings.includes("partial_results"), "exhaustive continuation needs no partial_results warning");
  }
});

fanInCase("D2/D4 150+150 records traverse as three 100-record pages with every identity once", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (const binding of f.bindings) {
    for (let i = 0; i < 150; i += 1) {
      // Identical ids and cursor values across connections: identity is (connection, id).
      await f.ingest(binding.connectorInstanceId, EVENTS, { id: `r${String(i).padStart(3, "0")}`, occurred_at: iso(i) });
    }
  }
  const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, f.grant(EVENTS), p), {
    limit: 100,
    order: "asc",
  });
  assert.deepEqual(
    pages.map((p) => p.data.length),
    [100, 100, 100]
  );
  const all = identities(pages);
  assertNoDuplicates(all, "no identity may repeat");
  assert.equal(all.length, 300);
  // Ties on (cursor, pk) are broken by connection, so each pair is adjacent.
  const flat = pages.flatMap((p) => p.data);
  for (let i = 0; i < flat.length; i += 2) {
    assert.equal(flat[i]?.id, flat[i + 1]?.id, `tied records must be adjacent at ${i}`);
    assert.notEqual(flat[i]?.connection_id, flat[i + 1]?.connection_id);
  }
});

fanInCase("D2 default and clamped limits bound the combined page with one limit_clamped warning", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (const binding of f.bindings) {
    for (let i = 0; i < 70; i += 1) {
      await f.ingest(binding.connectorInstanceId, EVENTS, { id: `r${String(i).padStart(3, "0")}`, occurred_at: iso(i) });
    }
  }
  const grant = f.grant(EVENTS);
  const byDefault = await fanIn(f, f.bindings, EVENTS, grant, {});
  assert.equal(byDefault.data.length, 25, "omitted limit defaults to 25 records in total");
  assert.equal(byDefault.has_more, true);

  const clamped = await fanIn(f, f.bindings, EVENTS, grant, { limit: 500 });
  assert.equal(clamped.data.length, 100, "limit=500 is clamped to 100 records in total");
  const clampWarnings = (clamped.meta?.warnings ?? []).filter((w) => w.code === "limit_clamped");
  assert.equal(clampWarnings.length, 1, "exactly one limit_clamped warning");

  const exact = await fanIn(f, f.bindings, EVENTS, grant, { limit: 100 });
  assert.equal(exact.data.length, 100);
  assert.ok(!(exact.meta?.warnings ?? []).some((w) => w.code === "limit_clamped"), "limit=100 is not clamped");
});

const NULLABLE_ROWS: Array<[string, Json]> = [
  ["a", { id: "a_present_old", title: "x", updated_at: "2026-01-01T00:00:00.000Z" }],
  ["a", { id: "a_null", title: "x", updated_at: null }],
  ["a", { id: "a_missing", title: "x" }],
  ["b", { id: "b_present_new", title: "x", updated_at: "2026-03-01T00:00:00.000Z" }],
  ["b", { id: "b_null", title: "x", updated_at: null }],
  ["b", { id: "b_missing", title: "x" }],
  ["b", { id: "b_present_mid", title: "x", updated_at: "2026-02-01T00:00:00.000Z" }],
];

fanInCase("D3 missing cursor values sort after present values in both directions across connections", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (const [label, data] of NULLABLE_ROWS) {
    await f.ingest(f.instance(label), NOTES, data);
  }
  const grant = f.grant(NOTES);
  const expected = {
    asc: ["a_present_old", "b_present_mid", "b_present_new", "a_missing", "a_null", "b_missing", "b_null"],
    desc: ["b_present_new", "b_present_mid", "a_present_old", "b_null", "b_missing", "a_null", "a_missing"],
  };
  for (const order of ["asc", "desc"] as const) {
    for (const limit of [1, 2, 3]) {
      const pages = await traverse((p) => fanIn(f, f.bindings, NOTES, grant, p), { limit, order });
      assert.deepEqual(ids(pages), expected[order], `${order} limit=${limit}`);
      assert.ok(
        pages.every((p) => p.data.length <= limit),
        `${order} limit=${limit}: no page exceeds limit`
      );
    }
  }
});

fanInCase("extra: a single connection orders missing cursor values last in DESC", async (backend) => {
  const f = await fixture(backend, ["a"]);
  const [a] = f.bindings.map((x) => x.connectorInstanceId) as [string];
  for (const [, data] of NULLABLE_ROWS) {
    await f.ingest(a, NOTES, data);
  }
  for (const limit of [1, 2, 3, 10]) {
    const desc = await traverse((p) => single(f, a, NOTES, p), { limit, order: "desc" });
    assert.deepEqual(
      ids(desc),
      ["b_present_new", "b_present_mid", "a_present_old", "b_null", "b_missing", "a_null", "a_missing"],
      `desc limit=${limit}: present values first, then the missing bucket in descending key order`
    );
    const asc = await traverse((p) => single(f, a, NOTES, p), { limit, order: "asc" });
    assert.deepEqual(
      ids(asc),
      ["a_present_old", "b_present_mid", "b_present_new", "a_missing", "a_null", "b_missing", "b_null"],
      `asc limit=${limit}: present values first, then the missing bucket in ascending key order`
    );
  }
});

fanInCase("D3 numeric cursor fan-in reproduces the backend's single-binding order", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  const rows: Array<[string, Json]> = [
    ["a", { id: "a9", seq: 9 }],
    ["b", { id: "b10", seq: 10 }],
    ["a", { id: "a100", seq: 100 }],
    ["b", { id: "b2", seq: 2 }],
    ["a", { id: "a20", seq: 20 }],
  ];
  for (const [label, data] of rows) {
    await f.ingest(f.instance(label), COUNTERS, data);
  }
  for (const order of ["asc", "desc"] as const) {
    const pages = await traverse((p) => fanIn(f, f.bindings, COUNTERS, f.grant(COUNTERS), p), { limit: 2, order });
    assert.deepEqual(
      ids(pages),
      await singleBindingOracle(
        backend,
        f,
        COUNTERS,
        rows.map(([, d]) => d),
        order
      ),
      `${order}: fan-in order equals the single-binding order`
    );
  }
});

fanInCase("D4 a connection that contributes nothing to early pages is still fully visited", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  // In ascending order every b record precedes every a record.
  for (let i = 0; i < 5; i += 1) {
    await f.ingest(f.instance("a"), EVENTS, { id: `a${i}`, occurred_at: iso(100 + i) });
    await f.ingest(f.instance("b"), EVENTS, { id: `b${i}`, occurred_at: iso(i) });
  }
  const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, f.grant(EVENTS), p), { limit: 3, order: "asc" });
  assert.deepEqual(ids(pages), ["b0", "b1", "b2", "b3", "b4", "a0", "a1", "a2", "a3", "a4"]);
  assert.deepEqual(
    pages.map((p) => p.data.length),
    [3, 3, 3, 1]
  );
});

fanInCase("D3 ordering holds when the grant and request omit the cursor field", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  const rows: Array<[string, Json]> = [
    ["a", { id: "z1", occurred_at: iso(1), secret: "s", title: "1" }],
    ["b", { id: "y2", occurred_at: iso(2), secret: "s", title: "2" }],
    ["a", { id: "x3", occurred_at: iso(3), secret: "s", title: "3" }],
    ["b", { id: "w4", occurred_at: iso(4), secret: "s", title: "4" }],
  ];
  for (const [label, data] of rows) {
    await f.ingest(f.instance(label), EVENTS, data);
  }
  const grant = f.grant(EVENTS, { fields: ["id", "title"] });
  const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, grant, p), { limit: 1, order: "asc" });
  assert.deepEqual(ids(pages), ["z1", "y2", "x3", "w4"]);
  for (const record of pages.flatMap((p) => p.data)) {
    assert.deepEqual(Object.keys(record.data as Json).sort(), ["id", "title"], "no ungranted field in data");
  }
});

fanInCase("D4 cursors are bound to the binding set, order and token space", async (backend) => {
  const f = await fixture(backend, ["a", "b", "c"]);
  for (const binding of f.bindings) {
    for (let i = 0; i < 3; i += 1) {
      await f.ingest(binding.connectorInstanceId, EVENTS, { id: `r${i}`, occurred_at: iso(i) });
    }
  }
  const grant = f.grant(EVENTS);
  const two = f.bindings.slice(0, 2);
  const page = await fanIn(f, two, EVENTS, grant, { limit: 2, order: "asc" });
  const fanInCursor = String(page.next_cursor);
  await expectCode(
    fanIn(f, f.bindings, EVENTS, grant, { cursor: fanInCursor, limit: 2, order: "asc" }),
    "invalid_cursor",
    "a cursor minted for two connections must not resume over three"
  );
  await expectCode(
    fanIn(f, two, EVENTS, grant, { cursor: fanInCursor, limit: 2, order: "desc" }),
    "invalid_cursor",
    "page cursors are direction-bound (Core §8)"
  );
  await expectCode(
    fanIn(f, two, EVENTS, grant, { cursor: "not-a-cursor", limit: 2 }),
    "invalid_cursor",
    "malformed cursor"
  );
  const singlePage = await single(f, f.bindings[0]?.connectorInstanceId ?? "", EVENTS, { limit: 1, order: "asc" });
  await expectCode(
    fanIn(f, two, EVENTS, grant, { cursor: singlePage.next_cursor, limit: 2, order: "asc" }),
    "invalid_cursor",
    "a single-connection cursor must not be replayed against every connection"
  );
  await expectCode(
    single(f, f.bindings[0]?.connectorInstanceId ?? "", EVENTS, { cursor: fanInCursor, limit: 2, order: "asc" }),
    "invalid_cursor",
    "a fan-in cursor must not be read as a single-connection cursor"
  );
  await expectCode(
    fanIn(f, two, EVENTS, grant, { changes_since: "beginning", cursor: fanInCursor }),
    "invalid_request",
    "cursor plus changes_since is an unsupported query shape (Core §8)"
  );
});

fanInCase("D4 writes between pages never duplicate or reorder records", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (let i = 0; i < 4; i += 1) {
    await f.ingest(f.instance("a"), EVENTS, { id: `a${i}`, occurred_at: iso(10 * i + 1) });
    await f.ingest(f.instance("b"), EVENTS, { id: `b${i}`, occurred_at: iso(10 * i + 2) });
  }
  const pages = await traverse((p) => fanIn(f, f.bindings, EVENTS, f.grant(EVENTS), p), { limit: 3, order: "asc" }, {
    between: async (pageIndex) => {
      if (pageIndex !== 0) {
        return;
      }
      // After page 1 (a0,b0,a1 at minutes 1,2,11):
      // - behind the cursor in b's own range: not visited, like one connection;
      await f.ingest(f.instance("b"), EVENTS, { id: "b_behind", occurred_at: iso(5) });
      // - ahead of the cursor: visited once, in order.
      await f.ingest(f.instance("a"), EVENTS, { id: "a_ahead", occurred_at: iso(25) });
    },
  });
  const seen = ids(pages);
  assertNoDuplicates(seen, "no record may repeat");
  assert.deepEqual(seen, ["a0", "b0", "a1", "b1", "a2", "b2", "a_ahead", "a3", "b3"]);
});

// ─── D5: changes_since across connections ───────────────────────────────────

function changes(f: Fixture, stream: string, params: Json, grant = f.grant(stream)): Promise<ListPage> {
  return fanIn(f, f.bindings, stream, grant, params);
}

async function syncSession(
  f: Fixture,
  stream: string,
  since: string,
  limit: number,
  between?: (pageIndex: number) => Promise<void>
): Promise<{ next: string; pages: ListPage[] }> {
  const pages = await traverse((p) => changes(f, stream, p), { changes_since: since, limit }, between ? { between } : {});
  for (const page of pages.slice(0, -1)) {
    assert.equal(page.next_changes_since, undefined, "a non-terminal page must not hand out a sync token");
    assert.ok(page.data.length <= limit, "no page exceeds limit");
  }
  const last = pages.at(-1);
  assert.equal(typeof last?.next_changes_since, "string", "the terminal page MUST carry next_changes_since");
  return { next: String(last?.next_changes_since), pages };
}

fanInCase("D5 changes_since=beginning pages across connections and ends with next_changes_since", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  for (let i = 0; i < 3; i += 1) {
    await f.ingest(f.instance("a"), EVENTS, { id: `a${i}`, occurred_at: iso(i), title: "v1" });
    await f.ingest(f.instance("b"), EVENTS, { id: `b${i}`, occurred_at: iso(i), title: "v1" });
  }
  const { pages, next } = await syncSession(f, EVENTS, "beginning", 2);
  const seen = identities(pages);
  assertNoDuplicates(seen, "no change may repeat");
  assert.equal(seen.length, 6);
  assert.deepEqual(
    pages.map((p) => p.data.length),
    [2, 2, 2]
  );
  const empty = await changes(f, EVENTS, { changes_since: next, limit: 2 });
  assert.deepEqual(empty.data, [], "nothing changed since the terminal token");
  assert.equal(empty.has_more, false);
  assert.equal(typeof empty.next_changes_since, "string", "an empty terminal page still carries next_changes_since");
});

fanInCase("D5 pages stay anchored to the page-1 horizon; later writes surface next session", async (backend) => {
  const f = await fixture(backend, ["a", "b", "c"]);
  for (let i = 0; i < 2; i += 1) {
    await f.ingest(f.instance("a"), EVENTS, { id: `a${i}`, occurred_at: iso(i), title: "v1" });
    await f.ingest(f.instance("b"), EVENTS, { id: `b${i}`, occurred_at: iso(i), title: "v1" });
  }
  // c is empty when the session starts.
  const { pages, next } = await syncSession(f, EVENTS, "beginning", 1, async (pageIndex) => {
    if (pageIndex !== 0) {
      return;
    }
    await f.ingest(f.instance("a"), EVENTS, { id: "a_late", occurred_at: iso(50), title: "late" });
    await f.ingest(f.instance("b"), EVENTS, { id: "b1", occurred_at: iso(1), title: "v2-after-horizon" });
    await f.ingest(f.instance("c"), EVENTS, { id: "c_late", occurred_at: iso(51), title: "late" });
  });
  const firstSession = pages.flatMap((p) => p.data);
  assert.deepEqual(firstSession.map((r) => r.id).sort(), ["a0", "a1", "b0", "b1"]);
  const b1 = firstSession.find((r) => r.id === "b1");
  assert.equal((b1?.data as Json | undefined)?.title, "v1", "a record updated after the horizon is served at its horizon state");

  const second = await syncSession(f, EVENTS, next, 10);
  const secondSession = second.pages.flatMap((p) => p.data);
  assert.deepEqual(secondSession.map((r) => r.id).sort(), ["a_late", "b1", "c_late"]);
  assert.equal((secondSession.find((r) => r.id === "b1")?.data as Json | undefined)?.title, "v2-after-horizon");
});

fanInCase("D5 a lagging connection keeps its own progress in next_changes_since", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  // a advances its version counter much further than b.
  for (let i = 0; i < 30; i += 1) {
    await f.ingest(f.instance("a"), EVENTS, { id: "a_hot", occurred_at: iso(1), title: `v${i}` });
  }
  await f.ingest(f.instance("b"), EVENTS, { id: "b_cold", occurred_at: iso(1), title: "v0" });
  const first = await syncSession(f, EVENTS, "beginning", 10);
  assert.deepEqual(identities(first.pages).length, 2);

  await f.ingest(f.instance("b"), EVENTS, { id: "b_cold", occurred_at: iso(1), title: "v1" });
  await f.ingest(f.instance("a"), EVENTS, { id: "a_hot", occurred_at: iso(1), title: "v-final" });
  const second = await syncSession(f, EVENTS, first.next, 10);
  const titles = Object.fromEntries(second.pages.flatMap((p) => p.data).map((r) => [r.id, (r.data as Json).title]));
  assert.deepEqual(titles, { a_hot: "v-final", b_cold: "v1" }, "b's next change must not be filtered by a's counter");
});

fanInCase("D5 deletions surface as tombstones from every connection", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  await f.ingest(f.instance("a"), EVENTS, { id: "a_keep", occurred_at: iso(1) });
  await f.ingest(f.instance("b"), EVENTS, { id: "b_gone", occurred_at: iso(2) });
  const first = await syncSession(f, EVENTS, "beginning", 5);
  await f.ingest(f.instance("b"), EVENTS, { id: "b_gone" }, { op: "delete" });
  const second = await syncSession(f, EVENTS, first.next, 5);
  const [tombstone, ...rest] = second.pages.flatMap((p) => p.data);
  assert.deepEqual(rest, []);
  assert.equal(tombstone?.id, "b_gone");
  assert.equal(tombstone?.deleted, true);
  assert.equal(tombstone?.data, undefined, "no data on a tombstone");
  assert.equal(typeof tombstone?.deleted_at, "string");
  assert.equal(typeof tombstone?.emitted_at, "string");
});

fanInCase("D5 change eligibility uses the grant projection on every connection", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  const grant = f.grant(EVENTS, { fields: ["id", "title"] });
  await f.ingest(f.instance("a"), EVENTS, { id: "a1", occurred_at: iso(1), secret: "s1", title: "t" });
  await f.ingest(f.instance("b"), EVENTS, { id: "b1", occurred_at: iso(1), secret: "s1", title: "t" });
  const first = await traverse((p) => changes(f, EVENTS, p, grant), { changes_since: "beginning", limit: 5 });
  const token = String(first.at(-1)?.next_changes_since);
  await f.ingest(f.instance("a"), EVENTS, { id: "a1", occurred_at: iso(1), secret: "s2", title: "t" });
  await f.ingest(f.instance("b"), EVENTS, { id: "b1", occurred_at: iso(1), secret: "s1", title: "t2" });
  const second = await traverse((p) => changes(f, EVENTS, p, grant), { changes_since: token, limit: 5 });
  assert.deepEqual(ids(second), ["b1"], "a hidden-only change must not appear");
});

fanInCase("D5 sync tokens are bound to their binding set and token space", async (backend) => {
  const f = await fixture(backend, ["a", "b", "c"]);
  for (const binding of f.bindings) {
    await f.ingest(binding.connectorInstanceId, EVENTS, { id: "r", occurred_at: iso(1) });
  }
  const grant = f.grant(EVENTS);
  const two = f.bindings.slice(0, 2);
  const session = await traverse((p) => fanIn(f, two, EVENTS, grant, p), { changes_since: "beginning", limit: 1 });
  const vector = String(session.at(-1)?.next_changes_since);
  await expectCode(
    fanIn(f, f.bindings, EVENTS, grant, { changes_since: vector }),
    "invalid_cursor",
    "a sync token for two connections must not seed three"
  );
  await expectCode(
    single(f, f.bindings[0]?.connectorInstanceId ?? "", EVENTS, { changes_since: vector }),
    "invalid_cursor",
    "a fan-in sync token must not be read as one connection's token"
  );
  const singleToken = (await single(f, f.bindings[0]?.connectorInstanceId ?? "", EVENTS, { changes_since: "beginning" }))
    .next_changes_since;
  await expectCode(
    fanIn(f, two, EVENTS, grant, { changes_since: singleToken }),
    "invalid_cursor",
    "one connection's sync token must not be copied to every connection"
  );
  await expectCode(
    fanIn(f, two, EVENTS, grant, { changes_since: String(session[0]?.next_cursor) }),
    "invalid_cursor",
    "a page cursor is not a sync token (Core §4 two cursor spaces)"
  );
  await expectCode(
    fanIn(f, two, EVENTS, grant, { cursor: vector }),
    "invalid_cursor",
    "a sync token is not a page cursor (Core §4 two cursor spaces)"
  );
});

fanInCase("D5 expired history on one connection fails the whole session with cursor_expired", async (backend) => {
  const f = await fixture(backend, ["a", "b"]);
  await f.ingest(f.instance("a"), EVENTS, { id: "a1", occurred_at: iso(1) });
  for (let i = 0; i < 4; i += 1) {
    await f.ingest(f.instance("b"), EVENTS, { id: "b1", occurred_at: iso(1), title: `v${i}` });
  }
  await backend.pruneChangesThrough(f.instance("b"), EVENTS, 3);
  await expectCode(
    changes(f, EVENTS, { changes_since: "beginning", limit: 5 }),
    "cursor_expired",
    "a lagging connection whose history is gone must not be skipped"
  );
});

// ─── Single-binding reads are unchanged ─────────────────────────────────────

// SHA-256 of the transcript below, captured on main at f926c97c2b before this
// change. Non-null cursor values only: the missing-cursor DESC order is a
// deliberate fix (see the "extra" case above).
const SINGLE_BINDING_TRANSCRIPT_SHA256: Record<Backend["name"], string> = {
  postgres: "eae494ff19f8ff68ef96c44e565ed1c4f4bdac2425b0323865225db64cf21fa2",
  sqlite: "fd3afc4e9879e446c1f7d8c135f61326d44629c3d187568043c271877a21c668",
};

fanInCase("single-binding reads through the fan-in facade are byte-identical to main", async (backend) => {
  const connectorId = `fanin-core-golden-${backend.name}`;
  const manifest = manifestFor(connectorId);
  await registerConnector(manifest);
  const instanceId = `cin_fanin_core_golden_${backend.name}`;
  await backend.seedInstance(connectorId, instanceId, "Golden");
  const binding: Binding = { connectorId, connectorInstanceId: instanceId, displayName: "Golden" };
  const f: Fixture = {
    bindings: [binding],
    connectorId,
    grant: (stream, opts = {}) => ({
      streams: [{ fields: opts.fields ?? STREAM_FIELDS[stream], instance_ids: [instanceId], name: stream }],
    }),
    ingest: async (target, stream, data, opts = {}) => {
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: target },
        {
          data: opts.op === "delete" ? null : data,
          emitted_at: opts.emittedAt ?? "2026-10-01T00:00:00.000Z",
          key: String(data.id),
          ...(opts.op ? { op: opts.op } : {}),
          stream,
        } as never
      );
    },
    instance: () => instanceId,
    manifest,
  };
  for (let i = 0; i < 5; i += 1) {
    await f.ingest(instanceId, EVENTS, { id: `g${i}`, occurred_at: iso(i), secret: "s", title: `t${i}` });
  }
  const read = (params: Json) => fanIn(f, [binding], EVENTS, f.grant(EVENTS), params);
  const transcript: unknown[] = [];
  transcript.push(await traverse(read, { limit: 2, order: "asc" }));
  transcript.push(await traverse(read, { limit: 2, order: "desc" }));
  transcript.push(await read({ count: "exact", fields: ["id", "title"], limit: 3 }));
  const firstSync = await traverse(read, { changes_since: "beginning", limit: 2 });
  transcript.push(firstSync);
  await f.ingest(instanceId, EVENTS, { id: "g1", occurred_at: iso(1), secret: "s", title: "t1-v2" }, {
    emittedAt: "2026-10-02T00:00:00.000Z",
  });
  await f.ingest(instanceId, EVENTS, { id: "g3" }, { emittedAt: "2026-10-03T00:00:00.000Z", op: "delete" });
  transcript.push(await traverse(read, { changes_since: String(firstSync.at(-1)?.next_changes_since), limit: 2 }));
  const json = JSON.stringify(transcript);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(json).digest("hex");
  assert.equal(digest, SINGLE_BINDING_TRANSCRIPT_SHA256[backend.name], `single-binding transcript changed: ${json}`);
});

// ─── Backends ───────────────────────────────────────────────────────────────

const sqliteBackend: Backend = {
  name: "sqlite",
  pruneChangesThrough(instanceId, stream, version) {
    getDb()
      .prepare("DELETE FROM record_changes WHERE connector_instance_id = ? AND stream = ? AND version <= ?")
      .run(instanceId, stream, version);
    return Promise.resolve();
  },
  async seedInstance(connectorId, instanceId, displayName) {
    await upsertInstance(createSqliteConnectorInstanceStore(), connectorId, instanceId, displayName);
  },
};

const postgresBackend: Backend = {
  name: "postgres",
  async pruneChangesThrough(instanceId, stream, version) {
    await postgresQuery(
      "DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND version <= $3",
      [instanceId, stream, version]
    );
  },
  async seedInstance(connectorId, instanceId, displayName) {
    await upsertInstance(createPostgresConnectorInstanceStore(), connectorId, instanceId, displayName);
  },
};

async function upsertInstance(
  store: { upsert: (input: never) => unknown },
  connectorId: string,
  instanceId: string,
  displayName: string
): Promise<void> {
  const now = "2026-10-01T00:00:00.000Z";
  await store.upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: instanceId },
    sourceBindingKey: instanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  } as never);
}

test("multi-binding fan-in conforms to PDPP Core on SQLite (memory-default)", async (t) => {
  initDb(":memory:");
  try {
    for (const [name, run] of CASES) {
      await t.test(name, () => run(sqliteBackend));
    }
  } finally {
    closeDb();
  }
});

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
if (POSTGRES_URL) {
  test("multi-binding fan-in conforms to PDPP Core on PostgreSQL", async (t) => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_fanin_core_${process.pid}_${Date.now().toString(36)}`,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        try {
          for (const [name, run] of CASES) {
            await t.test(name, () => run(postgresBackend));
          }
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
} else {
  test("multi-binding fan-in conforms to PDPP Core on PostgreSQL", {
    skip: "PDPP_TEST_POSTGRES_URL is unset; run with PDPP_TEST_PROFILE=postgres to cover the PostgreSQL backend",
  }, () => {
    // skipped: no PostgreSQL test database in this profile
  });
}
