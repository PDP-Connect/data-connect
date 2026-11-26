// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { historyBackend, historyBounds, historyDaySql, historyLimit, historyPage, historyRows, type HistoryQuery, type HistoryBackend, type HistoryInput, type HistoryList } from "./history-query.ts";
export type SyncOutcome = "finished" | "failed" | "stopped" | "interrupted" | "could_not_start" | "syncing";
export interface SyncHistoryInput extends HistoryInput { only_problems?: boolean; run_id?: string }
export interface SyncDay {
  day: string; connection_id: string; connector_id: string;
  ran: number; finished: number; failed: number; stopped: number; interrupted: number;
  could_not_start: number; records: number; last_at: string | null;
  last_outcome: SyncOutcome | null; manual: number; cause: string | null;
}
export interface SyncEntry {
  id: string | null; history_id: string; connection_id: string; connector_id: string;
  at: string; started_at: string; completed_at: string | null; outcome: SyncOutcome;
  records: number; trigger: string | null; cause: string | null;
}
export type SyncHistory = HistoryList<SyncDay, "days"> | HistoryList<SyncEntry, "syncs">;
const time = "coalesce(completed_at, started_at)";
const ran = "status IN ('succeeded','failed','cancelled','abandoned')";
const outcome = `CASE status WHEN 'succeeded' THEN 'finished' WHEN 'cancelled' THEN 'stopped' WHEN 'abandoned' THEN 'interrupted' WHEN 'skipped' THEN 'could_not_start' WHEN 'surface_failed' THEN 'could_not_start' WHEN 'running' THEN 'syncing' ELSE 'failed' END`;
export async function readSyncHistory(input: SyncHistoryInput, backend: HistoryBackend = historyBackend(), query?: HistoryQuery): Promise<SyncHistory> {
  const [first, end] = historyBounds(input);
  const values: unknown[] = [first, end];
  let where = `${time} >= ? AND ${time} < ?`;
  if (input.connection_id) { where += " AND connector_instance_id = ?"; values.push(input.connection_id); }
  if (input.day || input.run_id) {
    if (input.run_id) { where += " AND run_id = ?"; values.push(input.run_id); }
    if (!input.connection_id && !input.run_id) throw new RangeError("A single day requires a connection");
    const limit = historyLimit(input);
    if (input.cursor) {
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as [string, string];
      if (!Array.isArray(cursor) || cursor.length !== 2 || !/^\d+$/.test(cursor[1])) throw new RangeError("Invalid cursor");
      where += ` AND (${time} < ? OR (${time} = ? AND id < ?))`;
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = await historyRows<SyncEntry>(`SELECT run_id AS id, CAST(id AS TEXT) AS history_id,
      connector_instance_id AS connection_id, connector_id, ${time} AS at, started_at, completed_at,
      ${outcome} AS outcome, records_emitted AS records, trigger_kind AS trigger,
      coalesce(failure_reason, terminal_reason, error) AS cause FROM run_history
      WHERE ${where} ORDER BY ${time} DESC, id DESC LIMIT ?`, [...values, limit + 1], backend, query);
    return historyPage(rows, limit, "syncs", (row) => Buffer.from(JSON.stringify([row.at, row.history_id])).toString("base64url"));
  }
  const day = historyDaySql(time, backend, input.offset);
  const rows = await historyRows<Record<string, unknown>>(`WITH bucketed AS (
    SELECT *, ${day} AS day, ROW_NUMBER() OVER (PARTITION BY ${day}, connector_instance_id
      ORDER BY CASE WHEN ${ran} THEN 0 ELSE 1 END, ${time} DESC, id DESC) AS latest
    FROM run_history WHERE ${where}
  ) SELECT day, connector_instance_id AS connection_id, MAX(connector_id) AS connector_id,
    SUM(CASE WHEN ${ran} THEN 1 ELSE 0 END) AS ran,
    SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS finished,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS stopped,
    SUM(CASE WHEN status='abandoned' THEN 1 ELSE 0 END) AS interrupted,
    SUM(CASE WHEN status IN ('skipped','surface_failed') THEN 1 ELSE 0 END) AS could_not_start,
    SUM(CASE WHEN ${ran} THEN records_emitted ELSE 0 END) AS records,
    MAX(CASE WHEN latest=1 THEN ${time} END) AS last_at,
    MAX(CASE WHEN latest=1 THEN ${outcome} END) AS last_outcome,
    SUM(CASE WHEN ${ran} AND trigger_kind='manual' THEN 1 ELSE 0 END) AS manual,
    MAX(CASE WHEN latest=1 AND status='failed' THEN coalesce(failure_reason,terminal_reason,error) END) AS cause
    FROM bucketed GROUP BY day, connector_instance_id ORDER BY day DESC, last_at DESC, connection_id`, values, backend, query);
  const data = rows.map((row) => {
    for (const key of ["ran","finished","failed","stopped","interrupted","could_not_start","records","manual"]) row[key] = Number(row[key]);
    return row as unknown as SyncDay;
  }).filter((row) => !input.only_problems || row.failed + row.stopped + row.interrupted > 0);
  return { mode: "days", data, has_more: false, next_cursor: null };
}
