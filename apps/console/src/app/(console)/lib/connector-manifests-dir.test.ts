// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveInstalledConnectorManifestsDir } from "./connector-manifests-dir.ts";

test("resolves manifests from a package available only through node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-manifests-package-"));
  try {
    const packageRoot = join(root, "node_modules", "@pdpp", "polyfill-connectors");
    const manifestsDir = join(packageRoot, "manifests");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await mkdir(manifestsDir);
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: { "./manifests": "./src/manifest-registry.js" },
        name: "@pdpp/polyfill-connectors",
        type: "module",
      }),
    );
    await writeFile(join(packageRoot, "src", "manifest-registry.js"), "export {};\n");

    const resolveFromTempPackage = createRequire(join(root, "package.json")).resolve;
    assert.equal(resolveInstalledConnectorManifestsDir(resolveFromTempPackage), manifestsDir);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
