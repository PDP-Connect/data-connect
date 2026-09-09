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

test("the console build the workflow runs is the one the test looks for", async () => {
  // The test locates the build through apps/console's own build script. If the
  // workflow built some other target the prebuild would not satisfy the test,
  // and the silent in-test build would come back without the workflow
  // appearing to change.
  const consolePackage = JSON.parse(await readFile(join(__dirname, "../../apps/console/package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.ok(consolePackage.scripts?.build, "apps/console must define the build script the workflow invokes");
});
