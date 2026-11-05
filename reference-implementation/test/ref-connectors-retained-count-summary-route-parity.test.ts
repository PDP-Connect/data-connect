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
 * `connector_id` query-string parsing (Express's array-of-values behavior)
 * and the route's profile/limit/cursor validation are proven end-to-end, not
 * assumed. Mirrors `ref-connectors-list-page-route-parity.test.ts`'s method.
 */

import assert from "node:assert/strict";
import test from "node:test";

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

  // >100 distinct ids is a typed invalid request, over HTTP.
  const oversized = Array.from({ length: 101 }, (_, i) => `connector-${i}`)
    .map((id) => `connector_id=${encodeURIComponent(id)}`)
    .join("&");
  const oversizedResult = await getEnvelope(asUrl, `${oversized}&limit=100&profile=retained_count_summary`);
  assert.equal(oversizedResult.status, 400, JSON.stringify(oversizedResult.body));
  assert.equal(oversizedResult.body.error?.code, "invalid_request");

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

/** Same serializer as the console client (`lib/ref-client.ts`): URLSearchParams, one repeated `connector_id` per id. */
function clientQuery(ids: readonly string[], limit: number): string {
  const params = new URLSearchParams();
  for (const id of ids) {
    params.append("connector_id", id);
  }
  params.set("limit", String(limit));
  params.set("profile", "retained_count_summary");
  return params.toString();
}

/**
 * A scope the contract allows (at most 100 ids) must either walk to its last
 * page or fail on page 1 with a typed error. It must never hand out a cursor
 * whose continuation request exceeds Node's header limit (HTTP 431).
 * URLSearchParams escapes `~!'()`, three bytes each, so tilde-padded ids make
 * the wire form much larger than the ids look.
 */
async function assertScopedContinuation(asUrl: string): Promise<void> {
  await seedConnector(CONNECTOR_A);
  await seedConnector(CONNECTOR_B);
  const expected = ["cin_walk_a1", "cin_walk_a2", "cin_walk_b1"];
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: expected[0] as string, index: 0 });
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: expected[1] as string, index: 1 });
  await seedInstance({ connectorId: CONNECTOR_B, connectorInstanceId: expected[2] as string, index: 2 });

  const scope = (fillers: number, pad: string) => [
    CONNECTOR_A,
    CONNECTOR_B,
    ...Array.from({ length: fillers }, (_, i) => `${pad}${i.toString(36)}`),
  ];

  async function walk(query: string): Promise<{ failed: { status: number; body: RouteEnvelope } | null; seen: string[] }> {
    const seen: string[] = [];
    let page = await getEnvelope(asUrl, query);
    for (let pages = 0; pages < 10; pages += 1) {
      if (page.status !== 200) {
        return { failed: page, seen };
      }
      seen.push(...(page.body.data ?? []).map((row) => row.connection_id ?? ""));
      if (!page.body.has_more) {
        return { failed: null, seen };
      }
      const cursor = page.body.next_cursor as string;
      assert.ok(cursor.length < 1024, "cursor must not grow with the scope");
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous page's cursor.
      page = await getEnvelope(asUrl, `${query}&cursor=${encodeURIComponent(cursor)}`);
    }
    throw new Error("scope did not terminate");
  }

  // 410 ordinary ids: the contract allows at most 100, so this is a typed 400 before page 1.
  const tooMany = await getEnvelope(asUrl, clientQuery(scope(408, "f"), 1));
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body).slice(0, 200));
  assert.equal(tooMany.body.error?.code, "invalid_request");

  // 100 short ids walk to the last page.
  const small = await walk(clientQuery(scope(98, "f"), 1));
  assert.equal(small.failed, null, `${JSON.stringify(small.failed?.body)}`.slice(0, 200));
  assert.deepEqual(small.seen.sort(), expected);

  // 100 tilde-padded ids: page 1 fits but the continuation would not. Every
  // padding from small to large must walk to the end or fail on page 1.
  let walked = 0;
  let guardRefused = 0;
  for (const tildes of [10, 30, 40, 44, 46, 47, 48, 49, 50, 52, 60]) {
    // biome-ignore lint/performance/noAwaitInLoops: each padding is a separate HTTP boundary assertion.
    const result = await walk(clientQuery(scope(98, "~".repeat(tildes)), 1));
    if (result.failed === null) {
      assert.deepEqual(result.seen.sort(), expected, `${tildes}: every matching row must be reachable`);
      walked += 1;
      continue;
    }
    assert.equal(result.seen.length, 0, `${tildes}: a refusal must come from page 1, before any cursor is issued`);
    if (result.failed.status === 400) {
      assert.match(result.failed.body.error?.message ?? "", /too large to continue/, `${tildes}`);
      guardRefused += 1;
    } else {
      // Past Node's limit the transport itself refuses page 1; nothing is stranded.
      assert.equal(result.failed.status, 431, `${tildes}`);
    }
  }
  assert.ok(walked >= 3, "paddings that fit must walk");
  assert.ok(guardRefused >= 1, "paddings that fit page 1 but cannot continue must be refused before page 2");
}

test("SQLite mounted route: repeated connector_id SET scope + retained_count_summary profile", async () => {
  await withMountedRoute(null, assertRouteSetScopeParity);
});

test("SQLite mounted route: a scoped list that issues a cursor can always send it back", async () => {
  await withMountedRoute(null, assertScopedContinuation);
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

  test("PostgreSQL mounted route: a scoped list that issues a cursor can always send it back", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_route_scope_continue_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertScopedContinuation)
    );
  });
}
