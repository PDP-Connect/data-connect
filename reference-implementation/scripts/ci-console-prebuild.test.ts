// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * composed-origin.test.ts requires the console's production build. If it is
 * absent the test builds it in a subprocess whose output the test captures
 * rather than forwards, and Node's test runner owns the file's stdio, so
 * nothing written during the build reaches the gate. The gate kills a file
 * that produces no output for its idle budget (120s by default), so a cold
 * console build turns into a silence long enough to be mistaken for a hung
 * file. How long it takes depends on the share of the machine it gets, which
 * is exactly what file concurrency changes.
 *
 * The gate's continuous-integration job therefore builds the console up front,
 * alongside the other build-time workspace prerequisites. This asserts that
 * ordering holds, so removing the step fails here rather than as an
 * intermittent timeout attributed to concurrency.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, "../../.github/workflows/reference-implementation.yml");

test("the test job builds the console before it runs the gate", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");

  const buildIndex = workflow.indexOf("npm --prefix apps/console run build");
  assert.notEqual(
    buildIndex,
    -1,
    "the reference-implementation workflow must build apps/console, or composed-origin.test.ts builds it silently mid-run"
  );

  const testIndex = workflow.indexOf("npm --prefix reference-implementation run test");
  assert.notEqual(testIndex, -1, "expected the workflow to run the reference-implementation gate");

  assert.ok(
    buildIndex < testIndex,
    "the console build must come before the gate, otherwise the build still happens inside the test"
  );
});

test("the workflow builds the same target the test would build itself", async () => {
  // A prebuild of some other target would leave composed-origin.test.ts still
  // building silently while the workflow looked correct. Derive the command
  // from the test's own spawn arguments rather than restating it here, so the
  // two cannot drift apart silently.
  const testSource = await readFile(join(__dirname, "../test/composed-origin.test.ts"), "utf8");
  const spawnArgs = testSource.match(/runCommand\("npm",\s*\[([^\]]+)\]/);
  assert.ok(spawnArgs?.[1], "expected composed-origin.test.ts to build the console with runCommand(\"npm\", [...])");

  const argv = [...spawnArgs[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const command = `npm ${argv.join(" ")}`;
  assert.equal(command, "npm --prefix apps/console run build", "unexpected console build command in the test");

  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  assert.ok(
    workflow.includes(command),
    `the workflow must run ${command}, the exact build composed-origin.test.ts falls back to`
  );
});
