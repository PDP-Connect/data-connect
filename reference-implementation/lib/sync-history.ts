// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { decodeHistoryCursor, HistoryInputError, historyDates, historyBackend, historyBounds, historyDaySql, historyLimit, historyPage, historyRows, type HistoryQuery, type HistoryBackend, type HistoryInput, type HistoryList } from "./history-query.ts";
export type SyncOutcome = "finished" | "failed" | "stopped" | "interrupted" | "could_not_start" | "syncing";
export interface SyncHistoryInput extends HistoryInput { only_problems?: boolean; run_id?: string }
export interface SyncEvidence { reason: string | null; error: string | null; connector_error: unknown }
export interface SyncMissing { stream: string | null; retryable: boolean }
export interface SyncDay {
  day: string; connection_id: string; connector_id: string;
  ran: number; finished: number; failed: number; stopped: number; interrupted: number;
  could_not_start: number; records: number; last_at: string | null;
  last_outcome: SyncOutcome | null; manual: number; cause: string | null;
  evidence?: SyncEvidence; missing?: SyncMissing[];
}
export interface SyncEntry {
  id: string | null; history_id: string; connection_id: string; connector_id: string;
  at: string; started_at: string; completed_at: string | null; outcome: SyncOutcome;
  records: number; trigger: string | null; cause: string | null;
  evidence?: SyncEvidence; missing?: SyncMissing[];
}
export type SyncHistory = HistoryList<SyncDay, "days"> | HistoryList<SyncEntry, "syncs">;
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}
export function syncMissing(value: unknown): SyncMissing[] {
  const gaps = parsed(value);
  if (!Array.isArray(gaps)) return [];
  const missing = new Map<string, SyncMissing>();
  for (const raw of gaps) {
    const gap = parsed(raw);
    if (Array.isArray(gap)) { for (const item of syncMissing(gap)) missing.set(item.stream ?? "", item); continue; }
    if (!gap || typeof gap !== "object") continue;
    const item = gap as Record<string, unknown>;
    if ((item.kind === "run_failed" && item.reason === "connector_protocol_violation") || item.severity === "informational" || item.kind === "informational") continue;
    const stream = typeof item.stream === "string" ? item.stream : null;
    const retryable = (item.recovery_hint as { retryable?: unknown } | undefined)?.retryable === true;
    missing.set(stream ?? "", { stream, retryable });
  }
  return [...missing.values()];
}
const time = "coalesce(completed_at, started_at)";
const ran = "status IN ('succeeded','failed','cancelled','abandoned')";
const outcome = `CASE status WHEN 'succeeded' THEN 'finished' WHEN 'cancelled' THEN 'stopped' WHEN 'abandoned' THEN 'interrupted' WHEN 'skipped' THEN 'could_not_start' WHEN 'surface_failed' THEN 'could_not_start' WHEN 'running' THEN 'syncing' ELSE 'failed' END`;
export async function readSyncHistory(input: SyncHistoryInput, backend: HistoryBackend = historyBackend(), query?: HistoryQuery): Promise<SyncHistory> {
  historyBounds(input);
  const page = !input.day && !input.run_id && input.days ? await historyDates(input, backend, query, "FROM run_history", time,
    `status IN ('succeeded','failed','cancelled','abandoned','skipped','surface_failed')${input.connection_id ? " AND connector_instance_id = ?" : ""}`, input.connection_id ? [input.connection_id] : []) : null;
  if (page?.empty) return {mode:"days",data:[],has_more:false,next_cursor:null,...page.dates};
  const [first, end] = historyBounds(page?.input ?? input);
  const values: unknown[] = [first, end];
  const jsonText = (column: string) => `CAST(${column} AS TEXT)`;
  const gapsAggregate = backend === "postgres" ? "json_agg(known_gaps_json)" : "json_group_array(known_gaps_json)";
  let where = `${time} >= ? AND ${time} < ?`;
  if (input.connection_id) { where += " AND connector_instance_id = ?"; values.push(input.connection_id); }
  if (input.day || input.run_id) {
    if (input.run_id) { where += " AND run_id = ?"; values.push(input.run_id); }
    if (!input.connection_id && !input.run_id) throw new HistoryInputError("A single day requires a connection");
    const limit = historyLimit(input);
    if (input.cursor) {
      const cursor = decodeHistoryCursor(input.cursor) as [string, string];
      if (!Array.isArray(cursor) || cursor.length !== 2 || !/^\d+$/.test(cursor[1])) throw new HistoryInputError("Invalid cursor");
      where += ` AND (${time} < ? OR (${time} = ? AND id < ?))`;
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = await historyRows<SyncEntry & { raw_error: string | null; connector_error: unknown; gaps: unknown }>(`SELECT run_id AS id, CAST(id AS TEXT) AS history_id,
      connector_instance_id AS connection_id, connector_id, ${time} AS at, started_at, completed_at,
      ${outcome} AS outcome, records_emitted AS records, trigger_kind AS trigger,
      coalesce(failure_reason, terminal_reason, error) AS cause, error AS raw_error, connector_error_json AS connector_error, known_gaps_json AS gaps FROM run_history
      WHERE ${where} ORDER BY ${time} DESC, id DESC LIMIT ?`, [...values, limit + 1], backend, query);
    const entries = rows.map(({ raw_error, connector_error, gaps, ...row }) => ({ ...row,
      evidence: { reason: row.cause, error: raw_error, connector_error: parsed(connector_error) }, missing: syncMissing(gaps) }));
    return historyPage(entries, limit, "syncs", (row) => Buffer.from(JSON.stringify([row.at, row.history_id])).toString("base64url"));
  }
  const day = historyDaySql(time, backend, input.offset);
  const rows = await historyRows<Record<string, unknown>>(`WITH bucketed AS (
    SELECT *, ${day} AS day, ROW_NUMBER() OVER (PARTITION BY ${day}, connector_instance_id
      ORDER BY CASE WHEN ${ran} THEN 0 ELSE 1 END, ${time} DESC, id DESC) AS latest
    FROM run_history WHERE ${where} AND status IN ('succeeded','failed','cancelled','abandoned','skipped','surface_failed')
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
    MAX(CASE WHEN latest=1 AND status='failed' THEN coalesce(failure_reason,terminal_reason,error) END) AS cause,
    MAX(CASE WHEN latest=1 THEN error END) AS raw_error,
    MAX(CASE WHEN latest=1 THEN ${jsonText("connector_error_json")} END) AS connector_error,
    ${gapsAggregate} FILTER (WHERE status='succeeded' AND ${jsonText("known_gaps_json")} NOT IN ('[]','{}','null')) AS gaps
    FROM bucketed GROUP BY day, connector_instance_id ORDER BY day DESC, last_at DESC, connection_id`, values, backend, query);
  const data = rows.map((row) => {
    for (const key of ["ran","finished","failed","stopped","interrupted","could_not_start","records","manual"]) row[key] = Number(row[key]);
    const { raw_error, connector_error, gaps, ...fields } = row;
    return { ...fields, evidence: { reason: row.cause, error: raw_error, connector_error: parsed(connector_error) }, missing: syncMissing(gaps) } as unknown as SyncDay;
  }).filter((row) => !input.only_problems || row.failed + row.stopped + row.interrupted > 0 || Boolean(row.missing?.length));
  return { mode: "days", data, has_more: Boolean(page?.dates.before_day), next_cursor: null, ...page?.dates };
}
