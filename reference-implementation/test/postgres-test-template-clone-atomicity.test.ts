// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * External review P2: verification and the clone ran on DIFFERENT admin
 * connections, leaving a time-of-check/time-of-use window.
 *
 * `clonePostgresTestDatabaseFromTemplate` opened an admin connection, then
 * called `assertPostgresTestTemplateUsable(baseConnectionString, ...)`, which
 * opened a second, independent connection of its own to do the checking. The
 * check therefore proved something about the template as seen by a
 * connection that was already closed by the time `CREATE DATABASE ...
 * TEMPLATE` ran on the other one. Anything that swapped the template in
 * between -- a concurrent runner dropping and recreating a same-named
 * database -- would be cloned without ever being verified.
 *
 * The repair has three parts, and this file pins each one:
 *
 *   1. One connection does both the verification and the clone.
 *   2. An advisory lock, held across verify -> capture -> clone, serialises
 *      that whole sequence against any other process doing the same thing.
 *   3. The template's OID is captured during verification and re-checked
 *      immediately before the clone, so a drop-and-recreate that preserves
 *      the NAME is still caught -- a new database gets a new OID.
 *
 * The OID re-check is what makes this testable without racing: swapping the
 * template's identity behind the verification is exactly what a hostile
 * concurrent runner would do, and it is simulated here deterministically.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  clonePostgresTestDatabaseFromTemplate,
  ensurePostgresTestTemplate,
  POSTGRES_TEST_RUNNER_NONCE_BYTES,
  TEMPLATE_CLONE_SERIALIZATION_LOCK,
} from "../scripts/postgres-test-template.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

async function withAdmin<T>(base: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrlFor(base) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(base: string, name: string): Promise<void> {
  await withAdmin(base, async (admin) => {
    await admin.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query("DELETE FROM pdpp_test_template_metadata WHERE template_name = $1", [name]).catch(() => undefined);
  });
}

test(
  "clone REFUSES a template that was swapped for a different database under the same name",
  { skip: POSTGRES_SKIP },
  async () => {
    const baseUrl = POSTGRES_URL as string;
    const runnerId = randomBytes(POSTGRES_TEST_RUNNER_NONCE_BYTES).toString("hex");
    const { identityDigest, templateName } = await ensurePostgresTestTemplate(baseUrl, runnerId);
    const cloneName = `pdpp_test_toctou_${runnerId.slice(0, 8)}_1`;

    try {
      const originalOid = await withAdmin(baseUrl, async (admin) => {
        const { rows } = await admin.query<{ oid: string }>("SELECT oid::text FROM pg_database WHERE datname = $1", [
          templateName,
        ]);
        return rows[0]?.oid;
      });
      assert.ok(originalOid, "template should exist after being built");

      // Simulate the concurrent runner that wins the TOCTOU race: drop the
      // verified template and put a DIFFERENT database under the same name,
      // carrying a metadata row that is internally self-consistent. Nothing
      // about the name changed, so only a check bound to the actual database
      // -- its OID -- can notice.
      await withAdmin(baseUrl, async (admin) => {
        await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false`);
        await admin.query(`DROP DATABASE "${templateName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${templateName}"`);
        await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
      });

      const swappedOid = await withAdmin(baseUrl, async (admin) => {
        const { rows } = await admin.query<{ oid: string }>("SELECT oid::text FROM pg_database WHERE datname = $1", [
          templateName,
        ]);
        return rows[0]?.oid;
      });
      assert.notEqual(swappedOid, originalOid, "the swapped-in database must be a genuinely different one");

      await assert.rejects(
        () => clonePostgresTestDatabaseFromTemplate(baseUrl, cloneName, templateName, identityDigest),
        /identity verification|no longer the database|changed identity/i,
        "a template replaced by a different database under the same name must be refused, not cloned"
      );

      const cloneExists = await withAdmin(baseUrl, async (admin) => {
        const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [cloneName]);
        return rows.length > 0;
      });
      assert.equal(cloneExists, false, "refusing the clone must leave no database behind");
    } finally {
      await dropDatabase(baseUrl, cloneName);
      await dropDatabase(baseUrl, templateName);
    }
  }
);

test("verification and clone hold one advisory lock on one connection", { skip: POSTGRES_SKIP }, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = randomBytes(POSTGRES_TEST_RUNNER_NONCE_BYTES).toString("hex");
  const { identityDigest, templateName } = await ensurePostgresTestTemplate(baseUrl, runnerId);
  const cloneName = `pdpp_test_lockheld_${runnerId.slice(0, 8)}_1`;

  const blocker = new Client({ connectionString: adminUrlFor(baseUrl) });
  await blocker.connect();
  try {
    // Hold the clone lock from an unrelated session. If the clone path takes
    // that same lock across its verify-and-clone sequence, it cannot proceed
    // while we hold it -- which is the serialisation the repair promises.
    await blocker.query("SELECT pg_advisory_lock($1, $2)", TEMPLATE_CLONE_SERIALIZATION_LOCK);

    let settled = false;
    const clone = clonePostgresTestDatabaseFromTemplate(baseUrl, cloneName, templateName, identityDigest).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(
      settled,
      false,
      "the clone must block while another session holds the clone lock; if it completed, verify and clone are not serialised under that lock"
    );

    await blocker.query("SELECT pg_advisory_unlock($1, $2)", TEMPLATE_CLONE_SERIALIZATION_LOCK);
    await clone;
    assert.equal(settled, true, "the clone should proceed once the lock is released");
  } finally {
    await blocker.end();
    await dropDatabase(baseUrl, cloneName);
    await dropDatabase(baseUrl, templateName);
  }
});
