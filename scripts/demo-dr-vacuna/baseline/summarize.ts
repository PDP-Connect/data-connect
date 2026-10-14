// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Print a Markdown summary of loadgen result files:
//   node summarize.ts results/*.json
// "Sustained" is the highest-throughput stage that met both criteria
// (errors <= 0.1%, p95 <= 500 ms).

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const TOTAL_REQUESTS = 4_320_800;

interface Stage {
  audit: { query_received: number; query_rejected: number; requests_answered: number; spine_rows_total: number };
  concurrency: number;
  counts: { cross: number; ok: number; revoked: number };
  cpu_pg_container_pct: number;
  cpu_server_pct: number;
  error_rate: number;
  latency_ms_all: { p50: number; p95: number; p99: number };
  pass: boolean;
  requests_sent_incl_warmup: { cross: number; ok: number; revoked: number };
  rps: number;
  rps_ok: number;
  wal: { bytes_per_request: number | null };
}

const rows: string[] = [];
const detail: string[] = [];
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { label: string; stages: Stage[] };
  const passing = run.stages.filter((s) => s.pass);
  const best = passing.reduce<Stage | null>((a, s) => (a === null || s.rps > a.rps ? s : a), null);
  const maxConc = passing.reduce((m, s) => Math.max(m, s.concurrency), 0);
  const firstFail = run.stages.find((s) => !s.pass);
  if (best) {
    const hours = TOTAL_REQUESTS / best.rps / 3600;
    rows.push(
      `| ${run.label} | ${best.rps} | ${best.rps_ok} | ${best.concurrency} | ${best.latency_ms_all.p50} / ${best.latency_ms_all.p95} / ${best.latency_ms_all.p99} | ${(best.error_rate * 100).toFixed(3)}% | ${maxConc} | ${firstFail ? `${firstFail.concurrency} (${firstFail.error_rate > 0.001 ? `${(firstFail.error_rate * 100).toFixed(1)}% errors` : `p95 ${firstFail.latency_ms_all.p95} ms`})` : "none"} | ${hours.toFixed(2)} |`
    );
  }
  detail.push(`\n${run.label} (${basename(file)})\n`);
  detail.push("| conc | req/s | ok/s | p50 | p95 | p99 | err | server CPU | PG CPU | audited / answered | rejected / denied | WAL B/req |");
  detail.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of run.stages) {
    const denied = s.requests_sent_incl_warmup.revoked + s.requests_sent_incl_warmup.cross;
    detail.push(
      `| ${s.concurrency} | ${s.rps} | ${s.rps_ok} | ${s.latency_ms_all.p50} | ${s.latency_ms_all.p95} | ${s.latency_ms_all.p99} | ${(s.error_rate * 100).toFixed(3)}% | ${s.cpu_server_pct}% | ${s.cpu_pg_container_pct}% | ${s.audit.query_received} / ${s.audit.requests_answered} | ${s.audit.query_rejected} / ${denied} | ${s.wal.bytes_per_request} |`
    );
  }
}
console.log(
  "| config | sustained req/s | of which 200 | at conc | p50 / p95 / p99 ms | errors | max passing conc | first failing conc | hours for 4,320,800 |"
);
console.log("|---|---:|---:|---:|---|---:|---:|---|---:|");
console.log(rows.join("\n"));
console.log(detail.join("\n"));
