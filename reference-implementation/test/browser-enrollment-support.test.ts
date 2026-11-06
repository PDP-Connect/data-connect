// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `browserEnrollmentSupport` is the one rule the console's browser-session
 * routes and the RI's enrollment-shell route apply. It reads the manifest's
 * bindings, excludes known scaffolds, and accepts host-verified artifacts
 * when the optional conformance roster did not load.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { browserEnrollmentSupport } from "../server/connection-setup-plan.ts";

const CONNECTION_SETUP_PLAN = fileURLToPath(new URL("../server/connection-setup-plan.ts", import.meta.url));
const SELECTED_ARTIFACT_PASS = /^ok \d+ - selected local bytes control enrollment/m;
const ZERO_FAILURES = /^# fail 0$/m;

const browser = { runtime_requirements: { bindings: { browser: { required: true }, network: { required: true } } } };
const network = { runtime_requirements: { bindings: { network: { required: true } } } };

test("a browser binding permits a new account, including a connector no key list names", () => {
  assert.deepEqual(browserEnrollmentSupport("reddit", browser), { browserBound: true, canAddAccount: true });
  assert.deepEqual(browserEnrollmentSupport("acme-shop", browser), { browserBound: true, canAddAccount: true });
});

test("a known scaffold stays browser-bound but cannot add an account", () => {
  assert.deepEqual(browserEnrollmentSupport("anthropic", browser), { browserBound: true, canAddAccount: false });
});

test("a connector without a browser binding is not browser-bound", () => {
  assert.deepEqual(browserEnrollmentSupport("github", network), { browserBound: false, canAddAccount: false });
  assert.deepEqual(browserEnrollmentSupport("reddit", null), { browserBound: false, canAddAccount: false });
});

test("verified artifacts permit enrollment without the optional conformance roster", () => {
  const hook = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@pdpp/polyfill-connectors/")) {
      throw Object.assign(new Error("Cannot find module '" + specifier + "'"), { code: "MODULE_NOT_FOUND" });
    }
    return nextResolve(specifier, context);
  },
});
`;
  const probe = `
const { browserEnrollmentSupport } = await import(${JSON.stringify(pathToFileURL(CONNECTION_SETUP_PLAN).href)});
const browser = ${JSON.stringify(browser)};
process.stdout.write(JSON.stringify(["chatgpt", "whoop", "book-shelf", "anthropic", "unregistered"].map((key) => browserEnrollmentSupport(key, { ...browser, browser_enrollment_artifact: key === "unregistered" ? { status: "none" } : { status: "verified", trust: "developer-local-unsigned", manifest: browser } }))));
`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      "--input-type=module",
      "--eval",
      probe,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [
    { browserBound: true, canAddAccount: true },
    { browserBound: true, canAddAccount: true },
    { browserBound: true, canAddAccount: true },
    { browserBound: true, canAddAccount: false },
    { browserBound: true, canAddAccount: false },
  ]);
});

test("real local artifact inspection also passes with every optional connector import blocked", () => {
  const hook = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@pdpp/polyfill-connectors/")) throw Object.assign(new Error("optional package absent"), { code: "MODULE_NOT_FOUND" });
  return nextResolve(specifier, context);
} });`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      "--test-reporter=tap",
      "--test",
      "test/browser-enrollment-artifact.test.ts",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    }
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, SELECTED_ARTIFACT_PASS);
  assert.match(child.stdout, ZERO_FAILURES);
});

test("hosted enrollment route and owner template work without the optional connector package", () => {
  const hook = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@pdpp/polyfill-connectors" || specifier.startsWith("@pdpp/polyfill-connectors/"))
    throw Object.assign(new Error("optional package absent"), { code: "MODULE_NOT_FOUND" });
  return nextResolve(specifier, context);
} });`;
  const scenarioUrl = new URL("./helpers/browser-enrollment-hosted-scenario.ts", import.meta.url).href;
  const probe = `const { runHostedBrowserEnrollmentScenario } = await import(${JSON.stringify(scenarioUrl)});
console.log("HOSTED_ENROLLMENT_RESULT " + JSON.stringify(await runHostedBrowserEnrollmentScenario()));`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      "--input-type=module",
      "--eval",
      probe,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    }
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const marker = child.stdout.split("\n").find((line) => line.startsWith("HOSTED_ENROLLMENT_RESULT "));
  assert.ok(marker, "the actual hosted route scenario must complete");
  assert.deepEqual(JSON.parse(marker.slice("HOSTED_ENROLLMENT_RESULT ".length)), {
    nextSteps: {
      anthropic: "manual_runbook",
      "bare-browser": "manual_runbook",
      "book-shelf": "enroll_browser_collector",
      chatgpt: "enroll_browser_collector",
      whoop: "enroll_browser_collector",
    },
    rosterLoaded: false,
    statuses: { anthropic: 409, "bare-browser": 409, "book-shelf": 201, chatgpt: 201, whoop: 201 },
  });
});
