// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Revocation time-to-effect. For each of --probes active grants (seeded
// choice, outside the revoked sample): rotate the child's tokens, read the
// child's record back to back with the reminder service's token, revoke
// through the parent path while reads are running, and keep reading until
// the RS refuses.
//
// Per probe:
//   effect_ms        revoke request sent -> end of the first refused read
//                    (upper bound on how long revocation took to bite)
//   served_after_ack reads that STARTED after the revoke response and were
//                    still served (must be 0)
// plus, from the audit spine, disclosure.served rows on the probe grants
// that occurred after their grant.revoked row.
//
// Probe reads are real served reads (receipts, disclosure rows); run this
// after the reconciliation window closes.
//
// Usage: node probe-revocation.ts --children N --probes 20 [--every 50] [--offset 25] [--seed S] --out file.json

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { STREAM } from "../baseline/lib/manifest.ts";
import { DATABASE_URL, RS_URL, rng } from "./lib/plan.ts";
import { freshAccessToken, keepAlive, openStore, ParentPortal, reminderClient } from "./lib/pilot.ts";

const children = argInt("children", 0);
const probes = argInt("probes", 20);
const every = argInt("every", 50);
const offset = argInt("offset", 25);
const seed = argInt("seed", 20_261_014);
const reminderState = process.env.VACUNA_REMINDER_STATE_DIR as string;
const out = argValue("out", join(reminderState, "..", "probes-result.json"));
const rand = rng(seed ^ 0x9b0b);

const store = openStore(reminderState);
const client = reminderClient(reminderState);
const dispatcher = keepAlive(4);
const portal = new ParentPortal(dispatcher);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

const eligible: number[] = [];
for (let i = 1; i <= children; i++) {
  if (i % every !== offset && store.getChild(i)?.status === "active") {
    eligible.push(i);
  }
}
const chosen = new Set<number>();
while (chosen.size < Math.min(probes, eligible.length)) {
  chosen.add(eligible[Math.floor(rand() * eligible.length)] as number);
}

async function readOnce(child: string, token: string) {
  const start = performance.now();
  const res = await fetch(`${RS_URL}/v1/streams/${STREAM}/records/${encodeURIComponent(child)}`, {
    dispatcher,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  } as RequestInit);
  await res.arrayBuffer();
  return { end: performance.now(), start, status: res.status };
}

const results: Array<Record<string, unknown>> = [];
for (const index of [...chosen].sort((a, b) => a - b)) {
  const row = store.getChild(index);
  if (!row) {
    continue;
  }
  // biome-ignore lint/performance/noAwaitInLoops: probes run one at a time
  const token = await freshAccessToken(store, client, index);
  if (!token) {
    results.push({ child: row.child_id, error: "token refresh failed" });
    continue;
  }
  const cedula = (
    await pool.query("SELECT parent_cedula FROM pilot_rep_grants WHERE grant_id = $1", [row.grant_id])
  ).rows[0]?.parent_cedula as string;
  await portal.session(cedula); // sign in before timing
  const reads: Array<{ end: number; start: number; status: number }> = [];
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      reads.push(await readOnce(row.child_id, token));
    }
  })();
  await new Promise((r) => setTimeout(r, 300));
  const sent = performance.now();
  const revoke = await portal.revoke(cedula, row.grant_id, "keep");
  const ack = performance.now();
  // Keep reading until 5 consecutive refusals or 10 s.
  const deadline = ack + 10_000;
  while (performance.now() < deadline) {
    const tail = reads.slice(-5);
    if (tail.length === 5 && tail.every((r) => r.status !== 200) && (tail[0] as { start: number }).start > ack) {
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  stop = true;
  await reader;
  const firstRefused = reads.find((r) => r.status !== 200 && r.end >= sent);
  const servedAfterAck = reads.filter((r) => r.start > ack && r.status === 200).length;
  const lastServed = [...reads].reverse().find((r) => r.status === 200);
  results.push({
    child: row.child_id,
    effect_ms: firstRefused ? Math.round((firstRefused.end - sent) * 10) / 10 : null,
    grant_id: row.grant_id,
    last_served_ended_ms_after_ack: lastServed ? Math.round((lastServed.end - ack) * 10) / 10 : null,
    reads: reads.length,
    refused_status: firstRefused?.status ?? null,
    revoke_ms: Math.round((ack - sent) * 10) / 10,
    revoke_status: revoke.status,
    served_after_ack: servedAfterAck,
  });
}

const grantIds = results.map((r) => r.grant_id).filter(Boolean);
const spine = await pool.query(
  `SELECT count(*) AS n,
          max(EXTRACT(EPOCH FROM (d.occurred_at::timestamptz - v.revoked_at::timestamptz))) AS max_lag_s
     FROM spine_events d
     JOIN (SELECT grant_id, min(occurred_at) AS revoked_at FROM spine_events
            WHERE event_type = 'grant.revoked' AND grant_id = ANY($1) GROUP BY grant_id) v ON v.grant_id = d.grant_id
    WHERE d.event_type = 'disclosure.served' AND d.occurred_at > v.revoked_at`,
  [grantIds]
);
await pool.end();
store.close();
await dispatcher.close();

const effects = results.map((r) => r.effect_ms).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
const summary = {
  disclosures_after_revocation_in_spine: Number(spine.rows[0]?.n ?? 0),
  effect_ms: {
    max: effects.at(-1) ?? null,
    median: effects.length ? effects[Math.floor(effects.length / 2)] : null,
  },
  probes: results.length,
  probes_without_effect: results.filter((r) => r.effect_ms === null).length,
  served_after_ack_total: results.reduce((n, r) => n + Number(r.served_after_ack ?? 0), 0),
};
writeFileSync(out, `${JSON.stringify({ probes: results, summary }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exitCode =
  summary.served_after_ack_total === 0 &&
  summary.probes_without_effect === 0 &&
  summary.disclosures_after_revocation_in_spine === 0 &&
  (summary.effect_ms.max ?? Number.POSITIVE_INFINITY) <= 60_000
    ? 0
    : 1;
