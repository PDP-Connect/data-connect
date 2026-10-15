// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Resumable, idempotent seeding of the pilot's grants through the real path,
// into the reminder service's store.
//
// Per child i (1..--children), for the reminder service's confidential
// client (private_key_jwt, registered by `reminder-service/cli.ts bootstrap`):
//   client  GET  /oauth/authorize                 authorization_details for child i,
//                                                 PKCE; the AS stores the request as
//                                                 a PAR-backed pending consent
//   parent  POST /pilot/cuenta-unica/login        once per parent (session reused)
//   parent  POST /pilot/vacuna/consent/select     civil-registry check -> review
//   parent  POST /pilot/vacuna/consent/approve    grant + authorization code
//   client  POST /oauth/token                     code exchange (private_key_jwt + PKCE)
//                                                 -> access + refresh token, stored
// Per row of pilot_rc_refusal_set (first --refusals): authorize, parent login,
// select -> 403 access_denied with the expected registry reason.
//
// Resume / idempotency: a child with a row in the reminder store is done; a
// refusal is done once recorded in <state>/seed-grants.sqlite. A grant the
// AS issued but whose tokens never reached the store (crash between approve
// and storing) is revoked by its parent ("delete") at start and end of each
// run, then the child is granted again.
//
// Usage: node seed-grants.ts --children 9802 --refusals 600 [--from 1]
//          [--concurrency 8] [--fields child_id,birth_date,doses,next_dose_due]
//          [--state-dir <reminder state dir>] [--out result.json]
// Env: VACUNA_AS_URL, VACUNA_DATABASE_URL, VACUNA_REMINDER_STATE_DIR

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pg from "pg";
import { Agent } from "undici";
import { AS_URL, argInt, argValue, DATABASE_URL } from "../baseline/lib/common.ts";
import { childId } from "../baseline/lib/dataset.ts";
import { SOURCE_ID, STREAM } from "../baseline/lib/manifest.ts";
import { type ClientCredentials, loadOrCreateClientKey, privateKeyJwtClient } from "../reminder-service/lib/oauth.ts";
import { ReminderStore } from "../reminder-service/lib/store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.env.PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD || "vacuna-demo-2026";
const REDIRECT_URI = "https://reminders.example/callback";
const SESSION_REUSE_MS = 20 * 60 * 1000; // stub sessions live 30 min
const MAX_ATTEMPTS = 3;

const from = argInt("from", 1);
const to = argInt("children", 980_200);
const refusalCount = argInt("refusals", 60_000);
const concurrency = argInt("concurrency", 8);
const fields = argValue("fields", "child_id,birth_date,doses,next_dose_due")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const stateDir = argValue(
  "state-dir",
  process.env.VACUNA_REMINDER_STATE_DIR || join(HERE, "..", "reminder-service", ".state")
);
const outPath = argValue("out", join(stateDir, "seed-grants-result.json"));
const issuer = process.env.VACUNA_AS_ISSUER || AS_URL;
const dispatcher = new Agent({ connections: concurrency * 2, keepAliveTimeout: 30_000 });

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
type Json = Record<string, any>;

interface HttpResult {
  body: Json;
  headers: Headers;
  status: number;
}

async function http(path: string, init: RequestInit & { cookie?: string } = {}): Promise<HttpResult> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const res = await fetch(`${AS_URL}${path}`, {
    ...rest,
    dispatcher,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  } as RequestInit);
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { body, headers: res.headers, status: res.status };
}

const jsonPost = (payload: unknown, cookie?: string) => ({
  body: JSON.stringify(payload),
  cookie,
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  method: "POST",
});

const formPost = (fieldsIn: Record<string, string>) => ({
  body: new URLSearchParams(fieldsIn).toString(),
  headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});

class StepError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function expect(res: HttpResult, status: number, what: string): void {
  if (res.status !== status) {
    throw new StepError(
      `${what}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`,
      res.status >= 500 || res.status === 429
    );
  }
}

const timing: Record<string, { n: number; ms: number }> = {};
async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const slot = (timing[step] ??= { ms: 0, n: 0 });
    slot.ms += performance.now() - t0;
    slot.n += 1;
  }
}

// ─── client and parent sessions ─────────────────────────────────────────────

