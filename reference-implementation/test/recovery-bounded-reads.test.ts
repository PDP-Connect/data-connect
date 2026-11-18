// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery eligibility must be applied BEFORE a bounded read's LIMIT, in the
 * store, for one connection. Filtering `retryable: false` (or another
 * connection's rows, or non-pressure rows) after a 100/200-row read lets older
 * permanent loss, or a busy sibling connection, fill the whole page so later
 * recoverable work is never seen.
 *
 * Real SQLite store always; real Postgres when `PDPP_TEST_POSTGRES_URL` names an
 * isolated, sentinel-provisioned test database. The scheduler probes are the
 * shared helpers both scheduler wirings (`server/index.ts` and
 * `server/scheduler-manager-factory.ts`) call, so one test pins both.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { probeNonPressureRecoverableCount, probeSourcePressureGaps } from "../server/scheduler-manager-factory.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
} from "../server/stores/connector-detail-gap-store.ts";

type Store = ReturnType<typeof createSqliteConnectorDetailGapStore>;

interface Ctx {
  readonly connectorId: string;
  readonly store: Store;
}

let sequence = 0;
function uniqueConnectorId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL as string;

const BACKENDS: readonly { readonly name: string; readonly run: (fn: (ctx: Ctx) => Promise<void>) => Promise<void> }[] =
  [
    {
      name: "sqlite",
      run: async (fn) => {
        const dir = mkdtempSync(join(tmpdir(), "pdpp-bounded-reads-"));
        initDb(join(dir, "pdpp.sqlite"));
        try {
          await fn({ connectorId: uniqueConnectorId("bounded_sqlite"), store: createSqliteConnectorDetailGapStore() });
        } finally {
          closeDb();
          rmSync(dir, { force: true, recursive: true });
        }
      },
    },
    ...(POSTGRES_URL
      ? [
          {
            name: "postgres",
            run: async (fn: (ctx: Ctx) => Promise<void>) => {
              initDb(":memory:");
              await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
              const connectorId = uniqueConnectorId("bounded_pg");
              try {
                await fn({ connectorId, store: createPostgresConnectorDetailGapStore() as unknown as Store });
              } finally {
                await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [connectorId]);
                await closePostgresStorage();
                closeDb();
              }
            },
          },
        ]
      : []),
  ];

function at(base: string, index: number): string {
  return new Date(Date.parse(base) + index * 1000).toISOString();
}

async function seedMany(
  ctx: Ctx,
  input: {
    readonly count: number;
    readonly instance: string;
    readonly keyPrefix: string;
    readonly reason: string;
    readonly retryable: boolean;
    readonly startAt: string;
  }
): Promise<void> {
  for (let index = 0; index < input.count; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup keeps created_at ordering deterministic.
    await ctx.store.upsertPendingGap({
      connectorId: ctx.connectorId,
      connectorInstanceId: input.instance,
      detailLocator: { item: `${input.keyPrefix}${index}`, kind: "test.item" },
      grantId: "grant_1",
      now: at(input.startAt, index),
      reason: input.reason,
      recordKey: `${input.keyPrefix}${index}`,
      retryable: input.retryable,
      stream: "messages",
    });
  }
}

const OLD = "2026-01-01T00:00:00.000Z";
const MID = "2026-03-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

