// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { getDb } from "../server/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";

export interface HistoryInput {
  first: string;
  before?: string;
  days?: number;
  last: string;
  /** Minutes east of UTC (the negative of Date.getTimezoneOffset()). */
  offset: number;
  connection_id?: string;
  day?: string;
  limit?: number;
  cursor?: string;
}
/** A history request with bad input from the client; routes answer it with 400 and this fixed message. */
export class HistoryInputError extends RangeError {
  override readonly name = "HistoryInputError";
}
/** Decodes a page cursor the client sent back; anything unreadable is bad input, not a server failure. */
export function decodeHistoryCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch {
    throw new HistoryInputError("Invalid cursor");
  }
}
function validHistoryDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function decodeHistoryPageCursor(value: string, idPattern: RegExp): [string, string] {
  const cursor = decodeHistoryCursor(value);
  if (!Array.isArray(cursor) || cursor.length !== 2 ||
    typeof cursor[0] !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(cursor[0]) ||
    !Number.isFinite(Date.parse(cursor[0])) || !validHistoryDay(cursor[0].slice(0, 10)) ||
    typeof cursor[1] !== "string" || !idPattern.test(cursor[1])) throw new HistoryInputError("Invalid cursor");
  return [cursor[0], cursor[1]];
}
export type HistoryBackend = "sqlite" | "postgres";
export function historyBackend(): HistoryBackend {
  return isPostgresStorageBackend() ? "postgres" : "sqlite";
}
export function historyBounds(input: HistoryInput): [string, string] {
  if (!validHistoryDay(input.first) || !validHistoryDay(input.last) || (input.day && !validHistoryDay(input.day)) || (input.before && !validHistoryDay(input.before)) ||
      (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 366)) ||
      !Number.isInteger(input.offset) || Math.abs(input.offset) > 840 || input.first > input.last ||
      (input.day && (input.day < input.first || input.day > input.last))) {
    throw new HistoryInputError("Invalid history day range or UTC distance");
  }
  const shift = input.offset * 60_000;
  return [new Date(Date.parse(input.day ?? input.first) - shift).toISOString(),
    new Date(Date.parse(input.day ?? input.last) + 86_400_000 - shift).toISOString()];
}
export function historyDaySql(column: string, backend: HistoryBackend, offset: number): string {
  return backend === "postgres"
    ? `to_char((${column})::timestamptz AT TIME ZONE 'UTC' + interval '${offset} minutes', 'YYYY-MM-DD')`
    : `date(${column}, '${offset} minutes')`;
}
export type HistoryQuery = (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
export async function historyRows<T>(sql: string, values: unknown[], backend: HistoryBackend, query: HistoryQuery = postgresQuery): Promise<T[]> {
  if (backend === "sqlite") return getDb().prepare(sql).all(...values) as T[];
  let index = 0;
  return (await query(sql.replaceAll("?", () => `$${++index}`), values)).rows as T[];
}
export interface HistoryList<T, M extends string> {
  first_day?: string | null;
  before_day?: string | null;
  mode: M;
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}
export function historyPage<T, M extends string>(rows: T[], limit: number, mode: M, cursor: (row: T) => string): HistoryList<T, M> {
  const more = rows.length > limit;
  const data = rows.slice(0, limit);
  return { mode, data, has_more: more, next_cursor: more && data.length ? cursor(data[data.length - 1] as T) : null };
}
export function historyLimit(input: HistoryInput): number {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HistoryInputError("Invalid page size");
  return limit;
}

export interface HistoryDates { first_day: string | null; before_day: string | null }
/** Date pages are independent of row cursors; the next page never repeats a day. */
export async function historyDates(input: HistoryInput, backend: HistoryBackend, query: HistoryQuery | undefined,
  from: string, time: string, where: string, values: unknown[]): Promise<{ input: HistoryInput; dates: HistoryDates; empty: boolean }> {
  const day = historyDaySql(time,backend,input.offset);
  const dates = await historyRows<{day:string}>(`SELECT DISTINCT ${day} AS day ${from} WHERE ${where} ORDER BY day DESC`,values,backend,query);
  const first_day = dates.at(-1)?.day ?? null;
  const eligible = dates.filter(row => row.day >= input.first && row.day <= input.last && (!input.before || row.day < input.before));
  const count = input.days ?? eligible.length;
  if (!Number.isInteger(count) || count < 0 || (input.days !== undefined && (count < 1 || count > 366))) throw new HistoryInputError("Invalid day page size");
  const selected = eligible.slice(0,count);
  return { empty: selected.length === 0, input: { ...input, first: selected.at(-1)?.day ?? input.last, last: selected[0]?.day ?? input.last },
    dates: { first_day, before_day: eligible.length > selected.length ? selected.at(-1)?.day ?? null : null } };
}
