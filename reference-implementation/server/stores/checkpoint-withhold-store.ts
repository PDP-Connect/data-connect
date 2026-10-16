// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive checkpoint-withhold outcomes per cursor scope.
 *
 * last_run_id stores a versioned JSON ledger of observed run identities.
 * Commits retain a tombstone so replaying an older outcome cannot reset or
 * recreate a newer streak. Legacy scalar run ids are upgraded on first write.
 * Replay fencing covers only the most recent CHECKPOINT_REPLAY_HORIZON distinct
 * runs. Without a replay-stable run ordinal, an evicted run is indistinguishable
 * from a new run: its replay can increment, reset, or restart a streak. This
 * bounded best-effort history affects stall signals only, never cursors/data.
 */
import { iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

export const CHECKPOINT_REPLAY_HORIZON = 64;

/** The scope a checkpoint commits under. Absent ids are stored as "". */
export interface CheckpointScope {
  readonly connectorId: string;
  readonly connectorInstanceId: string | null;
  readonly grantId: string | null;
}

export interface RecordCheckpointOutcomesInput {
  readonly committed: readonly string[];
  readonly nowIso: string;
  readonly runId: string;
  readonly scope: CheckpointScope;
  readonly withheld: ReadonlyMap<string, string>;
}

export interface CheckpointWithholdStore {
  recordCheckpointOutcomes: (input: RecordCheckpointOutcomesInput) => Promise<Map<string, number>>;
}

interface StreakRow {
  readonly consecutive_runs: number | string;
  readonly committed: boolean | number;
}

/**
 * Both backends make the membership test and update in one atomic upsert.
 * The marker distinguishes our ledger from legacy scalar run ids.
 */
function upsertOutcome(postgres: boolean): string {
  const p = (n: number) => postgres ? `$${n}` : `?${n}`;
  const row = "connector_checkpoint_withholds";
  const stored = `${row}.last_run_id`;
  const versioned = `substr(${stored}, 1, 3) = 'v1:'`;
  const history = postgres
    ? `CASE WHEN ${versioned} THEN substr(${stored}, 4)::jsonb ELSE jsonb_build_object('runs', jsonb_build_array(${stored}), 'committed', false) END`
    : `CASE WHEN ${versioned} THEN substr(${stored}, 4) ELSE json_object('runs', json_array(${stored}), 'committed', 0) END`;
  const seen = postgres
    ? `((${history})->'runs') @> jsonb_build_array(${p(6)}::text)`
    : `EXISTS (SELECT 1 FROM json_each(${history}, '$.runs') WHERE value = ${p(6)})`;
  const wasCommitted = postgres
    ? `((${history})->>'committed')::boolean`
    : `json_extract(${history}, '$.committed') = 1`;
  // Retain the newest N - 1 identities, then append this unseen run. Ordering
  // is explicit on both backends; this also compacts oversized v1 histories.
  const retainedRuns = postgres
    ? `(SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) FROM (SELECT value, ord FROM jsonb_array_elements((${history})->'runs') WITH ORDINALITY AS runs(value, ord) ORDER BY ord DESC LIMIT ${CHECKPOINT_REPLAY_HORIZON - 1}) recent)`
    : `(SELECT json_group_array(value) FROM (SELECT value FROM (SELECT value, key FROM json_each(${history}, '$.runs') ORDER BY key DESC LIMIT ${CHECKPOINT_REPLAY_HORIZON - 1}) recent ORDER BY key))`;
  const nextLedger = postgres
    ? `'v1:' || jsonb_build_object('runs', ${retainedRuns} || jsonb_build_array(${p(6)}::text), 'committed', ${p(8)} = 1)::text`
    : `'v1:' || json_object('runs', json(json_insert(${retainedRuns}, '$[#]', ${p(6)})), 'committed', ${p(8)})`;
  const committedResult = postgres
    ? "CASE WHEN substr(last_run_id, 1, 3) = 'v1:' THEN (substr(last_run_id, 4)::jsonb->>'committed')::boolean ELSE false END"
    : "CASE WHEN substr(last_run_id, 1, 3) = 'v1:' THEN json_extract(substr(last_run_id, 4), '$.committed') ELSE 0 END";
  return `
    INSERT INTO connector_checkpoint_withholds
      (connector_id, connector_instance_id, grant_id, state_stream, reason_key, consecutive_runs, last_run_id, updated_at)
    VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, 1, ${p(9)}, ${p(7)})
    ON CONFLICT (connector_id, connector_instance_id, grant_id, state_stream) DO UPDATE SET
      consecutive_runs = CASE
        WHEN ${seen} THEN ${row}.consecutive_runs
        WHEN ${p(8)} = 1 OR ${wasCommitted} OR ${row}.reason_key <> excluded.reason_key THEN 1
        ELSE ${row}.consecutive_runs + 1
      END,
      reason_key = CASE WHEN ${seen} THEN ${row}.reason_key ELSE excluded.reason_key END,
      last_run_id = CASE WHEN ${seen} THEN ${stored} ELSE ${nextLedger} END,
      updated_at = CASE WHEN ${seen} THEN ${row}.updated_at ELSE excluded.updated_at END
    RETURNING consecutive_runs, ${committedResult} AS committed`;
}

function outcomeParams(
  input: RecordCheckpointOutcomesInput, stateStream: string, reasonKey: string, committed: boolean
): (string | number)[] {
  return [
    input.scope.connectorId, input.scope.connectorInstanceId || "", input.scope.grantId || "",
    stateStream, reasonKey, input.runId, input.nowIso, committed ? 1 : 0,
    `v1:${JSON.stringify({ runs: [input.runId], committed })}`,
  ];
}

function readCount(row: StreakRow | undefined): number {
  if (row?.committed) {
    return 0;
  }
  const count = Number(row?.consecutive_runs);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Checkpoint withhold streak is invalid.");
  }
  return count;
}

