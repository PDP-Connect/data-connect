// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single-connection list pagination across the null-cursor group (PDPP Core
 * §8 "Stable sort": records sort by `(cursor_field, primary_key)`, and null or
 * absent cursor values sort after present values).
 *
 * Each case pages one connection by `next_cursor` with small limits so that a
 * page boundary falls inside the null group, in both directions, and asserts
 * that every record is returned exactly once and in the order of an unpaged
 * read. The same cases run on SQLite (memory-default) and, when
 * PDPP_TEST_POSTGRES_URL is set, on a temporary PostgreSQL database.
 *
 * Two cursor shapes are covered: a nullable `date-time` string and a nullable
 * integer (single-digit values, since PostgreSQL compares `cursor_value` as
 * text). A third case mixes null, absent and empty-string cursor values and
 * also reads the stream through `changes_since`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { ingestRecord, queryRecords } from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

type Json = Record<string, unknown>;
interface ListPage {
  data: Json[];
  has_more: boolean;
  next_changes_since?: string;
  next_cursor?: string | null;
}
type Order = "asc" | "desc";
type InstanceStore = { upsert: (input: never) => unknown };

const DATED = "dated";
const RANKED = "ranked";

function manifestFor(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Null cursor pagination",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        cursor_field: "updated_at",
        name: DATED,
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            updated_at: { format: "date-time", type: ["string", "null"] },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        cursor_field: "rank",
        name: RANKED,
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, rank: { type: ["integer", "null"] } },
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

const FIELDS: Record<string, string[]> = { [DATED]: ["id", "updated_at"], [RANKED]: ["id", "rank"] };

let caseCounter = 0;

async function seedConnection(store: InstanceStore, stream: string, rows: Json[]) {
  caseCounter += 1;
  const connectorId = `null-cursor-pagination-${caseCounter}`;
  const instanceId = `cin_null_cursor_pagination_${caseCounter}`;
  const manifest = manifestFor(connectorId);
  await registerConnector(manifest);
  const now = "2026-10-01T00:00:00.000Z";
  await store.upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName: "Account",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: instanceId },
    sourceBindingKey: instanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  } as never);
  const binding = { connector_id: connectorId, connector_instance_id: instanceId };
  for (const data of rows) {
    await ingestRecord(binding, { data, emitted_at: now, key: String(data.id), stream } as never);
  }
  const grant = { streams: [{ fields: FIELDS[stream], instance_ids: [instanceId], name: stream }] };
  return (params: Json) =>
    queryRecords(binding, stream, grant as never, params as never, manifest as never) as unknown as Promise<ListPage>;
}

async function pageIds(read: (params: Json) => Promise<ListPage>, order: Order, limit: number): Promise<string[]> {
  const out: string[] = [];
  let params: Json = { limit, order };
  for (let page = 0; page < 50; page += 1) {
    const result = await read(params);
    out.push(...result.data.map((record) => String(record.id)));
    if (!result.has_more) {
      return out;
    }
    assert.equal(typeof result.next_cursor, "string", "has_more=true must carry next_cursor");
    params = { cursor: result.next_cursor, limit, order };
  }
  assert.fail(`${order} limit=${limit} pagination did not terminate`);
}

function assertExactlyOnce(actual: string[], all: string[], label: string): void {
  assert.equal(new Set(actual).size, actual.length, `${label}: no record repeats: ${JSON.stringify(actual)}`);
  assert.deepEqual([...actual].sort(), [...all].sort(), `${label}: every record is returned`);
}

// Present cursor values in ascending order, then null and absent values. The
// null group holds more rows than any tested limit, so pages end inside it.
const DATED_ROWS: Json[] = [
  { id: "d03", updated_at: "2026-01-03T00:00:00Z" },
  { id: "d07" },
  { id: "d01", updated_at: "2026-01-01T00:00:00Z" },
  { id: "d05", updated_at: null },
  { id: "d02", updated_at: "2026-01-02T00:00:00Z" },
  { id: "d04", updated_at: null },
  { id: "d06" },
  { id: "d08", updated_at: null },
];
const DATED_PRESENT_ASC = ["d01", "d02", "d03"];
const DATED_MISSING_ASC = ["d04", "d05", "d06", "d07", "d08"];

const RANKED_ROWS: Json[] = [
  { id: "r05", rank: null },
  { id: "r01", rank: 1 },
  { id: "r06" },
  { id: "r02", rank: 7 },
  { id: "r04" },
  { id: "r03", rank: 7 },
  { id: "r07", rank: null },
];
const RANKED_PRESENT_ASC = ["r01", "r02", "r03"];
const RANKED_MISSING_ASC = ["r04", "r05", "r06", "r07"];

// `order` reverses (cursor_field, primary_key) inside each group. In asc the
// null group follows the present values (Core §8). In desc both backends
// serve the null group first; Core §8 puts it last, and moving it is a
// separate change, so desc pins only that the group stays whole at one end.
function acceptedOrders(present: string[], missing: string[], order: Order): string[][] {
  if (order === "asc") {
    return [[...present, ...missing]];
  }
  const presentDesc = [...present].reverse();
  const missingDesc = [...missing].reverse();
  return [
    [...missingDesc, ...presentDesc],
    [...presentDesc, ...missingDesc],
  ];
}

