// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mounted-route proof for `GET /_ref/connectors?connector_id=A&connector_id=B
 * &profile=retained_count_summary` — the actual HTTP composition Add Source's
 * console client hits (design doc add-source-perf-design-agy-0730.md;
 * Fable ruling terminal-read-architecture-fable-0730.md §2 R5).
 *
 * Unlike `ref-connectors-retained-count-summary-profile.test.ts` (which calls
 * `listConnectorSummaryPage`/`getConnectorSummaryForRoute` directly), this
 * file goes through `fetch` against a live mounted server so the repeated
 * `connector_id` query-string parsing (Fastify's flat-value query parsing)
 * and the route's profile/limit/cursor validation are proven end-to-end, not
 * assumed. Mirrors `ref-connectors-list-page-route-parity.test.ts`'s method.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CONNECTOR_SUMMARY_SCOPE_MAX_BYTES } from "../operations/ref-connectors-list/pagination.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const CONNECTOR_A = "route-retained-count-a";
const CONNECTOR_B = "route-retained-count-b";
const CONNECTOR_C = "route-retained-count-c";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "retained count route parity cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface RetainedCountRouteItem {
  readonly acquisition_coverage?: { latest_batch?: { uploaded_file_name?: string | null } | null } | null;
  readonly connection_id?: string;
  readonly connector_id?: string;
  readonly revoked_at?: string | null;
  readonly status?: string;
  readonly total_records?: number;
  readonly total_records_state?: string;
}

interface RouteEnvelope {
  readonly data?: readonly RetainedCountRouteItem[];
  readonly error?: { code?: string; message?: string };
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
  readonly object?: string;
}

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("retained-count route parity shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function withMountedRoute(databaseUrl: string | null, fn: (asUrl: string) => Promise<void>): Promise<void> {
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (databaseUrl) {
    process.env.PDPP_DATABASE_URL = databaseUrl;
  } else {
    delete process.env.PDPP_DATABASE_URL;
  }
  let server: StartedServer | null = null;
  try {
    server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    await server.startupBackfillDone.catch(() => undefined);
    await fn(`http://localhost:${server.asPort}`);
  } finally {
    await closeServer(server);
    await closePostgresStorage().catch(() => undefined);
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
  }
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 30, 12, 0, index)).toISOString();
}

async function seedConnector(connectorId: string): Promise<void> {
  const manifestBody = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: `Route retained-count ${connectorId}`,
    protocol_version: "0.1.0",
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify(manifestBody),
      iso(0),
    ]);
    return;
  }
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifestBody), iso(0));
}

async function seedInstance(options: {
  connectorId: string;
  connectorInstanceId: string;
  index: number;
  status?: string;
  revokedAt?: string | null;
}): Promise<void> {
  const createdAt = iso(options.index);
  const status = options.status ?? "active";
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, $2, $3, $4, $5, 'account', $1, '{}'::jsonb, $6, $6, $7)`,
      [
        options.connectorInstanceId,
        OWNER,
        options.connectorId,
        `Route ${options.connectorInstanceId}`,
        status,
        createdAt,
        options.revokedAt ?? null,
      ]
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES(?, ?, ?, ?, ?, 'account', ?, '{}', ?, ?, ?)`
    )
    .run(
      options.connectorInstanceId,
      OWNER,
      options.connectorId,
      `Route ${options.connectorInstanceId}`,
      status,
      options.connectorInstanceId,
      createdAt,
      createdAt,
      options.revokedAt ?? null
    );
}

async function getEnvelope(asUrl: string, query: string): Promise<{ status: number; body: RouteEnvelope }> {
  const response = await fetch(`${asUrl}/_ref/connectors?${query}`);
  const body = (await response.json()) as RouteEnvelope;
  return { body, status: response.status };
}

