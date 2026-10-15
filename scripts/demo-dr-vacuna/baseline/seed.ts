// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Seed the reference server for the DR vaccination-reminder load test.
//
// Phases (default: all, in order):
//   bootstrap    register the synthetic registry source, mint an owner token
//                (device flow), register the reminder service (DCR, public)
//   records      ingest synthetic child records through POST /v1/ingest
//                (use --concurrency 1: parallel batches fail in this build)
//   bulk-records load the remaining records directly into Postgres
//   real-grants  issue grants through PAR -> consent/review -> consent/approve
//   bulk-grants  clone the first real grant in SQL for the remaining children
//   revoke       revoke every 100th grant through POST /grants/:id/revoke
//   prepare      VACUUM ANALYZE + CHECKPOINT so the load test starts settled
//   registry     (DR pilot, not in "all") civil-registry stub: ~650k parents,
//                guardianships, refusal set; ../consent/seed-registry.ts
//
// Usage:
//   node seed.ts [--phase all|bootstrap|records|bulk-records|real-grants|bulk-grants|revoke|prepare|registry]
//                [--records 1000000] [--api-records 20000] [--grants 980200] [--real-grants 2000]
//                [--from N] [--concurrency 4] [--batch 1000]

import pg from "pg";
import {
  AS_URL,
  argInt,
  argValue,
  DATABASE_URL,
  derivedGrantId,
  derivedToken,
  isRevokedIndex,
  OWNER_SUBJECT_ID,
  RS_URL,
  readRealTokens,
  readState,
  runPool,
  type SeedState,
  tokenFor,
  writeRealTokens,
  writeState,
} from "./lib/common.ts";
import { childId, generateChild } from "./lib/dataset.ts";
import { CONNECTOR_ID, SOURCE_ID, STREAM, VACUNA_MANIFEST } from "./lib/manifest.ts";

const phase = argValue("phase", "all");
const recordTotal = argInt("records", 1_000_000);
const grantTotal = argInt("grants", 980_200);
const realGrantTotal = argInt("real-grants", 2000);
const state: SeedState = readState();
state.timings ??= {};

interface JsonResponse {
  body: Record<string, unknown>;
  status: number;
}

async function request(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { body, status: res.status };
}

function expectStatus(res: JsonResponse, ok: number[], what: string): void {
  if (!ok.includes(res.status)) {
    throw new Error(`${what} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 500)}`);
  }
}

const form = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});

const jsonPost = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
  method: "POST",
});

function recordTiming(name: string, count: number, startedAt: number): void {
  const seconds = (Date.now() - startedAt) / 1000;
  const perSecond = Math.round((count / Math.max(seconds, 0.001)) * 10) / 10;
  state.timings = { ...state.timings, [name]: { count, perSecond, seconds: Math.round(seconds) } };
  writeState(state);
  console.log(`[${name}] ${count} in ${seconds.toFixed(1)}s = ${perSecond}/s`);
}

