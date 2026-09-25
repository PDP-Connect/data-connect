// Seed the DR demo sources into a running, password-protected server over HTTPS.
//
// Same data as `demo.sh seed`, but through the owner-authenticated API, so a
// deployed instance never has to run without a password:
//
//   owner login ─▶ device flow (owner token) ─▶ POST /connectors ─▶ POST /v1/ingest/:stream
//
// Usage:
//   ORIGIN=https://<app>.fly.dev OWNER_PASSWORD=… node --import tsx scripts/demo-dr/seed-remote.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DR_DEMO_RECORDS_BY_STREAM } from "../../reference-implementation/connectors/seed/index.ts";
import { establishOwnerSessionCookie } from "../lib/owner-session.ts";
import { mintOwnerToken } from "../railway-mcp-query-smoke.ts";

const MANIFESTS_DIR = join(import.meta.dirname, "../../reference-implementation/fixtures/seed-manifests");
const DEMO_SOURCES = ["sns", "siuben", "intrant"] as const;
const OWNER_SUBJECT_ID = "owner_local";
const HTTP_OK = 200;
const REGISTER_OK_STATUSES = new Set([200, 201, 409]);

interface Manifest {
  connector_id: string;
  streams: { name: string }[];
}

const origin = process.env.ORIGIN?.replace(/\/$/, "");
const ownerPassword = process.env.OWNER_PASSWORD ?? "";
if (!origin) {
  throw new Error("ORIGIN is required, e.g. https://<app>.fly.dev");
}

const log = (line: string) => console.log(line);

// Register a source manifest; 409 means it is already registered.
async function register(manifest: Manifest, cookie: string): Promise<void> {
  const res = await fetch(`${origin}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    method: "POST",
  });
  if (!REGISTER_OK_STATUSES.has(res.status)) {
    throw new Error(`register ${manifest.connector_id} failed ${res.status}: ${await res.text()}`);
  }
  log(`registered ${manifest.connector_id} (${res.status})`);
}

// Ingest one stream's records as NDJSON ({ key, data, emitted_at } per line).
async function ingest(connectorId: string, stream: string, token: string): Promise<void> {
  const records = DR_DEMO_RECORDS_BY_STREAM[stream] ?? [];
  const emittedAt = new Date().toISOString();
  const body = records.map((data) => JSON.stringify({ data, emitted_at: emittedAt, key: data.id })).join("\n");

  const url = `${origin}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`;
  const res = await fetch(url, {
    body: `${body}\n`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
    method: "POST",
  });
  const text = await res.text();
  if (res.status !== HTTP_OK) {
    throw new Error(`ingest ${stream} failed ${res.status}: ${text}`);
  }
  log(`ingested ${stream}: ${text}`);
}

const cookie = ownerPassword ? ((await establishOwnerSessionCookie({ origin, ownerPassword })) ?? "") : "";
const token = await mintOwnerToken(origin, cookie, OWNER_SUBJECT_ID, log);

for (const source of DEMO_SOURCES) {
  const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${source}.json`), "utf8")) as Manifest;
  await register(manifest, cookie);

  for (const { name } of manifest.streams) {
    await ingest(manifest.connector_id, name, token);
  }
}
log("done");
