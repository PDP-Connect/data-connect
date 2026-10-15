// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pilot count job: reconcile paid reads across the four systems and check the
// audit invariants, for one run (a time window on the PDPP audit spine).
//
//   node reconcile.ts --run-id pilot-2026-10-20 \
//     --from 2026-10-20T08:00:00Z --to 2026-10-20T12:00:00Z \
//     --register-receipts register-receipts.jsonl \
//     --reminder-received http://127.0.0.1:9100/stats --reminder-received-field received \
//     --gateway-accepted gateway.json --gateway-accepted-field accepted \
//     [--client-id cli_...] [--database-url postgres://...] [--out ./out]
//
// From the spine (window = occurred_at in [from, to)):
//   requests          query.received rows (one per RS request, denials included)
//   served reads      disclosure.served rows; records served = sum(record_count)
//   denials by reason query.rejected grouped by denial_reason (auth gate:
//                     token_unknown, bearer_missing, grant_revoked, grant_expired,
//                     context.*) or error.code (not_found = outside the grant)
//   unresolved        query.received with no disclosure.served / query.rejected
//   after revocation  disclosure.served on a grant after its grant.revoked event
//   consent refusals  consent.denied (informational: no token, so no RS request)
//
// The three external counts are each one of: an integer; a JSON file or http(s)
// URL holding a number, an array (its length) or an object (field from
// --<name>-field, else "count"); a .jsonl / .ndjson file (non-empty lines); or a
// .csv file (data rows, header excluded).
//
// Pass when: paid reads are equal across all four sources; every request has an
// outcome; no record was served after revocation. Writes reconcile-<run>.json
// and reconcile-<run>.md to --out (default: ./out) and exits 1 on fail.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
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

function required(name: string): string {
  const value = arg(name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function toIso(value: string, name: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`--${name} is not a timestamp: ${value}`);
  }
  return new Date(ms).toISOString();
}

export interface ExternalCount {
  readonly count: number;
  readonly source: string;
}

function countFromJson(value: unknown, field: string | undefined, source: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    const key = field ?? "count";
    const n = (value as Record<string, unknown>)[key];
    if (typeof n === "number") {
      return n;
    }
    throw new Error(`${source}: field "${key}" is not a number`);
  }
  throw new Error(`${source}: expected a number, array or object`);
}

/** Resolve one external count input (see header for accepted forms). */
export async function readExternalCount(input: string, field?: string): Promise<ExternalCount> {
  if (/^\d+$/.test(input)) {
    return { count: Number(input), source: "literal" };
  }
  if (/^https?:\/\//.test(input)) {
    const resp = await fetch(input, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      throw new Error(`${input}: HTTP ${resp.status}`);
    }
    return { count: countFromJson(await resp.json(), field, input), source: input };
  }
  const text = readFileSync(input, "utf8");
  const ext = extname(input).toLowerCase();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (ext === ".jsonl" || ext === ".ndjson") {
    return { count: lines.length, source: input };
  }
  if (ext === ".csv") {
    return { count: Math.max(0, lines.length - 1), source: input };
  }
  return { count: countFromJson(JSON.parse(text), field, input), source: input };
}

export interface SpineCounts {
  readonly consent_refusals: number;
  readonly denials_by_reason: Record<string, number>;
  readonly denials_total: number;
  readonly records_served: number;
  readonly requests: number;
  readonly served_after_revocation: number;
  readonly served_after_revocation_max_lag_s: number | null;
  readonly served_reads: number;
  readonly unresolved_requests: number;
}

const WINDOW = "occurred_at >= $1 AND occurred_at < $2 AND ($3::text IS NULL OR client_id = $3)";

export async function readSpineCounts(
  client: pg.ClientBase,
  from: string,
  to: string,
  clientId: string | null
): Promise<SpineCounts> {
  const params = [from, to, clientId];
  const totals = await client.query<{ received: string; served: string; records: string; rejected: string }>(
    `SELECT count(*) FILTER (WHERE event_type = 'query.received') AS received,
            count(*) FILTER (WHERE event_type = 'disclosure.served') AS served,
            COALESCE(sum((data_json->>'record_count')::bigint) FILTER (WHERE event_type = 'disclosure.served'), 0) AS records,
            count(*) FILTER (WHERE event_type = 'query.rejected') AS rejected
       FROM spine_events
      WHERE object_type = 'query' AND ${WINDOW}`,
    params
  );
  const reasons = await client.query<{ reason: string; n: string }>(
    `SELECT COALESCE(data_json->>'denial_reason', data_json->'error'->>'code', 'unspecified') AS reason, count(*) AS n
       FROM spine_events
      WHERE event_type = 'query.rejected' AND ${WINDOW}
      GROUP BY 1 ORDER BY 2 DESC`,
    params
  );
  // A request is one query object_id; it is resolved when it has an outcome
  // event (served or rejected) anywhere at or after the window start.
  const unresolved = await client.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM spine_events r
      WHERE r.event_type = 'query.received' AND r.object_type = 'query' AND ${WINDOW.replaceAll("occurred_at", "r.occurred_at").replace("client_id", "r.client_id")}
        AND NOT EXISTS (
          SELECT 1 FROM spine_events o
           WHERE o.object_id = r.object_id AND o.trace_id = r.trace_id
             AND o.event_type IN ('disclosure.served', 'query.rejected'))`,
    params
  );
  const afterRevoke = await client.query<{ n: string; max_lag_s: string | null }>(
    `SELECT count(*) AS n,
            max(EXTRACT(EPOCH FROM (d.occurred_at::timestamptz - v.revoked_at::timestamptz))) AS max_lag_s
       FROM spine_events d
       JOIN (SELECT grant_id, min(occurred_at) AS revoked_at
               FROM spine_events WHERE event_type = 'grant.revoked' GROUP BY grant_id) v
         ON v.grant_id = d.grant_id
      WHERE d.event_type = 'disclosure.served' AND d.occurred_at > v.revoked_at
        AND ${WINDOW.replaceAll("occurred_at", "d.occurred_at").replace("client_id", "d.client_id")}`,
    params
  );
  const consent = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM spine_events WHERE event_type = 'consent.denied' AND ${WINDOW}`,
    params
  );
  const row = totals.rows[0];
  const denialsByReason = Object.fromEntries(reasons.rows.map((r) => [r.reason, Number(r.n)]));
  const lag = afterRevoke.rows[0]?.max_lag_s;
  return {
    consent_refusals: Number(consent.rows[0]?.n ?? 0),
    denials_by_reason: denialsByReason,
    denials_total: Number(row?.rejected ?? 0),
    records_served: Number(row?.records ?? 0),
    requests: Number(row?.received ?? 0),
    served_after_revocation: Number(afterRevoke.rows[0]?.n ?? 0),
    served_after_revocation_max_lag_s: lag === null || lag === undefined ? null : Number(lag),
    served_reads: Number(row?.served ?? 0),
    unresolved_requests: Number(unresolved.rows[0]?.n ?? 0),
  };
}

