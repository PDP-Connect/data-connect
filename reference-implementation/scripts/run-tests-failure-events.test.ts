// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A test child can exit 0 while its reporter recorded a failure: `node --test`
// exits 0 when only a `todo` test fails. The gate must still go red. This runs
// the real runner on a throwaway fixture file whose only test is a failing
// todo, selected with --files-from so no other finalization can turn it red.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runRunner(listPath: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["scripts/run-tests.ts", "--files-from", listPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        PDPP_TEST_POSTGRES_URL: undefined,
        PDPP_TEST_PROFILE: "memory-default",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

test("a recorded failure event makes the gate exit non-zero even when the child exited 0", async () => {
  // Discovery reads scripts/ one level deep, so the fixture must sit there to
  // pass --files-from validation; the random name keeps it unique.
  const fixture = `scripts/zz-failure-event-fixture-${randomBytes(4).toString("hex")}.test.ts`;
  const workDir = await mkdtemp(join(tmpdir(), "pdpp-failure-events-"));
  const listPath = join(workDir, "files.txt");
  await writeFile(
    join(repoRoot, fixture),
    'import test from "node:test";\n' +
      'test("a failing todo still records a failure event", { todo: "fixture" }, () => {\n' +
      '  throw new Error("fixture failure");\n' +
      "});\n"
  );
  await writeFile(listPath, `${fixture}\n`);
  try {
    const { code, output } = await runRunner(listPath);
    assert.match(output, /"type":"test:fail"/, `the fixture must record a failure event. Output:\n${output.slice(-2000)}`);
    assert.notEqual(code, 0, `the runner exited 0 although a failure was recorded. Output:\n${output.slice(-2000)}`);
    assert.match(output, /recorded failure events although the test process exited 0/);
  } finally {
    await rm(join(repoRoot, fixture), { force: true });
    await rm(workDir, { force: true, recursive: true });
  }
});
