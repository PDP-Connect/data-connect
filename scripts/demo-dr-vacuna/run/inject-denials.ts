// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The pilot's denied reads, sent to the RS in one seeded, shuffled stream:
//
//   revoked   --revoked-reads   a revoked grant's (unexpired) access token
//                               reading its own child's record   -> 403 grant_revoked
//   fields    --field-reads     an active grant's fresh token asking for a
//                               declared field outside the grant
//                               (?fields=updated_at)             -> 403 field_not_granted
//   expired   half of --bad-token-reads: each child's first access token
//                               (10-minute lifetime, long expired) -> 401 (token_expired)
//   malformed the other half: never-issued, truncated, non-hex,
//                               empty bearer                     -> 401
//
// Any other status, a 200 above all, is counted as unexpected. Tokens come
// from the reminder service's store; active-grant tokens are rotated first
// through the real token endpoint (the store keeps the new pair).
//
// Usage: node inject-denials.ts --children N --revoked-reads A --field-reads B --bad-token-reads C
//          [--every 50] [--offset 25] [--seed 20261014] [--concurrency 32] [--field-pool 2000] --out file.json

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { childId } from "../baseline/lib/dataset.ts";
import { STREAM } from "../baseline/lib/manifest.ts";
import { RS_URL, rng } from "./lib/plan.ts";
import { freshAccessToken, keepAlive, openStore, reminderClient } from "./lib/pilot.ts";

type Kind = "revoked" | "fields" | "expired" | "malformed";
const EXPECTED: Record<Kind, number> = { expired: 401, fields: 403, malformed: 401, revoked: 403 };

const children = argInt("children", 0);
const every = argInt("every", 50);
const offset = argInt("offset", 25);
const seed = argInt("seed", 20_261_014);
const concurrency = argInt("concurrency", 32);
const badTokenReads = argInt("bad-token-reads", 0);
const counts: Record<Kind, number> = {
  expired: Math.floor(badTokenReads / 2),
  fields: argInt("field-reads", 0),
  malformed: badTokenReads - Math.floor(badTokenReads / 2),
  revoked: argInt("revoked-reads", 0),
};
const fieldPoolSize = argInt("field-pool", 2000);
const reminderState = process.env.VACUNA_REMINDER_STATE_DIR as string;
const out = argValue("out", join(reminderState, "..", "injector-result.json"));
const rand = rng(seed);
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)] as T;

const store = openStore(reminderState);
const client = reminderClient(reminderState);
const isRevoked = (i: number) => i % every === offset;

// Revoked grants: the token the reminder service holds (rotated just before revocation).
const revoked: Array<{ child: string; token: string }> = [];
for (let i = offset; i <= children; i += every) {
  const row = store.getChild(i);
  if (row?.access_token) {
    revoked.push({ child: row.child_id, token: row.access_token });
  }
}

// Expired tokens: each child's first access token, from the grant seeding journal.
// Wait for them to expire before rotating any fresh token below (10-minute lifetime).
const journal = new Database(join(reminderState, "seed-grants.sqlite"), { readonly: true });
const expiredCandidates = (
  journal
    .prepare(
      "SELECT child_index, initial_access_token AS token, initial_access_expires_at AS exp FROM granted ORDER BY child_index"
    )
    .all() as Array<{ child_index: number; exp: number | null; token: string }>
).filter((r) => !isRevoked(r.child_index));
journal.close();
const latestExpiry = expiredCandidates.reduce((max, r) => Math.max(max, r.exp ?? 0), 0);
if (counts.expired > 0 && latestExpiry > Date.now()) {
  const waitMs = latestExpiry - Date.now() + 2000;
  console.log(`[inject] waiting ${Math.round(waitMs / 1000)} s for the first access tokens to expire`);
  await new Promise((r) => setTimeout(r, waitMs));
}

// Active grants for out-of-grant field reads: rotate a seeded sample's tokens now.
const activeIndexes: number[] = [];
for (let i = 1; i <= children; i++) {
  if (!isRevoked(i)) {
    activeIndexes.push(i);
  }
}
const poolIdx = new Set<number>();
while (poolIdx.size < Math.min(fieldPoolSize, activeIndexes.length)) {
  poolIdx.add(pick(activeIndexes));
}
const fieldPool: Array<{ child: string; token: string }> = [];
const rotateFailures: number[] = [];
{
  const ids = [...poolIdx].sort((a, b) => a - b);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < ids.length) {
        const i = ids[next++] as number;
        // biome-ignore lint/performance/noAwaitInLoops: per-lane sequence
        const token = await freshAccessToken(store, client, i);
        if (token) {
          fieldPool.push({ child: childId(i), token });
        } else {
          rotateFailures.push(i);
        }
      }
    })
  );
  fieldPool.sort((a, b) => a.child.localeCompare(b.child));
}

