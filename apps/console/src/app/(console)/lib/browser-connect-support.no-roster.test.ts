// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every @pdpp/polyfill-connectors subpath fails to resolve, from any parent,
// as in a packaged console whose bundle cannot find the package.
const NO_ROSTER_HOOK = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@pdpp/polyfill-connectors/")) {
      throw Object.assign(new Error("Cannot find module '" + specifier + "' (simulated packaged console)"), {
        code: "MODULE_NOT_FOUND",
      });
    }
    return nextResolve(specifier, context);
  },
});
`;

test("browser-connect-support.test.ts passes without the conformance roster", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(NO_ROSTER_HOOK)}`,
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("./browser-connect-support.test.ts", import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
      // Without NODE_TEST_CONTEXT the child reports plain TAP, not to this runner.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, PDPP_TEST_SIMULATE_NO_CONNECTOR_ROSTER: "1" },
    }
  );
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /^ok \d+ - the conformance roster is loaded exactly when this run expects it$/m);
  assert.match(child.stdout, /^ok \d+ - a known scaffold stays browser-bound but cannot add an account$/m);
  assert.match(child.stdout, /^# fail 0$/m);
});
