// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The release's prepare step runs this script on the real config. Package
// verify never runs it, so these tests are its only gate: they copy the
// release config and every lockstep package.json into a scratch tree, pin,
// and read the manifests back.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lockstepPackages } from "./lockstep-packages.js"
import { pinLockstepDependencies } from "./pin-lockstep-dependencies.js"

const REPO_ROOT = resolve(import.meta.dirname, "..")
const VERSION = "9.8.7"

interface Manifest {
  name: string
  dependencies?: Record<string, string>
}

describe("pinLockstepDependencies on the release config", () => {
  const packages = lockstepPackages(REPO_ROOT)
  const names = new Set(packages.map((pkg) => pkg.name))
  let tree = ""

  const read = (root: string, base = tree) =>
    JSON.parse(readFileSync(join(base, root, "package.json"), "utf8")) as Manifest

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "pin-lockstep-"))
    copyFileSync(join(REPO_ROOT, ".releaserc.yaml"), join(tree, ".releaserc.yaml"))
    for (const { root } of packages) {
      mkdirSync(join(tree, root), { recursive: true })
      copyFileSync(join(REPO_ROOT, root, "package.json"), join(tree, root, "package.json"))
    }
  })

  afterEach(() => {
    rmSync(tree, { force: true, recursive: true })
  })

  it("pins every dependency one lockstep package has on another to the release version", () => {
    const pinned = pinLockstepDependencies(VERSION, tree)

    const expected = packages.flatMap((pkg) =>
      pkg.dependsOn.map((dependency) => ({
        dependency,
        from: read(pkg.root, REPO_ROOT).dependencies?.[dependency],
        root: pkg.root,
      }))
    )
    expect(pinned).toEqual(expected)
    // The release has such edges; a config where none resolve would pass vacuously.
    expect(pinned.map(({ dependency }) => dependency)).toEqual(
      expect.arrayContaining(["@pdpp/connector-protocol", "@pdpp/cli", "@pdpp/read-core"])
    )
  })

  it("changes each manifest only by setting its lockstep dependencies to the release version", () => {
    pinLockstepDependencies(VERSION, tree)

    for (const { root } of packages) {
      const before = read(root, REPO_ROOT)
      const dependencies =
        before.dependencies &&
        Object.fromEntries(
          Object.entries(before.dependencies).map(([dependency, range]) => [
            dependency,
            names.has(dependency) ? VERSION : range,
          ])
        )
      expect(read(root), root).toStrictEqual({ ...before, ...(dependencies && { dependencies }) })
    }
  })
})
