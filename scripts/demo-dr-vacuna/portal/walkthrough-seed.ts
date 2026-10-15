// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Idempotent seed for the guided walkthrough (walkthrough-data.ts):
//   1. register the synthetic vaccination-register source (409 = already there);
//   2. ingest the 15 child records through the real RS ingest API (upsert by key);
//   3. upsert the civil-registry stub rows (adults, children, guardianships),
//      restoring each guardianship's seeded status.
// Safe to run on every boot. Talks to the AS/RS on loopback and to Postgres.
//
//   node walkthrough-seed.ts      (VACUNA_AS_URL, VACUNA_RS_URL, VACUNA_DATABASE_URL)

import pg from "pg";
import { REGISTRY_SCHEMA_SQL } from "../../../reference-implementation/server/pilot-dr-vacuna/registry-schema.ts";
import { CONNECTOR_ID, STREAM, VACUNA_MANIFEST } from "../baseline/lib/manifest.ts";
import { ADULTS, CHILDREN, GUARDIANSHIPS, walkthroughRecord } from "./walkthrough-data.ts";

export interface SeedTargets {
  asUrl: string;
  databaseUrl: string;
  rsUrl: string;
}

const OWNER_SUBJECT_ID = "owner_local";

async function call(url: string, init: RequestInit = {}) {
  const resp = await fetch(url, { redirect: "manual", ...init });
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { body, status: resp.status };
}

const form = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});

async function ownerToken(asUrl: string): Promise<string> {
  const device = await call(`${asUrl}/oauth/device_authorization`, form({ client_id: "cli_longview" }));
  if (device.status !== 200) {
    throw new Error(`device authorization: HTTP ${device.status} ${JSON.stringify(device.body)}`);
  }
  await fetch(
    `${asUrl}/device/approve`,
    form({ subject_id: OWNER_SUBJECT_ID, user_code: String(device.body.user_code) })
  );
  const token = await call(
    `${asUrl}/oauth/token`,
    form({
      client_id: "cli_longview",
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  );
  if (token.status !== 200) {
    throw new Error(`owner token: HTTP ${token.status} ${JSON.stringify(token.body)}`);
  }
  return String(token.body.access_token);
}

export async function seedWalkthrough(targets: SeedTargets): Promise<{ adults: number; children: number }> {
  const reg = await call(`${targets.asUrl}/connectors`, {
    body: JSON.stringify(VACUNA_MANIFEST),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  if (![200, 201, 409].includes(reg.status)) {
    throw new Error(`register source: HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
  }

  const owner = await ownerToken(targets.asUrl);
  const lines = CHILDREN.map((child) => {
    const data = walkthroughRecord(child);
    return JSON.stringify({ data, emitted_at: data.updated_at, key: data.child_id });
  });
  const ingest = await call(
    `${targets.rsUrl}/v1/ingest/${STREAM}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
    {
      body: lines.join("\n"),
      headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
  if (ingest.status !== 200 || Number(ingest.body.records_rejected) > 0) {
    throw new Error(`ingest: HTTP ${ingest.status} ${JSON.stringify(ingest.body).slice(0, 400)}`);
  }

  const pool = new pg.Pool({ connectionString: targets.databaseUrl, max: 1 });
  try {
    await pool.query(REGISTRY_SCHEMA_SQL);
    await pool.query("BEGIN");
    for (const a of ADULTS) {
      await pool.query(
        `INSERT INTO pilot_rc_parents (cedula, given_name, family_name) VALUES ($1, $2, $3)
         ON CONFLICT (cedula) DO UPDATE SET given_name = EXCLUDED.given_name, family_name = EXCLUDED.family_name`,
        [a.cedula, a.given_name, a.family_name]
      );
    }
    for (const c of CHILDREN) {
      await pool.query(
        `INSERT INTO pilot_rc_children (child_id, given_name, family_name, birth_date) VALUES ($1, $2, $3, $4)
         ON CONFLICT (child_id) DO UPDATE SET given_name = EXCLUDED.given_name,
           family_name = EXCLUDED.family_name, birth_date = EXCLUDED.birth_date`,
        [c.child_id, c.given_name, c.family_name, c.birth_date]
      );
    }
    for (const g of GUARDIANSHIPS) {
      await pool.query(
        `INSERT INTO pilot_rc_guardianships (parent_cedula, child_id, capacity, status) VALUES ($1, $2, $3, $4)
         ON CONFLICT (parent_cedula, child_id) DO UPDATE SET capacity = EXCLUDED.capacity, status = EXCLUDED.status`,
        [g.cedula, g.child_id, g.capacity, g.status]
      );
    }
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await pool.end();
  }
  return { adults: ADULTS.length, children: CHILDREN.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await seedWalkthrough({
    asUrl: process.env.VACUNA_AS_URL || "http://127.0.0.1:7662",
    databaseUrl: process.env.VACUNA_DATABASE_URL || "postgres://pdpp:pdpp@localhost:55432/pdpp",
    rsUrl: process.env.VACUNA_RS_URL || "http://127.0.0.1:7663",
  });
  console.log(`walkthrough seed: ${result.adults} adults, ${result.children} children`);
}
