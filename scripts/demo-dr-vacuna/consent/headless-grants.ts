// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Headless consent driver for the DR pilot: creates parent-approved grants
// and refused attempts through the real HTTP path, including the civil
// registry check, and measures the rate.
//
// Per grant (child i, one of its registered guardians):
//   client  POST /oauth/par                      authorization_details for child i
//   parent  POST /pilot/cuenta-unica/login       once per parent (session reused)
//   parent  POST /pilot/vacuna/consent/select    registry check -> review
//   parent  POST /pilot/vacuna/consent/approve   grant + token
// Per refusal (row of pilot_rc_refusal_set): PAR, login, select -> 403 access_denied.
//
// Needs a server started with PDPP_PILOT_DR_VACUNA=1, the baseline
// `bootstrap` phase (reminder client), the records phase for the connector
// instance, and seed-registry.ts.
//
// Usage: node headless-grants.ts [--from 1] [--grants 2000] [--refusals 2000]
//          [--concurrency 8] [--label run] [--tokens-out path.ndjson]
// Env: VACUNA_AS_URL, VACUNA_DATABASE_URL, VACUNA_STATE_DIR (baseline state for client_id)

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { AS_URL, argInt, argValue, DATABASE_URL, readState, runPool } from "../baseline/lib/common.ts";
import { childId } from "../baseline/lib/dataset.ts";
import { SOURCE_ID, STREAM } from "../baseline/lib/manifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.env.PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD || "vacuna-demo-2026";
const from = argInt("from", 1);
const grantCount = argInt("grants", 2000);
const refusalCount = argInt("refusals", 2000);
const concurrency = argInt("concurrency", 8);
const label = argValue("label", "headless");
const tokensOut = argValue("tokens-out", "");

interface Session {
  cookie: string;
  csrf: string;
}

async function post(path: string, payload: unknown, cookie?: string) {
  const res = await fetch(`${AS_URL}${path}`, {
    body: JSON.stringify(payload),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    method: "POST",
  });
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { body, headers: res.headers, status: res.status };
}

function detailsFor(child: string) {
  return [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "Recordatorios de vacunación para un niño o niña",
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [{ name: STREAM, resources: [child] }],
      type: "https://pdpp.dev/data-access",
    },
  ];
}

const timing = { approve: 0, login: 0, par: 0, select: 0 };
const sessions = new Map<string, Promise<Session>>();
let parRetries = 0;

async function timed<T>(key: keyof typeof timing, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timing[key] += performance.now() - t0;
  }
}

