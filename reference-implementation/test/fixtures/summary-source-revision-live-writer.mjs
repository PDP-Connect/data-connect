#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
// This standalone subprocess cannot import server/sqlite-driver.ts (no TS
// loader here), so it names the driver package directly. It must stay the
// SAME package server/sqlite-driver.ts resolves -- this fixture opens the
// database `initDb` owns, so a different native build would neither read an
// encrypted vault nor contend for its write lock.
// biome-ignore lint/correctness/noUnresolvedImports: the driver is loaded dynamically in this standalone subprocess.
const Database = require("better-sqlite3-multiple-ciphers");
const dbPath = process.env.PDPP_SUMMARY_LIVE_WRITER_DB_PATH;
const connectorInstanceId = process.env.PDPP_SUMMARY_LIVE_WRITER_CONNECTOR_INSTANCE_ID;
const markerPath = process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH;
if (!(dbPath && connectorInstanceId && markerPath)) {
  throw new Error("the source-revision live-writer fixture requires its database, instance, and marker paths");
}

const db = new Database(dbPath, { timeout: 30_000 });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
const input = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
await new Promise((resolve) => input.once("line", resolve));

await new Promise((resolve, reject) => {
  const deadline = Date.now() + 30_000;
  const interval = setInterval(() => {
    if (existsSync(markerPath)) {
      clearInterval(interval);
      resolve();
      return;
    }
    if (Date.now() >= deadline) {
      clearInterval(interval);
      reject(new Error("source-revision installation lock marker timed out"));
    }
  }, 2);
});

try {
  db.prepare(
    `INSERT INTO connector_schedules(
       connector_instance_id, connector_id, interval_seconds, jitter_seconds,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    connectorInstanceId,
    "https://test.pdpp.dev/connectors/source-revision",
    900,
    0,
    1,
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:05:00.000Z"
  );
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  db.close();
  process.exit(0);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false })}\n`
  );
  db.close();
  process.exit(1);
}