function createSqliteCheckpointWithholdStore(): CheckpointWithholdStore {
  const template = upsertOutcome(false);
  // The SQLite adapter binds anonymous positional parameters, not ?N names.
  const positions = [...template.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]) - 1);
  const sql = template.replace(/\?\d+/g, "?");
  const params = (input: RecordCheckpointOutcomesInput, stream: string, reason: string, committed: boolean) => {
    const values = outcomeParams(input, stream, reason, committed);
    return positions.map((position) => values[position] as string | number);
  };
  return {
    recordCheckpointOutcomes(input) {
      const counts = writeTransaction(() => {
        const result = new Map<string, number>();
        for (const stateStream of input.committed) {
          // REVIEWED-DYNAMIC: fixed atomic upsert with bound outcome parameters.
          Array.from(iterateDynamicSqlAcknowledged<StreakRow>(sql, params(input, stateStream, "", true)));
        }
        for (const [stateStream, reasonKey] of input.withheld) {
          // REVIEWED-DYNAMIC: fixed atomic upsert; BEGIN IMMEDIATE serializes writers.
          const [row] = [...iterateDynamicSqlAcknowledged<StreakRow>(sql, params(input, stateStream, reasonKey, false))];
          result.set(stateStream, readCount(row));
        }
        return result;
      });
      return Promise.resolve(counts);
    },
  };
}

function createPostgresCheckpointWithholdStore(): CheckpointWithholdStore {
  const sql = upsertOutcome(true);
  return {
    async recordCheckpointOutcomes(input) {
      for (const stateStream of input.committed) {
        // biome-ignore lint/performance/noAwaitInLoops: one atomic statement per staged cursor.
        await postgresQuery(sql, outcomeParams(input, stateStream, "", true));
      }
      const result = new Map<string, number>();
      for (const [stateStream, reasonKey] of input.withheld) {
        // biome-ignore lint/performance/noAwaitInLoops: one atomic statement per staged cursor.
        const { rows } = await postgresQuery<StreakRow>(sql, outcomeParams(input, stateStream, reasonKey, false));
        result.set(stateStream, readCount(rows[0]));
      }
      return result;
    },
  };
}

export function getDefaultCheckpointWithholdStore(): CheckpointWithholdStore {
  return isPostgresStorageBackend() ? createPostgresCheckpointWithholdStore() : createSqliteCheckpointWithholdStore();
}
