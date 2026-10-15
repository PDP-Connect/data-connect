// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable `retryable` discriminator for `connector_detail_gaps`, proven on BOTH
 * backends (SQLite always; Postgres when `PDPP_TEST_POSTGRES_URL` names an
 * ISOLATED test database).
 *
 * Policy under test (collection-profile §5.6 + the existing observation rules):
 *   - `retryable` is stored as NULL (legacy / unknown), 1 (retryable) or
 *     0 (permanent). It round-trips on every read.
 *   - Eligibility for recovery is atomic in the store: the default
 *     `listPendingGaps` selection and the `claimPendingGaps` CAS both exclude an
 *     explicit `retryable = 0` row. A permanent row stays inspectable through the
 *     diagnostic listings.
 *   - A legacy NULL row keeps its old-contract eligibility (the old normative
 *     wire only allowed `true`), so a migration never strands or resurrects work.
 *   - The latest VALID observation wins, exactly as `reason`/`last_error` already
 *     do on re-upsert; an observation that carries NO `retryable` (null/absent)
 *     never changes an existing explicit value, so a null/default update cannot
 *     resurrect an explicit false.
 *   - Lease CAS stays authoritative: a stale leased outcome cannot undo a
 *     permanent observation, and a row that turned permanent after listing cannot
 *     be claimed.
 *   - Existing terminal/quarantine classification is unchanged.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
} from "../server/stores/connector-detail-gap-store.ts";
import Database from "./helpers/sqlite-driver.ts";

type GapStore = ReturnType<typeof createSqliteConnectorDetailGapStore>;

interface Backend {
  readonly name: "sqlite" | "postgres";
  /** Runs `fn` against a fresh, isolated store and cleans up afterwards. */
  readonly run: (fn: (ctx: BackendContext) => Promise<void>) => Promise<void>;
}

interface BackendContext {
  readonly connectorId: string;
  /** Drops the `retryable` column and re-runs schema bootstrap, simulating a pre-field database. */
  readonly downgradeThenReopen: () => Promise<void>;
  /** Re-opens the store without altering data (persist/reopen). */
  readonly reopen: () => Promise<void>;
  store: GapStore;
}

const NOW = "2026-10-15T00:00:00.000Z";
const LATER = "2026-12-31T00:00:00.000Z";

let backendSequence = 0;
function uniqueConnectorId(prefix: string): string {
  backendSequence += 1;
  return `${prefix}_${Date.now()}_${backendSequence}`;
}

const sqliteBackend: Backend = {
  name: "sqlite",
  run: async (fn) => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-store-"));
    const dbPath = join(dir, "pdpp.sqlite");
    initDb(dbPath);
    const ctx: BackendContext = {
      connectorId: uniqueConnectorId("perm_store_sqlite"),
      downgradeThenReopen: () => {
        closeDb();
        const raw = new Database(dbPath);
        try {
          raw.exec("ALTER TABLE connector_detail_gaps DROP COLUMN retryable");
        } finally {
          raw.close();
        }
        initDb(dbPath);
        ctx.store = createSqliteConnectorDetailGapStore();
        return Promise.resolve();
      },
      reopen: () => {
        closeDb();
        initDb(dbPath);
        ctx.store = createSqliteConnectorDetailGapStore();
        return Promise.resolve();
      },
      store: createSqliteConnectorDetailGapStore(),
    };
    try {
      await fn(ctx);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  },
};

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL as string;

