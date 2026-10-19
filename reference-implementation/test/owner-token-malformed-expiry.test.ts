// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Introspection must fail closed when a persisted token expiry is not a
 * timestamp. `tokens.expires_at` is TEXT on both SQLite and PostgreSQL, so a
 * malformed or empty value can be stored on either backend; `new Date(bad)`
 * is an Invalid Date, and a comparison against it is always false, so the
 * expiry check used to fall through and report the token active.
 *
 * The valid-future and null-expiry controls keep the fix from passing by
 * rejecting every owner token.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { introspect } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const FIXTURES: readonly {
  expiresAt: string | null;
  active: boolean;
  tokenId: string;
}[] = [
  { active: true, expiresAt: null, tokenId: "tok_null_expiry_fixture" },
  {
    active: true,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenId: "tok_valid_expiry_fixture",
  },
  {
    active: false,
    expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    tokenId: "tok_past_expiry_fixture",
  },
  {
    active: false,
    expiresAt: "not-a-timestamp",
    tokenId: "tok_invalid_expiry_fixture",
  },
  { active: false, expiresAt: "", tokenId: "tok_empty_expiry_fixture" },
];

async function assertIntrospectionMatchesFixtures(): Promise<void> {
  for (const fixture of FIXTURES) {
    const result = await introspect(fixture.tokenId);
    assert.equal(result.active, fixture.active, `${fixture.tokenId} (expires_at=${JSON.stringify(fixture.expiresAt)})`);
    if (!fixture.active) {
      assert.equal(result.inactive_reason, "token_expired", fixture.tokenId);
    }
  }
}

test("owner token introspection fails closed on malformed expiry (SQLite)", async () => {
  initDb(":memory:");
  try {
    const insert = getDb().prepare(
      `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked)
       VALUES (?, 'owner_local', 'expiry_test_client', 'owner', ?, 0)`
    );
    for (const fixture of FIXTURES) {
      insert.run(fixture.tokenId, fixture.expiresAt);
    }
    await assertIntrospectionMatchesFixtures();
  } finally {
    closeDb();
  }
});

test("owner token introspection fails closed on malformed expiry (PostgreSQL)", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_malformed_expiry_${randomBytes(4).toString("hex")}`,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      for (const fixture of FIXTURES) {
        await postgresQuery(
          `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked)
             VALUES ($1, 'owner_local', 'expiry_test_client', 'owner', $2, FALSE)`,
          [fixture.tokenId, fixture.expiresAt]
        );
      }
      await assertIntrospectionMatchesFixtures();
    }
  );
});

test("owner token expiry is inactive at exact timestamp equality", async (t) => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  initDb(":memory:");
  try {
    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked)
         VALUES ('tok_exact_expiry_fixture', 'owner_local', 'expiry_test_client', 'owner', ?, 0)`
      )
      .run(new Date(now).toISOString());
    const result = await introspect("tok_exact_expiry_fixture");
    assert.equal(result.active, false);
    assert.equal(result.inactive_reason, "token_expired");
  } finally {
    closeDb();
    t.mock.timers.reset();
  }
});