async function bootstrap(): Promise<void> {
  const reg = await request(`${AS_URL}/connectors`, jsonPost(VACUNA_MANIFEST));
  expectStatus(reg, [200, 201, 409], "register source manifest");

  // Owner token through the device flow (the reference AS has no owner
  // password configured in this harness, so approval needs no session).
  const device = await request(`${AS_URL}/oauth/device_authorization`, form({ client_id: "cli_longview" }));
  expectStatus(device, [200], "device authorization");
  const approve = await fetch(
    `${AS_URL}/device/approve`,
    form({ subject_id: OWNER_SUBJECT_ID, user_code: String(device.body.user_code) })
  );
  if (!approve.ok) {
    throw new Error(`device approve failed: HTTP ${approve.status}`);
  }
  const token = await request(
    `${AS_URL}/oauth/token`,
    form({
      client_id: "cli_longview",
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  );
  expectStatus(token, [200], "owner token");
  state.ownerToken = String(token.body.access_token);

  // The reminder service: a public client registered through DCR (the only
  // client type the reference AS supports).
  const client = await request(
    `${AS_URL}/oauth/register`,
    jsonPost({
      client_name: "Recordatorio de Vacunas (synthetic)",
      grant_types: ["authorization_code"],
      redirect_uris: ["https://reminders.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
  );
  expectStatus(client, [201], "client registration");
  state.clientId = String(client.body.client_id);
  writeState(state);
  console.log(`[bootstrap] client_id=${state.clientId}`);
}

async function ingestRecords(to = recordTotal): Promise<void> {
  const ownerToken = state.ownerToken;
  if (!ownerToken) {
    throw new Error("run --phase bootstrap first");
  }
  const batch = argInt("batch", 2000);
  // Parallel batches into one connector instance fail with
  // ingest_batch_storage_error in this build, so the default is serial.
  const concurrency = argInt("concurrency", 1);
  const from = argInt("from", 1);
  const batches = Math.ceil((to - from + 1) / batch);
  const url = `${RS_URL}/v1/ingest/${STREAM}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`;
  const startedAt = Date.now();
  let done = 0;
  await runPool(0, batches - 1, concurrency, async (b) => {
    const first = from + b * batch;
    const last = Math.min(first + batch - 1, to);
    const lines: string[] = [];
    for (let i = first; i <= last; i++) {
      const data = generateChild(i);
      lines.push(JSON.stringify({ data, emitted_at: data.updated_at, key: data.child_id }));
    }
    const res = await request(url, {
      body: lines.join("\n"),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });
    expectStatus(res, [200], `ingest ${first}-${last}`);
    if (Number(res.body.records_rejected) > 0) {
      throw new Error(`ingest ${first}-${last} rejected records: ${JSON.stringify(res.body).slice(0, 500)}`);
    }
    done += last - first + 1;
    if (b % 50 === 0) {
      const rate = done / ((Date.now() - startedAt) / 1000);
      console.log(`[records] ${done} ingested (${rate.toFixed(0)}/s), last=${childId(last)}`);
    }
  });
  state.recordCount = Math.max(state.recordCount ?? 0, to);
  recordTiming("records_ingest", done, startedAt);
}

/**
 * Load children (--from)..(--records) straight into `records` and
 * `record_changes`. Bypasses POST /v1/ingest, which in this build accepts one
 * writer per connector instance and sustains ~42 records/s (1M records would
 * take ~6.5 h). Rows mirror what ingest writes for this stream: same
 * connector instance, monotonically increasing version, cursor/semantic time
 * from updated_at. Row triggers are disabled for the load
 * (session_replication_role=replica); the per-instance source_revision bump
 * they would do is applied once at the end. Retained-size and connector
 * summary read models are not updated (the record read path does not use
 * them).
 */
async function bulkRecords(): Promise<void> {
  const from = argInt("from", (state.recordCount ?? 0) + 1);
  const chunk = argInt("bulk-batch", 5000);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const startedAt = Date.now();
  let done = 0;
  try {
    const counter = await pool.query(
      "SELECT connector_instance_id, max_version FROM version_counter WHERE connector_id = $1 AND stream = $2",
      [CONNECTOR_ID, STREAM]
    );
    const instanceId = counter.rows[0]?.connector_instance_id as string | undefined;
    if (!instanceId) {
      throw new Error("ingest at least one batch through --phase records first (creates the connector instance)");
    }
    let version = Number(counter.rows[0]?.max_version ?? 0);
    for (let lo = from; lo <= recordTotal; lo += chunk) {
      const hi = Math.min(lo + chunk - 1, recordTotal);
      const keys: string[] = [];
      const jsons: string[] = [];
      const times: string[] = [];
      const versions: number[] = [];
      for (let i = lo; i <= hi; i++) {
        const child = generateChild(i);
        version += 1;
        keys.push(child.child_id);
        jsons.push(JSON.stringify(child));
        times.push(child.updated_at);
        versions.push(version);
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at,
                                semantic_time, version, deleted, cursor_value, primary_key_text)
           SELECT $1, $2, $3, k, j::jsonb, t, t, v, false, t, k
             FROM unnest($4::text[], $5::text[], $6::text[], $7::bigint[]) AS u(k, j, t, v)
           ON CONFLICT (connector_instance_id, stream, record_key) DO NOTHING`,
          [CONNECTOR_ID, instanceId, STREAM, keys, jsons, times, versions]
        );
        await client.query(
          `INSERT INTO record_changes (connector_id, connector_instance_id, stream, record_key, version, record_json,
                                       emitted_at, deleted)
           SELECT $1, $2, $3, k, v, j::jsonb, t, false
             FROM unnest($4::text[], $5::text[], $6::text[], $7::bigint[]) AS u(k, j, t, v)
           ON CONFLICT DO NOTHING`,
          [CONNECTOR_ID, instanceId, STREAM, keys, jsons, times, versions]
        );
        await client.query(
          "UPDATE version_counter SET max_version = GREATEST(max_version, $3) WHERE connector_id = $1 AND stream = $2",
          [CONNECTOR_ID, STREAM, version]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      done += hi - lo + 1;
      if ((hi / chunk) % 20 === 0 || hi === recordTotal) {
        console.log(`[bulk-records] ${hi} (${(done / ((Date.now() - startedAt) / 1000)).toFixed(0)}/s)`);
      }
    }
    await pool.query(
      "UPDATE connector_instances SET source_revision = COALESCE(source_revision, 0) + 1 WHERE connector_instance_id = $1",
      [instanceId]
    );
    await pool.query("ANALYZE records");
  } finally {
    await pool.end();
  }
  state.recordCount = recordTotal;
  recordTiming("bulk_records", done, startedAt);
}

async function issueRealGrant(clientId: string, index: number): Promise<{ grantId: string; token: string }> {
  const par = await request(
    `${AS_URL}/oauth/par`,
    jsonPost({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/assist_summarize",
          purpose_description: "Recordatorios de vacunación para un niño o niña",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ name: STREAM, resources: [childId(index)] }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: clientId,
    })
  );
  expectStatus(par, [201], `PAR ${index}`);
  const review = await request(
    `${AS_URL}/consent/review`,
    jsonPost({ request_uri: par.body.request_uri, subject_id: OWNER_SUBJECT_ID })
  );
  expectStatus(review, [200], `consent review ${index}`);
  const approved = await request(
    `${AS_URL}/consent/approve`,
    jsonPost({ approval_review_revision: review.body.approval_review_revision, request_uri: par.body.request_uri })
  );
  expectStatus(approved, [200], `consent approve ${index}`);
  return { grantId: String(approved.body.grant_id), token: String(approved.body.token) };
}

async function realGrants(): Promise<void> {
  const clientId = state.clientId;
  if (!clientId) {
    throw new Error("run --phase bootstrap first");
  }
  const concurrency = argInt("concurrency", 8);
  const tokens = readRealTokens();
  const startedAt = Date.now();
  let done = 0;
  await runPool(1, realGrantTotal, concurrency, async (index) => {
    if (tokens[String(index)]) {
      return;
    }
    const { token } = await issueRealGrant(clientId, index);
    tokens[String(index)] = token;
    done += 1;
    if (done % 250 === 0) {
      writeRealTokens(tokens);
      console.log(`[real-grants] ${done} (${(done / ((Date.now() - startedAt) / 1000)).toFixed(1)}/s)`);
    }
  });
  writeRealTokens(tokens);
  state.realGrantCount = realGrantTotal;
  recordTiming("real_grants", done, startedAt);
}

/**
 * Clone real grant #1 for children realGrantTotal+1..grantTotal directly in
 * Postgres. Bypasses PAR, consent review/approve, token minting, and the
 * grant.issued / token.issued / consent.approved spine events. The cloned
 * rows have the same grant_json shape (one stream, resources = [child_id]),
 * so introspection and the read path treat them exactly like real grants.
 */
async function bulkGrants(): Promise<void> {
  const realTokens = readRealTokens();
  const templateToken = realTokens["1"];
  if (!templateToken) {
    throw new Error("run --phase real-grants first (grant #1 is the template)");
  }
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const from = Math.max(argInt("from", 0), (state.realGrantCount ?? 0) + 1);
  const chunk = 50_000;
  const startedAt = Date.now();
  try {
    const template = await pool.query("SELECT grant_id FROM tokens WHERE token_id = $1", [templateToken]);
    const templateGrantId = template.rows[0]?.grant_id;
    if (!templateGrantId) {
      throw new Error("template grant not found");
    }
    for (let lo = from; lo <= grantTotal; lo += chunk) {
      const hi = Math.min(lo + chunk - 1, grantTotal);
      await pool.query("BEGIN");
      await pool.query(
        `INSERT INTO grants (grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode,
                             status, consumed, issued_at, expires_at, trace_id, scenario_id)
         SELECT ids.gid, t.subject_id, t.client_id, t.storage_binding_json,
                jsonb_set(jsonb_set(t.grant_json, '{grant_id}', to_jsonb(ids.gid)),
                          '{streams,0,resources}', jsonb_build_array(ids.child)),
                t.access_mode, 'active', false, t.issued_at, t.expires_at,
                'trc_' || substr(md5('vacuna-baseline-trace:' || i), 1, 16), t.scenario_id
           FROM grants t,
                generate_series($2::int, $3::int) AS i,
                LATERAL (SELECT 'grt_' || substr(encode(sha256(convert_to('vacuna-baseline-grant:' || i, 'UTF8')), 'hex'), 1, 16) AS gid,
                                'DR-' || lpad(i::text, 7, '0') AS child) ids
          WHERE t.grant_id = $1
         ON CONFLICT (grant_id) DO NOTHING`,
        [templateGrantId, lo, hi]
      );
      await pool.query(
        `INSERT INTO tokens (token_id, grant_id, subject_id, client_id, token_kind, expires_at, revoked)
         SELECT encode(sha256(convert_to('vacuna-baseline-token:' || i, 'UTF8')), 'hex'),
                'grt_' || substr(encode(sha256(convert_to('vacuna-baseline-grant:' || i, 'UTF8')), 'hex'), 1, 16),
                t.subject_id, t.client_id, 'client', t.expires_at, false
           FROM tokens t, generate_series($2::int, $3::int) AS i
          WHERE t.token_id = $1
         ON CONFLICT (token_id) DO NOTHING`,
        [templateToken, lo, hi]
      );
      await pool.query("COMMIT");
      console.log(`[bulk-grants] cloned ${lo}-${hi}`);
    }
    // Spot-check the derivation matches what the load generator computes.
    const probe = Math.min(grantTotal, from + 7);
    const check = await pool.query("SELECT grant_id FROM tokens WHERE token_id = $1", [derivedToken(probe)]);
    if (check.rows[0]?.grant_id !== derivedGrantId(probe)) {
      throw new Error(`derived token/grant mismatch for child ${probe}`);
    }
    await pool.query("ANALYZE grants");
    await pool.query("ANALYZE tokens");
  } finally {
    await pool.end();
  }
  state.grantCount = grantTotal;
  recordTiming("bulk_grants", grantTotal - from + 1, startedAt);
}

async function revokeGrants(): Promise<void> {
  const realTokens = readRealTokens();
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const targets: number[] = [];
  for (let i = 1; i <= grantTotal; i++) {
    if (isRevokedIndex(i)) {
      targets.push(i);
    }
  }
  const startedAt = Date.now();
  let done = 0;
  try {
    await runPool(0, targets.length - 1, argInt("concurrency", 8), async (k) => {
      const index = targets[k] as number;
      const token = tokenFor(index, realTokens);
      const lookup = await pool.query("SELECT grant_id FROM tokens WHERE token_id = $1", [token]);
      const grantId = lookup.rows[0]?.grant_id;
      if (!grantId) {
        throw new Error(`no grant for child ${index}`);
      }
      // The grant holder revokes its own grant: the real revoke route,
      // authenticated with that grant's client bearer.
      const res = await request(`${AS_URL}/grants/${grantId}/revoke`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        method: "POST",
      });
      expectStatus(res, [200, 409], `revoke ${grantId}`);
      done += 1;
      if (done % 1000 === 0) {
        console.log(`[revoke] ${done}/${targets.length}`);
      }
    });
  } finally {
    await pool.end();
  }
  state.revokedCount = targets.length;
  recordTiming("revoke", done, startedAt);
}

/**
 * Settle the database before measuring: the bulk load leaves 1M+ unvacuumed
 * rows, and the autovacuum + checkpoint WAL it triggers otherwise competes
 * with the audit inserts (first probe ran at ~7 req/s with spine INSERTs
 * stuck in WALWrite for seconds).
 */
async function prepare(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const startedAt = Date.now();
  try {
    for (const table of ["records", "record_changes", "grants", "tokens", "spine_events"]) {
      await pool.query(`VACUUM (ANALYZE) ${table}`);
    }
    await pool.query("CHECKPOINT");
  } finally {
    await pool.end();
  }
  recordTiming("prepare", 1, startedAt);
}

/** DR pilot civil-registry stub: parents, guardianships, refusal set (see ../consent/README.md). */
async function registry(): Promise<void> {
  await import("../consent/seed-registry.ts");
}

const phases: Record<string, () => Promise<void>> = {
  bootstrap,
  "bulk-grants": bulkGrants,
  "bulk-records": bulkRecords,
  prepare,
  records: ingestRecords,
  "real-grants": realGrants,
  registry,
  revoke: revokeGrants,
};

if (phase === "all") {
  // The API ingest covers the first --api-records children; the rest are
  // bulk-loaded (see bulkRecords for why).
  await bootstrap();
  await ingestRecords(Math.min(argInt("api-records", 20_000), recordTotal));
  for (const name of ["bulk-records", "real-grants", "bulk-grants", "revoke", "prepare"]) {
    await (phases[name] as () => Promise<void>)();
  }
} else if (phases[phase]) {
  await (phases[phase] as () => Promise<void>)();
} else {
  throw new Error(`unknown phase ${phase}`);
}