const postgresBackend: Backend = {
  name: "postgres",
  run: async (fn) => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    const connectorId = uniqueConnectorId("perm_store_pg");
    const ctx: BackendContext = {
      connectorId,
      downgradeThenReopen: async () => {
        await postgresQuery("ALTER TABLE connector_detail_gaps DROP COLUMN IF EXISTS retryable");
        await closePostgresStorage();
        await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
        ctx.store = createPostgresConnectorDetailGapStore() as unknown as GapStore;
      },
      reopen: async () => {
        await closePostgresStorage();
        await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
        ctx.store = createPostgresConnectorDetailGapStore() as unknown as GapStore;
      },
      store: createPostgresConnectorDetailGapStore() as unknown as GapStore,
    };
    try {
      await fn(ctx);
    } finally {
      await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [ctx.connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  },
};

const BACKENDS: readonly Backend[] = POSTGRES_URL ? [sqliteBackend, postgresBackend] : [sqliteBackend];

interface SeedInput {
  readonly connectorInstanceId?: string;
  readonly now?: string;
  readonly reason: string;
  readonly recordKey: string;
  readonly retryable?: boolean | null;
}

function seed(ctx: BackendContext, input: SeedInput) {
  return ctx.store.upsertPendingGap({
    connectorId: ctx.connectorId,
    connectorInstanceId: input.connectorInstanceId ?? "cin_perm_store_main",
    detailLocator: { item: input.recordKey, kind: "test.item" },
    grantId: "grant_1",
    now: input.now ?? NOW,
    reason: input.reason,
    recordKey: input.recordKey,
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    stream: "messages",
  });
}

function recoverableSelection(
  ctx: BackendContext,
  extra: { includeNonRetryable?: boolean; limit?: number; now?: string } = {}
) {
  return ctx.store.listPendingGaps({
    connectorId: ctx.connectorId,
    connectorInstanceId: "cin_perm_store_main",
    grantId: "grant_1",
    ...extra,
  });
}

function ids(gaps: readonly { gap_id: string }[]): string[] {
  return gaps.map((gap) => gap.gap_id).sort();
}

for (const backend of BACKENDS) {
  test(`[${backend.name}] retryable round-trips and the default recovery selection excludes only explicit false`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      const legacy = await seed(ctx, { reason: "retry_exhausted", recordKey: "l" });
      assert.ok(permanent && transient && legacy);

      assert.equal((await ctx.store.getGapById(permanent.gap_id))?.retryable, false);
      assert.equal((await ctx.store.getGapById(transient.gap_id))?.retryable, true);
      assert.equal(
        (await ctx.store.getGapById(legacy.gap_id))?.retryable,
        null,
        "an observation without retryable stores NULL (legacy / unknown)"
      );

      assert.deepEqual(
        await recoverableSelection(ctx).then(ids),
        ids([transient, legacy]),
        "explicit false is excluded; true and legacy NULL stay eligible"
      );
      assert.deepEqual(
        await recoverableSelection(ctx, { now: LATER }).then(ids),
        ids([transient, legacy]),
        "advancing time never makes a permanent gap eligible"
      );

      assert.deepEqual(
        await recoverableSelection(ctx, { includeNonRetryable: true }).then(ids),
        ids([permanent, transient, legacy]),
        "the read-only inspection opt-in lists the permanent gap too"
      );
      assert.deepEqual(
        await recoverableSelection(ctx, { includeNonRetryable: false }).then(ids),
        ids([transient, legacy]),
        "an explicit false is the default"
      );
      const diagnostic = await ctx.store.listPendingGapsForConnector(ctx.connectorId);
      assert.deepEqual(ids(diagnostic), ids([permanent, transient, legacy]), "the permanent gap stays inspectable");
      assert.equal(diagnostic.find((gap) => gap.gap_id === permanent.gap_id)?.retryable, false);
      const byInstance = await ctx.store.listPendingGapsForConnectorInstance(ctx.connectorId, "cin_perm_store_main");
      assert.deepEqual(ids(byInstance), ids([permanent, transient, legacy]));
      const batched = await ctx.store.listPendingGapsByConnectorInstanceIds(["cin_perm_store_main"]);
      assert.deepEqual(ids(batched.get("cin_perm_store_main") ?? []), ids([permanent, transient, legacy]));
      assert.equal(
        await ctx.store.countGapsByStatusForConnector(ctx.connectorId, { status: "pending" }),
        3,
        "accounting counts every pending loss, permanent included"
      );
    });
  });

  test(`[${backend.name}] a permanent gap with a future retry floor stays inspectable (a floor is not a hiding time)`, async () => {
    await backend.run(async (ctx) => {
      const future = "2099-01-01T00:00:00.000Z";
      const permanent = await ctx.store.upsertPendingGap({
        connectorId: ctx.connectorId,
        connectorInstanceId: "cin_perm_store_main",
        detailLocator: { item: "p", kind: "test.item" },
        grantId: "grant_1",
        nextAttemptAfter: future,
        now: NOW,
        reason: "source_unrepresentable",
        recordKey: "p",
        retryable: false,
        stream: "messages",
      });
      const cooling = await ctx.store.upsertPendingGap({
        connectorId: ctx.connectorId,
        connectorInstanceId: "cin_perm_store_main",
        detailLocator: { item: "c", kind: "test.item" },
        grantId: "grant_1",
        nextAttemptAfter: future,
        now: NOW,
        reason: "rate_limited",
        recordKey: "c",
        retryable: true,
        stream: "messages",
      });
      assert.ok(permanent && cooling);
      assert.deepEqual(
        await recoverableSelection(ctx).then(ids),
        [],
        "cooling transient work stays gated; permanent never selected"
      );
      assert.deepEqual(
        await recoverableSelection(ctx, { includeNonRetryable: true }).then(ids),
        [permanent.gap_id],
        "inspection shows the permanent loss despite its floor, but still honors the cooling gate for transient work"
      );
      const batched = await ctx.store.listPendingGapsByConnectorInstanceIds(["cin_perm_store_main"]);
      assert.deepEqual(ids(batched.get("cin_perm_store_main") ?? []), [permanent.gap_id]);
    });
  });

  test(`[${backend.name}] direct CAS claim refuses a permanent gap and never partially claims it`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(permanent && transient);

      const claimed = await ctx.store.claimPendingGaps([permanent.gap_id, transient.gap_id], {
        leaseExpiresAt: LATER,
        leaseId: "lease_1",
        runId: "run_1",
      });
      assert.deepEqual(claimed, [transient.gap_id], "only the transient gap can be claimed by id");
      const after = await ctx.store.getGapById(permanent.gap_id);
      assert.equal(after?.status, "pending");
      assert.equal(after?.lease_id, null);
      assert.equal(after?.attempt_count, 0);
    });
  });

  test(`[${backend.name}] a gap that turns permanent after a stale listing cannot be claimed`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(gap);
      const staleList = await recoverableSelection(ctx);
      assert.deepEqual(ids(staleList), [gap.gap_id], "the stale listing offered it as transient");

      // A fresh VALID observation reports the same record as permanent.
      await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "t", retryable: false });

      const claimed = await ctx.store.claimPendingGaps(
        staleList.map((entry) => entry.gap_id),
        { leaseExpiresAt: LATER, leaseId: "lease_stale", runId: "run_stale" }
      );
      assert.deepEqual(claimed, [], "the CAS re-checks eligibility atomically");
      assert.equal((await ctx.store.getGapById(gap.gap_id))?.status, "pending");
    });
  });

  test(`[${backend.name}] a permanent gap cannot starve or be charged for transient recovery`, async () => {
    await backend.run(async (ctx) => {
      // The permanent row is OLDER and attempt-free: under the age-rotation
      // order it would win a limit-1 selection if it were not excluded.
      const permanent = await seed(ctx, {
        now: "2026-01-01T00:00:00.000Z",
        reason: "source_unrepresentable",
        recordKey: "p",
        retryable: false,
      });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(permanent && transient);

      const first = await recoverableSelection(ctx, { limit: 1 });
      assert.deepEqual(ids(first), [transient.gap_id], "the first-page cap is spent only on recoverable work");

      const claimed = await ctx.store.claimPendingGaps([transient.gap_id], {
        leaseExpiresAt: LATER,
        leaseId: "lease_t",
        runId: "run_t",
      });
      assert.deepEqual(claimed, [transient.gap_id]);
      const lease = { gapId: transient.gap_id, leaseId: "lease_t", runId: "run_t" };
      const settled = await ctx.store.settleLeasedGapRecovered(lease);
      assert.equal(settled?.status, "recovered", "transient recovery proceeds normally");

      const permanentAfter = await ctx.store.getGapById(permanent.gap_id);
      assert.equal(permanentAfter?.attempt_count, 0, "no attempt was charged to the permanent gap");
      assert.equal(permanentAfter?.next_attempt_after, null, "no cooldown was armed on the permanent gap");
      assert.equal(permanentAfter?.status, "pending");
    });
  });

  test(`[${backend.name}] explicit false survives persist/reopen and later time`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(permanent && transient);
      await ctx.reopen();
      assert.equal((await ctx.store.getGapById(permanent.gap_id))?.retryable, false);
      assert.deepEqual(await recoverableSelection(ctx, { now: LATER }).then(ids), [transient.gap_id]);
    });
  });

  test(`[${backend.name}] a null or absent retryable observation never resurrects false and never contradicts the stored pair`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, {
        reason: "source_unrepresentable",
        recordKey: "p",
        retryable: false,
      });
      assert.ok(permanent);
      // Same identity, same reason, no retryable (an internal/default writer).
      await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "p" });
      await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "p", retryable: null });
      assert.equal((await ctx.store.getGapById(permanent.gap_id))?.retryable, false);
      assert.deepEqual(await recoverableSelection(ctx), [], "still excluded");

      // Null/absent input is NOT a fresh classification: with a CONFLICTING
      // reason it must preserve BOTH the stored reason and the stored boolean,
      // never leave (false, rate_limited), and never overwrite the explanatory
      // last_error into a contradictory classification.
      const conflicting = await ctx.store.upsertPendingGap({
        connectorId: ctx.connectorId,
        connectorInstanceId: "cin_perm_store_main",
        detailLocator: { item: "p", kind: "test.item" },
        grantId: "grant_1",
        lastError: { class: "provider_pressure", message: "late default writer" },
        now: LATER,
        reason: "rate_limited",
        recordKey: "p",
        stream: "messages",
      });
      assert.equal(conflicting?.gap_id, permanent.gap_id);
      assert.equal(conflicting?.retryable, false, "the boolean is preserved");
      assert.equal(conflicting?.reason, "source_unrepresentable", "the paired reason is preserved with it");
      assert.notDeepEqual(
        conflicting?.last_error,
        { class: "provider_pressure", message: "late default writer" },
        "contradictory explanatory metadata is not written over the permanent classification"
      );
      assert.deepEqual(await recoverableSelection(ctx), [], "and the row is still not recoverable");
    });
  });

  test(`[${backend.name}] the same null-input rule keeps a known TRUE pair intact`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(gap);
      const after = await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "t" });
      assert.equal(after?.retryable, true, "null input does not flip a known true");
      assert.equal(after?.reason, "temporary_unavailable", "nor replace its reason");
    });
  });

  test(`[${backend.name}] a legacy NULL row still accepts the old-contract reason update`, async () => {
    await backend.run(async (ctx) => {
      const legacy = await seed(ctx, { reason: "retry_exhausted", recordKey: "l" });
      assert.ok(legacy);
      const after = await seed(ctx, { now: LATER, reason: "rate_limited", recordKey: "l" });
      assert.equal(after?.retryable, null, "legacy NULL stays NULL");
      assert.equal(after?.reason, "rate_limited", "legacy internal reason codes keep updating as before");
    });
  });

  test(`[${backend.name}] a fresh valid retryable observation replaces the stored value, like reason does`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "source_unrepresentable", recordKey: "k", retryable: false });
      assert.ok(gap);
      const reopened = await seed(ctx, {
        now: LATER,
        reason: "temporary_unavailable",
        recordKey: "k",
        retryable: true,
      });
      assert.equal(reopened?.gap_id, gap.gap_id, "same identity");
      assert.equal(reopened?.reason, "temporary_unavailable");
      assert.equal(reopened?.retryable, true, "the valid (reason, retryable) pair is stored together");
      assert.deepEqual(await recoverableSelection(ctx).then(ids), [gap.gap_id]);

      const again = await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "k", retryable: false });
      assert.equal(again?.retryable, false);
      assert.deepEqual(await recoverableSelection(ctx), []);
    });
  });

  test(`[${backend.name}] stale leased outcomes cannot undo a permanent observation`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "temporary_unavailable", recordKey: "k", retryable: true });
      assert.ok(gap);
      const claimed = await ctx.store.claimPendingGaps([gap.gap_id], {
        leaseExpiresAt: LATER,
        leaseId: "lease_a",
        runId: "run_a",
      });
      assert.deepEqual(claimed, [gap.gap_id]);

      // While leased, a fresh observation reports the record permanent.
      await seed(ctx, { now: LATER, reason: "source_unrepresentable", recordKey: "k", retryable: false });

      const lease = { gapId: gap.gap_id, leaseId: "lease_a", runId: "run_a" };
      const stalePending = await ctx.store.settleLeasedGapPending(lease, {
        connectorId: ctx.connectorId,
        connectorInstanceId: "cin_perm_store_main",
        now: LATER,
        reason: "temporary_unavailable",
        recordKey: "k",
        retryable: true,
        stream: "messages",
      });
      assert.equal(stalePending, null, "the stale lease cannot re-defer the gap as transient");
      assert.equal(await ctx.store.settleLeasedGapRecovered(lease), null, "nor mark it recovered");

      const after = await ctx.store.getGapById(gap.gap_id);
      assert.equal(after?.retryable, false);
      assert.equal(after?.reason, "source_unrepresentable");
      assert.deepEqual(await recoverableSelection(ctx), []);
    });
  });

  test(`[${backend.name}] a leased gap settled as permanent leaves the recovery selection`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "temporary_unavailable", recordKey: "k", retryable: true });
      assert.ok(gap);
      await ctx.store.claimPendingGaps([gap.gap_id], { leaseExpiresAt: LATER, leaseId: "lease_b", runId: "run_b" });
      const settled = await ctx.store.settleLeasedGapPending(
        { gapId: gap.gap_id, leaseId: "lease_b", runId: "run_b" },
        {
          connectorId: ctx.connectorId,
          connectorInstanceId: "cin_perm_store_main",
          now: LATER,
          reason: "source_unrepresentable",
          recordKey: "k",
          retryable: false,
          stream: "messages",
        }
      );
      assert.equal(settled?.retryable, false);
      assert.equal(settled?.status, "pending");
      assert.deepEqual(await recoverableSelection(ctx), []);
    });
  });

  test(`[${backend.name}] direct status transitions cannot put a permanent gap in_progress (no opt-in exists); generic completion transitions are unchanged`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      assert.ok(permanent && transient);

      const blocked = await ctx.store.markGapStatus(permanent.gap_id, "in_progress", { runId: "run_x" });
      assert.equal(blocked?.status, "pending", "the permanent gap is not claimed through the legacy status API");
      assert.equal(blocked?.attempt_count, 0, "and no attempt is charged");
      assert.equal((await ctx.store.getGapById(permanent.gap_id))?.status, "pending");

      const allowed = await ctx.store.markGapStatus(transient.gap_id, "in_progress", { runId: "run_x" });
      assert.equal(allowed?.status, "in_progress", "transient gaps keep the legacy transition (control)");

      // A legacy NULL row keeps the legacy transition (three-valued-logic guard).
      const legacy = await seed(ctx, { reason: "retry_exhausted", recordKey: "l" });
      assert.ok(legacy);
      const legacyClaimed = await ctx.store.markGapStatus(legacy.gap_id, "in_progress", { runId: "run_x" });
      assert.equal(legacyClaimed?.status, "in_progress", "legacy NULL rows are unaffected by the guard");

      // Generic producer completion is NOT restricted at the store: scheduling
      // is what the store guards, not the completion contract of other producers.
      const completed = await ctx.store.markGapStatus(permanent.gap_id, "recovered", { runId: "run_y" });
      assert.equal(completed?.status, "recovered", "the generic completion transition keeps its existing contract");
    });
  });

  test(`[${backend.name}] connector-origin recovery is refused atomically for a permanent gap and succeeds otherwise`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      const transient = await seed(ctx, { reason: "temporary_unavailable", recordKey: "t", retryable: true });
      const legacy = await seed(ctx, { reason: "retry_exhausted", recordKey: "l" });
      assert.ok(permanent && transient && legacy);

      assert.equal(
        await ctx.store.markConnectorGapRecovered(permanent.gap_id, { runId: "run_c" }),
        null,
        "no update is distinguishable from a recovery"
      );
      const unchanged = await ctx.store.getGapById(permanent.gap_id);
      assert.equal(unchanged?.status, "pending");
      assert.equal(unchanged?.retryable, false);
      assert.equal(unchanged?.recovered_run_id, null);

      const recovered = await ctx.store.markConnectorGapRecovered(transient.gap_id, { runId: "run_c" });
      assert.equal(recovered?.status, "recovered");
      assert.equal(recovered?.recovered_run_id, "run_c");
      const recoveredLegacy = await ctx.store.markConnectorGapRecovered(legacy.gap_id, { runId: "run_c" });
      assert.equal(recoveredLegacy?.status, "recovered", "legacy NULL rows keep their old eligibility");
      assert.equal(await ctx.store.markConnectorGapRecovered("gap_missing", { runId: "run_c" }), null);

      // The generic trusted path is unchanged (local-collector settlement).
      const generic = await ctx.store.markGapStatus(permanent.gap_id, "recovered", { runId: "run_g" });
      assert.equal(generic?.status, "recovered");
    });
  });

  test(`[${backend.name}] claimPendingGaps has no opt-in that can claim a permanent gap`, async () => {
    await backend.run(async (ctx) => {
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      assert.ok(permanent);
      const claimed = await ctx.store.claimPendingGaps([permanent.gap_id], {
        includeNonRetryable: true,
        leaseExpiresAt: LATER,
        leaseId: "lease_opt_in",
        runId: "run_opt_in",
      } as unknown as Parameters<GapStore["claimPendingGaps"]>[1]);
      assert.deepEqual(claimed, [], "the read-only inspection flag is ignored by the claim path");
    });
  });

  test(`[${backend.name}] terminal and quarantine classification is unchanged and never resurrected`, async () => {
    await backend.run(async (ctx) => {
      const gap = await seed(ctx, { reason: "source_unrepresentable", recordKey: "k", retryable: false });
      assert.ok(gap);
      const terminal = await ctx.store.markGapStatus(gap.gap_id, "terminal", { now: NOW });
      assert.equal(terminal?.status, "terminal");
      const reUpserted = await seed(ctx, {
        now: LATER,
        reason: "source_unrepresentable",
        recordKey: "k",
        retryable: false,
      });
      assert.equal(reUpserted?.status, "terminal", "terminal stays sticky on re-upsert");
      assert.equal(reUpserted?.retryable, false, "the discriminator survives the terminal transition");
      assert.deepEqual(await recoverableSelection(ctx), []);

      const legacyTerminal = await seed(ctx, { reason: "gone", recordKey: "g" });
      assert.ok(legacyTerminal);
      const legacyAfter = await ctx.store.markGapStatus(legacyTerminal.gap_id, "terminal", { now: NOW });
      assert.equal(legacyAfter?.status, "terminal");
      assert.equal(legacyAfter?.retryable, null, "an old terminal row keeps NULL; nothing is backfilled");
    });
  });

  test(`[${backend.name}] pre-field rows migrate to NULL and keep old-contract eligibility`, async () => {
    await backend.run(async (ctx) => {
      const legacy = await seed(ctx, { reason: "retry_exhausted", recordKey: "old", retryable: true });
      assert.ok(legacy);
      await ctx.downgradeThenReopen();
      const migrated = await ctx.store.getGapById(legacy.gap_id);
      assert.ok(migrated, "the pre-field row survived the additive migration");
      assert.equal(migrated.retryable, null, "migration never invents false (nor true): NULL = unknown/legacy");
      assert.deepEqual(
        await recoverableSelection(ctx).then(ids),
        [legacy.gap_id],
        "legacy NULL stays eligible exactly as before the field existed"
      );
      assert.deepEqual(
        await ctx.store.claimPendingGaps([legacy.gap_id], { leaseExpiresAt: LATER, leaseId: "l", runId: "r" }),
        [legacy.gap_id]
      );
    });
  });

  test(`[${backend.name}] a foreign-instance gap is never selected or claimed through another instance`, async () => {
    await backend.run(async (ctx) => {
      const foreign = await seed(ctx, {
        connectorInstanceId: "cin_perm_store_foreign",
        reason: "temporary_unavailable",
        recordKey: "f",
        retryable: true,
      });
      const permanent = await seed(ctx, { reason: "source_unrepresentable", recordKey: "p", retryable: false });
      assert.ok(foreign && permanent);
      assert.deepEqual(await recoverableSelection(ctx), [], "main instance has only the permanent gap");
      assert.equal((await ctx.store.getGapById(foreign.gap_id))?.status, "pending");
    });
  });
}
