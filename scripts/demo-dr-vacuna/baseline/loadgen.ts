// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Closed-loop load generator for the DR vaccination-reminder access pattern.
//
// Each request reads one child's record with that child's own grant token:
//   ok       token of child i, record of child i            -> expect 200
//   revoked  token of a revoked grant, its own record        -> expect 403
//   cross    token of child i, record of another child j     -> expect 404
//   unknown  a bearer the AS never issued (--unknown-ratio)   -> expect 401
// The denied share defaults to the pilot ratio 400,000 / 4,320,800.
// --unknown-ratio (default 0) is carved out of that denied share; the pilot
// has 40,000 expired or malformed tokens, i.e. 0.0093.
//
// Concurrency ramps through --stages; the run stops at the first stage where
// unexpected responses exceed 0.1% or p95 exceeds 500 ms. Per stage it also
// samples server/Postgres CPU and pg_stat_activity, and counts the spine
// (audit) rows written, to check every request was audited.
//
// Usage:
//   node loadgen.ts [--stages 4,8,16,32,64,128] [--stage-seconds 30] [--warmup-seconds 5]
//                   [--grants 980200] [--deny-ratio 0.0926] [--unknown-ratio 0]
//                   [--label baseline]
//                   [--no-stop]
//                   [--tokens-file tokens.json] [--results-dir dir]
//
// --tokens-file replaces the baseline's derived tokens with real ones:
// { "active": [[childIndex, token], ...], "revoked": [[childIndex, token], ...] }.
// Revoked tokens may have expired by then, so a revoked read then expects
// 403 or 401.

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { Agent, request } from "undici";
import {
  argInt,
  argValue,
  DATABASE_URL,
  isRevokedIndex,
  REVOKE_MODULUS,
  REVOKE_REMAINDER,
  RS_URL,
  readRealTokens,
  tokenFor,
} from "./lib/common.ts";
import { childId } from "./lib/dataset.ts";
import { STREAM } from "./lib/manifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const stages = argValue("stages", "4,8,16,32,64,128")
  .split(",")
  .map((s) => Number.parseInt(s, 10));
const stageSeconds = argInt("stage-seconds", 30);
const warmupSeconds = argInt("warmup-seconds", 5);
const grantTotal = argInt("grants", 980_200);
const denyRatio = Number(argValue("deny-ratio", String(400_000 / 4_320_800)));
const unknownRatio = Number(argValue("unknown-ratio", "0"));
const label = argValue("label", "baseline");
const stopOnFail = !process.argv.includes("--no-stop");
const MAX_ERROR_RATE = 0.001;
const MAX_P95_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

type Kind = "ok" | "revoked" | "cross" | "unknown";
const EXPECTED: Record<Kind, number> = { cross: 404, ok: 200, revoked: 403, unknown: 401 };

const realTokens = readRealTokens();
const tokensFile = argValue("tokens-file", "");
const supplied = tokensFile
  ? (JSON.parse(readFileSync(tokensFile, "utf8")) as { active: [number, string][]; revoked: [number, string][] })
  : null;
const suppliedToken = new Map<number, string>([...(supplied?.active ?? []), ...(supplied?.revoked ?? [])]);
const tokenOf = (i: number) => suppliedToken.get(i) ?? tokenFor(i, realTokens);
let rngState = 0x5eed_1234;
function rand(): number {
  // xorshift32; deterministic request sequence per run.
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4_294_967_296;
}
function randomChild(): number {
  return 1 + Math.floor(rand() * grantTotal);
}
function randomActiveChild(): number {
  if (supplied) {
    return (supplied.active[Math.floor(rand() * supplied.active.length)] as [number, string])[0];
  }
  let i = randomChild();
  while (isRevokedIndex(i)) {
    i = randomChild();
  }
  return i;
}
function randomRevokedChild(): number {
  if (supplied) {
    return (supplied.revoked[Math.floor(rand() * supplied.revoked.length)] as [number, string])[0];
  }
  const slots = Math.floor((grantTotal - REVOKE_REMAINDER) / REVOKE_MODULUS) + 1;
  return Math.floor(rand() * slots) * REVOKE_MODULUS + REVOKE_REMAINDER;
}

function unknownToken(): string {
  // 64 hex chars, the shape the AS mints, but never issued.
  let hex = "";
  while (hex.length < 64) {
    hex += Math.floor(rand() * 4_294_967_296)
      .toString(16)
      .padStart(8, "0");
  }
  return hex.slice(0, 64);
}

