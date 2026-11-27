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
import { dirname, join, resolve } from "node:path";
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
        return { readPolyfillManifests: "cwd" };
      },
    ],
    "@pdpp/polyfill-connectors/manifests"
  );
  assert.deepEqual(found, { readPolyfillManifests: "cwd" });
  assert.deepEqual(seen, [
    "build:@pdpp/polyfill-connectors/manifests",
    "cwd:@pdpp/polyfill-connectors/manifests",
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
function manifestFilesFromChild(cwd: string): string[] {
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
process.stdout.write(JSON.stringify(runtime.readPolyfillManifests().map((entry) => entry.file)));
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
    {
      cwd,
      encoding: "utf8",
      // A relative TSX_TSCONFIG_PATH (the mutation runner sets one) would
      // resolve against the child's cwd, so pin it to this process's cwd.
      env: {
        ...process.env,
        NODE_PATH: "",
        PDPP_POLYFILL_MANIFESTS_DIR: "",
        ...(process.env.TSX_TSCONFIG_PATH ? { TSX_TSCONFIG_PATH: resolve(process.env.TSX_TSCONFIG_PATH) } : {}),
      },
    }
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as string[];
}

test("the module falls back to the package staged under the process cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-polyfill-runtime-cwd-"));
  try {
    const installedPackage = dirname(
      createRequire(RUNTIME_MODULE).resolve("@pdpp/polyfill-connectors/manifests")
    );
    const packageRoot = dirname(installedPackage);
    const stagedPackage = join(directory, "staged", "node_modules", "@pdpp", "polyfill-connectors");
    mkdirSync(join(stagedPackage, "src"), { recursive: true });
    mkdirSync(join(stagedPackage, "manifests"));
    cpSync(join(packageRoot, "package.json"), join(stagedPackage, "package.json"));
    cpSync(join(packageRoot, "src", "manifest-registry.js"), join(stagedPackage, "src", "manifest-registry.js"));
    writeFileSync(join(stagedPackage, "manifests", "staged-example.json"), "{}\n");
    mkdirSync(join(directory, "empty"));
    writeFileSync(join(directory, "empty", "package.json"), "{}\n");

    assert.deepEqual(manifestFilesFromChild(join(directory, "staged")), ["staged-example.json"]);
    assert.deepEqual(manifestFilesFromChild(join(directory, "empty")), []);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
