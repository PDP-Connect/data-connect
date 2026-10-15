// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Revoke a deterministic sample of grants through the parent path
// (Cuenta Única stub sign-in + POST /pilot/vacuna/autorizaciones/:id/revoke)
// with an alternating keep / delete choice. Before revoking, each sampled
// child's tokens are rotated through the real token endpoint so the access
// token the reminder service holds is unexpired: reads made with it after
// revocation are then refused for the revocation, not for expiry.
//
// Afterwards the parents' recorded choices are copied from the AS
// (pilot_rep_grants.disposition) into the reminder service's disposition
// stub (dispositions.json), standing in for the PR #401 lifecycle answer.
//
// Idempotent: grants already revoked are skipped.
//
// Usage: node revoke.ts --children N [--every 50] [--offset 25] [--concurrency 8] --out file.json
// Env: see lib/plan.ts runEnv (VACUNA_REMINDER_STATE_DIR, VACUNA_DATABASE_URL, ...)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { DATABASE_URL } from "./lib/plan.ts";
import { freshAccessToken, keepAlive, openStore, ParentPortal, reminderClient } from "./lib/pilot.ts";

const children = argInt("children", 0);
const every = argInt("every", 50);
const offset = argInt("offset", 25);
const concurrency = argInt("concurrency", 8);
const reminderState = process.env.VACUNA_REMINDER_STATE_DIR as string;
const out = argValue("out", join(reminderState, "..", "revoke-result.json"));

const store = openStore(reminderState);
const client = reminderClient(reminderState);
const dispatcher = keepAlive(concurrency * 2);
const portal = new ParentPortal(dispatcher);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

const sample: Array<{ disposition: "keep" | "delete"; grantId: string; index: number }> = [];
for (let i = offset, k = 0; i <= children; i += every, k++) {
  const row = store.getChild(i);
  if (!row) {
    throw new Error(`child ${i} has no grant in the reminder store`);
  }
  sample.push({ disposition: k % 2 === 0 ? "keep" : "delete", grantId: row.grant_id, index: i });
}
const grantRows = new Map<string, { cedula: string; status: string }>();
for (let k = 0; k < sample.length; k += 20_000) {
  const ids = sample.slice(k, k + 20_000).map((s) => s.grantId);
  // biome-ignore lint/performance/noAwaitInLoops: chunked lookup
  const res = await pool.query(
    `SELECT p.grant_id, p.parent_cedula, g.status FROM pilot_rep_grants p JOIN grants g ON g.grant_id = p.grant_id
      WHERE p.grant_id = ANY($1)`,
    [ids]
  );
  for (const r of res.rows) {
    grantRows.set(String(r.grant_id), { cedula: String(r.parent_cedula), status: String(r.status) });
  }
}

const started = Date.now();
let revoked = 0;
let skipped = 0;
let refreshed = 0;
const errors: string[] = [];
const ackMs: number[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, sample.length) }, async () => {
    while (next < sample.length) {
      const s = sample[next++] as (typeof sample)[number];
      const g = grantRows.get(s.grantId);
      if (!g) {
        errors.push(`${s.grantId}: not a pilot grant`);
        continue;
      }
      if (g.status !== "active") {
        skipped += 1;
        continue;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: per-lane sequence
        if (await freshAccessToken(store, client, s.index)) {
          refreshed += 1;
        }
        const t0 = performance.now();
        const res = await portal.revoke(g.cedula, s.grantId, s.disposition);
        ackMs.push(performance.now() - t0);
        if (res.status !== 200 || res.body.status !== "revoked") {
          throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
        }
        revoked += 1;
      } catch (err) {
        errors.push(`${s.grantId}: ${(err as Error).message}`);
      }
    }
  })
);
const seconds = (Date.now() - started) / 1000;

// The AS-recorded choices feed the reminder service's disposition stub.
const recorded = await pool.query(
  "SELECT grant_id, disposition FROM pilot_rep_grants WHERE grant_id = ANY($1) AND revoked_at IS NOT NULL",
  [sample.map((s) => s.grantId)]
);
const dispositions: Record<string, string> = {};
const byDisposition: Record<string, number> = {};
for (const r of recorded.rows) {
  dispositions[String(r.grant_id)] = String(r.disposition);
  byDisposition[String(r.disposition)] = (byDisposition[String(r.disposition)] ?? 0) + 1;
}
writeFileSync(join(reminderState, "dispositions.json"), JSON.stringify(dispositions));
await pool.end();
store.close();
await dispatcher.close();

ackMs.sort((a, b) => a - b);
const pct = (p: number) => (ackMs.length ? Math.round(ackMs[Math.min(ackMs.length - 1, Math.ceil(p * ackMs.length) - 1)] as number) : null);
const result = {
  errors: errors.length,
  error_samples: errors.slice(0, 10),
  recorded_revoked: recorded.rowCount,
  recorded_by_disposition: byDisposition,
  refreshed_before_revoke: refreshed,
  revoke_ack_ms: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
  revoked_this_run: revoked,
  sample: sample.length,
  seconds: Math.round(seconds * 10) / 10,
  skipped_already_revoked: skipped,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length || recorded.rowCount !== sample.length ? 1 : 0;
