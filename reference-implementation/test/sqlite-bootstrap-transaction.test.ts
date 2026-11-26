// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import Database from "./helpers/sqlite-driver.ts";

const injectedFailure = new Error("injected late bootstrap failure");

test("SQLite bootstrap rolls back the whole schema and restores foreign keys after a late failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-bootstrap-transaction-"));
  const path = join(dir, "test.sqlite");
  const seed = new Database(path, { timeout: 1000 });
  seed.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep')");
  const before = seed.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  seed.close();
  const prototype = Database.prototype;
  const original = prototype.exec;
  let failedConnection: InstanceType<typeof Database> | undefined;
  prototype.exec = function (sql: string) {
    if (sql.includes("CREATE TRIGGER stamp_terminal_manifest_generation")) {
      failedConnection = this;
      throw injectedFailure;
    }
    return original.call(this, sql);
  };
  try {
    assert.throws(() => initDb(path), (error) => error === injectedFailure);
    assert.ok(failedConnection);
    assert.equal(failedConnection.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(failedConnection.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), before);
    assert.deepEqual(failedConnection.prepare("SELECT value FROM preserved").all(), [{ value: "keep" }]);
  } finally {
    prototype.exec = original;
    failedConnection?.close();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite bootstrap enables foreign keys after success", () => {
  try {
    const db = initDb(":memory:", { onSchemaMigration: () => undefined });
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    closeDb();
  }
});

test("SQLite bootstrap retries while another process holds the write lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-bootstrap-wait-"));
  const path = join(dir, "test.sqlite");
  initDb(path);
  closeDb();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { SqliteDriver } from './server/sqlite-driver.ts';
    const db = new SqliteDriver(process.env.BOOTSTRAP_WAIT_PATH, { timeout: 1000 });
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 750);
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BOOTSTRAP_WAIT_PATH: path },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error("lock holder exited before readiness"); }),
    ]);
    let retries = 0;
    const db = initDb(path, { busyTimeoutMs: 50, onSchemaRetry() { retries += 1; } });
    assert.ok(retries > 0, "the bootstrap must wait beyond a single busy timeout");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal((await exited)[0], 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite bootstrap refuses foreign-key violations before committing schema changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-bootstrap-invalid-fk-"));
  const path = join(dir, "test.sqlite");
  const seed = new Database(path);
  seed.pragma("foreign_keys = OFF");
  seed.exec(`
    CREATE TABLE bootstrap_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE bootstrap_child (parent_id INTEGER REFERENCES bootstrap_parent(id));
    INSERT INTO bootstrap_child VALUES (99);
  `);
  seed.close();
  try {
    assert.throws(() => initDb(path), /SQLite bootstrap failed foreign_key_check/);
    const readback = new Database(path);
    try {
      assert.equal(readback.prepare("SELECT name FROM sqlite_master WHERE name = 'grants'").get(), undefined);
      assert.deepEqual(readback.prepare("SELECT parent_id FROM bootstrap_child").all(), [{ parent_id: 99 }]);
    } finally {
      readback.close();
    }
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