export interface Check {
  readonly detail: string;
  readonly name: string;
  readonly pass: boolean;
}

export function evaluate(spine: SpineCounts, external: Record<string, ExternalCount>): Check[] {
  const paid: Record<string, number> = { pdpp_audit_served_reads: spine.served_reads };
  for (const [name, value] of Object.entries(external)) {
    paid[name] = value.count;
  }
  const distinct = new Set(Object.values(paid));
  return [
    {
      detail: Object.entries(paid)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      name: "paid reads equal across PDPP audit, register receipts, reminder service, gateway",
      pass: distinct.size === 1,
    },
    {
      detail: `${spine.requests} requests, ${spine.served_reads} served + ${spine.denials_total} rejected, ${spine.unresolved_requests} without an outcome`,
      name: "every request audited with an outcome (denials included)",
      pass: spine.unresolved_requests === 0 && spine.requests === spine.served_reads + spine.denials_total,
    },
    {
      detail: `${spine.served_after_revocation} disclosures after their grant's revocation${
        spine.served_after_revocation_max_lag_s === null ? "" : ` (max ${spine.served_after_revocation_max_lag_s.toFixed(3)} s after)`
      }`,
      name: "0 records served after revocation",
      pass: spine.served_after_revocation === 0,
    },
  ];
}

export function renderMarkdown(report: {
  checks: Check[];
  external: Record<string, ExternalCount>;
  pass: boolean;
  run_id: string;
  spine: SpineCounts;
  window: { from: string; to: string; client_id: string | null };
}): string {
  const lines = [
    `# Reconciliation: ${report.run_id} - ${report.pass ? "PASS" : "FAIL"}`,
    "",
    `Window: ${report.window.from} to ${report.window.to}${report.window.client_id ? `, client ${report.window.client_id}` : ""}`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...report.checks.map((c) => `| ${c.name} | ${c.pass ? "pass" : "FAIL"} | ${c.detail} |`),
    "",
    "| PDPP audit spine | Count |",
    "|---|---:|",
    `| requests (query.received) | ${report.spine.requests} |`,
    `| served reads (disclosure.served) | ${report.spine.served_reads} |`,
    `| records served | ${report.spine.records_served} |`,
    `| denials (query.rejected) | ${report.spine.denials_total} |`,
    ...Object.entries(report.spine.denials_by_reason).map(([reason, n]) => `| - ${reason} | ${n} |`),
    `| requests without outcome | ${report.spine.unresolved_requests} |`,
    `| served after revocation | ${report.spine.served_after_revocation} |`,
    `| consent refusals (consent.denied) | ${report.spine.consent_refusals} |`,
    "",
    "| External count | Value | Source |",
    "|---|---:|---|",
    ...Object.entries(report.external).map(([k, v]) => `| ${k} | ${v.count} | ${v.source} |`),
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const runId = required("run-id");
  const from = toIso(required("from"), "from");
  const to = toIso(required("to"), "to");
  const clientId = arg("client-id") ?? null;
  const databaseUrl = arg("database-url", process.env.VACUNA_DATABASE_URL || "postgres://pdpp:pdpp@localhost:55432/pdpp");
  const outDir = arg("out", "out") as string;

  const external: Record<string, ExternalCount> = {
    gateway_accepted: await readExternalCount(required("gateway-accepted"), arg("gateway-accepted-field")),
    register_receipts: await readExternalCount(required("register-receipts"), arg("register-receipts-field")),
    reminder_received: await readExternalCount(required("reminder-received"), arg("reminder-received-field")),
  };

  const client = new pg.Client({ application_name: "vacuna-reconcile", connectionString: databaseUrl });
  await client.connect();
  let spine: SpineCounts;
  try {
    // One snapshot for all counts.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    spine = await readSpineCounts(client, from, to, clientId);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }

  const checks = evaluate(spine, external);
  const pass = checks.every((c) => c.pass);
  const report = {
    checks,
    external,
    generated_at: new Date().toISOString(),
    pass,
    run_id: runId,
    spine,
    window: { client_id: clientId, from, to },
  };
  mkdirSync(outDir, { recursive: true });
  const safeRun = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  const jsonPath = join(outDir, `reconcile-${safeRun}.json`);
  const mdPath = join(outDir, `reconcile-${safeRun}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`wrote ${jsonPath}\nwrote ${mdPath}`);
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
