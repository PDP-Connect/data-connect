// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Audit export (CSV) for a handful of children: every RS request that named
// the child's record, with its outcome, in the order it happened.
//
//   node export-audit.ts --children DR-0000001,DR-0000050,DR-0000123 \
//     [--from 2026-10-20T08:00:00Z --to 2026-10-20T12:00:00Z] \
//     [--database-url postgres://...] [--out out/audit-sample.csv]
//
// One row per request (query object): occurred_at, child_record_id, outcome
// (served | denied | no_outcome), reason (denial_reason or error code),
// http_status, records_served, grant_id, client_id, token_ref (the keyed HMAC
// reference; rows written before hashing show unhashed-legacy-row, never the
// bearer), trace_id, request_id. Revocations of the same grants are listed as
// outcome=grant_revoked rows so the revoke-then-deny sequence is visible.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1];
  }
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : fallback;
}

const COLUMNS = [
  "occurred_at",
  "child_record_id",
  "outcome",
  "reason",
  "http_status",
  "records_served",
  "grant_id",
  "client_id",
  "token_ref",
  "trace_id",
  "request_id",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Rows written before bearer hashing (server/audit-token-ref.ts) hold the raw
 * bearer in token_id; never copy one into an export.
 */
export function exportTokenRef(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  return value.startsWith("tkh_") ? value : "unhashed-legacy-row";
}

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  return `${[COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((c) => csvCell(row[c])).join(","))].join("\n")}\n`;
}

const QUERY = `
WITH received AS (
  SELECT object_id, trace_id, occurred_at, data_json->>'requested_record_id' AS child_record_id,
         grant_id, client_id, token_id
    FROM spine_events
   WHERE event_type = 'query.received'
     AND data_json->>'requested_record_id' = ANY($1::text[])
     AND ($2::text IS NULL OR occurred_at >= $2) AND ($3::text IS NULL OR occurred_at < $3)
),
requests AS (
  SELECT r.occurred_at, r.child_record_id,
         CASE WHEN o.event_type = 'disclosure.served' THEN 'served'
              WHEN o.event_type = 'query.rejected' THEN 'denied'
              ELSE 'no_outcome' END AS outcome,
         COALESCE(o.data_json->>'denial_reason', o.data_json->'error'->>'code') AS reason,
         CASE WHEN o.event_type = 'disclosure.served' THEN '200' ELSE o.data_json->'error'->>'http_status' END AS http_status,
         o.data_json->>'record_count' AS records_served,
         r.grant_id, r.client_id, r.token_id AS token_ref, r.trace_id, r.object_id AS request_id
    FROM received r
    LEFT JOIN spine_events o
      ON o.object_id = r.object_id AND o.trace_id = r.trace_id
     AND o.event_type IN ('disclosure.served', 'query.rejected')
),
revocations AS (
  SELECT v.occurred_at, NULL::text AS child_record_id, 'grant_revoked' AS outcome, NULL::text AS reason,
         NULL::text AS http_status, NULL::text AS records_served, v.grant_id, v.client_id,
         NULL::text AS token_ref, v.trace_id, v.object_id AS request_id
    FROM spine_events v
   WHERE v.event_type = 'grant.revoked' AND v.grant_id IN (SELECT DISTINCT grant_id FROM received WHERE grant_id IS NOT NULL)
)
SELECT * FROM requests
UNION ALL
SELECT * FROM revocations
ORDER BY occurred_at`;

async function main(): Promise<void> {
  const children = (arg("children") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (children.length === 0) {
    throw new Error("--children is required (comma-separated record ids)");
  }
  const from = arg("from") ? new Date(arg("from") as string).toISOString() : null;
  const to = arg("to") ? new Date(arg("to") as string).toISOString() : null;
  const databaseUrl = arg("database-url", process.env.VACUNA_DATABASE_URL || "postgres://pdpp:pdpp@localhost:55432/pdpp");
  const out = arg("out", "out/audit-sample.csv") as string;

  const client = new pg.Client({ application_name: "vacuna-audit-export", connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(QUERY, [children, from, to]);
    // Fill the child id on revocation rows from that grant's requests.
    const childByGrant = new Map<string, string>();
    for (const row of rows) {
      if (row.child_record_id && row.grant_id) {
        childByGrant.set(row.grant_id, childByGrant.get(row.grant_id) ?? row.child_record_id);
      }
    }
    for (const row of rows) {
      row.child_record_id ??= childByGrant.get(row.grant_id) ?? null;
      row.token_ref = exportTokenRef(row.token_ref);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toCsv(rows));
    console.log(`wrote ${rows.length} rows for ${children.length} children to ${out}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
