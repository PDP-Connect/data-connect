// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One orchestrated pilot run at a scale factor (see README.md).
//
//   node run.ts --scale 0.01 --label s1 [--fresh] [--seed 20261014] [--revoke-every 50]
//   node run.ts --children 3 --revoke-every 2 --probes 1 --label smoke --fresh   (smoke)
//               [--phases records,registry,...] [--grant-concurrency 8]
//               [--read-concurrency 64] [--pool 32] [--probes 20]
//   node run.ts --label s1 --phases ramp [--stages 8,16,32,64,128,256]
//
// Phases (default: all except ramp, in order; finished phases are skipped
// on a rerun of the same label unless named in --phases):
//   db         (--fresh only) recreate the Postgres container, wipe .state/<label>
//   records    reference server bootstrap + synthetic records
//   registry   civil-registry stub: parents, guardianships, refusal set
//   client     the reminder service's confidential client (private_key_jwt, DCR)
//   grants     every child's grant through the real parent path + code exchange,
//              and the registry refusals; the audit window opens here
//   prepare    VACUUM ANALYZE + CHECKPOINT
//   weeks      reminder service: 28 simulated days, weekly reads, mock payer
//   revoke     parent revocations of every 50th grant (keep/delete alternating)
//   lifecycle  reminder service daily job: learns the revocations, deletes "delete"
//   denials    reads after revocation, out-of-grant fields, expired/malformed tokens
//   reconcile  closes the window; four-way count + audit checks
//   probes     revocation time-to-effect (after the window)
//   report     report.md / report.json in .state/<label>
//   ramp       (separate) closed-loop ramp for peak throughput
//
// The server runs as a child of this process with every pilot flag on and is
// stopped when the run ends.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import pg from "pg";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { AS_URL, buildPlan, DATABASE_URL, DEMO_DIR, PILOT, type Plan, runEnv, runPaths } from "./lib/plan.ts";

const SIM_START = "2026-10-05T08:00:00.000Z";
const SIM_AFTER = "2026-11-02T09:00:00.000Z"; // day 28: the first daily job after week 4
const ALL = [
  "records",
  "registry",
  "client",
  "grants",
  "prepare",
  "weeks",
  "revoke",
  "lifecycle",
  "denials",
  "reconcile",
  "probes",
  "report",
] as const;

const label = argValue("label", "");
if (!label) {
  throw new Error("--label is required");
}
const paths = runPaths(label);
interface PhaseRecord {
  ended_at: string;
  exit_code: number;
  seconds: number;
  started_at: string;
}
interface RunState {
  label: string;
  phases: Record<string, PhaseRecord>;
  plan: Plan;
  pool: number;
  window?: { from?: string; to?: string };
}

function loadState(): RunState | null {
  try {
    return JSON.parse(readFileSync(paths.runJson, "utf8")) as RunState;
  } catch {
    return null;
  }
}

const fresh = process.argv.includes("--fresh");
const requested = argValue("phases", "");
const previous = fresh ? null : loadState();
// --children N is shorthand for --scale N/980200 (smoke runs).
const childrenArg = argInt("children", 0);
const scale = childrenArg
  ? childrenArg / PILOT.children
  : Number(argValue("scale", String(previous?.plan.scale ?? "")));
const seed = argInt("seed", previous?.plan.seed ?? 20_261_014);
const pool = argInt("pool", previous?.pool ?? 32);
const plan = buildPlan(scale, seed, argInt("revoke-every", previous?.plan.revokeEvery ?? 50));
const state: RunState = previous ?? { label, phases: {}, plan, pool };
state.plan = plan;
state.pool = pool;
const save = () => writeFileSync(paths.runJson, `${JSON.stringify(state, null, 2)}\n`);
const env = runEnv(paths, pool);
const node = process.execPath;

// ─── process helpers ──────────────────────────────────────────────────────────

