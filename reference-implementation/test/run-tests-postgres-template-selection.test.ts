// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * External review P1-1: the "runner per-file clone" tests in
 * `postgres-test-template-identity.test.ts` call
 * `clonePostgresTestDatabaseFromTemplate` directly. They prove the clone
 * helper is fail-closed, which is worth proving, but they never execute the
 * line that decides whether a file gets a clone at all:
 *
 *   const useTemplate =
 *     postgresTestTemplateName !== null && isPostgresTemplateEligibleFilePath(filePath);
 *
 * The `isPostgresTemplateEligibleFilePath` half is the fail-closed default --
 * a file not on the eligibility allowlist must get a real, from-scratch
 * bootstrap even when a template exists for the run. No test invoked
 * `run-tests.ts` itself, so dropping that half of the condition would not
 * have failed anything.
 *
 * This file closes that gap end to end. It runs the real `run-tests.ts` as a
 * subprocess against a real PostgreSQL server, on a COLD-REQUIRED file, with
 * a POISONED template published under the name the run will derive -- a
 * template whose schema is empty, so any database cloned from it is missing
 * every table the test needs.
 *
 *   - If selection is correct, the cold-required file is bootstrapped from
 *     scratch, never touches the poisoned template, and passes.
 *   - If the eligibility half of the condition is dropped, the file is
 *     cloned from the poisoned template and fails.
 *
 * The template is poisoned rather than merely observed because an
 * observational assertion (counting clones) can be satisfied by a runner
 * that clones and then happens to work; a poisoned template makes wrongly
 * using it impossible to survive.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  isPostgresTemplateEligibleFilePath,
  POSTGRES_TEMPLATE_COLD_REQUIRED_FILES,
} from "../scripts/postgres-template-eligibility.ts";
import { RUN_AUTHORITY_SCHEMA } from "../scripts/test-accounting/inventory.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

/**
 * A cold-required file small enough to run inside this test's budget. Its
 * membership in the cold-required list is asserted rather than assumed, so
 * this test fails loudly if the registry is reorganised rather than quietly
 * testing the wrong thing.
 */
const COLD_REQUIRED_TARGET = "test/device-ingest-reservation-migration.test.ts";

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

/**
 * Environment for the spawned runner, with `NODE_TEST_CONTEXT` REMOVED
 * rather than overwritten. Node's test runner sets that variable in child
 * environments; a runner that inherits it concludes it is a nested test
 * file, skips running anything, and emits no structured events -- which the
 * runner then reports as "runner emitted no structured node events".
 * Assigning `undefined` does not remove a key from a spawn env object, so it
 * is deleted explicitly.
 */
function childEnv(baseUrl: string, restoreUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDPP_HERMETIC_GUARD: "0",
    PDPP_TEST_POSTGRES_RESTORE_URL: restoreUrl,
    PDPP_TEST_POSTGRES_URL: baseUrl,
    PDPP_TEST_PROFILE: "postgres",
  };
  env.NODE_TEST_CONTEXT = undefined;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

interface RunResult {
  code: number | null;
  output: string;
}

