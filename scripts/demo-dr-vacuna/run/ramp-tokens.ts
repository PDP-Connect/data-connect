// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Token pool for the throughput ramp (baseline/loadgen.ts --tokens-file):
// fresh access tokens for a seeded sample of active grants (rotated through
// the real token endpoint, 10-minute lifetime, so the ramp should start right
// after this) and the tokens the reminder service holds for revoked grants.
//
// Usage: node ramp-tokens.ts --children N [--active 3000] [--every 50] [--offset 25] [--seed S] --out tokens.json

import { writeFileSync } from "node:fs";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { rng } from "./lib/plan.ts";
import { freshAccessToken, openStore, reminderClient } from "./lib/pilot.ts";

const children = argInt("children", 0);
const activeTarget = argInt("active", 3000);
const every = argInt("every", 50);
const offset = argInt("offset", 25);
const rand = rng(argInt("seed", 20_261_014) ^ 0x7a3b);
const out = argValue("out", "ramp-tokens.json");
const reminderState = process.env.VACUNA_REMINDER_STATE_DIR as string;

const store = openStore(reminderState);
const client = reminderClient(reminderState);
const candidates = new Set<number>();
for (let tries = 0; candidates.size < Math.min(activeTarget, children) && tries < activeTarget * 20; tries++) {
  const i = 1 + Math.floor(rand() * children);
  if (i % every !== offset && store.getChild(i)?.status === "active") {
    candidates.add(i);
  }
}
const ids = [...candidates];
const active: [number, string][] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const i = ids[next++] as number;
      // biome-ignore lint/performance/noAwaitInLoops: per-lane sequence
      const token = await freshAccessToken(store, client, i);
      if (token) {
        active.push([i, token]);
      }
    }
  })
);
const revoked: [number, string][] = [];
for (let i = offset; i <= children; i += every) {
  const row = store.getChild(i);
  if (row?.access_token) {
    revoked.push([i, row.access_token]);
  }
}
store.close();
writeFileSync(out, JSON.stringify({ active, revoked }));
console.log(JSON.stringify({ active: active.length, revoked: revoked.length, out }));
if (!(active.length && revoked.length)) {
  process.exitCode = 1;
}
