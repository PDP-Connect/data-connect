// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reminder service CLI. See README.md.
//
//   node cli.ts bootstrap --children 50 [--ingest]
//   node cli.ts week   [--now ISO | --clock-offset-days N]
//   node cli.ts daily  [--now ISO | --clock-offset-days N]
//   node cli.ts simulate --start ISO --days 28
//   node cli.ts import-baseline --from 2001 --to 980200
//   node cli.ts counters

import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argInt, argValue, derivedGrantId, derivedToken, OWNER_SUBJECT_ID } from "../baseline/lib/common.ts";
import { childId, generateChild } from "../baseline/lib/dataset.ts";
import { CONNECTOR_ID, SOURCE_ID, STREAM, VACUNA_MANIFEST } from "../baseline/lib/manifest.ts";
import { type Clock, createClock, DAY_MS, ManualClock, WEEK_MS } from "./lib/clock.ts";
import { type ClientCredentials, loadOrCreateClientKey, privateKeyJwtClient, publicClient } from "./lib/oauth.ts";
import {
  assertAllowedRemote,
  type GatewayPayer,
  HttpGatewayPayer,
  MockPayer,
  NATIVE_ASSET,
  ONE_HUNDREDTH_VANA_WEI,
} from "./lib/payer.ts";
import { DEFAULT_CONFIG, ReminderService } from "./lib/service.ts";
import {
  dispositionStubFromFile,
  type GrantStatusSource,
  IntrospectionStatusSource,
  LifecycleEndpointStatusSource,
} from "./lib/status.ts";
import { ReminderStore } from "./lib/store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = argValue("state-dir", process.env.VACUNA_REMINDER_STATE_DIR || join(HERE, ".state"));
const AS_URL = argValue("as-url", process.env.VACUNA_AS_URL || "http://127.0.0.1:7662");
const RS_URL = argValue("rs-url", process.env.VACUNA_RS_URL || "http://127.0.0.1:7663");
const ISSUER = argValue("issuer", process.env.VACUNA_AS_ISSUER || AS_URL);
const REDIRECT_URI = "https://reminders.example/callback";
mkdirSync(STATE_DIR, { recursive: true });

interface ClientState {
  clientId: string;
  method: "private_key_jwt" | "none";
}

function readClientState(): ClientState | null {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, "client.json"), "utf8")) as ClientState;
  } catch {
    return null;
  }
}

function clientCredentials(): ClientCredentials {
  const state = readClientState();
  if (!state) {
    throw new Error("no registered client: run `node cli.ts bootstrap` first");
  }
  if (state.method === "none") {
    return publicClient(state.clientId);
  }
  const { key, kid } = loadOrCreateClientKey(join(STATE_DIR, "client-key.pem"));
  return privateKeyJwtClient({ clientId: state.clientId, issuer: ISSUER, key, kid });
}

function buildClock(): Clock {
  const now = argValue("now", "");
  return createClock({ fixedNow: now || null, offsetMs: argInt("clock-offset-days", 0) * DAY_MS });
}