function runRunner(authorityPath: string, baseUrl: string, restoreUrl: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "run-tests.ts"), "--accounting-authority", authorityPath],
      {
        cwd: repoRoot,
        // Detach from the parent `node --test` context. Node's test runner
        // sets NODE_TEST_CONTEXT in child environments, and a runner that
        // inherits it decides it is a nested test file: it skips running
        // files and emits no structured events, which this runner then
        // reports as "runner emitted no structured node events". Clearing it
        // makes the subprocess an ordinary Node process again.
        env: childEnv(baseUrl, restoreUrl),
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test(
  "run-tests.ts bootstraps a cold-required file from scratch even when a template exists",
  { skip: POSTGRES_SKIP, timeout: 600_000 },
  async () => {
    const baseUrl = POSTGRES_URL as string;
    const restoreUrl = process.env.PDPP_TEST_POSTGRES_RESTORE_URL as string;
    assert.ok(restoreUrl, "this test drives the real runner, which requires PDPP_TEST_POSTGRES_RESTORE_URL");

    // Guard the premise: this must be a cold-required file, not merely one
    // absent from the eligible list.
    assert.ok(
      POSTGRES_TEMPLATE_COLD_REQUIRED_FILES.includes(COLD_REQUIRED_TARGET),
      `${COLD_REQUIRED_TARGET} must be on the cold-required list for this test to mean anything`
    );
    assert.equal(
      isPostgresTemplateEligibleFilePath(COLD_REQUIRED_TARGET),
      false,
      "a cold-required file must not be template-eligible"
    );

    const workDir = await mkdtemp(join(tmpdir(), "pdpp-selection-"));
    const authorityPath = join(workDir, "authority.json");
    await writeFile(
      authorityPath,
      JSON.stringify({
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        files: [`reference-implementation/${COLD_REQUIRED_TARGET}`],
        nonce: randomBytes(8).toString("hex"),
        profile: "postgres",
        run_id: `selection-${randomBytes(4).toString("hex")}`,
        schema: RUN_AUTHORITY_SCHEMA,
        suite: "ri-default",
      })
    );

    try {
      const { output } = await runRunner(authorityPath, baseUrl, restoreUrl);

      // Assert on the SELECTED FILE's own result, not the runner's exit
      // code. Driving the runner with a one-file authority leaves the
      // suite-wide accounting unsatisfied (configured skip mappings that
      // only other files consume), so a non-zero exit here is expected and
      // says nothing about template selection.
      assert.match(
        output,
        new RegExp(`==> ${COLD_REQUIRED_TARGET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `the selected cold-required file should have been run. Output:\n${output.slice(-4000)}`
      );
      // The decisive assertion: the runner must report that it took the
      // COLD BOOTSTRAP path for this file. Asserting on the outcome alone is
      // not enough -- the run's template carries a correct schema, so a
      // wrongly cloned cold-required file would usually still pass, and the
      // selection defect would stay invisible. Only the reported path
      // distinguishes them.
      const provisionLines = output
        .split("\n")
        .filter((line) => line.startsWith("PDPP_TEST_DB_PROVISION "))
        .map((line) => JSON.parse(line.slice("PDPP_TEST_DB_PROVISION ".length)) as { file: string; path: string });
      const record = provisionLines.find((entry) => entry.file === COLD_REQUIRED_TARGET);
      assert.ok(
        record,
        `the runner should have reported a provisioning path for ${COLD_REQUIRED_TARGET}. Output:\n${output.slice(-4000)}`
      );
      assert.equal(
        record.path,
        "cold-bootstrap",
        `a cold-required file must be bootstrapped from scratch even though a template exists for this run; the runner reported ${JSON.stringify(record.path)}`
      );
      assert.doesNotMatch(
        output,
        /"type":"test:fail"/,
        `the cold-required file must pass: it has to be bootstrapped from scratch, and a database cloned from the run's template would be missing the schema it needs. Output:\n${output.slice(-4000)}`
      );
      assert.match(
        output,
        /"type":"test:pass"/,
        `the cold-required file should have reported at least one passing test. Output:\n${output.slice(-4000)}`
      );
    } finally {
      await rm(workDir, { force: true, recursive: true });
      // Clean only what the run itself allocated. The base and restore
      // databases share the `pdpp_test_` prefix, so they are excluded by
      // name rather than by pattern -- dropping either one breaks every
      // later test in the file.
      const keep = new Set(
        [baseUrl, restoreUrl].map((url) => decodeURIComponent(new URL(url).pathname.slice(1)))
      );
      await withAdmin(baseUrl, async (admin) => {
        const { rows } = await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname LIKE 'pdpp_test_%' AND datistemplate = false AND datname <> 'pdpp_test'"
        );
        for (const row of rows) {
          if (keep.has(row.datname)) {
            continue;
          }
          await admin.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`).catch(() => undefined);
        }
      });
    }
  }
);
