// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `browserEnrollmentSupport` is the one rule the console's browser-session
 * routes and the RI's enrollment-shell route apply. It reads the manifest's
 * bindings, excludes known scaffolds, and fails closed when the optional
 * conformance roster did not load.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { browserEnrollmentSupport } from "../server/connection-setup-plan.ts";

const CONNECTION_SETUP_PLAN = fileURLToPath(new URL("../server/connection-setup-plan.ts", import.meta.url));

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

test("without the conformance roster no connector can add an account", () => {
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
process.stdout.write(JSON.stringify(["reddit", "acme-shop", "anthropic"].map((key) => browserEnrollmentSupport(key, browser))));
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
    { browserBound: true, canAddAccount: false },
    { browserBound: true, canAddAccount: false },
    { browserBound: true, canAddAccount: false },
  ]);
});