function buildPayer(store: ReminderStore): GatewayPayer {
  const kind = argValue("payer", "mock");
  if (kind === "mock") {
    return new MockPayer();
  }
  if (kind !== "http") {
    throw new Error(`unknown --payer ${kind}`);
  }
  const env = process.env;
  const required = (name: string): string => {
    const v = env[name];
    if (!v) {
      throw new Error(`--payer http needs ${name}`);
    }
    return v;
  };
  const gatewayUrl = assertAllowedRemote(required("VACUNA_GATEWAY_URL"), env.VACUNA_GATEWAY_ALLOWLIST, "VACUNA_GATEWAY_ALLOWLIST");
  return new HttpGatewayPayer({
    config: {
      amountWei: env.VACUNA_PAYMENT_AMOUNT_WEI || ONE_HUNDREDTH_VANA_WEI,
      asset: env.VACUNA_PAYMENT_ASSET || NATIVE_ASSET,
      builderPrivateKey: required("VACUNA_BUILDER_PRIVATE_KEY") as `0x${string}`,
      chainId: BigInt(required("VACUNA_CHAIN_ID")),
      dataOwnerAddress: required("VACUNA_DATA_OWNER_ADDRESS"),
      dataPointScope: env.VACUNA_DATA_POINT_SCOPE || "dr.vacuna.child_immunizations",
      dataPointVersion: BigInt(env.VACUNA_DATA_POINT_VERSION || "1"),
      dataRegistryContract: required("VACUNA_DATA_REGISTRY_CONTRACT"),
      escrowContract: required("VACUNA_ESCROW_CONTRACT"),
      gatewayUrl,
      registerServerPrivateKey: required("VACUNA_REGISTER_SERVER_PRIVATE_KEY") as `0x${string}`,
    },
    nextNonce: () => store.nextPaymentNonce(),
  });
}

function buildStatus(client: ClientCredentials, clock: Clock): GrantStatusSource {
  const kind = argValue("status", process.env.VACUNA_LIFECYCLE_ENDPOINT ? "lifecycle" : "introspection");
  if (kind === "lifecycle") {
    return new LifecycleEndpointStatusSource({
      client,
      endpoint: process.env.VACUNA_LIFECYCLE_ENDPOINT || `${AS_URL}/oauth/grant-lifecycle`,
    });
  }
  const id = process.env.VACUNA_INTROSPECTION_CLIENT_ID || process.env.PDPP_RS_INTROSPECTION_CLIENT_ID;
  const secret = process.env.VACUNA_INTROSPECTION_CLIENT_SECRET || process.env.PDPP_RS_INTROSPECTION_CLIENT_SECRET;
  if (!(id && secret)) {
    throw new Error("--status introspection needs VACUNA_INTROSPECTION_CLIENT_ID and VACUNA_INTROSPECTION_CLIENT_SECRET");
  }
  return new IntrospectionStatusSource({
    clientId: id,
    clientSecret: secret,
    disposition: dispositionStubFromFile(argValue("disposition-file", join(STATE_DIR, "dispositions.json"))),
    endpoint: `${AS_URL}/introspect`,
    now: () => clock.now(),
  });
}

function buildService(clock: Clock): { service: ReminderService; store: ReminderStore } {
  const store = new ReminderStore(join(STATE_DIR, "reminder.sqlite"));
  const client = clientCredentials();
  const receiptKeyPath = argValue("receipt-public-key", process.env.VACUNA_RECEIPT_PUBLIC_KEY || "");
  const rate = argInt("rate", 0);
  const verbose = process.argv.includes("--verbose");
  const service = new ReminderService({
    client,
    clock,
    config: {
      ...DEFAULT_CONFIG,
      concurrency: argInt("concurrency", DEFAULT_CONFIG.concurrency),
      deleteGraceMs: argInt("delete-grace-days", 0) * DAY_MS,
      ratePerSecond: rate > 0 ? rate : null,
      receiptPublicKey: receiptKeyPath ? createPublicKey(readFileSync(receiptKeyPath, "utf8")) : null,
      rsUrl: RS_URL,
      stream: STREAM,
      tokenEndpoint: `${AS_URL}/oauth/token`,
    },
    log: verbose ? (line) => console.log(JSON.stringify(line)) : undefined,
    payer: buildPayer(store),
    status: buildStatus(client, clock),
    store,
  });
  return { service, store };
}

function writeCounters(service: ReminderService, label: string): void {
  const snapshot = { label, ...service.snapshot() };
  const out = argValue("counters-out", join(STATE_DIR, "counters.json"));
  let history: unknown[] = [];
  try {
    history = JSON.parse(readFileSync(out, "utf8")) as unknown[];
  } catch {
    history = [];
  }
  history.push(snapshot);
  writeFileSync(out, `${JSON.stringify(history, null, 2)}\n`);
  console.log(JSON.stringify(snapshot, null, 2));
}