async function assertRouteSetScopeParity(asUrl: string): Promise<void> {
  await seedConnector(CONNECTOR_A);
  await seedConnector(CONNECTOR_B);
  await seedConnector(CONNECTOR_C);
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_route_a1", index: 0 });
  await seedInstance({ connectorId: CONNECTOR_B, connectorInstanceId: "cin_route_b1", index: 1 });
  await seedInstance({
    connectorId: CONNECTOR_B,
    connectorInstanceId: "cin_route_b2_revoked",
    index: 2,
    revokedAt: "2026-07-01T00:00:00.000Z",
    status: "revoked",
  });

  // Repeated connector_id query values (`?connector_id=A&connector_id=B`) —
  // the actual HTTP shape the design doc's "Minimal contract" specifies.
  const { body, status } = await getEnvelope(
    asUrl,
    `connector_id=${encodeURIComponent(CONNECTOR_A)}&connector_id=${encodeURIComponent(CONNECTOR_B)}&connector_id=${encodeURIComponent(CONNECTOR_C)}&limit=100&profile=retained_count_summary`
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.object, "list");
  const ids = (body.data ?? []).map((row) => row.connection_id).sort();
  assert.deepEqual(ids, ["cin_route_a1", "cin_route_b1", "cin_route_b2_revoked"]);
  assert.equal(body.has_more, false);

  // Pinned field set flows through the HTTP envelope, not just the
  // in-process call. Whether the startup maintenance sweep reconciled
  // evidence before or after this fixture's connections were inserted is a
  // timing race this route-parity test does not control (both "known_zero"
  // — an evidence row exists, proven zero — and "unobserved" — no evidence
  // row yet — are honest, typed answers); the exact evidence-state
  // derivation is proven directly and deterministically against
  // `reconcileConnectorSummaryEvidence` in
  // `ref-connectors-retained-count-summary-profile.test.ts`. This test's job
  // is the HTTP shape: the field is present, typed, and the count is exact.
  const first = (body.data ?? []).find((row) => row.connection_id === "cin_route_a1");
  assert.ok(first);
  assert.equal(first.total_records, 0);
  assert.ok(
    first.total_records_state === "known_zero" || first.total_records_state === "unobserved",
    `expected known_zero or unobserved, got ${first.total_records_state}`
  );
  assert.equal(first.acquisition_coverage, null);

  // Revoked pagination itself does not erase the row.
  const revoked = (body.data ?? []).find((row) => row.connection_id === "cin_route_b2_revoked");
  assert.ok(revoked);
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revoked_at);

  // Flat sets are bounded by request bytes, not connector count. Keep profile
  // and limit AFTER the IDs to detect qs's default parameterLimit truncation.
  // A larger scope is rejected before page 1; see assertLargeScopeContinues.
  for (const count of [64, 65, 101, 150]) {
    const filterIds = [CONNECTOR_A, ...Array.from({ length: count - 1 }, (_, i) => i.toString(36))];
    const query = filterIds.map((id) => `connector_id=${encodeURIComponent(id)}`).join("&");
    // biome-ignore lint/performance/noAwaitInLoops: each size is a separate HTTP boundary assertion.
    const result = await getEnvelope(asUrl, `${query}&limit=1&profile=retained_count_summary`);
    assert.equal(result.status, 200, `${count}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.data?.length, 1);
    assert.equal(result.body.data?.[0]?.connector_id, CONNECTOR_A);
    assert.equal(result.body.data?.[0]?.total_records, 0);
  }
  for (const shape of ["connector_id[x]=a", "connector_id=a&connector_id[x]=b", "connector_id=a&connector_id=a"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each malformed scope is asserted separately.
    const result = await getEnvelope(asUrl, `${shape}&limit=100&profile=retained_count_summary`);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, "invalid_request");
  }

  // connector_id SET mixed with `connection` is rejected (mutual exclusivity).
  const mixedResult = await getEnvelope(
    asUrl,
    `connection=cin_route_a1&connector_id=${encodeURIComponent(CONNECTOR_A)}&connector_id=${encodeURIComponent(CONNECTOR_B)}`
  );
  assert.equal(mixedResult.status, 400, JSON.stringify(mixedResult.body));

  // A single repeated connector_id value behaves exactly like the pre-existing
  // one-id filter (byte-identical request/cursor shape).
  const singleResult = await getEnvelope(
    asUrl,
    `connector_id=${encodeURIComponent(CONNECTOR_A)}&limit=100&profile=retained_count_summary`
  );
  assert.equal(singleResult.status, 200, JSON.stringify(singleResult.body));
  assert.deepEqual(
    (singleResult.body.data ?? []).map((row) => row.connection_id),
    ["cin_route_a1"]
  );
}

function scopeQuery(ids: readonly string[]): string {
  return ids.map((id) => `connector_id=${encodeURIComponent(id)}`).join("&");
}

/**
 * Every scope that page 1 admits must also complete a limit=1 walk. The client
 * re-sends the scope on every continuation, so a scope that fits page 1 but not
 * page 1 plus a cursor would strand the later rows behind an HTTP 431. A scope
 * the server cannot continue must instead fail before page 1 with a typed 400.
 */
async function assertLargeScopeContinues(asUrl: string): Promise<void> {
  await seedConnector(CONNECTOR_A);
  await seedConnector(CONNECTOR_B);
  const expected = ["cin_walk_a1", "cin_walk_a2", "cin_walk_b1"];
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: expected[0] as string, index: 0 });
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: expected[1] as string, index: 1 });
  await seedInstance({ connectorId: CONNECTOR_B, connectorInstanceId: expected[2] as string, index: 2 });

  const fillerIds = (count: number) => [
    CONNECTOR_A,
    CONNECTOR_B,
    ...Array.from({ length: count - 2 }, (_, i) => `f${i.toString(36)}`),
  ];
  let largest = 2;
  while (scopeQuery(fillerIds(largest + 1)).length <= CONNECTOR_SUMMARY_SCOPE_MAX_BYTES) {
    largest += 1;
  }
  let admitted = 0;
  let rejected = 0;
  let rejectedByScopeBound = 0;
  for (const count of [2, 150, largest, largest + 1, 700, 1001, 5000]) {
    const ids = fillerIds(count);
    const base = `${scopeQuery(ids)}&limit=1&profile=retained_count_summary`;
    // biome-ignore lint/performance/noAwaitInLoops: each scope size is a separate HTTP boundary assertion.
    const first = await getEnvelope(asUrl, base);
    if (first.status === 431) {
      // Beyond Node's own header bound the transport refuses page 1 itself.
      rejected += 1;
      continue;
    }
    if (first.status === 400) {
      assert.equal(first.body.error?.code, "invalid_request", `${count}: ${JSON.stringify(first.body)}`);
      assert.match(first.body.error?.message ?? "", /8192 bytes/);
      rejectedByScopeBound += 1;
      continue;
    }
    admitted += 1;
    const seen: string[] = [];
    let page = first;
    for (let pages = 0; pages < 10; pages += 1) {
      assert.equal(page.status, 200, `${count} page ${pages + 1}: ${JSON.stringify(page.body).slice(0, 200)}`);
      seen.push(...(page.body.data ?? []).map((row) => row.connection_id ?? ""));
      if (!page.body.has_more) {
        break;
      }
      const cursor = page.body.next_cursor;
      assert.ok(cursor && cursor.length < 1024, `${count}: cursor must not grow with the scope`);
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous page's cursor.
      page = await getEnvelope(asUrl, `${base}&cursor=${encodeURIComponent(cursor)}`);
    }
    assert.deepEqual(seen.sort(), expected, `${count}: every matching row must be reachable`);
  }
  assert.ok(admitted >= 3, "the ladder must exercise admitted scopes");
  assert.ok(rejectedByScopeBound >= 1, "the ladder must hit the server's scope bound before the transport limit");
  assert.ok(rejected >= 1, "the ladder must hit the transport's own limit");

  // The cursor is bound to its scope by digest: replaying it on another scope,
  // or tampering with it, is an invalid cursor.
  const scoped = `${scopeQuery([CONNECTOR_A, CONNECTOR_B])}&limit=1&profile=retained_count_summary`;
  const page1 = await getEnvelope(asUrl, scoped);
  assert.equal(page1.status, 200);
  const cursor = page1.body.next_cursor;
  assert.ok(cursor);
  for (const replay of [
    `${scopeQuery([CONNECTOR_A, CONNECTOR_C])}&limit=1&profile=retained_count_summary&cursor=${encodeURIComponent(cursor)}`,
    `${scopeQuery([CONNECTOR_A])}&limit=1&profile=retained_count_summary&cursor=${encodeURIComponent(cursor)}`,
    `limit=1&profile=retained_count_summary&cursor=${encodeURIComponent(cursor)}`,
    `${scoped}&cursor=${encodeURIComponent(`${cursor.slice(0, -2)}${cursor.endsWith("AA") ? "BB" : "AA"}`)}`,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each replay is asserted separately.
    const result = await getEnvelope(asUrl, replay);
    assert.equal(result.status, 400, replay.slice(-120));
    assert.equal(result.body.error?.code, "invalid_cursor");
  }
  // The same scope in another order is the same scope.
  const reordered = await getEnvelope(
    asUrl,
    `${scopeQuery([CONNECTOR_B, CONNECTOR_A])}&limit=1&profile=retained_count_summary&cursor=${encodeURIComponent(cursor)}`
  );
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
}

test("SQLite mounted route: repeated connector_id SET scope + retained_count_summary profile", async () => {
  await withMountedRoute(null, assertRouteSetScopeParity);
});

test("SQLite mounted route: every admitted large connector_id scope walks to the last page", async () => {
  await withMountedRoute(null, assertLargeScopeContinues);
});

if (POSTGRES_URL) {
  test("PostgreSQL mounted route: repeated connector_id SET scope + retained_count_summary profile", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_route_retained_count_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertRouteSetScopeParity)
    );
  });

  test("PostgreSQL mounted route: every admitted large connector_id scope walks to the last page", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_route_large_scope_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertLargeScopeContinues)
    );
  });
}
