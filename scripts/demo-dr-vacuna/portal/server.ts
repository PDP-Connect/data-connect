// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One-process walkthrough deployment of the "Vacuna al día" pilot.
//
//   internet ─▶ :PORT (this file)
//                 ├─ /recordatorio/*      reminder-service web app (OAuth client)
//                 ├─ /pilot/*, /oauth/authorize, GET /consent, /.well-known/*
//                 │                       proxied to the AS on 127.0.0.1
//                 ├─ /                    302 → /pilot/vacuna (landing)
//                 └─ anything else        404
//   AS 127.0.0.1:7662 / RS 127.0.0.1:7663 (loopback only, Postgres)
//
// The AS runs without an owner password (the walkthrough seed and the
// reminder service use the owner/token endpoints on loopback), so only the
// paths a browser needs are exposed. Boot order: AS/RS, walkthrough seed
// (idempotent), reminder client registration, then the public listener.
//
// Env: PORT (8080), PUBLIC_ORIGIN (http://localhost:$PORT), DATABASE_URL or
// PDPP_DATABASE_URL, VACUNA_STATE_DIR (reminder SQLite + client key),
// VACUNA_PAYER (mock|http). See ../deploy/DEPLOY.md.

import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { wipeStateDir } from "./reset-state.ts";
import { WALKTHROUGH_PASSWORD } from "./walkthrough-data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, "");
const AS_PORT = Number(process.env.VACUNA_INTERNAL_AS_PORT || 7662);
const RS_PORT = Number(process.env.VACUNA_INTERNAL_RS_PORT || 7663);
const AS_INTERNAL = `http://127.0.0.1:${AS_PORT}`;
const RS_INTERNAL = `http://127.0.0.1:${RS_PORT}`;
const DATABASE_URL = process.env.PDPP_DATABASE_URL || process.env.DATABASE_URL;
const STATE_DIR = process.env.VACUNA_STATE_DIR || join(HERE, ".state");

if (!DATABASE_URL) {
  console.error("Set DATABASE_URL (or PDPP_DATABASE_URL) to a Postgres database.");
  process.exit(2);
}
mkdirSync(STATE_DIR, { recursive: true });

// Server configuration: env vars the reference server already reads. Set
// before the server module loads; explicit env wins.
const defaults: Record<string, string> = {
  AS_PUBLIC_URL: PUBLIC_ORIGIN,
  // The owner surface has no password: the parent flow runs through the
  // pilot's Cuenta Única stub, and /oauth/authorize must not demand an owner
  // session. That surface is unreachable from outside: the AS listens on
  // loopback and the public listener forwards only isPublicAsPath() paths.
  PDPP_ALLOW_UNAUTHENTICATED_OWNER: "1",
  PDPP_CONFIDENTIAL_CLIENTS: "1",
  PDPP_DATABASE_URL: DATABASE_URL,
  PDPP_DB_PATH: join(STATE_DIR, "pdpp-scratch.sqlite"),
  PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
  PDPP_HTTP_KEEP_ALIVE: "1",
  PDPP_PILOT_DR_VACUNA: "1",
  PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD: WALKTHROUGH_PASSWORD,
  PDPP_PILOT_DR_VACUNA_START_URL: "/recordatorio",
  PDPP_READ_RECEIPTS: "1",
  PDPP_READ_RECEIPTS_KEY_FILE: join(STATE_DIR, "read-receipts-key.pem"),
  PDPP_RECONCILE_POLYFILL_MANIFESTS: "0",
  PDPP_RS_INPROCESS_INTROSPECTION: "1",
  PDPP_RUNTIME_QUIET: "1",
  PDPP_SEMANTIC_EMBEDDING_BACKEND: "disabled",
  PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT: "1",
  PDPP_STORAGE_BACKEND: "postgres",
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
for (const key of ["PDPP_OWNER_PASSWORD", "PDPP_OWNER_TOKEN", "PDPP_OWNER_SUBJECT_ID"]) {
  delete process.env[key];
}
if (!process.env.PDPP_AUDIT_TOKEN_HMAC_KEY) {
  console.warn("PDPP_AUDIT_TOKEN_HMAC_KEY is not set: audit rows keep raw token references.");
}

// Full reset (../deploy/reset.sh): a marker file in the state dir asks the
// next boot to wipe the database schema and the reminder service's state.
// The walkthrough seed below then restores the fixed dataset.
const RESET_MARKER = "reset-requested";
if (existsSync(join(STATE_DIR, RESET_MARKER))) {
  console.log("reset requested: wiping the database and the reminder service state");
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await pool.end();
  }
  wipeStateDir(STATE_DIR);
}

const { startServer } = await import("../../../reference-implementation/server/index.ts");
const { seedWalkthrough } = await import("./walkthrough-seed.ts");
const { createReminderWeb } = await import("./reminder-web.ts");
const { isPublicAsPath } = await import("./public-paths.ts");

const pdpp = await startServer({
  asPort: AS_PORT,
  bindHost: "127.0.0.1",
  quiet: process.env.VACUNA_SERVER_LOGS !== "1",
  rsPort: RS_PORT,
});
console.log(`AS ${AS_INTERNAL} RS ${RS_INTERNAL} (loopback)`);

const seeded = await seedWalkthrough({ asUrl: AS_INTERNAL, databaseUrl: DATABASE_URL, rsUrl: RS_INTERNAL });
console.log(`walkthrough seed: ${seeded.adults} adults, ${seeded.children} children`);

const reminder = await createReminderWeb({
  asInternal: AS_INTERNAL,
  issuer: process.env.VACUNA_AS_ISSUER || PUBLIC_ORIGIN,
  publicOrigin: PUBLIC_ORIGIN,
  rsInternal: RS_INTERNAL,
  stateDir: STATE_DIR,
});

function proxy(req: IncomingMessage, res: ServerResponse): void {
  const forwardedProto = new URL(PUBLIC_ORIGIN).protocol.replace(":", "");
  const upstream = request(
    {
      headers: {
        ...req.headers,
        "x-forwarded-host": req.headers.host ?? new URL(PUBLIC_ORIGIN).host,
        "x-forwarded-proto": forwardedProto,
      },
      host: "127.0.0.1",
      method: req.method,
      path: req.url,
      port: AS_PORT,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end("upstream unavailable");
  });
  req.pipe(upstream);
}

const front = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(302, { Location: `/pilot/vacuna${url.search}` }).end();
    return;
  }
  if (url.pathname === "/recordatorio" || url.pathname.startsWith("/recordatorio/")) {
    reminder.handle(req, res).catch((err: unknown) => {
      console.error("reminder web error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Error");
    });
    return;
  }
  if (isPublicAsPath(method, url.pathname)) {
    proxy(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

front.listen(PORT, "0.0.0.0", () => {
  console.log(`walkthrough: ${PUBLIC_ORIGIN} (listening on :${PORT})`);
});

const stop = () => {
  front.close();
  pdpp.asServer.close();
  pdpp.rsServer.close();
  reminder.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