function nextRequest(): { kind: Kind; record: number; token: string } {
  const roll = rand();
  if (roll < unknownRatio) {
    return { kind: "unknown", record: randomChild(), token: unknownToken() };
  }
  const known = denyRatio - unknownRatio;
  const shifted = roll - unknownRatio;
  if (shifted < known / 2) {
    const i = randomRevokedChild();
    return { kind: "revoked", record: i, token: tokenOf(i) };
  }
  if (shifted < known) {
    const i = randomActiveChild();
    let j = randomChild();
    while (j === i) {
      j = randomChild();
    }
    return { kind: "cross", record: j, token: tokenOf(i) };
  }
  const i = randomActiveChild();
  return { kind: "ok", record: i, token: tokenOf(i) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface Sample {
  kind: Kind;
  ms: number;
  ok: boolean;
  status: number;
}

const serverPid = (() => {
  const explicit = argValue("server-pid", "");
  if (explicit) {
    return explicit;
  }
  try {
    const port = new URL(RS_URL).port || "80";
    return execFileSync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return "";
  }
})();
const pgContainer = process.env.VACUNA_PG_CONTAINER || "pdpp-vacuna-pg";

const execFileAsync = promisify(execFile);

// Sampled asynchronously so monitoring never blocks the request lanes.
async function processCpu(pid: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "%cpu="]);
    return Number(stdout.trim());
  } catch {
    return Number.NaN;
  }
}

async function containerCpu(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      pgContainer,
    ]);
    return Number.parseFloat(stdout);
  } catch {
    return Number.NaN;
  }
}

const monitorPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

async function activitySnapshot(): Promise<Record<string, number>> {
  const { rows } = await monitorPool.query(
    `SELECT state || ':' || COALESCE(wait_event_type || '/' || wait_event, 'cpu') AS k, count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
        AND application_name NOT LIKE 'vacuna%'
      GROUP BY 1`
  );
  return Object.fromEntries(rows.map((r) => [r.k as string, r.n as number]));
}

async function spineWatermark(): Promise<number> {
  const { rows } = await monitorPool.query("SELECT COALESCE(max(event_seq), 0)::bigint AS m FROM spine_events");
  return Number(rows[0]?.m ?? 0);
}

async function walAndCheckpoints(): Promise<{ checkpoints: number; lsn: string }> {
  const { rows } = await monitorPool.query(
    `SELECT pg_current_wal_lsn()::text AS lsn,
            (checkpoints_timed + checkpoints_req)::int AS checkpoints
       FROM pg_stat_bgwriter`
  );
  return { checkpoints: Number(rows[0]?.checkpoints ?? 0), lsn: String(rows[0]?.lsn) };
}

async function walBytesBetween(from: string, to: string): Promise<number> {
  const { rows } = await monitorPool.query("SELECT pg_wal_lsn_diff($2::pg_lsn, $1::pg_lsn)::bigint AS b", [from, to]);
  return Number(rows[0]?.b ?? 0);
}

async function spineCountsSince(seq: number): Promise<Record<string, number>> {
  const { rows } = await monitorPool.query(
    "SELECT event_type, count(*)::int AS n FROM spine_events WHERE event_seq > $1 GROUP BY 1",
    [seq]
  );
  return Object.fromEntries(rows.map((r) => [r.event_type as string, r.n as number]));
}

