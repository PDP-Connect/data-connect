// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration mutation control (reviewer HOLD on PR #278, item 3). The
 * explicit opt-in default (scripts/postgres-template-eligibility.ts) and the
 * machine-checked inventory (test/postgres-template-eligibility-inventory.test.ts)
 * both prove STRUCTURE -- that every relevant file is classified. Proving this
 * test's real point requires a BEHAVIORAL check: does the real runtime default
 * still keep a cold-required file cold when a usable template is available?
 *
 * Method: build a template database whose migration outcome is deliberately
 * WRONG -- reproduce the exact pre-migration legacy shape
 * `migratePostgresRunHistoryCompletedAtNullable` exists to repair
 * (`run_history.completed_at` is still legacy NOT NULL), while retaining the
 * template's valid provenance metadata. This is not a synthetic unit mock of
 * the migration function -- it is a real run-scoped template whose migration
 * outcome was corrupted after construction.
 *
 *   1. Prove the counterfactual the reviewer's HOLD was about: a plain
 *      `CREATE DATABASE ... TEMPLATE` clone of that broken template silently
 *      carries the legacy NOT NULL shape forward -- exactly what the old
 *      (pre-repair) scheme would have handed to EVERY caller, cold-required
 *      or not, once a template existed.
 *   2. Prove the repair actually closes this: `withTemporaryPostgresDatabase`
 *      invoked by this CURRENTLY RUNNING cold-required file takes its real
 *      default-selection path. Even though the usable broken template is in
 *      the environment, the resulting database is empty before bootstrap;
 *      a mutation that selects the template for every file therefore fails
 *      before migrations can mask the defect.
 *
 * This is the same load-bearing pattern
 * `test/run-history-completed-at-fleet-migration.test.ts` already uses inline
 * for its own PostgreSQL proof (construct the exact pre-migration legacy
 * shape, then a real `initPostgresStorage` call) -- this file adds the
 * template-vs-cold contrast that file does not need to make, because after
 * this repair it is cold-required and never sees a template at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  deriveDedicatedPostgresTemplateName,
  dropPostgresTestTemplate,
  ensurePostgresTestTemplate,
  readPostgresTestTemplateIdentity,
} from "../scripts/postgres-test-template.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

let counter = 0;
function name(label: string): string {
  counter += 1;
  return `pdpp_test_mmc_${label}_${process.pid}_${counter}`;
}

function templateDatabaseName(label: string): string {
  counter += 1;
  return deriveDedicatedPostgresTemplateName(`mmc_${label}_${process.pid}_${counter}`);
}

function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

function urlFor(base: string, db: string): string {
  const url = new URL(base);
  url.pathname = `/${db}`;
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

/**
 * Build a real, identity-bearing template, then corrupt exactly the migration
 * outcome this test needs. Its metadata remains valid so a selection mutation
 * reaches the real clone path instead of being stopped by identity validation.
 */
async function buildBrokenMigrationTemplate(baseUrl: string, templateName: string): Promise<void> {
  await ensurePostgresTestTemplate(baseUrl, templateName.slice("pdpp_test_template_".length));
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
  });
  const templateUrl = urlFor(baseUrl, templateName);
  const seed = new Client({ connectionString: templateUrl });
  await seed.connect();
  try {
    await seed.query(`ALTER TABLE run_history ALTER COLUMN completed_at SET NOT NULL`);
  } finally {
    await seed.end();
  }
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });
}

async function completedAtIsNullable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
    );
    return result.rows[0]?.is_nullable === "YES";
  } finally {
    await client.end();
  }
}

async function runHistoryExists(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ run_history: string | null }>(
      `SELECT to_regclass('public.run_history') AS run_history`
    );
    return result.rows[0]?.run_history !== null;
  } finally {
    await client.end();
  }
}

test("COUNTERFACTUAL: a plain template clone silently carries a broken migration's legacy shape forward", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const templateName = templateDatabaseName("broken_template");
  const cloneName = name("broken_clone");
  try {
    await buildBrokenMigrationTemplate(baseUrl, templateName);
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${cloneName}" TEMPLATE "${templateName}"`);
    });
    const cloneUrl = urlFor(baseUrl, cloneName);
    assert.equal(
      await completedAtIsNullable(cloneUrl),
      false,
      "a raw CREATE DATABASE ... TEMPLATE clone carries the broken (legacy NOT NULL) shape forward unchanged -- this is exactly what the pre-repair scheme handed to every caller, cold-required or not"
    );
  } finally {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
    });
    await dropPostgresTestTemplate(baseUrl, templateName);
  }
});

test("REPAIR: a cold-required file's real default selection ignores an existing, usable, env-pointed broken template", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const templateName = templateDatabaseName("broken_template_gate");
  await buildBrokenMigrationTemplate(baseUrl, templateName);
  const priorEnv = process.env.PDPP_TEST_POSTGRES_TEMPLATE;
  const priorIdentity = process.env.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY;
  process.env.PDPP_TEST_POSTGRES_TEMPLATE = templateName;
  process.env.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY = await readPostgresTestTemplateIdentity(baseUrl, templateName);
  try {
    let observedUrl = "";
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: baseUrl,
        databaseName: name("gate_db"),
        // Omit templateName. This is the production default-selection seam:
        // it reads this child process's argv[1] and only then chooses the
        // env-pointed template or a cold database.
      },
      async (url) => {
        observedUrl = url;
        assert.equal(
          await runHistoryExists(url),
          false,
          "the real cold default must create an empty database; if selection is broadened to clone the env-pointed broken template, run_history already exists here and this mutation control fails before bootstrap can repair it"
        );
        // Run the real migration-bearing bootstrap for real, inside the
        // callback -- this is what makes the database's schema correct
        // regardless of what (if anything) a template would have provided.
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        try {
          assert.equal(
            await completedAtIsNullable(url),
            true,
            "a cold, from-scratch bootstrap builds run_history.completed_at nullable from the start -- the migration's target end-state -- never inheriting a broken template's legacy shape"
          );
        } finally {
          await closePostgresStorage();
        }
      }
    );
    assert.ok(observedUrl, "callback must have run");
  } finally {
    if (priorEnv === undefined) {
      delete process.env.PDPP_TEST_POSTGRES_TEMPLATE;
    } else {
      process.env.PDPP_TEST_POSTGRES_TEMPLATE = priorEnv;
    }
    if (priorIdentity === undefined) {
      delete process.env.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY;
    } else {
      process.env.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY = priorIdentity;
    }
    await dropPostgresTestTemplate(baseUrl, templateName);
  }
});

test("migration mutation control (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: POSTGRES_URL !== null,
}, () => {
  assert.ok(true);
});