function loadClient(): ClientCredentials {
  let state: { clientId: string; method: string };
  try {
    state = JSON.parse(readFileSync(join(stateDir, "client.json"), "utf8"));
  } catch {
    throw new Error(`no client in ${stateDir}: run \`node reminder-service/cli.ts bootstrap --children 0\` first`);
  }
  if (state.method !== "private_key_jwt") {
    throw new Error("seed-grants expects the confidential (private_key_jwt) reminder client");
  }
  const { key, kid } = loadOrCreateClientKey(join(stateDir, "client-key.pem"));
  return privateKeyJwtClient({ clientId: state.clientId, issuer, key, kid });
}

interface Session {
  cookie: string;
  csrf: string;
  at: number;
}
const sessions = new Map<string, Promise<Session>>();
let logins = 0;

function sessionFor(cedula: string, fresh = false): Promise<Session> {
  const cached = sessions.get(cedula);
  if (cached && !fresh) {
    return cached.then((s) => (Date.now() - s.at < SESSION_REUSE_MS ? s : sessionFor(cedula, true)));
  }
  const session = timed("login", async () => {
    const res = await http("/pilot/cuenta-unica/login", jsonPost({ cedula, password: PASSWORD }));
    expect(res, 200, `login ${cedula}`);
    logins += 1;
    return {
      at: Date.now(),
      cookie: String(res.headers.get("set-cookie")).split(";")[0] as string,
      csrf: String(res.body.csrf_token),
    };
  });
  sessions.set(cedula, session);
  session.catch(() => sessions.delete(cedula));
  if (sessions.size > 50_000) {
    // Children come in family order, so old parents are not needed again.
    const oldest = sessions.keys().next().value as string;
    sessions.delete(oldest);
  }
  return session;
}

/** POST as the parent; one re-login if the stub session expired. */
async function asParent(cedula: string, path: string, payload: Json): Promise<HttpResult> {
  let session = await sessionFor(cedula);
  let res = await http(path, jsonPost({ ...payload, csrf_token: session.csrf }, session.cookie));
  if (res.status === 401 && res.body.error === "login_required") {
    session = await sessionFor(cedula, true);
    res = await http(path, jsonPost({ ...payload, csrf_token: session.csrf }, session.cookie));
  }
  return res;
}

// ─── the authorization request ───────────────────────────────────────────────

function authorizationDetails(child: string) {
  return [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "Recordatorios de vacunación para un niño o niña",
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [{ name: STREAM, resources: [child], ...(fields.length ? { fields } : {}) }],
      type: "https://pdpp.dev/data-access",
    },
  ];
}

async function authorize(client: ClientCredentials, child: string): Promise<{ requestUri: string; state: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("base64url");
  const url = new URLSearchParams({
    authorization_details: JSON.stringify(authorizationDetails(child)),
    client_id: client.clientId,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
  });
  const res = await timed("authorize", () => http(`/oauth/authorize?${url}`));
  const location = res.headers.get("location");
  const requestUri = location ? new URL(location, AS_URL).searchParams.get("request_uri") : null;
  if (res.status !== 302 || !requestUri) {
    throw new StepError(
      `authorize ${child}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`,
      res.status >= 500
    );
  }
  return { requestUri, state, verifier };
}

// ─── progress journal ────────────────────────────────────────────────────────

