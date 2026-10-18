// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof that one hung test file is a failed file, not an aborted
 * run: the real runner executes a file the watchdog kills, still runs the file
 * after it, reports completed_files for both, and exits non-zero.
 *
 * The fixtures sit in a hidden scratch directory under scripts/. The runner
 * selects them by authority path, and no discovery walk descends into a
 * subdirectory, so no other runner picks them up.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUN_AUTHORITY_SCHEMA } from "./test-accounting/inventory.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runTestsPath = join(scriptsDir, "run-tests.ts");
const RESULT_PREFIX = "PDPP_TEST_ACCOUNTING_RESULT ";

function runRunner(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runTestsPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("a hung file is reported failed with its output and the next file still runs", async () => {
  const scratch = await mkdtemp(join(scriptsDir, ".ri-timeout-fixture-"));
  try {
    await mkdir(scratch, { recursive: true });
    await writeFile(
      join(scratch, "a-hang.test.mjs"),
      [
        'import test from "node:test";',
        'test("hang", () => {',
        '  process.stderr.write("HUNG-FIXTURE-OUTPUT\\n");',
        "  setInterval(() => {}, 1000);",
        "  return new Promise(() => {});",
        "});",
      ].join("\n")
    );
    await writeFile(
      join(scratch, "b-after.test.mjs"),
      'import test from "node:test";\ntest("after the hang", () => {});\n'
    );
    const base = scratch.slice(scriptsDir.length + 1);
    const files = [`reference-implementation/scripts/${base}/a-hang.test.mjs`, `reference-implementation/scripts/${base}/b-after.test.mjs`];
    const authorityPath = join(scratch, "authority.json");
    await writeFile(
      authorityPath,
      JSON.stringify({
        expires_at: "2099-01-01T00:00:00.000Z",
        files,
        nonce: "timeout-nonce",
        profile: "memory-default",
        run_id: "timeout-run",
        schema: RUN_AUTHORITY_SCHEMA,
        suite: "ri-default",
      })
    );

    const { code, stderr, stdout } = await runRunner(["--accounting-authority", authorityPath], {
      ...process.env,
      // Inside a node --test child this would make the nested runner's own
      // test children refuse to start ("run() called recursively").
      NODE_TEST_CONTEXT: undefined,
      PDPP_TEST_CONCURRENCY: "1",
      PDPP_TEST_FILE_HARD_TIMEOUT_MS: "60000",
      PDPP_TEST_FILE_TIMEOUT_MS: "2500",
      PDPP_TEST_PROFILE: "memory-default",
    });

    assert.notEqual(code, 0, `a timed-out file must fail the run\n${stderr}`);
    assert.match(stdout, /TIMED OUT \(idle\) after 2500ms/, `the timeout is named\n${stdout}\n${stderr}`);
    assert.match(stdout, /==> a-hang\.test\.mjs|==> .*a-hang\.test\.mjs/, "the hung file's header is kept");
    assert.match(stdout, /==> .*b-after\.test\.mjs/, "the file after the hang still ran");
    const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
    assert.ok(line, `no accounting result line\n${stdout}\n${stderr}`);
    const result = JSON.parse(line.slice(RESULT_PREFIX.length));
    assert.equal(result.counts.planned_files, 2);
    assert.equal(result.counts.completed_files, 2, "both files' children exited");
    assert.equal(result.counts.failed_files, 1);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});