function run(args: string[], logName: string, opts: { allowFail?: boolean } = {}): Promise<number> {
  const logPath = join(paths.root, `${logName}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { cwd: DEMO_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    const relay = (chunk: Buffer) => {
      log.write(chunk);
      process.stdout.write(chunk);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("close", (code) => {
      log.end();
      if (code !== 0 && !opts.allowFail) {
        reject(new Error(`${args.join(" ")} exited ${code} (log: ${logPath})`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

let server: ChildProcess | null = null;

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${AS_URL}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  if (await serverUp()) {
    throw new Error(`something already answers on ${AS_URL}; stop it first (this run starts its own server)`);
  }
  const log = createWriteStream(paths.serverLog, { flags: "a" });
  server = spawn("sh", [join(DEMO_DIR, "baseline", "start-server.sh")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  writeFileSync(join(paths.root, "server.pid"), String(server.pid));
  for (let i = 0; i < 120; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: polling
    if (await serverUp()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up; see ${paths.serverLog}`);
}

function stopServer(): void {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
  }
}
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

function db(...args: string[]): string {
  return execFileSync("sh", [join(DEMO_DIR, "baseline", "db.sh"), ...args], {
    encoding: "utf8",
    env: { ...env, VACUNA_PG_EXTRA_ARGS: process.env.VACUNA_PG_EXTRA_ARGS || "-c max_wal_size=2GB -c checkpoint_timeout=15min" },
  });
}