async function runStage(concurrency: number) {
  const dispatcher = new Agent({ connections: concurrency, keepAliveTimeout: 30_000, pipelining: 1 });
  const samples: Sample[] = [];
  const counts = { cross: 0, ok: 0, revoked: 0, unknown: 0 };
  // Every completed request of the stage, warm-up and drain included, for
  // the audit-coverage check.
  const sent = { cross: 0, ok: 0, revoked: 0, unknown: 0 };
  let measuring = false;
  let stopping = false;
  let errorExample = "";

  const lane = async () => {
    while (!stopping) {
      const req = nextRequest();
      const started = performance.now();
      let status = 0;
      try {
        const res = await request(`${RS_URL}/v1/streams/${STREAM}/records/${childId(req.record)}`, {
          dispatcher,
          headers: { authorization: `Bearer ${req.token}` },
          headersTimeout: REQUEST_TIMEOUT_MS,
        });
        status = res.statusCode;
        await res.body.text();
      } catch (err) {
        errorExample ||= String((err as Error).message);
      }
      const ms = performance.now() - started;
      if (status !== 0) {
        sent[req.kind] += 1;
      }
      if (measuring) {
        const ok = status === EXPECTED[req.kind] || (supplied !== null && req.kind === "revoked" && status === 401);
        if (!(ok || errorExample)) {
          errorExample = `${req.kind} -> HTTP ${status}`;
        }
        samples.push({ kind: req.kind, ms, ok, status });
        const second = Math.floor((performance.now() - measureStart) / 1000);
        perSecond[second] = (perSecond[second] ?? 0) + 1;
        counts[req.kind] += 1;
      }
    }
  };

  const perSecond: number[] = [];
  let measureStart = 0;
  const lanes = Array.from({ length: concurrency }, lane);
  await new Promise((r) => setTimeout(r, warmupSeconds * 1000));
  measureStart = performance.now();
  measuring = true;
  const cpuServer: number[] = [];
  const cpuPg: number[] = [];
  const activity: Record<string, number>[] = [];
  const monitor = (async () => {
    while (measuring) {
      const [snap, srv, pgc] = await Promise.all([
        activitySnapshot(),
        serverPid ? processCpu(serverPid) : Promise.resolve(Number.NaN),
        containerCpu(),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      activity.push(snap);
      cpuServer.push(srv);
      cpuPg.push(pgc);
    }
  })();
  await new Promise((r) => setTimeout(r, stageSeconds * 1000));
  const measuredSeconds = (performance.now() - measureStart) / 1000;
  measuring = false;
  stopping = true;
  await Promise.all(lanes);
  await monitor;
  await dispatcher.close();

  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const okLat = samples
    .filter((s) => s.kind === "ok")
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
  const activityAvg: Record<string, number> = {};
  for (const snap of activity) {
    for (const [k, v] of Object.entries(snap)) {
      activityAvg[k] = (activityAvg[k] ?? 0) + v / activity.length;
    }
  }
  for (const k of Object.keys(activityAvg)) {
    activityAvg[k] = round(activityAvg[k] as number, 2);
  }
  return {
    concurrency,
    counts,
    cpu_pg_container_pct: round(avg(cpuPg)),
    cpu_server_pct: round(avg(cpuServer)),
    error_example: errorExample || null,
    error_rate: samples.length ? errors / samples.length : 0,
    errors,
    latency_ms_all: { p50: round(percentile(all, 50)), p95: round(percentile(all, 95)), p99: round(percentile(all, 99)) },
    latency_ms_ok: {
      p50: round(percentile(okLat, 50)),
      p95: round(percentile(okLat, 95)),
      p99: round(percentile(okLat, 99)),
    },
    measured_seconds: round(measuredSeconds, 2),
    pg_activity_avg: activityAvg,
    requests: samples.length,
    requests_sent_incl_warmup: sent,
    rps_timeline: Array.from({ length: stageSeconds }, (_, i) => perSecond[i] ?? 0),
    rps: round(samples.length / measuredSeconds),
    rps_ok: round(counts.ok / measuredSeconds),
  };
}

async function main() {
  const results = [];
  console.log(
    `label=${label} grants=${grantTotal} deny_ratio=${round(denyRatio, 4)} unknown_ratio=${round(unknownRatio, 4)} stage=${stageSeconds}s warmup=${warmupSeconds}s server_pid=${serverPid || "?"}`
  );
  console.log("conc  req/s  ok/s   p50   p95   p99  err%    srvCPU pgCPU  audit");
  for (const concurrency of stages) {
    const before = await spineWatermark();
    const walBefore = await walAndCheckpoints();
    const stage = await runStage(concurrency);
    const walAfter = await walAndCheckpoints();
    const walBytes = await walBytesBetween(walBefore.lsn, walAfter.lsn);
    // All lanes have finished, so every request of this stage is complete.
    const spine = await spineCountsSince(before);
    // Audit rows for the whole stage (warm-up included) against every
    // request that got an HTTP response in the stage.
    const sentTotal = Object.values(stage.requests_sent_incl_warmup).reduce((a, b) => a + b, 0);
    const audit = {
      coverage: sentTotal ? round((spine["query.received"] ?? 0) / sentTotal, 4) : null,
      disclosure_served: spine["disclosure.served"] ?? 0,
      query_received: spine["query.received"] ?? 0,
      query_rejected: spine["query.rejected"] ?? 0,
      requests_answered: sentTotal,
      spine_rows_per_request: sentTotal
        ? round(Object.values(spine).reduce((a, b) => a + b, 0) / sentTotal, 3)
        : null,
      spine_rows_total: Object.values(spine).reduce((a, b) => a + b, 0),
    };
    const pass = stage.error_rate <= MAX_ERROR_RATE && stage.latency_ms_all.p95 <= MAX_P95_MS;
    const wal = {
      bytes_per_request: audit.requests_answered ? Math.round(walBytes / audit.requests_answered) : null,
      checkpoints: walAfter.checkpoints - walBefore.checkpoints,
      mb_total: round(walBytes / 1_048_576),
    };
    results.push({ ...stage, audit, pass, wal });
    console.log(
      [
        String(concurrency).padStart(4),
        String(stage.rps).padStart(6),
        String(stage.rps_ok).padStart(6),
        String(stage.latency_ms_all.p50).padStart(5),
        String(stage.latency_ms_all.p95).padStart(5),
        String(stage.latency_ms_all.p99).padStart(5),
        (stage.error_rate * 100).toFixed(3).padStart(6),
        String(stage.cpu_server_pct).padStart(7),
        String(stage.cpu_pg_container_pct).padStart(6),
        ` audited=${audit.query_received}/${audit.requests_answered} rows/req=${audit.spine_rows_per_request} wal/req=${wal.bytes_per_request}B ckpt=${wal.checkpoints}`,
        pass ? "" : "  FAIL",
      ].join(" ")
    );
    if (!pass && stopOnFail) {
      break;
    }
  }
  const outDir = argValue("results-dir", join(HERE, "results"));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ deny_ratio: denyRatio, unknown_ratio: unknownRatio, grants: grantTotal, label, stage_seconds: stageSeconds, stages: results, warmup_seconds: warmupSeconds }, null, 2)}\n`
  );
  console.log(`wrote ${file}`);
  await monitorPool.end();
}

await main();
