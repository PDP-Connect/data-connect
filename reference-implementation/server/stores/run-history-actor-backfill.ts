// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded backfill of `run_history.actor_type` for rows written before the
// column existed.
//
// The live writer (server/stores/run-history-writer.ts) copies the terminal
// spine event's actor_type onto the row it finalizes. A row finalized earlier
// has none. This walk fills it from the run's terminal spine event: the FIRST
// terminal event by event_seq, which is the event the live writer finalizes a
// row from (a later duplicate terminal no-ops there). Identity is the pair
// (run_id, connector_instance_id), never run_id alone.
//
// Shape (why it is safe on a large table):
// - The walk keys on run_history's own primary key, in ascending id order, one
//   batch per round. run_history holds one row per run, so a pass is
//   O(run_history), not O(spine_events). Each row costs one probe of
//   spine_events by (run_id, event_type) through its terminal partial index,
//   so millions of spine events add index depth, not scan work.
// - Each round is ONE short autocommit statement over at most `batchSize`
//   rows. It never holds a transaction between rounds, and it locks only the
//   rows it updates (a Postgres UPDATE takes row locks, no table lock).
// - It only touches rows that are terminal (`status <> 'running'`) with
//   actor_type NULL, and re-checks `actor_type IS NULL` in the UPDATE. A live
//   finalize needs `status = 'running'`, so the two writers never touch the
//   same row, and a backfill can never overwrite a live value.
// - Idempotent: a filled row drops out of the candidate set. A row whose run
//   has no terminal event stays NULL and is not rewritten (the UPDATE joins
//   only rows that found an actor), so repeated boots add no dead tuples.
// - No durable cursor. A pass re-reads from id 0 each boot; the filled rows
//   are skipped by the `actor_type IS NULL` filter, so a capped pass resumes
//   where the last one effectively stopped. Only rows that can never be
//   filled are re-probed, and only until the round cap.
//
// A run's `run.browser_surface_failed` terminal is not in the Postgres terminal
// partial index. It is probed only for rows the indexed lookup did not fill, so
// the common case never scans a run's whole event window.

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_ROUNDS = 1000;

export interface RunHistoryActorBackfillRound {
  /** Rows that had no actor_type, were terminal, and were examined this round. */
  readonly examined: number;
  /** Rows this round filled. */
  readonly filled: number;
  /** The highest run_history id examined; the next round starts after it. null when nothing was left. */
  readonly lastId: number | null;
}

export interface RunHistoryActorBackfillSummary {
  /** True when a round found fewer candidates than the batch size: the pass reached the end of run_history. */
  readonly complete: boolean;
  readonly examined: number;
  readonly filled: number;
  readonly rounds: number;
}

// The SQLite terminal partial index (idx_spine_events_run_terminal) covers all
// five terminal types; the Postgres one (idx_pg_spine_events_run_terminal)
// covers the first four. An IN list must stay literal and identical to the
// index predicate for the planner to use the partial index.
const SQLITE_TERMINAL_TYPES = `'run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned'`;
const POSTGRES_INDEXED_TERMINAL_TYPES = `'run.completed', 'run.failed', 'run.cancelled', 'run.abandoned'`;

function toFiniteId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fill the batch `[lo, hi]` of run_history ids on SQLite. Exported so a test can
 * read its query plan.
 *
 * The leading `+` on `se.connector_instance_id` stops SQLite from choosing
 * idx_spine_events_instance_seq, which would scan every event of the whole
 * connection for each row. With it the planner probes the terminal partial
 * index by (run_id, event_type). Measured on 1M events over 50k runs:
 * 110 s without it, 0.4 s with it.
 */
export const SQLITE_FILL_ACTOR_SQL = `UPDATE run_history
     SET actor_type = found.actor_type
     FROM (
       SELECT rh.id AS id,
              (SELECT se.actor_type FROM spine_events se
                WHERE se.run_id = rh.run_id
                  AND +se.connector_instance_id = rh.connector_instance_id
                  AND se.event_type IN (${SQLITE_TERMINAL_TYPES})
                ORDER BY se.event_seq ASC
                LIMIT 1) AS actor_type
       FROM run_history rh
       WHERE rh.id BETWEEN ? AND ?
         AND rh.actor_type IS NULL AND rh.run_id IS NOT NULL AND rh.status <> 'running'
     ) AS found
     WHERE run_history.id = found.id
       AND found.actor_type IS NOT NULL
       AND run_history.actor_type IS NULL`;

