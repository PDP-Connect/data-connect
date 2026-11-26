// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import Database from "./helpers/sqlite-driver.ts";

const injectedFailure = new Error("injected late bootstrap failure");

type Connection = InstanceType<typeof Database>;

/**
 * Record every connection `initDb` touches. It calls `pragma` on the raw
 * handle before anything can fail, so a failed bootstrap's handle is in the
 * list even though `initDb` never returned it.
 */
function trackConnections(): { connections: Connection[]; restore(): void } {
  const prototype = Database.prototype;
  const original = prototype.pragma;
  const connections: Connection[] = [];
  prototype.pragma = function (this: Connection, ...args: Parameters<typeof original>) {
    if (!connections.includes(this)) connections.push(this);
    return original.apply(this, args);
  } as typeof original;
  return { connections, restore: () => { prototype.pragma = original; } };
}

test("SQLite bootstrap rolls back the whole schema, restores foreign keys and closes its handle after a late failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-bootstrap-transaction-"));
  const path = join(dir, "test.sqlite");
  const seed = new Database(path, { timeout: 1000 });
  seed.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep')");
  const before = seed.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  seed.close();
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  const originalClose = prototype.close;
  const tracker = trackConnections();
  let failedConnection: Connection | undefined;
  // initDb closes the failed handle, so read its state at the moment it closes.
  let stateAtClose:
    | { foreignKeys: unknown; schema: unknown; preserved: unknown }
    | undefined;
  prototype.exec = function (sql: string) {
    if (sql.includes("CREATE TRIGGER stamp_terminal_manifest_generation")) {
      failedConnection = this;
      throw injectedFailure;
    }
    return originalExec.call(this, sql);
  };
  prototype.close = function (this: Connection) {
    if (this === failedConnection) {
      stateAtClose = {
        foreignKeys: this.pragma("foreign_keys", { simple: true }),
        schema: this.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
        preserved: this.prepare("SELECT value FROM preserved").all(),
      };
    }
    return originalClose.call(this);
  };
  try {
    assert.throws(() => initDb(path), (error) => error === injectedFailure);
    assert.ok(failedConnection);
    assert.ok(stateAtClose, "initDb must close the handle it could not publish");
    assert.equal(stateAtClose.foreignKeys, 1);
    assert.deepEqual(stateAtClose.schema, before);
    assert.deepEqual(stateAtClose.preserved, [{ value: "keep" }]);
    assert.deepEqual(tracker.connections.filter((connection) => connection.open), []);
  } finally {
    prototype.exec = originalExec;
    prototype.close = originalClose;
    tracker.restore();
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
  const tracker = trackConnections();
  try {
    assert.throws(() => initDb(path), /SQLite bootstrap failed foreign_key_check/);
    assert.ok(tracker.connections.length > 0, "the test must observe the bootstrap connection");
    assert.deepEqual(tracker.connections.filter((connection) => connection.open), []);
    const readback = new Database(path);
    try {
      assert.equal(readback.prepare("SELECT name FROM sqlite_master WHERE name = 'grants'").get(), undefined);
      assert.deepEqual(readback.prepare("SELECT parent_id FROM bootstrap_child").all(), [{ parent_id: 99 }]);
    } finally {
      readback.close();
    }
  } finally {
    tracker.restore();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed SQLite bootstrap leaves the caller's previous handle open", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-bootstrap-previous-handle-"));
  const bad = join(dir, "bad.sqlite");
  const seed = new Database(bad);
  seed.pragma("foreign_keys = OFF");
  seed.exec(`
    CREATE TABLE bootstrap_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE bootstrap_child (parent_id INTEGER REFERENCES bootstrap_parent(id));
    INSERT INTO bootstrap_child VALUES (99);
  `);
  seed.close();
  const previous = initDb(":memory:");
  const tracker = trackConnections();
  try {
    assert.throws(() => initDb(bad), /SQLite bootstrap failed foreign_key_check/);
    const failed = tracker.connections.filter((connection) => connection !== (previous as unknown));
    assert.ok(failed.length > 0);
    assert.deepEqual(failed.filter((connection) => connection.open), []);
    assert.equal(previous.prepare("SELECT 1 AS one").get<{ one: number }>()?.one, 1);
    // Intended: initDb detaches the previous handle before it can fail (see detachDb()),
    // so the caller's handle stays open but getDb() no longer returns it.
    assert.equal(getDb(), null);
  } finally {
    tracker.restore();
    previous.close();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure in the last initDb step leaves no published handle", () => {
  closeDb();
  const injected = new Error("injected final-step failure");
  const tracker = trackConnections();
  const originalDefineProperty = Object.defineProperty;
  Object.defineProperty = ((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    if (key === "vectorIndexKind") throw injected;
    return originalDefineProperty(target, key, descriptor);
  }) as typeof Object.defineProperty;
  try {
    assert.throws(() => initDb(":memory:"), (error) => error === injected);
  } finally {
    Object.defineProperty = originalDefineProperty;
    tracker.restore();
  }
  try {
    assert.equal(getDb(), null, "a failed initDb must not publish its handle");
    assert.ok(tracker.connections.length > 0, "the test must observe the bootstrap connection");
    assert.deepEqual(tracker.connections.filter((connection) => connection.open), []);
  } finally {
    closeDb();
  }
});
