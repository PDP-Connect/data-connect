// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RUN_AUTHORITY_SCHEMA } from "../scripts/test-accounting/inventory.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const restoreUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_RESTORE_URL);
const skipReason = baseUrl && restoreUrl ? false : "set dedicated primary and restore URLs";

type SignalResult = { code: number | null; output: string };

async function signalRunner(signal: "SIGINT" | "SIGTERM"): Promise<SignalResult> {
  const workDir = await mkdtemp(join(tmpdir(), "ri-signal-cleanup-"));
  const authorityPath = join(workDir, "authority.json");
  const authority = {
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    files: ["reference-implementation/test/accepted-provider-native-consent.test.ts"],
    nonce: randomBytes(8).toString("hex"),
    profile: "postgres",
    run_id: `signal-${randomBytes(4).toString("hex")}`,
    schema: RUN_AUTHORITY_SCHEMA,
    suite: "ri-default",
  };
  await writeFile(authorityPath, JSON.stringify(authority));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDPP_HERMETIC_GUARD: "0",
    PDPP_TEST_PROFILE: "postgres",
  };
  delete env.NODE_TEST_CONTEXT;
  try {
    const runnerPath = join(repoRoot, "scripts/run-tests.ts");
    const runnerArgs = ["--import", "tsx", runnerPath, "--accounting-authority", authorityPath];
    const child = spawn(process.execPath, runnerArgs, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let signalSent = false;
    let timedOut = false;
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 600_000);
      const capture = (chunk: Buffer) => {
        output += String(chunk);
        if (!signalSent && output.includes("PDPP_TEST_DB_PROVISION ")) {
          signalSent = true;
          output += `\nSIGNAL_SENT ${signal}\n`;
          child.kill(signal);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error("runner did not stop after the signal"));
          return;
        }
        resolve(exitCode);
      });
    });
    return { code, output };
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

async function listDatabases(): Promise<string[]> {
  const adminUrl = new URL(baseUrl as string);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>("SELECT datname FROM pg_database ORDER BY datname");
    return rows.map(({ datname }) => datname);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Other files (and an enclosing runner) own other databases on this server,
// so only what the nested runner created is asserted gone.
function runnerOwnedDatabases(output: string, before: ReadonlySet<string>, after: readonly string[]): string[] {
  const provisioned = output
    .split("\n")
    .filter((line) => line.startsWith("PDPP_TEST_DB_PROVISION "))
    .map((line) => (JSON.parse(line.slice("PDPP_TEST_DB_PROVISION ".length)) as { database: string }).database);
  const templates = after.filter((name) => name.startsWith("pdpp_test_template_") && !before.has(name));
  return [...new Set([...provisioned, ...templates])];
}

for (const [signal, expectedCode] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`runner cleans databases on ${signal}`, { skip: skipReason, timeout: 660_000 }, async () => {
    const before = new Set(await listDatabases());
    const result = await signalRunner(signal);
    const marker = `SIGNAL_SENT ${signal}`;
    const markerAt = result.output.indexOf(marker);
    assert.notEqual(markerAt, -1, `runner must provision a file database before ${signal}`);
    assert.equal(result.code, expectedCode);
    assert.doesNotMatch(result.output.slice(markerAt + marker.length), /^==> /m);
    const after = await listDatabases();
    const owned = runnerOwnedDatabases(result.output, before, after);
    assert.ok(owned.length > 0, "runner must report at least one database it created");
    assert.deepEqual(owned.filter((name) => after.includes(name)), []);
  });
}