function malformed(k: number): string {
  const hex = () => Math.floor(rand() * 4_294_967_296).toString(16).padStart(8, "0");
  switch (k % 4) {
    case 0:
      return Array.from({ length: 8 }, hex).join(""); // 64 hex, never issued
    case 1:
      return (pick(fieldPool).token as string).slice(0, 40); // truncated
    case 2:
      return `tok_${Array.from({ length: 3 }, hex).join("")}!`; // not a token shape
    default:
      return ""; // "Authorization: Bearer " with nothing after it
  }
}

interface Req {
  child: string;
  kind: Kind;
  query: string;
  token: string;
}
const requests: Req[] = [];
for (let k = 0; k < counts.revoked; k++) {
  const r = revoked[k % revoked.length] as { child: string; token: string };
  requests.push({ child: r.child, kind: "revoked", query: "", token: r.token });
}
for (let k = 0; k < counts.fields; k++) {
  const r = fieldPool[k % fieldPool.length] as { child: string; token: string };
  requests.push({ child: r.child, kind: "fields", query: "?fields=updated_at", token: r.token });
}
for (let k = 0; k < counts.expired; k++) {
  const r = expiredCandidates[k % expiredCandidates.length] as { child_index: number; token: string };
  requests.push({ child: childId(r.child_index), kind: "expired", query: "", token: r.token });
}
for (let k = 0; k < counts.malformed; k++) {
  requests.push({ child: childId(1 + (k % children)), kind: "malformed", query: "", token: malformed(k) });
}
// Fisher-Yates with the run seed: same order on every run.
for (let i = requests.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [requests[i], requests[j]] = [requests[j] as Req, requests[i] as Req];
}

const dispatcher = keepAlive(concurrency);
const statusByKind: Record<string, Record<string, number>> = {};
const codeByKind: Record<string, Record<string, number>> = {};
const latencies: number[] = [];
let unexpected = 0;
let served = 0;
let transportErrors = 0;
const started = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < requests.length) {
      const r = requests[next++] as Req;
      const t0 = performance.now();
      let status = 0;
      let code = "transport_error";
      try {
        // biome-ignore lint/performance/noAwaitInLoops: closed-loop lane
        const res = await fetch(`${RS_URL}/v1/streams/${STREAM}/records/${encodeURIComponent(r.child)}${r.query}`, {
          dispatcher,
          headers: { Accept: "application/json", Authorization: `Bearer ${r.token}` },
          signal: AbortSignal.timeout(15_000),
        } as RequestInit);
        status = res.status;
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        code = body.error?.code ?? (status === 200 ? "served" : "none");
      } catch {
        transportErrors += 1;
      }
      latencies.push(performance.now() - t0);
      (statusByKind[r.kind] ??= {})[status] = ((statusByKind[r.kind] as Record<string, number>)[status] ?? 0) + 1;
      (codeByKind[r.kind] ??= {})[code] = ((codeByKind[r.kind] as Record<string, number>)[code] ?? 0) + 1;
      if (status === 200) {
        served += 1;
      }
      if (status !== EXPECTED[r.kind]) {
        unexpected += 1;
      }
    }
  })
);
const seconds = (performance.now() - started) / 1000;
await dispatcher.close();
store.close();

latencies.sort((a, b) => a - b);
const pct = (p: number) => Math.round((latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] ?? 0) * 10) / 10;
const result = {
  codes_by_kind: codeByKind,
  concurrency,
  expected_status: EXPECTED,
  field_pool: fieldPool.length,
  latency_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
  per_second: Math.round((requests.length / seconds) * 10) / 10,
  requested: counts,
  revoked_tokens: revoked.length,
  rotate_failures: rotateFailures.length,
  seconds: Math.round(seconds * 10) / 10,
  sent: requests.length,
  served_200: served,
  status_by_kind: statusByKind,
  transport_errors: transportErrors,
  unexpected,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = unexpected === 0 ? 0 : 1;