function sqliteRound(afterId: number, batchSize: number): RunHistoryActorBackfillRound {
  // REVIEWED-DYNAMIC: fixed SQL, placeholders only; bounded by LIMIT ? and an
  // id range. A registered query cannot express the one-shot range update.
  const [bounds] = [
    ...iterateDynamicSqlAcknowledged<{ examined: number; hi: number | null; lo: number | null }>(
      `SELECT COUNT(*) AS examined, MIN(id) AS lo, MAX(id) AS hi
       FROM (
         SELECT id FROM run_history
         WHERE id > ? AND actor_type IS NULL AND run_id IS NOT NULL AND status <> 'running'
         ORDER BY id
         LIMIT ?
       )`,
      [afterId, batchSize]
    ),
  ];
  const lo = toFiniteId(bounds?.lo);
  const hi = toFiniteId(bounds?.hi);
  if (!bounds || lo === null || hi === null) {
    return { examined: 0, filled: 0, lastId: null };
  }
  // REVIEWED-DYNAMIC: fixed SQL, placeholders only; bounded by the id range
  // [lo, hi] the select above produced from at most `batchSize` candidates.
  const result = execDynamicSqlAcknowledged(SQLITE_FILL_ACTOR_SQL, [lo, hi]);
  return { examined: Number(bounds.examined), filled: result.changes, lastId: hi };
}

async function postgresRound(afterId: number, batchSize: number): Promise<RunHistoryActorBackfillRound> {
  const bounds = await postgresQuery<{ examined: string; hi: string | null; lo: string | null }>(
    `SELECT COUNT(*)::text AS examined, MIN(id)::text AS lo, MAX(id)::text AS hi
     FROM (
       SELECT id FROM run_history
       WHERE id > $1::bigint AND actor_type IS NULL AND run_id IS NOT NULL AND status <> 'running'
       ORDER BY id
       LIMIT $2
     ) batch`,
    [afterId, batchSize]
  );
  const [row] = bounds.rows;
  const lo = toFiniteId(row?.lo);
  const hi = toFiniteId(row?.hi);
  if (!row || lo === null || hi === null) {
    return { examined: 0, filled: 0, lastId: null };
  }
  const result = await postgresQuery(
    `UPDATE run_history
     SET actor_type = found.actor_type
     FROM (
       SELECT rh.id,
              COALESCE(
                (SELECT se.actor_type FROM spine_events se
                  WHERE se.run_id = rh.run_id
                    AND se.connector_instance_id = rh.connector_instance_id
                    AND se.event_type IN (${POSTGRES_INDEXED_TERMINAL_TYPES})
                  ORDER BY se.event_seq ASC
                  LIMIT 1),
                (SELECT se.actor_type FROM spine_events se
                  WHERE se.run_id = rh.run_id
                    AND se.connector_instance_id = rh.connector_instance_id
                    AND se.event_type = 'run.browser_surface_failed'
                  ORDER BY se.event_seq ASC
                  LIMIT 1)
              ) AS actor_type
       FROM run_history rh
       WHERE rh.id BETWEEN $1::bigint AND $2::bigint
         AND rh.actor_type IS NULL AND rh.run_id IS NOT NULL AND rh.status <> 'running'
     ) found
     WHERE run_history.id = found.id
       AND found.actor_type IS NOT NULL
       AND run_history.actor_type IS NULL`,
    [lo, hi]
  );
  return { examined: Number(row.examined), filled: result.rowCount ?? 0, lastId: hi };
}

/**
 * One bounded round: the next `batchSize` terminal rows after `afterId` that
 * have no actor_type, filled from their run's terminal spine event.
 */
export function runRunHistoryActorBackfillRound(options: {
  readonly afterId: number;
  readonly batchSize?: number;
}): Promise<RunHistoryActorBackfillRound> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  return isPostgresStorageBackend()
    ? postgresRound(options.afterId, batchSize)
    : Promise.resolve(sqliteRound(options.afterId, batchSize));
}

/**
 * Walk run_history once, from the start, in bounded rounds. Yields to the event
 * loop between rounds. Stops at the end of the table or after `maxRounds`; the
 * next boot continues, because filled rows no longer match.
 */
export async function runStartupRunHistoryActorBackfillToCompletion(
  options: {
    readonly batchSize?: number;
    readonly maxRounds?: number;
    readonly onRound?: (round: RunHistoryActorBackfillRound, index: number) => void;
  } = {}
): Promise<RunHistoryActorBackfillSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let afterId = 0;
  let examined = 0;
  let filled = 0;
  let rounds = 0;
  let complete = false;
  while (rounds < maxRounds) {
    // biome-ignore lint/performance/noAwaitInLoops: each round starts after the previous round's last id.
    const round = await runRunHistoryActorBackfillRound({ afterId, batchSize });
    rounds += 1;
    examined += round.examined;
    filled += round.filled;
    options.onRound?.(round, rounds);
    if (round.lastId === null || round.examined < batchSize) {
      complete = true;
      break;
    }
    afterId = round.lastId;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { complete, examined, filled, rounds };
}