async function waitForDatabase(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    try {
      // biome-ignore lint/performance/noAwaitInLoops: polling
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres did not become ready");
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ application_name: "vacuna-run", connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const S = (p: string) => join(DEMO_DIR, p);

// ─── phases ──────────────────────────────────────────────────────────────────

const phases: Record<string, () => Promise<void>> = {
  async records() {
    await run([S("baseline/seed.ts"), "--phase", "bootstrap"], "records");
    await run([S("baseline/seed.ts"), "--phase", "records", "--records", String(Math.min(2000, plan.children))], "records");
    if (plan.children > 2000) {
      await run([S("baseline/seed.ts"), "--phase", "bulk-records", "--records", String(plan.children)], "records");
    }
  },
  async registry() {
    await run(
      [
        S("consent/seed-registry.ts"),
        "--children",
        String(plan.children),
        "--refusals",
        String(plan.consentRefusals),
        "--suspended",
        String(plan.suspendedRefusals),
      ],
      "registry"
    );
  },
  async client() {
    await run([S("reminder-service/cli.ts"), "bootstrap", "--children", "0"], "client");
  },
  async grants() {
    state.window = { ...state.window, from: state.window?.from ?? new Date().toISOString() };
    save();
    await run(
      [
        S("consent/seed-grants.ts"),
        "--children",
        String(plan.children),
        "--refusals",
        String(plan.consentRefusals),
        "--concurrency",
        argValue("grant-concurrency", "8"),
        "--out",
        join(paths.root, "seed-grants-result.json"),
      ],
      "grants"
    );
  },
  async prepare() {
    await run([S("baseline/seed.ts"), "--phase", "prepare"], "prepare");
  },
  async weeks() {
    await run(
      [
        S("reminder-service/cli.ts"),
        "simulate",
        "--start",
        SIM_START,
        "--days",
        "28",
        ...reminderArgs(),
      ],
      "weeks"
    );
  },
  async revoke() {
    await run(
      [
        S("run/revoke.ts"),
        "--children",
        String(plan.children),
        "--every",
        String(plan.revokeEvery),
        "--offset",
        String(plan.revokeOffset),
        "--out",
        join(paths.root, "revoke-result.json"),
      ],
      "revoke"
    );
  },
  async lifecycle() {
    await run([S("reminder-service/cli.ts"), "daily", "--now", SIM_AFTER, ...reminderArgs()], "lifecycle");
  },
  async denials() {
    await run(
      [
        S("run/inject-denials.ts"),
        "--children",
        String(plan.children),
        "--every",
        String(plan.revokeEvery),
        "--offset",
        String(plan.revokeOffset),
        "--seed",
        String(plan.seed),
        "--revoked-reads",
        String(plan.readsAfterRevocation),
        "--field-reads",
        String(plan.outOfGrantFieldReads),
        "--bad-token-reads",
        String(plan.badTokenReads),
        "--out",
        join(paths.root, "injector-result.json"),
      ],
      "denials",
      { allowFail: true }
    );
  },
  async reconcile() {
    await new Promise((r) => setTimeout(r, 1500));
    state.window = { ...state.window, to: new Date().toISOString() };
    save();
    const { from, to } = state.window as { from: string; to: string };
    writeFileSync(join(paths.root, "register-receipts.json"), JSON.stringify({ count: await countReceipts(from, to) }));
    const reminder = reminderTotals();
    writeFileSync(join(paths.root, "reminder-received.json"), JSON.stringify({ count: reminder.records_received }));
    writeFileSync(join(paths.root, "gateway-accepted.json"), JSON.stringify({ count: await countLines(paths.ledger) }));
    await run(
      [
        S("reconcile/reconcile.ts"),
        "--run-id",
        label,
        "--from",
        from,
        "--to",
        to,
        "--register-receipts",
        join(paths.root, "register-receipts.json"),
        "--reminder-received",
        join(paths.root, "reminder-received.json"),
        "--gateway-accepted",
        join(paths.root, "gateway-accepted.json"),
        "--database-url",
        DATABASE_URL,
        "--out",
        join(paths.root, "reconcile"),
      ],
      "reconcile",
      { allowFail: true }
    );
  },
  async probes() {
    await run(
      [
        S("run/probe-revocation.ts"),
        "--children",
        String(plan.children),
        "--probes",
        argValue("probes", "20"),
        "--every",
        String(plan.revokeEvery),
        "--offset",
        String(plan.revokeOffset),
        "--seed",
        String(plan.seed),
        "--out",
        join(paths.root, "probes-result.json"),
      ],
      "probes",
      { allowFail: true }
    );
  },
  async report() {
    await writeReport();
  },
  async ramp() {
    const tokensFile = join(paths.root, "ramp-tokens.json");
    await run([S("run/ramp-tokens.ts"), "--children", String(plan.children), "--out", tokensFile], "ramp");
    await run(
      [
        S("baseline/loadgen.ts"),
        "--tokens-file",
        tokensFile,
        "--grants",
        String(plan.children),
        "--unknown-ratio",
        String(40_000 / 4_320_800),
        "--stages",
        argValue("stages", "8,16,32,64,128,256"),
        "--stage-seconds",
        argValue("stage-seconds", "30"),
        "--label",
        `ramp-${label}`,
        "--results-dir",
        join(paths.root, "ramp"),
      ],
      "ramp",
      { allowFail: true }
    );
  },
};

function reminderArgs(): string[] {
  return [
    "--payer",
    "mock",
    "--payer-ledger",
    paths.ledger,
    "--receipt-public-key",
    `${paths.receiptsKey}.pub`,
    "--concurrency",
    argValue("read-concurrency", "64"),
    "--counters-out",
    join(paths.reminderState, "counters.json"),
  ];
}

// ─── counts ──────────────────────────────────────────────────────────────────

async function countReceipts(from: string, to: string): Promise<number> {
  if (!existsSync(paths.receiptsLog)) {
    return 0;
  }
  let n = 0;
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(paths.receiptsLog) });
  for await (const line of lines) {
    if (!line.includes('"type":"receipt"')) {
      continue;
    }
    const servedAt = (JSON.parse(line) as { served_at: string }).served_at;
    if (servedAt >= from && servedAt < to) {
      n += 1;
    }
  }
  return n;
}

async function countLines(path: string): Promise<number> {
  if (!existsSync(path)) {
    return 0;
  }
  let n = 0;
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(path) });
  for await (const line of lines) {
    if (line.trim()) {
      n += 1;
    }
  }
  return n;
}