for (const backend of BACKENDS) {
  test(`[${backend.name}] recoverable-only instance read is not starved by 120 older permanent rows`, async () => {
    await backend.run(async (ctx) => {
      await seedMany(ctx, {
        count: 120,
        instance: "cin_a",
        keyPrefix: "p",
        reason: "source_unrepresentable",
        retryable: false,
        startAt: OLD,
      });
      await seedMany(ctx, {
        count: 1,
        instance: "cin_a",
        keyPrefix: "t",
        reason: "temporary_unavailable",
        retryable: true,
        startAt: NEW,
      });

      const diagnostic = await ctx.store.listPendingGapsForConnectorInstance(ctx.connectorId, "cin_a", { limit: 100 });
      assert.equal(diagnostic.length, 100, "the diagnostic read stays a bounded, complete-visibility read");
      assert.ok(
        diagnostic.every((gap) => gap.retryable === false),
        "older permanent loss fills the diagnostic page (visibility is preserved, and it is why it cannot gate recovery)"
      );

      const recoverable = await ctx.store.listPendingGapsForConnectorInstance(ctx.connectorId, "cin_a", {
        limit: 100,
        recoverableOnly: true,
      } as Parameters<Store["listPendingGapsForConnectorInstance"]>[2]);
      assert.deepEqual(
        recoverable.map((gap) => gap.record_key),
        ["t0"],
        "the recoverable-only read applies eligibility before LIMIT and sees the later transient gap"
      );
    });
  });

  test(`[${backend.name}] non-pressure probe sees recoverable work behind >200 permanent rows and a busy sibling connection`, async () => {
    await backend.run(async (ctx) => {
      // Sibling connection B is older and larger than the 200-row connector-wide page.
      await seedMany(ctx, {
        count: 230,
        instance: "cin_b",
        keyPrefix: "b",
        reason: "retry_exhausted",
        retryable: true,
        startAt: OLD,
      });
      await seedMany(ctx, {
        count: 210,
        instance: "cin_a",
        keyPrefix: "p",
        reason: "source_unrepresentable",
        retryable: false,
        startAt: MID,
      });
      await seedMany(ctx, {
        count: 1,
        instance: "cin_a",
        keyPrefix: "t",
        reason: "temporary_unavailable",
        retryable: true,
        startAt: NEW,
      });
      assert.equal(
        await probeNonPressureRecoverableCount(ctx.store, ctx.connectorId, "cin_a"),
        1,
        "exactly the one recoverable non-pressure gap of THIS connection counts"
      );
    });
  });

  test(`[${backend.name}] pressure probe sees a pressure gap behind older non-pressure, permanent and sibling rows`, async () => {
    await backend.run(async (ctx) => {
      await seedMany(ctx, {
        count: 230,
        instance: "cin_b",
        keyPrefix: "b",
        reason: "rate_limited",
        retryable: true,
        startAt: OLD,
      });
      await seedMany(ctx, {
        count: 120,
        instance: "cin_a",
        keyPrefix: "p",
        reason: "rate_limited",
        retryable: false,
        startAt: MID,
      });
      await seedMany(ctx, {
        count: 120,
        instance: "cin_a",
        keyPrefix: "n",
        reason: "retry_exhausted",
        retryable: true,
        startAt: at(MID, 1000),
      });
      await seedMany(ctx, {
        count: 1,
        instance: "cin_a",
        keyPrefix: "r",
        reason: "rate_limited",
        retryable: true,
        startAt: NEW,
      });
      const gaps = await probeSourcePressureGaps(ctx.store, ctx.connectorId, "cin_a");
      assert.deepEqual(
        gaps.map((gap) => gap.reason),
        ["rate_limited"],
        "the one retryable pressure gap of THIS connection is visible; the permanent rate_limited rows are not"
      );
    });
  });
  test(`[${backend.name}] connector-wide read scoped to one connection sees its later pressure gap before the LIMIT`, async () => {
    await backend.run(async (ctx) => {
      await seedMany(ctx, {
        count: 230,
        instance: "cin_b",
        keyPrefix: "b",
        reason: "rate_limited",
        retryable: true,
        startAt: OLD,
      });
      await seedMany(ctx, {
        count: 1,
        instance: "cin_a",
        keyPrefix: "r",
        reason: "rate_limited",
        retryable: true,
        startAt: NEW,
      });
      const unscoped = await ctx.store.listPendingGapsForConnector(ctx.connectorId, { limit: 200 });
      assert.ok(
        unscoped.every((gap) => gap.connector_instance_id === "cin_b"),
        "an unscoped page is filled by the sibling connection (diagnostic read unchanged)"
      );
      const scoped = await ctx.store.listPendingGapsForConnector(ctx.connectorId, {
        connectorInstanceId: "cin_a",
        limit: 200,
        reasons: ["rate_limited", "upstream_pressure"],
        recoverableOnly: true,
      });
      assert.deepEqual(
        scoped.map((gap) => gap.record_key),
        ["r0"]
      );
    });
  });
  test(`[${backend.name}] keyset pages visit every pending gap of one connection exactly once, in a stable order`, async () => {
    await backend.run(async (ctx) => {
      // Identical created_at on purpose: the cursor must tie-break on gap_id.
      for (let index = 0; index < 5; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup keeps the fixture deterministic.
        await ctx.store.upsertPendingGap({
          connectorId: ctx.connectorId,
          connectorInstanceId: "cin_a",
          detailLocator: { item: `s${index}`, kind: "test.item" },
          grantId: "grant_1",
          now: OLD,
          reason: "retry_exhausted",
          recordKey: `s${index}`,
          retryable: true,
          stream: "messages",
        });
      }
      const seen: string[] = [];
      let after: { createdAt: string; gapId: string } | undefined;
      for (let page = 0; page < 10; page += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each page depends on the previous cursor.
        const rows = await ctx.store.listPendingGapsForConnectorInstance(ctx.connectorId, "cin_a", {
          limit: 2,
          recoverableOnly: true,
          ...(after ? { after } : {}),
        } as Parameters<Store["listPendingGapsForConnectorInstance"]>[2]);
        if (rows.length === 0) {
          break;
        }
        seen.push(...rows.map((row) => row.record_key as string));
        const last = rows[rows.length - 1];
        assert.ok(last);
        after = { createdAt: last.created_at, gapId: last.gap_id };
        if (rows.length < 2) {
          break;
        }
      }
      assert.deepEqual([...seen].sort(), ["s0", "s1", "s2", "s3", "s4"], "every gap exactly once");
      assert.equal(new Set(seen).size, 5, "no duplicates across pages");
    });
  });
}
