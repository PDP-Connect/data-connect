// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { CONSOLE_OWNER_CLIENT_ID } from "../server/reference-local-defaults.ts";
import { jsonObject, type AppAccess } from "./app-access.ts";
import { historyDates, historyBackend, historyBounds, historyDaySql, historyLimit, historyPage, historyRows, type HistoryQuery, type HistoryBackend, type HistoryInput, type HistoryList } from "./history-query.ts";
export interface AppHistoryInput extends HistoryInput { client_ids?: string[] }
export interface AppReadSource { source_id: string; source_kind: string | null; connection_id: string | null; reads: number; records: number | null }
export interface AppReadDay {
  day: string; client_id: string; reads: number; across_sources: number; sources: AppReadSource[];
  last_at: string | null; last_refusal_at?: string | null; permission_refusals: number;
}
export interface AccessChange {
  id: string; trace_id: string; day: string; at: string; client_id: string;
  change: "allowed" | "not_allowed" | "removed"; source_id: string | null;
  source_kind: string | null; connection_id: string | null;
  sources?: { source_id: string; source_kind: string | null; connection_id: string | null }[];
}
export interface AppReadEntry {
  id: string; trace_id: string; at: string; client_id: string; shape: string | null;
  source_id: string | null; source_kind: string | null; connection_id: string | null;
  record_kind: string | null; records: number | null; metric: string | null;
  occurrences?: number;
  refused: boolean; reason: string | null;
}
export type AppHistory = (HistoryList<AppReadDay, "days"> & { changes: AccessChange[]; identities: AppAccess[] }) | (HistoryList<AppReadEntry, "reads"> & { discovery?: AppReadEntry[] });
/** Discovery describes available data rather than disclosing its contents. */
export const DISCOVERY_SHAPES = ["schema", "stream_list", "connector_list", "stream_metadata"] as const;
export const PERMISSION_REFUSALS = ["grant_invalid", "grant_revoked", "grant_expired", "field_not_granted", "grant_stream_not_allowed"] as const;
const accessTypes = "'consent.approved','consent.denied','grant.issued','grant.revoked','grant_package.issued','grant_package.revoked','client.deleted'";
function field(key: string, backend: HistoryBackend): string {
  return backend === "postgres" ? `e.data_json->>'${key}'` : `json_extract(e.data_json, '$.${key}')`;
}
export function appHistorySql(input: AppHistoryInput, backend: HistoryBackend, subjectId: string) {
  const [first, end] = historyBounds(input);
  const client = "coalesce(e.client_id, g.client_id)";
  const source = `coalesce(e.connector_instance_id, ${field("requested_connection_id", backend)}, e.source_id)`;
  const connection = `coalesce(e.connector_instance_id, ${field("requested_connection_id", backend)})`;
  const sourceKind = `CASE WHEN ${connection} IS NOT NULL THEN 'connector' ELSE e.source_kind END`;
  const shape = field("query_shape", backend);
  const reason = backend === "postgres" ? "e.data_json->'error'->>'code'" : "json_extract(e.data_json, '$.error.code')";
  const rawCount = `CAST(${field("record_count", backend)} AS TEXT)`;
  const countGuard = backend === "postgres" ? `${rawCount} ~ '^[0-9]{1,15}$'` : `length(${rawCount}) BETWEEN 1 AND 15 AND ${rawCount} NOT GLOB '*[^0-9]*'`;
  const records = `CASE WHEN ${countGuard} THEN CAST(${rawCount} AS BIGINT) END`;
  const values: unknown[] = [first, end, subjectId, subjectId, CONSOLE_OWNER_CLIENT_ID];
  let where = `e.occurred_at >= ? AND e.occurred_at < ? AND
    (e.subject_id = ? OR g.subject_id = ?) AND ${client} IS NOT NULL AND ${client} <> ?`;
  if (input.client_ids?.length) {
    where += ` AND ${client} IN (${input.client_ids.map(() => "?").join(",")})`; values.push(...input.client_ids);
  }
  if (input.connection_id) { where += ` AND (${source} = ? OR ${connection} = ?)`; values.push(input.connection_id, input.connection_id); }
  const from = "FROM spine_events e LEFT JOIN grants g ON g.grant_id=e.grant_id";
  return { client, source, sourceKind, connection, shape, reason, records, values, where, from };
}
export async function readAppHistory(subjectId: string, input: AppHistoryInput, backend: HistoryBackend = historyBackend(), query?: HistoryQuery): Promise<AppHistory> {
  const paging = !input.day && input.days ? appHistorySql({...input,first:"1970-01-01",last:"9999-12-30",before:undefined},backend,subjectId) : null;
  const page = paging ? await historyDates(input,backend,query,paging.from,"e.occurred_at",`${paging.where} AND e.event_type IN ('disclosure.served','query.rejected',${accessTypes})`,paging.values) : null;
  if (page?.empty) return {mode:"days",data:[],changes:[],identities:[],has_more:false,next_cursor:null,...page.dates};
  const { client, source, sourceKind, connection, shape, reason, records, values, where, from } = appHistorySql(page?.input ?? input, backend, subjectId);
  if (input.day) {
    if (!input.client_ids?.length) throw new RangeError("A single day requires an app");
    const discoveryOnly = `${shape} IN (${DISCOVERY_SHAPES.map(value=>`'${value}'`).join(",")})`;
    const discoveryRows = await historyRows<AppReadEntry & { occurrences: number | string }>(`SELECT ${shape} AS shape,
      ${source} AS source_id, ${sourceKind} AS source_kind, ${connection} AS connection_id,
      coalesce(e.stream_id, ${field("requested_stream",backend)}) AS record_kind,
      MAX(e.occurred_at) AS at, COUNT(*) AS occurrences ${from}
      WHERE ${where} AND e.event_type='disclosure.served' AND ${discoveryOnly}
      GROUP BY ${shape}, ${source}, ${sourceKind}, ${connection}, coalesce(e.stream_id, ${field("requested_stream",backend)})
      ORDER BY MAX(e.occurred_at) DESC`,values,backend,query);
    const discovery = discoveryRows.map((row,index)=>({...row,id:`discovery-${index}`,trace_id:"",client_id:input.client_ids?.[0] ?? "",records:null,metric:null,refused:false,reason:null,occurrences:Number(row.occurrences)}));
    const limit = historyLimit(input);
    let pageWhere = where;
    if (input.cursor) {
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as [string, string];
      if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== "string" || typeof cursor[1] !== "string") throw new RangeError("Invalid cursor");
      pageWhere += " AND (e.occurred_at < ? OR (e.occurred_at = ? AND e.event_id < ?))";
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = await historyRows<AppReadEntry & { event_type: string }>(`SELECT e.event_id AS id, e.trace_id, e.occurred_at AS at,
      ${client} AS client_id, ${shape} AS shape, ${source} AS source_id, ${sourceKind} AS source_kind,
      ${connection} AS connection_id, coalesce(e.stream_id, ${field("requested_stream", backend)}) AS record_kind,
      ${records} AS records, ${field("metric", backend)} AS metric, e.event_type, ${reason} AS reason
      ${from} WHERE ${pageWhere} AND e.event_type IN ('disclosure.served','query.rejected')
      AND NOT (e.event_type='disclosure.served' AND coalesce(${shape},'') IN (${DISCOVERY_SHAPES.map(value=>`'${value}'`).join(",")}))
      ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT ?`, [...values, limit + 1], backend, query);
    const data = rows.map(({ event_type, ...row }) => ({ ...row, records: row.records === null ? null : Number(row.records), refused: event_type === "query.rejected" }));
    return { ...historyPage(data, limit, "reads", row => Buffer.from(JSON.stringify([row.at, row.id])).toString("base64url")), discovery };
  }
  const day = historyDaySql("e.occurred_at", backend, input.offset);
  const disclosure = `e.event_type='disclosure.served' AND coalesce(${shape},'') NOT IN (${DISCOVERY_SHAPES.map(value => `'${value}'`).join(",")})`;
  const refusal = `e.event_type='query.rejected' AND ${reason} IN (${PERMISSION_REFUSALS.map(value => `'${value}'`).join(",")})`;
  const grouped = await historyRows<Record<string, unknown>>(`SELECT ${day} AS day, ${client} AS client_id,
    ${source} AS source_id, ${sourceKind} AS source_kind, ${connection} AS connection_id,
    SUM(CASE WHEN ${disclosure} THEN 1 ELSE 0 END) AS reads,
    SUM(CASE WHEN ${disclosure} THEN ${records} END) AS records,
    MAX(CASE WHEN ${disclosure} THEN e.occurred_at END) AS last_at,
    MAX(CASE WHEN ${refusal} THEN e.occurred_at END) AS last_refusal_at,
    SUM(CASE WHEN ${refusal} THEN 1 ELSE 0 END) AS permission_refusals
    ${from} WHERE ${where} AND e.event_type IN ('disclosure.served','query.rejected')
    GROUP BY ${day}, ${client}, ${source}, ${sourceKind}, ${connection}`, values, backend, query);
  const days = new Map<string, AppReadDay>();
  for (const row of grouped) {
    const reads = Number(row.reads); const refused = Number(row.permission_refusals);
    if (!reads && !refused) continue;
    const key = `${row.day}\0${row.client_id}`;
    let entry = days.get(key);
    if (!entry) { entry = { day: String(row.day), client_id: String(row.client_id), reads: 0, across_sources: 0, sources: [], last_at: null, permission_refusals: 0 }; days.set(key, entry); }
    if (row.last_refusal_at && String(row.last_refusal_at) > (entry.last_refusal_at ?? "")) entry.last_refusal_at = String(row.last_refusal_at);
    entry.reads += reads; entry.permission_refusals += refused;
    if (row.last_at && (!entry.last_at || String(row.last_at) > entry.last_at)) entry.last_at = String(row.last_at);
    if (row.source_id && reads) entry.sources.push({ source_id: String(row.source_id), source_kind: row.source_kind as string | null, connection_id: row.connection_id as string | null, reads, records: row.records === null ? null : Number(row.records) });
    else entry.across_sources += reads;
  }
  for (const entry of days.values()) entry.sources.sort((a,b) => b.reads-a.reads || a.source_id.localeCompare(b.source_id));
  const changes = await historyRows<AccessChange>(`SELECT e.event_id AS id, e.trace_id, ${day} AS day,
    e.occurred_at AS at, ${client} AS client_id,
    CASE WHEN e.event_type='consent.denied' THEN 'not_allowed' WHEN e.event_type IN ('grant.revoked','grant_package.revoked','client.deleted') THEN 'removed' ELSE 'allowed' END AS change,
    ${source} AS source_id, ${sourceKind} AS source_kind, ${connection} AS connection_id
    ${from} WHERE ${where} AND e.event_type IN (${accessTypes})
    ORDER BY e.occurred_at DESC, e.event_id DESC`, values, backend, query);
  const byDecision = new Map<string,AccessChange>();
  for (const change of changes) {
    const key = `${change.trace_id}\0${change.client_id}\0${change.change}`;
    const existing = byDecision.get(key);
    const source = change.source_id ? {source_id:change.source_id,source_kind:change.source_kind,connection_id:change.connection_id} : null;
    if (!existing) byDecision.set(key,{...change,sources:source ? [source] : []});
    else if (source && !existing.sources?.some(row=>JSON.stringify(row)===JSON.stringify(source))) existing.sources?.push(source);
  }
  const decisions = [...byDecision.values()];
  const ids = [...new Set([...days.values()].map(row => row.client_id).concat(changes.map(row=>row.client_id)))];
  const metadata = ids.length ? await historyRows<{client_id: string; metadata_json: unknown}>(`SELECT client_id, metadata_json FROM oauth_clients WHERE client_id IN (${ids.map(()=>"?").join(",")})`,ids,backend,query) : [];
  const identities: AppAccess[] = ids.map(id => {
    const data = jsonObject(metadata.find(row=>row.client_id===id)?.metadata_json);
    let host: string | null = null;
    try { if (Array.isArray(data.redirect_uris) && typeof data.redirect_uris[0] === "string") host = new URL(data.redirect_uris[0]).hostname; } catch { /* unknown address */ }
    return { client_id: id, client_name: typeof data.client_name === "string" ? data.client_name : "", return_host: host, returns_to_this_computer: host !== null && ["localhost","127.0.0.1","[::1]"].includes(host), domain_control_verified: false, sources: [], reads_last_7_days: 0 };
  });
  return { mode: "days", identities, data: [...days.values()].sort((a,b) => b.day.localeCompare(a.day) || (b.last_at ?? "").localeCompare(a.last_at ?? "") || a.client_id.localeCompare(b.client_id)), changes: decisions, has_more: Boolean(page?.dates.before_day), next_cursor: null, ...page?.dates };
}
