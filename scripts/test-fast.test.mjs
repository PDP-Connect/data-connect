// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import { planLanes } from "./test-fast.mjs"

const base = "59a3fb480e7f3e2d68d46b1e4ee2cb23d505d113"
const consoleTests = [
  {
    path: "apps/console/src/lib/format.test.ts",
    source: 'import { format } from "./format"\n',
  },
  {
    path: "apps/console/src/lib/other.test.ts",
    source: 'import { x } from "./unrelated"\n',
  },
  {
    path: "apps/console/src/app/(console)/sources/[id]/view.test.ts",
    source: 'import { pick } from "@/lib/pick-source.ts"\n',
  },
  {
    path: "apps/console/src/app/(console)/sources/[id]/other.test.ts",
    source: 'import { y } from "node:path"\n',
  },
]
const plan = changed =>
  planLanes(changed, {
    base,
    consoleTests,
    testedPackages: ["collector-runtime", "local-collector"],
  })
const names = result => result.lanes.map(lane => lane.name)

describe("planLanes", () => {
  it("runs vitest --changed for a src file", () => {
    const { lanes } = plan(["src/components/Button.tsx"])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].name).toBe("root")
    expect(lanes[0].argv).toEqual([
      "npm",
      "run",
      "test:unit",
      "--",
      "--changed",
      base,
      "--passWithNoTests",
    ])
  })

  it("runs a console source file's sibling tests and import matches only", () => {
    const { lanes } = plan(["apps/console/src/lib/format.ts"])
    expect(names({ lanes })).toEqual(["console"])
    // Both tests in src/lib are siblings; the sources/[id] tests are not.
    expect(lanes[0].argv.slice(-2)).toEqual([
      "src/lib/format.test.ts",
      "src/lib/other.test.ts",
    ])
  })

  it("selects a console test by import specifier and matches glob characters literally", () => {
    const { lanes } = plan(["apps/console/src/lib/pick-source.ts"])
    expect(lanes[0].argv).toContain(
      "src/app/(console)/sources/?id?/view.test.ts"
    )
    // The other test in that directory imports nothing relevant.
    expect(lanes[0].argv.join(" ")).not.toContain("sources/?id?/other.test.ts")
  })

  it("runs a changed console test file by itself", () => {
    const { lanes } = plan(["apps/console/src/lib/other.test.ts"])
    expect(lanes[0].argv.at(-1)).toBe("src/lib/other.test.ts")
    expect(lanes[0].argv).toContain("test:files")
  })

  it("falls back to the whole console suite when a source file matches no test", () => {
    const { lanes } = plan(["apps/console/src/orphan/lonely.ts"])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].argv).toEqual([
      "npm",
      "test",
      "--workspace",
      "apps/console",
    ])
  })

  it("runs the whole console suite for a console data file no import names", () => {
    const { lanes } = plan(["apps/console/data/brands.json"])
    expect(lanes.map(lane => lane.argv)).toEqual([
      ["npm", "test", "--workspace", "apps/console"],
    ])
  })

  it("does not pass a deleted console test to node --test", () => {
    const { lanes } = plan(["apps/console/src/lib/gone.test.ts"])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].argv.join(" ")).not.toContain("gone.test.ts")
    expect(lanes[0].argv.join(" ")).toContain("format.test.ts")
  })

  it("runs the whole console suite when console config changes", () => {
    const { lanes } = plan([
      "apps/console/tsconfig.json",
      "apps/console/src/lib/format.ts",
    ])
    expect(lanes[0].argv).toEqual([
      "npm",
      "test",
      "--workspace",
      "apps/console",
    ])
  })

  it("runs a changed package's whole test script", () => {
    const { lanes } = plan([
      "packages/local-collector/src/cli.ts",
      "packages/local-collector/test/a.test.ts",
    ])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].argv).toEqual([
      "npm",
      "test",
      "--workspace",
      "packages/local-collector",
    ])
  })

  it("ignores a package that has no test script", () => {
    expect(plan(["packages/polyfill-connectors/x.ts"]).lanes).toEqual([])
  })

  it("skips reference-implementation and says how to run it", () => {
    const result = plan(["reference-implementation/server/index.ts"])
    expect(result.lanes).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain(
      "npm test --workspace reference-implementation"
    )
  })

  it("plans no lane for docs, markdown, e2e and workflow changes", () => {
    const result = plan([
      "README.md",
      "docs/a.txt",
      "e2e/x.spec.ts",
      ".github/workflows/ci.yml",
      "apps/console/README.md",
    ])
    expect(result).toEqual({ lanes: [], notes: [] })
  })

  it("runs the whole unit tier when the lockfile or vitest config changes", () => {
    for (const file of [
      "package-lock.json",
      "vite.config.ts",
      "src/test/setup.ts",
      "package.json",
    ]) {
      const { lanes } = plan([file, "src/a.ts"])
      expect(lanes).toHaveLength(1)
      expect(lanes[0].argv).toEqual(["npm", "run", "test:unit"])
    }
  })

  it("falls back to the whole unit tier for a path no rule maps", () => {
    const { lanes } = plan(["deploy/railway.json"])
    expect(lanes[0].argv).toEqual(["npm", "run", "test:unit"])
    expect(lanes[0].why).toContain("deploy/railway.json")
  })

  it("orders lanes root, console, then packages", () => {
    expect(
      names(
        plan([
          "packages/collector-runtime/a.ts",
          "apps/console/src/lib/format.ts",
          "src/a.ts",
        ])
      )
    ).toEqual(["root", "console", "packages/collector-runtime"])
  })
})