function reminderTotals(): Record<string, number> {
  const store = new Database(join(paths.reminderState, "reminder.sqlite"), { readonly: true });
  try {
    const one = (q: string) => Number((store.prepare(q).get() as { n: number | null }).n ?? 0);
    return {
      children: one("SELECT COUNT(*) AS n FROM children"),
      children_active: one("SELECT COUNT(*) AS n FROM children WHERE status = 'active'"),
      children_deleted: one("SELECT COUNT(*) AS n FROM children WHERE status = 'deleted'"),
      children_ended_keep: one("SELECT COUNT(*) AS n FROM children WHERE status = 'ended_keep'"),
      children_erase_pending: one("SELECT COUNT(*) AS n FROM children WHERE status = 'erase_pending'"),
      children_needs_reauth: one("SELECT COUNT(*) AS n FROM children WHERE status = 'needs_reauth'"),
      payments_accepted: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'accepted'"),
      payments_pending: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'"),
      receipts_verified: one("SELECT COUNT(*) AS n FROM receipts WHERE verified = 1"),
      records_received: one("SELECT SUM(received_count) AS n FROM children"),
    };
  } finally {
    store.close();
  }
}

function readJson<T = Record<string, unknown>>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(paths.root, name), "utf8")) as T;
  } catch {
    return null;
  }
}

function dirBytes(path: string): number {
  try {
    return Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) * 1024;
  } catch {
    return 0;
  }
}

// ─── report ──────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: report assembly over loosely typed JSON
type Any = any;