const LIMITS = [1, 2, 3, 4];

type Case = (store: InstanceStore) => Promise<void>;
const CASES: Array<[string, Case]> = [];

for (const [stream, rows, present, missing] of [
  [DATED, DATED_ROWS, DATED_PRESENT_ASC, DATED_MISSING_ASC],
  [RANKED, RANKED_ROWS, RANKED_PRESENT_ASC, RANKED_MISSING_ASC],
] as const) {
  CASES.push([
    `${stream}: pages that end inside the null group lose no rows (asc and desc)`,
    async (store) => {
      const read = await seedConnection(store, stream, [...rows]);
      for (const order of ["asc", "desc"] as const) {
        const unpaged = await pageIds(read, order, 100);
        assert.ok(
          acceptedOrders(present, missing, order).some((accepted) => isDeepStrictEqual(unpaged, accepted)),
          `${order}: (cursor_field, primary_key) order with the null group whole: ${JSON.stringify(unpaged)}`
        );
        for (const limit of LIMITS) {
          const actual = await pageIds(read, order, limit);
          assertExactlyOnce(actual, [...present, ...missing], `${order} limit=${limit}`);
          assert.deepEqual(actual, unpaged, `${order} limit=${limit} equals the unpaged order`);
        }
      }
    },
  ]);
}

// Null, absent and empty-string cursor values together. Core §8 does not say
// where "" sorts (SQLite groups it with null, PostgreSQL treats it as a
// present value), so this case pins what a client relies on: each record
// once, the paged order equal to the unpaged order, and in asc null/absent
// values after every non-empty present value. `changes_since` must also
// return each record once.
const MIXED_ROWS: Json[] = [
  { id: "m01", updated_at: "2026-01-01T00:00:00Z" },
  { id: "m02", updated_at: "" },
  { id: "m03", updated_at: null },
  { id: "m04" },
  { id: "m05", updated_at: "" },
  { id: "m06", updated_at: "2026-01-06T00:00:00Z" },
  { id: "m07", updated_at: null },
  { id: "m08", updated_at: "" },
];
const MIXED_IDS = MIXED_ROWS.map((row) => String(row.id));
const MIXED_NON_EMPTY = new Set(["m01", "m06"]);
const MIXED_NULL_OR_ABSENT = new Set(["m03", "m04", "m07"]);

CASES.push([
  "dated: null, absent and empty-string cursors page without loss; changes_since returns each once",
  async (store) => {
    const read = await seedConnection(store, DATED, MIXED_ROWS);
    for (const order of ["asc", "desc"] as const) {
      const unpaged = await pageIds(read, order, 100);
      assertExactlyOnce(unpaged, MIXED_IDS, `${order} unpaged`);
      if (order === "asc") {
        const lastNonEmpty = Math.max(...unpaged.flatMap((id, i) => (MIXED_NON_EMPTY.has(id) ? [i] : [])));
        const firstNullOrAbsent = Math.min(...unpaged.flatMap((id, i) => (MIXED_NULL_OR_ABSENT.has(id) ? [i] : [])));
        assert.ok(lastNonEmpty < firstNullOrAbsent, `asc: null/absent values follow present values: ${unpaged}`);
      }
      for (const limit of LIMITS) {
        const paged = await pageIds(read, order, limit);
        assert.deepEqual(paged, unpaged, `${order} limit=${limit} equals the unpaged order`);
      }
    }

    const changed: string[] = [];
    let params: Json = { changes_since: "beginning", limit: 2 };
    for (let page = 0; page < 50; page += 1) {
      const result = await read(params);
      changed.push(...result.data.map((record) => String(record.id)));
      if (!result.has_more) {
        assert.equal(typeof result.next_changes_since, "string", "terminal change page carries next_changes_since");
        break;
      }
      params = { cursor: result.next_cursor, limit: 2 };
    }
    assertExactlyOnce(changed, MIXED_IDS, "changes_since");
  },
]);

test("single-connection list pages through the null-cursor group on SQLite (memory-default)", async (t) => {
  initDb(":memory:");
  try {
    for (const [name, run] of CASES) {
      await t.test(name, () => run(createSqliteConnectorInstanceStore()));
    }
  } finally {
    closeDb();
  }
});

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
if (POSTGRES_URL) {
  test("single-connection list pages through the null-cursor group on PostgreSQL", async (t) => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_null_cursor_pages_${process.pid}_${Date.now().toString(36)}`,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        try {
          for (const [name, run] of CASES) {
            await t.test(name, () => run(createPostgresConnectorInstanceStore()));
          }
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
} else {
  test("single-connection list pages through the null-cursor group on PostgreSQL", {
    skip: "PDPP_TEST_POSTGRES_URL is unset; run with PDPP_TEST_PROFILE=postgres to cover the PostgreSQL backend",
  }, () => {
    // skipped: no PostgreSQL test database in this profile
  });
}
