// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkPatchrightVersion } from "./check-patchright-version.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function locks({ root: rootVersion = "1.63.0", nested, runtime = "1.63.0", runner = "1.63.0" } = {}) {
  const rootPackages = {
    "": {},
    "node_modules/patchright": { version: rootVersion },
    "node_modules/patchright-core": { version: rootVersion },
  }
  if (nested) {
    rootPackages["node_modules/@pdpp/polyfill-connectors/node_modules/patchright"] = { version: nested }
  }
  const byPath = {
    "package-lock.json": { packages: rootPackages },
    "pdpp-runtime/package-lock.json": {
      packages: {
        "": {},
        "node_modules/patchright": { version: runtime },
        "node_modules/patchright-core": { version: runtime },
      },
    },
    "playwright-runner/package-lock.json": {
      packages: { "": {}, "node_modules/playwright-core": { version: runner } },
    },
  }
  return path => byPath[path]
}

describe("checkPatchrightVersion", () => {
  it("passes when every lock resolves one version", () => {
    expect(checkPatchrightVersion(locks())).toBeNull()
  })

  it("fails when the desktop runtime resolves a different Patchright", () => {
    const error = checkPatchrightVersion(locks({ root: "1.64.1" }))
    expect(error).toContain("Found 1.64.1, 1.63.0")
    expect(error).toContain("pdpp-runtime/package-lock.json: node_modules/patchright 1.63.0")
  })

  it("fails on a nested second copy inside one lock", () => {
    const error = checkPatchrightVersion(locks({ nested: "1.64.1" }))
    expect(error).toContain(
      "package-lock.json: node_modules/@pdpp/polyfill-connectors/node_modules/patchright 1.64.1"
    )
  })

  it("fails when the desktop's bundled Playwright differs", () => {
    const error = checkPatchrightVersion(locks({ runner: "1.64.1" }))
    expect(error).toContain("playwright-runner/package-lock.json: node_modules/playwright-core 1.64.1")
  })

  it("fails when a lock has no entry to compare", () => {
    const read = locks()
    const error = checkPatchrightVersion(path =>
      path === "pdpp-runtime/package-lock.json" ? { packages: { "": {} } } : read(path)
    )
    expect(error).toContain("pdpp-runtime/package-lock.json has no patchright or patchright-core entry")
  })

  it("passes on this repository's lock files", () => {
    expect(
      checkPatchrightVersion(path => JSON.parse(readFileSync(join(root, path), "utf8")))
    ).toBeNull()
  })
})
