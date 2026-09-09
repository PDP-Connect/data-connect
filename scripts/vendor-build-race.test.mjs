// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("../", import.meta.url)

test("npm ci serializes vendored prepares that build the same CLI directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vendor-build-race-"))
  const npm = args =>
    execFileSync("npm", args, {
      cwd: scratch,
      encoding: "utf8",
      // An inherited CLI override must not stand in for the repository policy.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "npm_config_foreground_scripts"
        )
      ),
      timeout: 30_000,
      shell: process.platform === "win32",
    })
  try {
    writeFileSync(
      join(scratch, ".npmrc"),
      readFileSync(new URL(".npmrc", root))
    )
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({
        name: "vendor-build-race-fixture",
        private: true,
        workspaces: ["vendor/*"],
      })
    )
    // Keep the real prepare commands and MCP -> CLI invocation. Replace only
    // compilation with a slow writer that detects simultaneous dist ownership.
    for (const name of ["cli", "mcp-server"]) {
      const { scripts } = JSON.parse(
        readFileSync(
          new URL(`reference-implementation/vendor/${name}/package.json`, root),
          "utf8"
        )
      )
      const build =
        name === "cli"
          ? "node ../../build.cjs cli"
          : scripts.build.replace(
              "node --import tsx scripts/build.ts",
              "node ../../build.cjs mcp-server"
            )
      if (name === "mcp-server") assert.notEqual(build, scripts.build)
      mkdirSync(join(scratch, "vendor", name), { recursive: true })
      writeFileSync(
        join(scratch, "vendor", name, "package.json"),
        JSON.stringify({
          name: `@pdpp/${name}`,
          version: "0.0.0",
          scripts: { prepare: scripts.prepare, build },
          ...(name === "mcp-server"
            ? { dependencies: { "@pdpp/cli": "*" } }
            : {}),
        })
      )
    }
    writeFileSync(
      join(scratch, "build.cjs"),
      `
const fs = require("node:fs");
const path = require("node:path");
const name = process.argv[2];
const lock = path.join(__dirname, name + ".lock");
try { fs.mkdirSync(lock); } catch { throw new Error("Concurrent build of " + name); }
setTimeout(() => {
  fs.mkdirSync("dist", { recursive: true });
  fs.writeFileSync("dist/complete", name);
  fs.appendFileSync(path.join(__dirname, "builds.log"), name + "\\n");
  fs.rmdirSync(lock);
}, 1000);
`
    )
    npm([
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
    ])
    // Deliberately omit --foreground-scripts: the repository must supply it.
    npm(["ci", "--offline", "--no-audit", "--no-fund"])
    for (const name of ["cli", "mcp-server"]) {
      assert.equal(
        readFileSync(join(scratch, "vendor", name, "dist/complete"), "utf8"),
        name
      )
    }
    assert.deepEqual(
      readFileSync(join(scratch, "builds.log"), "utf8")
        .trim()
        .split("\n")
        .sort(),
      ["cli", "cli", "mcp-server"]
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
