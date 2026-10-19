// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The gate must go red for a test that the Node runner itself would let through.
// `node --test` counts a passing `todo` as a pass and exits 0 when a `todo`
// fails, so the accounting rejects every `todo` test by name. These tests run
// the real runner on throwaway fixture files selected with --files-from, so no
// other finalization can turn the run red.
//
// `todo` was the only way found for a child to exit 0 after a `test:fail` event:
// the exit code comes from the outer `node --test` process, which a fixture
// cannot zero (an exit handler setting process.exitCode = 0, or process.exit(0)
// in a later test, still exits 1). The `silentFailures` check in run-tests.ts
// stays as defence in depth and has no test of its own.

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
        // CI keeps no private diagnostics, so these runs write nothing to the
        // user's state directory.
        CI: "1",
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

// Discovery reads scripts/ one level deep, so a fixture must sit there to pass
// --files-from validation; the random name keeps it unique.
async function runFixture(source: string): Promise<{ code: number | null; output: string }> {
  const fixture = `scripts/zz-failure-event-fixture-${randomBytes(4).toString("hex")}.test.ts`;
  const workDir = await mkdtemp(join(tmpdir(), "pdpp-failure-events-"));
  const listPath = join(workDir, "files.txt");
  await writeFile(join(repoRoot, fixture), source);
  await writeFile(listPath, `${fixture}\n`);
  try {
    return await runRunner(listPath);
  } finally {
    await rm(join(repoRoot, fixture), { force: true });
    await rm(workDir, { force: true, recursive: true });
  }
}

test("a passing todo test makes the gate exit non-zero, naming the file", async () => {
  const { code, output } = await runFixture(
    'import test from "node:test";\n' + 'test("a passing todo placeholder", { todo: "fixture" }, () => {});\n'
  );
  assert.notEqual(code, 0, `the runner exited 0 for a passing todo. Output:\n${output.slice(-2000)}`);
  assert.match(output, /accounting error in scripts\/zz-failure-event-fixture-\w+\.test\.ts: todo-rejected/);
});

test("a failing todo test makes the gate exit non-zero, naming the file", async () => {
  const { code, output } = await runFixture(
    'import test from "node:test";\n' +
      'test("a failing todo placeholder", { todo: "fixture" }, () => {\n' +
      '  throw new Error("fixture failure");\n' +
      "});\n"
  );
  assert.notEqual(code, 0, `the runner exited 0 for a failing todo. Output:\n${output.slice(-2000)}`);
  assert.match(output, /accounting error in scripts\/zz-failure-event-fixture-\w+\.test\.ts: todo-rejected/);
});

// Node 24 marks every test inside a todo describe as todo, so its children
// are rejected; the suite's own event is rejected as well.
test("a todo describe with a passing child makes the gate exit non-zero", async () => {
  const { code, output } = await runFixture(
    'import { describe, it } from "node:test";\n' +
      'describe("an unfinished suite", { todo: "fixture" }, () => {\n' +
      '  it("a green child", () => {});\n' +
      "});\n"
  );
  assert.notEqual(code, 0, `the runner exited 0 for a todo suite. Output:\n${output.slice(-2000)}`);
  assert.match(output, /accounting error in scripts\/zz-failure-event-fixture-\w+\.test\.ts: todo-rejected/);
});

test("a named skip is accepted by the gate", async () => {
  const { code, output } = await runFixture(
    'import test from "node:test";\n' + 'test("a named skip placeholder", { skip: "fixture reason" }, () => {});\n'
  );
  assert.equal(code, 0, `the runner rejected a named skip. Output:\n${output.slice(-2000)}`);
});
