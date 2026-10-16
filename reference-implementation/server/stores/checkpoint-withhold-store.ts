// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How many consecutive runs each staged checkpoint has been withheld for the
 * same reason.
 *
 * A withheld checkpoint is safe against data loss, not a liveness guarantee:
 * if the same reason recurs every run, the cursor never moves and the source
 * re-collects the same window forever. One run cannot tell a transient
 * shortfall from a stall, so the runtime records each run's outcome here and
 * reports a stall once the streak reaches a threshold.
 *
 * One row per (connector, connection, grant, state_stream): the scope a cursor
 * commits under (`PUT /v1/state/:connector_id`). A commit deletes the row; a
 * withhold for a different reason restarts the count at 1; recording the same
 * run twice (a replayed DONE) does not count it twice. A run that does not
 * stage the state stream leaves its row alone. Scheduling state only, never
 * evidence about the owner's data.
 */

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

/** The scope a checkpoint commits under. Absent ids are stored as "". */
export interface CheckpointScope {
  readonly connectorId: string;
  readonly connectorInstanceId: string | null;
  readonly grantId: string | null;
}

export interface RecordCheckpointOutcomesInput {
  /** State streams this run committed. */
  readonly committed: readonly string[];
  readonly nowIso: string;
  readonly runId: string;
  readonly scope: CheckpointScope;
  /** State streams this run withheld, each with a stable key for its reasons. */
  readonly withheld: ReadonlyMap<string, string>;
}

export interface CheckpointWithholdStore {
  /** Apply one run's outcomes; returns the consecutive-run count per withheld state stream. */
  recordCheckpointOutcomes: (input: RecordCheckpointOutcomesInput) => Promise<Map<string, number>>;
}

interface StreakRow {
  readonly consecutive_runs: number | string;
}

// Same statement on both backends: the existing row keeps counting only for
// the same reason and a new run.
const UPSERT_STREAK = (p: (n: number) => string) => `
  INSERT INTO connector_checkpoint_withholds
    (connector_id, connector_instance_id, grant_id, state_stream, reason_key, consecutive_runs, last_run_id, updated_at)
  VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, 1, ${p(6)}, ${p(7)})
  ON CONFLICT (connector_id, connector_instance_id, grant_id, state_stream) DO UPDATE SET
    consecutive_runs = CASE
      WHEN connector_checkpoint_withholds.reason_key <> excluded.reason_key THEN 1
      WHEN connector_checkpoint_withholds.last_run_id = excluded.last_run_id
        THEN connector_checkpoint_withholds.consecutive_runs
      ELSE connector_checkpoint_withholds.consecutive_runs + 1
    END,
    reason_key = excluded.reason_key,
    last_run_id = excluded.last_run_id,
    updated_at = excluded.updated_at
  RETURNING consecutive_runs`;

const DELETE_STREAK = (p: (n: number) => string) => `
  DELETE FROM connector_checkpoint_withholds
  WHERE connector_id = ${p(1)} AND connector_instance_id = ${p(2)} AND grant_id = ${p(3)} AND state_stream = ${p(4)}`;

function scopeParams(scope: CheckpointScope): [string, string, string] {
  return [scope.connectorId, scope.connectorInstanceId || "", scope.grantId || ""];
}

function readCount(row: StreakRow | undefined): number {
  const count = Number(row?.consecutive_runs);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Checkpoint withhold streak is invalid.");
  }
  return count;
}

function createSqliteCheckpointWithholdStore(): CheckpointWithholdStore {
  const sqlite = () => "?";
  return {
    recordCheckpointOutcomes({ committed, nowIso, runId, scope, withheld }) {
      const counts = writeTransaction(() => {
        const result = new Map<string, number>();
        for (const stateStream of committed) {
          // REVIEWED-DYNAMIC: fixed statement; a committed cursor ends its streak.
          execDynamicSqlAcknowledged(DELETE_STREAK(sqlite), [...scopeParams(scope), stateStream]);
        }
        for (const [stateStream, reasonKey] of withheld) {
          // REVIEWED-DYNAMIC: fixed upsert; BEGIN IMMEDIATE serializes the read-modify-write.
          const [row] = [
            ...iterateDynamicSqlAcknowledged<StreakRow>(UPSERT_STREAK(sqlite), [
              ...scopeParams(scope),
              stateStream,
              reasonKey,
              runId,
              nowIso,
            ]),
          ];
          result.set(stateStream, readCount(row));
        }
        return result;
      });
      return Promise.resolve(counts);
    },
  };
}

function createPostgresCheckpointWithholdStore(): CheckpointWithholdStore {
  const postgres = (n: number) => `$${n}`;
  return {
    async recordCheckpointOutcomes({ committed, nowIso, runId, scope, withheld }) {
      for (const stateStream of committed) {
        // biome-ignore lint/performance/noAwaitInLoops: one statement per staged state stream; a run stages few.
        await postgresQuery(DELETE_STREAK(postgres), [...scopeParams(scope), stateStream]);
      }
      const result = new Map<string, number>();
      for (const [stateStream, reasonKey] of withheld) {
        // Single-statement upsert: atomic per row without an explicit transaction.
        const { rows } = await postgresQuery<StreakRow>(UPSERT_STREAK(postgres), [
          ...scopeParams(scope),
          stateStream,
          reasonKey,
          runId,
          nowIso,
        ]);
        result.set(stateStream, readCount(rows[0]));
      }
      return result;
    },
  };
}

export function getDefaultCheckpointWithholdStore(): CheckpointWithholdStore {
  return isPostgresStorageBackend() ? createPostgresCheckpointWithholdStore() : createSqliteCheckpointWithholdStore();
}