async function writeReport(): Promise<void> {
  const { from, to } = (state.window ?? {}) as { from: string; to: string };
  const reconcile = readJson<Any>(`reconcile/reconcile-${label.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const injector = readJson<Any>("injector-result.json");
  const probes = readJson<Any>("probes-result.json");
  const grants = readJson<Any>("seed-grants-result.json");
  const revoke = readJson<Any>("revoke-result.json");
  const counters = (JSON.parse(readFileSync(join(paths.reminderState, "counters.json"), "utf8")) as Any[]) ?? [];
  const reminderCounters = (path: string) =>
    counters.reduce((n: number, snap: Any) => n + Number(path.split(".").reduce((o: Any, k) => o?.[k], snap.counters) ?? 0), 0);
  const reminder = reminderTotals();
  const spine = reconcile?.spine ?? {};
  const refusalsInWindow = await sql<{ n: string }>(
    "SELECT count(*) AS n FROM spine_events WHERE event_type = 'representative.authority_refused' AND occurred_at >= $1 AND occurred_at < $2",
    [from, to]
  );
  const grantsIssued = await sql<{ n: string }>(
    "SELECT count(*) AS n FROM spine_events WHERE event_type = 'grant.issued' AND occurred_at >= $1 AND occurred_at < $2",
    [from, to]
  );
  const dbSize = await sql<{ b: string }>("SELECT pg_database_size(current_database()) AS b");
  const spineRows = await sql<{ n: string }>("SELECT count(*) AS n FROM spine_events");
  const clientRequests = reminderCounters("reads.attempted") + Number(injector?.sent ?? 0);
  const denials = spine.denials_by_reason ?? {};
  const paid = {
    gateway_accepted: reconcile?.external?.gateway_accepted?.count ?? null,
    pdpp_audit_served: spine.served_reads ?? null,
    register_receipts: reconcile?.external?.register_receipts?.count ?? null,
    reminder_received: reconcile?.external?.reminder_received?.count ?? null,
  };
  const paidValues = Object.values(paid);
  const criteria = [
    {
      measured: `${JSON.stringify(paid)}; expected ${plan.expectedPaidReads}`,
      name: "Paid reads equal across PDPP audit, register receipts, reminder received, payments accepted",
      pass: new Set(paidValues).size === 1 && paidValues[0] === plan.expectedPaidReads,
    },
    {
      measured: `reconcile: ${spine.served_after_revocation ?? "?"} disclosures after revocation in window; probes: ${probes?.summary?.served_after_ack_total ?? "?"} reads started after the revoke ack were served, ${probes?.summary?.disclosures_after_revocation_in_spine ?? "?"} disclosure rows after grant.revoked; injected revoked-token reads served: ${injector?.status_by_kind?.revoked?.["200"] ?? 0}`,
      name: "0 records served after revocation",
      pass:
        spine.served_after_revocation === 0 &&
        probes?.summary?.served_after_ack_total === 0 &&
        probes?.summary?.disclosures_after_revocation_in_spine === 0 &&
        !injector?.status_by_kind?.revoked?.["200"],
    },
    {
      measured: `max ${probes?.summary?.effect_ms?.max ?? "?"} ms, median ${probes?.summary?.effect_ms?.median ?? "?"} ms over ${probes?.summary?.probes ?? 0} probes`,
      name: "Revocation effective within 60 s",
      pass: (probes?.summary?.effect_ms?.max ?? Number.POSITIVE_INFINITY) <= 60_000 && probes?.summary?.probes_without_effect === 0,
    },
    {
      measured: `${spine.requests ?? "?"} query.received for ${clientRequests} client requests; ${spine.unresolved_requests ?? "?"} without outcome; ${spine.served_reads ?? "?"} served + ${spine.denials_total ?? "?"} rejected; consent refusals audited ${Number(refusalsInWindow[0]?.n ?? 0)} of ${plan.consentRefusals}`,
      name: "100% of requests audited, denials included",
      pass:
        spine.requests === clientRequests &&
        spine.unresolved_requests === 0 &&
        spine.requests === spine.served_reads + spine.denials_total &&
        Number(refusalsInWindow[0]?.n ?? 0) === plan.consentRefusals,
    },
    {
      measured: `${injector?.sent ?? "?"} injected, ${injector?.unexpected ?? "?"} with an unexpected status, ${injector?.served_200 ?? "?"} served; ${JSON.stringify(injector?.codes_by_kind ?? {})}`,
      name: "Injected denials refused (revoked 403, out-of-grant fields 403, expired 401, malformed 401)",
      pass: injector?.unexpected === 0 && injector?.served_200 === 0 && injector?.sent === plan.readsAfterRevocation + plan.outOfGrantFieldReads + plan.badTokenReads,
    },
  ];
  const report = {
    criteria,
    db_bytes: Number(dbSize[0]?.b ?? 0),
    denials_by_reason: denials,
    expected: plan,
    grants,
    grants_issued_in_window: Number(grantsIssued[0]?.n ?? 0),
    injector,
    label,
    machine: {
      cpus: cpus().length,
      cpu_model: cpus()[0]?.model,
      free_mem_gb: Math.round((freemem() / 2 ** 30) * 10) / 10,
      total_mem_gb: Math.round(totalmem() / 2 ** 30),
    },
    phases: state.phases,
    pool,
    probes: probes?.summary ?? null,
    reconcile_pass: reconcile?.pass ?? null,
    reminder: {
      counters_total: {
        reads_attempted: reminderCounters("reads.attempted"),
        reads_succeeded: reminderCounters("reads.succeeded"),
        refresh_refreshed: reminderCounters("refresh.refreshed"),
        refresh_dead: reminderCounters("refresh.dead"),
        refresh_lost: reminderCounters("refresh.lost"),
        status_attempted: reminderCounters("status.attempted"),
        status_failed_grant: reminderCounters("status.failed_grant"),
        status_succeeded: reminderCounters("status.succeeded"),
        erasure_received: reminderCounters("erasure.instructions_received"),
        erasure_deleted: reminderCounters("erasure.deletions_completed"),
        lifecycle_ended_keep: reminderCounters("lifecycle.ended_keep"),
      },
      store: reminder,
    },
    revoke,
    spine_rows_total: Number(spineRows[0]?.n ?? 0),
    state_dir_bytes: dirBytes(paths.root),
    window: state.window,
  };
  writeFileSync(join(paths.root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# Run ${label}: scale ${plan.scale} (${plan.children} children)`,
    "",
    `Window ${from} to ${to}`,
    "",
    "| PRD criterion | Measured | Result |",
    "|---|---|---|",
    ...criteria.map((c) => `| ${c.name} | ${c.measured} | ${c.pass ? "pass" : "FAIL"} |`),
    "",
    "| Phase | Seconds |",
    "|---|---:|",
    ...Object.entries(state.phases).map(([k, v]) => `| ${k} | ${v.seconds} |`),
    "",
    "| Count | Expected | Measured |",
    "|---|---:|---:|",
    `| grants stored by the reminder service | ${plan.children} | ${reminder.children} |`,
    `| grant.issued in window | ${plan.children} | ${report.grants_issued_in_window} |`,
    `| consent refusals (authority_refused) | ${plan.consentRefusals} | ${Number(refusalsInWindow[0]?.n ?? 0)} |`,
    `| paid reads (audit) | ${plan.expectedPaidReads} | ${spine.served_reads ?? "?"} |`,
    `| reads after revocation (grant_revoked) | ${plan.readsAfterRevocation} | ${denials.grant_revoked ?? 0} |`,
    `| out-of-grant field reads (field_not_granted) | ${plan.outOfGrantFieldReads} | ${denials.field_not_granted ?? 0} |`,
    `| expired + malformed token reads (401 at injector) | ${plan.badTokenReads} | ${Number(injector?.status_by_kind?.expired?.["401"] ?? 0) + Number(injector?.status_by_kind?.malformed?.["401"] ?? 0)} |`,
    `| RS requests audited | ${clientRequests} | ${spine.requests ?? "?"} |`,
    `| revoked grants | ${plan.revokedChildren} | ${revoke?.recorded_revoked ?? "?"} |`,
    "",
    `Denials by reason: ${JSON.stringify(denials)}`,
    "",
    `Database ${(report.db_bytes / 2 ** 30).toFixed(2)} GiB; spine rows ${report.spine_rows_total}; state dir ${(report.state_dir_bytes / 2 ** 30).toFixed(2)} GiB.`,
    "",
  ];
  writeFileSync(join(paths.root, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const names = requested ? requested.split(",") : [...ALL];
  if (fresh) {
    try {
      db("down");
    } catch {
      // not running
    }
    rmSync(paths.root, { force: true, recursive: true });
    runPaths(label);
    db("up");
    await waitForDatabase();
    state.phases = {};
    state.window = {};
    save();
  }
  await waitForDatabase();
  save();
  const needsServer = names.some((n) => !["report"].includes(n));
  if (needsServer) {
    await startServer();
  }
  console.log(`[run ${label}] scale=${plan.scale} children=${plan.children} paid=${plan.expectedPaidReads} pool=${pool}`);
  for (const name of names) {
    const phase = phases[name];
    if (!phase) {
      throw new Error(`unknown phase ${name}`);
    }
    if (!requested && state.phases[name]?.exit_code === 0) {
      console.log(`[run ${label}] ${name}: done earlier, skipped`);
      continue;
    }
    const started = new Date();
    console.log(`\n[run ${label}] ── ${name} ── ${started.toISOString()}`);
    let code = 0;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: phases are sequential
      await phase();
    } catch (err) {
      code = 1;
      console.error(`[run ${label}] ${name} failed: ${(err as Error).message}`);
    }
    const ended = new Date();
    state.phases[name] = {
      ended_at: ended.toISOString(),
      exit_code: code,
      seconds: Math.round((ended.getTime() - started.getTime()) / 100) / 10,
      started_at: started.toISOString(),
    };
    save();
    if (code !== 0) {
      stopServer();
      process.exit(1);
    }
  }
  const size = existsSync(paths.receiptsLog) ? statSync(paths.receiptsLog).size : 0;
  console.log(`[run ${label}] finished; receipts log ${(size / 2 ** 20).toFixed(1)} MiB`);
  stopServer();
}

await main();