function sessionFor(cedula: string): Promise<Session> {
  let session = sessions.get(cedula);
  if (!session) {
    session = timed("login", async () => {
      const res = await post("/pilot/cuenta-unica/login", { cedula, password: PASSWORD });
      if (res.status !== 200) {
        throw new Error(`login ${cedula}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      return {
        cookie: String(res.headers.get("set-cookie")).split(";")[0] as string,
        csrf: String(res.body.csrf_token),
      };
    });
    sessions.set(cedula, session);
  }
  return session;
}

async function par(clientId: string, child: string): Promise<string> {
  return await timed("par", async () => {
    let res = await post("/oauth/par", { authorization_details: detailsFor(child), client_id: clientId });
    // The reference AS draws a 6-hex-digit user_code that is UNIQUE across every
    // pending_consents row ever written, so collisions grow with volume; retry.
    for (
      let attempt = 0;
      attempt < 5 && res.status === 500 && JSON.stringify(res.body).includes("user_code");
      attempt++
    ) {
      parRetries += 1;
      res = await post("/oauth/par", { authorization_details: detailsFor(child), client_id: clientId });
    }
    if (res.status !== 201) {
      throw new Error(`PAR ${child}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return String(res.body.request_uri);
  });
}

async function main(): Promise<void> {
  const clientId = readState().clientId;
  if (!clientId) {
    throw new Error("no client_id in baseline state; run `node seed.ts --phase bootstrap` first");
  }
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const children = Array.from({ length: grantCount }, (_, k) => childId(from + k));
  const guardians = await pool.query(
    `SELECT DISTINCT ON (child_id) child_id, parent_cedula FROM pilot_rc_guardianships
      WHERE status = 'active' AND child_id = ANY($1) ORDER BY child_id, capacity DESC, parent_cedula`,
    [children]
  );
  const guardianOf = new Map(guardians.rows.map((r) => [String(r.child_id), String(r.parent_cedula)]));
  const refusals = (
    await pool.query(
      "SELECT parent_cedula, child_id, expected_reason FROM pilot_rc_refusal_set ORDER BY seq LIMIT $1",
      [refusalCount]
    )
  ).rows as Array<{ child_id: string; expected_reason: string; parent_cedula: string }>;
  await pool.end();
  if (tokensOut) {
    mkdirSync(dirname(tokensOut), { recursive: true });
    writeFileSync(tokensOut, "");
  }

  const errors: string[] = [];
  let granted = 0;
  const grantStart = performance.now();
  await runPool(0, children.length - 1, concurrency, async (k) => {
    const child = children[k] as string;
    const cedula = guardianOf.get(child);
    if (!cedula) {
      errors.push(`${child}: no active guardian in registry`);
      return;
    }
    try {
      const requestUri = await par(clientId, child);
      const session = await sessionFor(cedula);
      const selected = await timed("select", () =>
        post("/pilot/vacuna/consent/select", { csrf_token: session.csrf, request_uri: requestUri }, session.cookie)
      );
      if (selected.status !== 200) {
        throw new Error(`select HTTP ${selected.status} ${JSON.stringify(selected.body).slice(0, 300)}`);
      }
      const approved = await timed("approve", () =>
        post(
          "/pilot/vacuna/consent/approve",
          { csrf_token: session.csrf, pilot_revision: selected.body.pilot_revision, request_uri: requestUri },
          session.cookie
        )
      );
      if (approved.status !== 200) {
        throw new Error(`approve HTTP ${approved.status} ${JSON.stringify(approved.body).slice(0, 300)}`);
      }
      granted += 1;
      if (tokensOut) {
        appendFileSync(
          tokensOut,
          `${JSON.stringify({ child, grant_id: approved.body.grant_id, token: approved.body.token })}\n`
        );
      }
      if (granted % 500 === 0) {
        console.log(`[grants] ${granted} (${(granted / ((performance.now() - grantStart) / 1000)).toFixed(1)}/s)`);
      }
    } catch (err) {
      errors.push(`${child}: ${(err as Error).message}`);
    }
  });
  const grantSeconds = (performance.now() - grantStart) / 1000;
  const grantTiming = { ...timing };

  let refused = 0;
  const reasons: Record<string, number> = {};
  const refuseStart = performance.now();
  await runPool(0, refusals.length - 1, concurrency, async (k) => {
    const attempt = refusals[k] as (typeof refusals)[number];
    try {
      const requestUri = await par(clientId, attempt.child_id);
      const session = await sessionFor(attempt.parent_cedula);
      const res = await timed("select", () =>
        post("/pilot/vacuna/consent/select", { csrf_token: session.csrf, request_uri: requestUri }, session.cookie)
      );
      if (res.status !== 403 || res.body.error !== "access_denied") {
        throw new Error(`expected access_denied, got HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      reasons[res.body.registry_reason] = (reasons[res.body.registry_reason] ?? 0) + 1;
      if (res.body.registry_reason !== attempt.expected_reason) {
        throw new Error(`reason ${res.body.registry_reason} != expected ${attempt.expected_reason}`);
      }
      refused += 1;
    } catch (err) {
      errors.push(`refusal ${attempt.parent_cedula}/${attempt.child_id}: ${(err as Error).message}`);
    }
  });
  const refuseSeconds = (performance.now() - refuseStart) / 1000;

  const per = (ms: number, n: number) => (n > 0 ? Math.round((ms / n) * 10) / 10 : null);
  const result = {
    concurrency,
    errors: errors.length,
    error_samples: errors.slice(0, 10),
    grants: {
      count: granted,
      mean_ms_per_step: {
        approve: per(grantTiming.approve, granted),
        login_per_parent: per(grantTiming.login, sessions.size),
        par: per(grantTiming.par, granted),
        select_incl_registry_check: per(grantTiming.select, granted),
      },
      per_second: Math.round((granted / grantSeconds) * 10) / 10,
      seconds: Math.round(grantSeconds * 10) / 10,
    },
    label,
    par_user_code_collision_retries: parRetries,
    projection_hours_for_980200_grants: granted
      ? Math.round((980_200 / (granted / grantSeconds) / 3600) * 100) / 100
      : null,
    refusals: {
      count: refused,
      per_second: Math.round((refused / Math.max(refuseSeconds, 0.001)) * 10) / 10,
      reasons,
      seconds: Math.round(refuseSeconds * 10) / 10,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`),
    `${JSON.stringify(result, null, 2)}\n`
  );
}

await main();