// ─── bootstrap (real reference AS) ───────────────────────────────────────────

async function http(url: string, init: RequestInit = {}) {
  const resp = await fetch(url, { redirect: "manual", ...init });
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { body, headers: resp.headers, status: resp.status };
}

const formInit = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  method: "POST",
});
const jsonInit = (payload: unknown): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  method: "POST",
});

async function ownerToken(): Promise<string> {
  const device = await http(`${AS_URL}/oauth/device_authorization`, formInit({ client_id: "cli_longview" }));
  await http(`${AS_URL}/device/approve`, formInit({ subject_id: OWNER_SUBJECT_ID, user_code: String(device.body.user_code) }));
  const token = await http(
    `${AS_URL}/oauth/token`,
    formInit({
      client_id: "cli_longview",
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  );
  if (token.status !== 200) {
    throw new Error(`owner token failed: ${token.status} ${JSON.stringify(token.body)}`);
  }
  return String(token.body.access_token);
}

async function authorizeChild(client: ClientCredentials, index: number) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${AS_URL}/oauth/authorize`);
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", `child-${index}`);
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "authorization_details",
    JSON.stringify([
      {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/assist_summarize",
        purpose_description: "Recordatorios de vacunación para un niño o niña",
        source: { id: SOURCE_ID, kind: "connector" },
        streams: [{ name: STREAM, resources: [childId(index)] }],
        type: "https://pdpp.dev/data-access",
      },
    ])
  );
  const redirect = await http(authorize.toString());
  const requestUri = new URL(String(redirect.headers.get("location")), AS_URL).searchParams.get("request_uri");
  if (!requestUri) {
    throw new Error(`authorize for child ${index}: HTTP ${redirect.status} ${JSON.stringify(redirect.body)}`);
  }
  const review = await http(`${AS_URL}/consent/review`, jsonInit({ request_uri: requestUri, subject_id: OWNER_SUBJECT_ID }));
  const approve = await http(
    `${AS_URL}/consent/approve`,
    formInit(
      { approval_review_revision: String(review.body.approval_review_revision), request_uri: requestUri },
      { Accept: "text/html" }
    )
  );
  const code = new URL(String(approve.headers.get("location"))).searchParams.get("code");
  if (!code) {
    throw new Error(`approve for child ${index}: HTTP ${approve.status}`);
  }
  const token = await http(
    `${AS_URL}/oauth/token`,
    formInit({ ...client.fields(), code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: REDIRECT_URI })
  );
  if (token.status !== 200) {
    throw new Error(`token for child ${index}: ${token.status} ${JSON.stringify(token.body)}`);
  }
  return token.body as { access_token: string; expires_in?: number; grant_id: string; refresh_token?: string };
}

async function bootstrap(): Promise<void> {
  const children = argInt("children", 50);
  const reg = await http(`${AS_URL}/connectors`, jsonInit(VACUNA_MANIFEST));
  if (![200, 201, 409].includes(reg.status)) {
    throw new Error(`register manifest: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  if (process.argv.includes("--ingest")) {
    const owner = await ownerToken();
    const lines = Array.from({ length: children }, (_, k) => {
      const data = generateChild(k + 1);
      return JSON.stringify({ data, emitted_at: data.updated_at, key: data.child_id });
    });
    const ingest = await http(`${RS_URL}/v1/ingest/${STREAM}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`, {
      body: lines.join("\n"),
      headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });
    if (ingest.status !== 200) {
      throw new Error(`ingest: ${ingest.status} ${JSON.stringify(ingest.body)}`);
    }
  }
  let state = readClientState();
  if (!state) {
    const confidential = !process.argv.includes("--public");
    const { jwk } = loadOrCreateClientKey(join(STATE_DIR, "client-key.pem"));
    const registered = await http(
      `${AS_URL}/oauth/register`,
      jsonInit({
        client_name: "Recordatorio de Vacunas (synthetic)",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [REDIRECT_URI],
        response_types: ["code"],
        token_endpoint_auth_method: confidential ? "private_key_jwt" : "none",
        ...(confidential ? { jwks: { keys: [jwk] } } : {}),
      })
    );
    if (registered.status !== 201) {
      throw new Error(
        `client registration: ${registered.status} ${JSON.stringify(registered.body)} (confidential clients need PDPP_CONFIDENTIAL_CLIENTS=1 on the server)`
      );
    }
    state = { clientId: String(registered.body.client_id), method: confidential ? "private_key_jwt" : "none" };
    writeFileSync(join(STATE_DIR, "client.json"), `${JSON.stringify(state, null, 2)}\n`);
  }
  const client = clientCredentials();
  const store = new ReminderStore(join(STATE_DIR, "reminder.sqlite"));
  const started = Date.now();
  for (let i = 1; i <= children; i++) {
    if (store.getChild(i)) {
      continue;
    }
    const t = await authorizeChild(client, i);
    store.upsertChild({
      access_expires_at: typeof t.expires_in === "number" ? Date.now() + t.expires_in * 1000 : null,
      access_token: t.access_token,
      child_id: childId(i),
      child_index: i,
      grant_id: t.grant_id,
      refresh_token: t.refresh_token ?? null,
    });
  }
  console.log(
    JSON.stringify({ children, client: state, seconds: (Date.now() - started) / 1000, store: store.totals() }, null, 2)
  );
  store.close();
}

/**
 * Imports bulk-seeded baseline grants (../baseline/seed.ts bulk-grants:
 * derived token and grant id, public client, no refresh token). Reads and
 * payments work; refresh-rotation does not apply to these rows.
 */
function importBaseline(): void {
  const from = argInt("from", 2001);
  const to = argInt("to", 980_200);
  const store = new ReminderStore(join(STATE_DIR, "reminder.sqlite"));
  const tx = store.db.transaction(() => {
    for (let i = from; i <= to; i++) {
      store.upsertChild({ access_token: derivedToken(i), child_id: childId(i), child_index: i, grant_id: derivedGrantId(i) });
    }
  });
  tx();
  console.log(JSON.stringify(store.totals()));
  store.close();
}

async function simulate(): Promise<void> {
  const start = argValue("start", "2026-10-05T08:00:00.000Z");
  const days = argInt("days", 28);
  const clock = new ManualClock(start);
  const { service, store } = buildService(clock);
  for (let d = 0; d < days; d++) {
    await service.runStatusChecks();
    await service.runDeletionSweep();
    if (d % 7 === 0) {
      await service.runWeeklyReads();
    }
    clock.advance(DAY_MS);
  }
  writeCounters(service, `simulate ${days}d from ${start}`);
  store.close();
}

const command = process.argv[2];
switch (command) {
  case "bootstrap":
    await bootstrap();
    break;
  case "import-baseline":
    importBaseline();
    break;
  case "week": {
    const { service, store } = buildService(buildClock());
    await service.runWeeklyReads();
    writeCounters(service, "week");
    store.close();
    break;
  }
  case "daily": {
    const { service, store } = buildService(buildClock());
    await service.runStatusChecks();
    await service.runDeletionSweep();
    await service.flushPayments();
    writeCounters(service, "daily");
    store.close();
    break;
  }
  case "simulate":
    await simulate();
    break;
  case "counters": {
    const store = new ReminderStore(join(STATE_DIR, "reminder.sqlite"));
    console.log(JSON.stringify({ store: store.totals(), weekMs: WEEK_MS }, null, 2));
    store.close();
    break;
  }
  default:
    console.error("usage: node cli.ts bootstrap|import-baseline|week|daily|simulate|counters [options]");
    process.exit(2);
}
