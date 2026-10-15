// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pending_consents.user_code` is a UNIQUE 6-hex-digit code over every row
 * ever written, so PAR / authorize start failing with a duplicate-key 500 at
 * volume (~1% of requests at ~130k rows in the DR pilot load test). A
 * collision on that column must draw a new code; any other conflict must
 * still fail.
 *
 * The SQLite cases run against the real reference schema. The Postgres cases
 * run only with PDPP_TEST_POSTGRES_URL (a provisioned scratch database):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55433/pdpp_test \
 *     node --test --import tsx test/pending-consent-user-code-collision.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  generatePendingConsentUserCode,
  insertWithFreshPendingConsentUserCode,
  isPendingConsentUserCodeConflict,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function sequence(...codes: string[]): () => string {
  let i = 0;
  return () => codes[Math.min(i++, codes.length - 1)] as string;
}

test("generated user codes are 6 upper-case hex digits", () => {
  assert.match(generatePendingConsentUserCode(), /^[0-9A-F]{6}$/);
});

test("only a user_code unique violation counts as a collision", () => {
  assert.equal(
    isPendingConsentUserCodeConflict({ code: "23505", constraint: "pending_consents_user_code_key" }),
    true
  );
  assert.equal(isPendingConsentUserCodeConflict({ code: "23505", constraint: "pending_consents_pkey" }), false);
  assert.equal(
    isPendingConsentUserCodeConflict({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: pending_consents.user_code",
    }),
    true
  );
  assert.equal(
    isPendingConsentUserCodeConflict({
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      message: "UNIQUE constraint failed: pending_consents.device_code",
    }),
    false
  );
  assert.equal(isPendingConsentUserCodeConflict(new Error("connection reset")), false);
  assert.equal(isPendingConsentUserCodeConflict(null), false);
});

test("gives up after the attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    insertWithFreshPendingConsentUserCode(
      () => {
        calls += 1;
        return Promise.reject(Object.assign(new Error("dup"), { code: "23505", constraint: "pending_consents_user_code_key" }));
      },
      () => "AAAAAA",
      3
    ),
    /dup/
  );
  assert.equal(calls, 3);
});

function sqliteInsert(deviceCode: string) {
  return (userCode: string) => {
    getDb()
      .prepare(
        `INSERT INTO pending_consents (device_code, user_code, params_json, created_at, expires_at)
         VALUES (?, ?, '{}', '2026-10-14T00:00:00Z', '2026-10-14T00:05:00Z')`
      )
      .run(deviceCode, userCode);
    return Promise.resolve();
  };
}

test("SQLite: a taken user_code is redrawn; a taken device_code still fails", async () => {
  initDb(":memory:");
  try {
    assert.equal(await insertWithFreshPendingConsentUserCode(sqliteInsert("dc_a"), sequence("ABC123")), "ABC123");
    const stored = await insertWithFreshPendingConsentUserCode(
      sqliteInsert("dc_b"),
      sequence("ABC123", "ABC123", "DEF456")
    );
    assert.equal(stored, "DEF456");
    const row = getDb().prepare("SELECT user_code FROM pending_consents WHERE device_code = 'dc_b'").get() as {
      user_code: string;
    };
    assert.equal(row.user_code, "DEF456");
    await assert.rejects(
      insertWithFreshPendingConsentUserCode(sqliteInsert("dc_a"), sequence("FFF000")),
      /device_code/
    );
  } finally {
    closeDb();
  }
});

test("Postgres: a taken user_code is redrawn; a taken device_code still fails", { skip: !POSTGRES_URL }, async () => {
  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  const prefix = `dc_ucc_${Date.now().toString(36)}`;
  const taken = Date.now().toString(16).slice(-6).toUpperCase();
  const pgInsert = (deviceCode: string) => async (userCode: string) => {
    await postgresQuery(
      `INSERT INTO pending_consents (device_code, user_code, params_json, created_at, expires_at)
       VALUES ($1, $2, '{}'::jsonb, '2026-10-14T00:00:00Z', '2026-10-14T00:05:00Z')`,
      [deviceCode, userCode]
    );
  };
  try {
    await postgresQuery("DELETE FROM pending_consents WHERE user_code = ANY($1)", [[taken, "0F0F0F"]]);
    await insertWithFreshPendingConsentUserCode(pgInsert(`${prefix}_a`), sequence(taken));
    const stored = await insertWithFreshPendingConsentUserCode(pgInsert(`${prefix}_b`), sequence(taken, "0F0F0F"));
    assert.equal(stored, "0F0F0F");
    await assert.rejects(
      insertWithFreshPendingConsentUserCode(pgInsert(`${prefix}_a`), sequence("0E0E0E")),
      /pending_consents_pkey/
    );
  } finally {
    await postgresQuery("DELETE FROM pending_consents WHERE device_code LIKE $1", [`${prefix}%`]).catch(() => {});
    await closePostgresStorage();
    closeDb();
  }
});