function openProgress(): Database.Database {
  const db = new Database(join(stateDir, "seed-grants.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS granted (
      child_index INTEGER PRIMARY KEY,
      grant_id TEXT NOT NULL,
      initial_access_token TEXT NOT NULL,
      initial_access_expires_at INTEGER,
      granted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refused (
      seq INTEGER PRIMARY KEY,
      reason TEXT NOT NULL,
      refused_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orphans_revoked (grant_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  return db;
}

// ─── orphan grants (issued, tokens never stored) ──────────────────────────────

async function revokeOrphans(pool: pg.Pool, client: ClientCredentials, store: ReminderStore, progress: Database.Database) {
  // The pilot creates its tables on first use.
  const exists = await pool.query("SELECT to_regclass('pilot_rep_grants') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) {
    return 0;
  }
  const rows = (
    await pool.query(
      `SELECT p.grant_id, p.child_id, p.parent_cedula
         FROM pilot_rep_grants p JOIN grants g ON g.grant_id = p.grant_id
        WHERE p.client_id = $1 AND g.status = 'active' AND p.revoked_at IS NULL`,
      [client.clientId]
    )
  ).rows as Array<{ child_id: string; grant_id: string; parent_cedula: string }>;
  const held = new Set(
    (store.db.prepare("SELECT grant_id FROM children").all() as Array<{ grant_id: string }>).map((r) => r.grant_id)
  );
  let revoked = 0;
  for (const row of rows) {
    if (held.has(row.grant_id)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: rare, sequential is fine
    const res = await asParent(row.parent_cedula, `/pilot/vacuna/autorizaciones/${row.grant_id}/revoke`, {
      disposition: "delete",
    });
    expect(res, 200, `revoke orphan ${row.grant_id}`);
    progress
      .prepare("INSERT OR IGNORE INTO orphans_revoked (grant_id, child_id, at) VALUES (?, ?, ?)")
      .run(row.grant_id, row.child_id, Date.now());
    revoked += 1;
  }
  return revoked;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await worker(item);
      }
    })
  );
}

async function withRetry<T>(what: string, fn: () => Promise<T>, retries: { n: number }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: retries are sequential by nature
      return await fn();
    } catch (err) {
      const retryable = err instanceof StepError ? err.retryable : true; // network errors
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw err;
      }
      retries.n += 1;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const client = loadClient();
  const store = new ReminderStore(join(stateDir, "reminder.sqlite"));
  const progress = openProgress();
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const started = Date.now();
  const errors: string[] = [];
  const retries = { n: 0 };

  const orphansBefore = await revokeOrphans(pool, client, store, progress);

  // Which children still need a grant, and the guardian who approves each.
  const done = new Set(
    (store.db.prepare("SELECT child_index FROM children WHERE child_index BETWEEN ? AND ?").all(from, to) as Array<{
      child_index: number;
    }>).map((r) => r.child_index)
  );
  const pending: number[] = [];
  for (let i = from; i <= to; i++) {
    if (!done.has(i)) {
      pending.push(i);
    }
  }
  const guardianOf = new Map<string, string>();
  for (let k = 0; k < pending.length; k += 50_000) {
    const ids = pending.slice(k, k + 50_000).map(childId);
    // biome-ignore lint/performance/noAwaitInLoops: chunked lookup
    const rows = await pool.query(
      `SELECT DISTINCT ON (child_id) child_id, parent_cedula FROM pilot_rc_guardianships
        WHERE status = 'active' AND child_id = ANY($1) ORDER BY child_id, capacity DESC, parent_cedula`,
      [ids]
    );
    for (const r of rows.rows) {
      guardianOf.set(String(r.child_id), String(r.parent_cedula));
    }
  }

  const insertGranted = progress.prepare(
    "INSERT OR REPLACE INTO granted (child_index, grant_id, initial_access_token, initial_access_expires_at, granted_at) VALUES (?, ?, ?, ?, ?)"
  );
  let granted = 0;
  const grantStart = performance.now();
  await runPool(pending, async (index) => {
    const child = childId(index);
    const cedula = guardianOf.get(child);
    if (!cedula) {
      errors.push(`${child}: no active guardian in the registry`);
      return;
    }
    try {
      const { requestUri, state, verifier } = await withRetry("authorize", () => authorize(client, child), retries);
      const selected = await timed("select", () =>
        asParent(cedula, "/pilot/vacuna/consent/select", { request_uri: requestUri })
      );
      expect(selected, 200, `select ${child}`);
      const approved = await timed("approve", () =>
        asParent(cedula, "/pilot/vacuna/consent/approve", {
          pilot_revision: selected.body.pilot_revision,
          request_uri: requestUri,
        })
      );
      expect(approved, 200, `approve ${child}`);
      const redirect = new URL(String(approved.body.redirect_to));
      const code = redirect.searchParams.get("code");
      if (!code || redirect.searchParams.get("state") !== state) {
        throw new StepError(`approve ${child}: no code/state in redirect`, false);
      }
      const token = await timed("token", () =>
        http(
          "/oauth/token",
          formPost({
            ...client.fields(),
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
          })
        )
      );
      expect(token, 200, `token ${child}`);
      const expiresAt =
        typeof token.body.expires_in === "number" ? Date.now() + Number(token.body.expires_in) * 1000 : null;
      const grantId = String(token.body.grant_id ?? approved.body.grant_id);
      store.upsertChild({
        access_expires_at: expiresAt,
        access_token: String(token.body.access_token),
        child_id: child,
        child_index: index,
        grant_id: grantId,
        refresh_token: typeof token.body.refresh_token === "string" ? token.body.refresh_token : null,
      });
      insertGranted.run(index, grantId, String(token.body.access_token), expiresAt, Date.now());
      granted += 1;
      if (granted % 1000 === 0) {
        const rate = granted / ((performance.now() - grantStart) / 1000);
        console.log(`[grants] ${granted}/${pending.length} (${rate.toFixed(1)}/s) last=${child}`);
      }
    } catch (err) {
      errors.push(`${child}: ${(err as Error).message}`);
    }
  });
  const grantSeconds = (performance.now() - grantStart) / 1000;

  // Refusals: the first --refusals rows of the registry's refusal set.
  const refusedDone = new Set(
    (progress.prepare("SELECT seq FROM refused").all() as Array<{ seq: number }>).map((r) => r.seq)
  );
  const refusalRows = (
    await pool.query(
      "SELECT seq, parent_cedula, child_id, expected_reason FROM pilot_rc_refusal_set WHERE seq <= $1 ORDER BY seq",
      [refusalCount]
    )
  ).rows.filter((r) => !refusedDone.has(Number(r.seq))) as Array<{
    child_id: string;
    expected_reason: string;
    parent_cedula: string;
    seq: number;
  }>;
  const insertRefused = progress.prepare("INSERT OR IGNORE INTO refused (seq, reason, refused_at) VALUES (?, ?, ?)");
  let refused = 0;
  const reasons: Record<string, number> = {};
  const refuseStart = performance.now();
  await runPool(refusalRows, async (row) => {
    try {
      const { requestUri } = await withRetry("authorize", () => authorize(client, row.child_id), retries);
      const res = await timed("select_refused", () =>
        asParent(row.parent_cedula, "/pilot/vacuna/consent/select", { request_uri: requestUri })
      );
      if (res.status !== 403 || res.body.error !== "access_denied") {
        throw new Error(`expected access_denied, got HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      if (res.body.registry_reason !== row.expected_reason) {
        throw new Error(`reason ${res.body.registry_reason} != expected ${row.expected_reason}`);
      }
      reasons[row.expected_reason] = (reasons[row.expected_reason] ?? 0) + 1;
      insertRefused.run(row.seq, row.expected_reason, Date.now());
      refused += 1;
    } catch (err) {
      errors.push(`refusal ${row.seq} ${row.parent_cedula}/${row.child_id}: ${(err as Error).message}`);
    }
  });
  const refuseSeconds = (performance.now() - refuseStart) / 1000;

  const orphansAfter = await revokeOrphans(pool, client, store, progress);
  await pool.end();

  const storeChildren = Number(
    (store.db.prepare("SELECT COUNT(*) AS n FROM children WHERE child_index BETWEEN ? AND ?").get(from, to) as { n: number }).n
  );
  const refusedTotal = Number((progress.prepare("SELECT COUNT(*) AS n FROM refused").get() as { n: number }).n);
  const per = (step: string) => {
    const t = timing[step];
    return t && t.n ? Math.round((t.ms / t.n) * 10) / 10 : null;
  };
  const result = {
    children: { expected: to - from + 1, stored: storeChildren },
    concurrency,
    error_samples: errors.slice(0, 20),
    errors: errors.length,
    fields,
    grants_this_run: {
      count: granted,
      per_second: Math.round((granted / Math.max(grantSeconds, 0.001)) * 10) / 10,
      seconds: Math.round(grantSeconds),
    },
    logins,
    mean_ms: Object.fromEntries(Object.keys(timing).map((k) => [k, per(k)])),
    orphans_revoked: orphansBefore + orphansAfter,
    refusals: { expected: refusalCount, recorded: refusedTotal },
    refusals_this_run: {
      count: refused,
      per_second: Math.round((refused / Math.max(refuseSeconds, 0.001)) * 10) / 10,
      reasons,
      seconds: Math.round(refuseSeconds),
    },
    retries: retries.n,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  store.close();
  progress.close();
  await dispatcher.close();
  const complete = storeChildren === to - from + 1 && refusedTotal >= refusalCount;
  process.exitCode = complete ? 0 : 1;
}

await main();
