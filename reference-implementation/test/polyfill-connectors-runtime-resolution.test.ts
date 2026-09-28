// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * polyfill-connectors-runtime.ts resolves the optional connector package from
 * its own location first and from the process cwd second. The console
 * bundles that module, and webpack replaces `import.meta.url` with the build
 * machine's path, so on an owner's machine only the cwd base (the staged
 * console runtime directory) can find the package.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requireFromFirstResolvingBase } from "../server/polyfill-connectors-runtime.ts";

const RUNTIME_MODULE = fileURLToPath(new URL("../server/polyfill-connectors-runtime.ts", import.meta.url));

function notFound(code: string): Error {
  return Object.assign(new Error(`missing (${code})`), { code });
}

test("the first base that resolves the specifier wins", () => {
  const seen: string[] = [];
  const found = requireFromFirstResolvingBase(
    [
      (specifier) => {
        seen.push(`build:${specifier}`);
        throw notFound("MODULE_NOT_FOUND");
      },
      (specifier) => {
        seen.push(`cwd:${specifier}`);
        return { PRODUCTION_READY_CONNECTORS: { reddit: {} } };
      },
    ],
    "@pdpp/polyfill-connectors/connector-conformance-roster"
  );
  assert.deepEqual(found, { PRODUCTION_READY_CONNECTORS: { reddit: {} } });
  assert.deepEqual(seen, [
    "build:@pdpp/polyfill-connectors/connector-conformance-roster",
    "cwd:@pdpp/polyfill-connectors/connector-conformance-roster",
  ]);
});

test("no resolving base means the package is absent", () => {
  assert.equal(
    requireFromFirstResolvingBase(
      [
        () => {
          throw notFound("MODULE_NOT_FOUND");
        },
        () => {
          throw notFound("ERR_MODULE_NOT_FOUND");
        },
      ],
      "@pdpp/polyfill-connectors/credential-probe"
    ),
    null
  );
});

test("a failure other than module-not-found propagates", () => {
  assert.throws(
    () =>
      requireFromFirstResolvingBase(
        [
          () => {
            throw new SyntaxError("broken module");
          },
          () => ({}),
        ],
        "@pdpp/polyfill-connectors/credential-probe"
      ),
    /broken module/
  );
});

// Loads the real module in a child whose resolve hook refuses the package
// when the parent is polyfill-connectors-runtime.ts itself, which is what a
// bundle's stale build-machine `import.meta.url` amounts to.
function productionReadyFromChild(cwd: string): string[] {
  const hook = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@pdpp/polyfill-connectors/") && String(context.parentURL ?? "").includes("polyfill-connectors-runtime")) {
      throw Object.assign(new Error("Cannot find module '" + specifier + "' (build path)"), { code: "MODULE_NOT_FOUND" });
    }
    return nextResolve(specifier, context);
  },
});
`;
  const probe = `
const runtime = await import(${JSON.stringify(pathToFileURL(RUNTIME_MODULE).href)});
process.stdout.write(JSON.stringify(Object.keys(runtime.PRODUCTION_READY_CONNECTORS)));
`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      "--input-type=module",
      "--eval",
      probe,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } }
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as string[];
}

test("the module falls back to the package staged under the process cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-polyfill-runtime-cwd-"));
  try {
    const installedPackage = dirname(
      createRequire(RUNTIME_MODULE).resolve("@pdpp/polyfill-connectors/connector-conformance-roster")
    );
    const packageRoot = dirname(installedPackage);
    const stagedPackage = join(directory, "staged", "node_modules", "@pdpp", "polyfill-connectors");
    mkdirSync(join(stagedPackage, "src"), { recursive: true });
    cpSync(join(packageRoot, "package.json"), join(stagedPackage, "package.json"));
    cpSync(
      join(packageRoot, "src", "connector-conformance-roster.js"),
      join(stagedPackage, "src", "connector-conformance-roster.js")
    );
    mkdirSync(join(directory, "empty"));
    writeFileSync(join(directory, "empty", "package.json"), "{}\n");

    assert.ok(productionReadyFromChild(join(directory, "staged")).includes("reddit"));
    assert.deepEqual(productionReadyFromChild(join(directory, "empty")), []);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
