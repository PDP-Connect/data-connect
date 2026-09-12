// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the two ways the source-reading filter used to withhold
// behavioural tests it should have kept.
//
// These run at the level the defect is expensive at: the SELECTION, not the
// predicate. `run-intent.ts` filters the cohort's selected tests with
// `readsMutatedSource` and writes what survives; a test wrongly dropped there is
// absent from the mutation baseline, so a mutant it would have killed is
// reported as surviving with nothing having executed it. The run still reports a
// completed baseline, which is what makes this failure silent.
//
// Both shapes are built as real files in a real temporary tree, so the paths
// being compared are paths that exist and are genuinely distinct:
//
//   1. An independent fixture. The batch mutates `src/target.ts`. A test
//      EXECUTES that implementation and separately reads
//      `test/fixtures/src/target.ts`, a different checked-in file. Comparing on
//      a `./`- and `../`-stripped suffix, without the reading test's own
//      directory, made the fixture look like the implementation.
//   2. A dynamic import outside a read call's arguments. Reading a read's
//      arguments as "text up to a semicolon or newline" overran the call's
//      closing paren; this repo writes no semicolons, so the span ran to the end
//      of the line and swept in an `import(...)` that followed an unrelated
//      `readFile`. Importing is EXECUTION, the one thing that must never cause a
//      withholding.
//
// Each case is asserted alongside a second test that is genuinely retained, so
// the selection is non-empty for a reason other than the fallback. `run-intent`
// falls back to the cohort's whole suite on an empty selection, and an assertion
// that only checked "the selection is not empty" would pass through the very
// defect these tests exist to catch.

import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { readsMutatedSource } from "./select-pr-files.ts"

/**
 * Create a real cohort tree and return the tests that survive the filter.
 *
 * This is the filtering `run-intent.ts` applies to `selectCohortTests`, over
 * files on disk rather than over string constants, so a path comparison that
 * conflates two distinct real files is visible as a missing test.
 */
function retainedTests(
  files: Readonly<Record<string, string>>,
  testPaths: readonly string[],
  mutate: readonly string[]
): string[] {
  const root = mkdtempSync(join(tmpdir(), "pdpp-source-read-"))
  try {
    for (const [path, contents] of Object.entries(files)) {
      const onDisk = join(root, path)
      mkdirSync(dirname(onDisk), { recursive: true })
      writeFileSync(onDisk, contents)
    }
    return testPaths.filter(
      (test) => !readsMutatedSource(test, readFileSync(join(root, test), "utf8"), mutate)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const implementation = `export function compute(value: number): number {
  return value * 2
}
`

/** A test that only executes the implementation. Retained in every case below. */
const behaviouralOnly = `import assert from "node:assert/strict"
import { test } from "node:test"
import { compute } from "../../src/target.ts"

test("doubles", () => assert.equal(compute(21), 42))
`

describe("source-reading selection keeps behavioural coverage", () => {
  it("keeps a test that reads an independent fixture while executing the mutated file", () => {
    // `test/fixtures/src/target.ts` and `src/target.ts` are both real, and
    // different. Only the second is mutated.
    const retained = retainedTests(
      {
        "src/target.ts": implementation,
        "test/fixtures/src/target.ts": "export const golden = 'a checked-in fixture'\n",
        "test/unit/compute.test.ts": `import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { compute } from "../../src/target.ts"

const golden = await readFile(new URL("../fixtures/src/target.ts", import.meta.url), "utf8")

test("doubles", () => assert.equal(compute(21), 42))
test("fixture is present", () => assert.match(golden, /golden/))
`,
        "test/unit/behaviour.test.ts": behaviouralOnly,
      },
      ["test/unit/compute.test.ts", "test/unit/behaviour.test.ts"],
      ["src/target.ts:1-3"]
    )

    // Named explicitly. Asserting only on the count would let a swap pass.
    expect(retained).toEqual(["test/unit/compute.test.ts", "test/unit/behaviour.test.ts"])
  })

  it("keeps a test whose dynamic import trails an unrelated read on one line", () => {
    const retained = retainedTests(
      {
        "src/target.ts": implementation,
        "test/config.json": "{}\n",
        "test/unit/dynamic.test.ts": `import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"

const config = await readFile(new URL("../config.json", import.meta.url), "utf8"), mod = await import("../../src/target.ts")

test("doubles", () => assert.equal(mod.compute(21), 42))
test("config parses", () => assert.ok(JSON.parse(config)))
`,
        "test/unit/behaviour.test.ts": behaviouralOnly,
      },
      ["test/unit/dynamic.test.ts", "test/unit/behaviour.test.ts"],
      ["src/target.ts:1-3"]
    )

    expect(retained).toEqual(["test/unit/dynamic.test.ts", "test/unit/behaviour.test.ts"])
  })

  it("still withholds a test that reads the mutated file itself", () => {
    // The filter has to keep doing its job: this is the shape it exists for, and
    // a repair that retained everything would pass the two cases above while
    // making the filter useless.
    const retained = retainedTests(
      {
        "src/target.ts": implementation,
        "test/unit/shape.test.ts": `import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"

const src = await readFile(new URL("../../src/target.ts", import.meta.url), "utf8")

test("asserts on source text", () => assert.match(src, /value \\* 2/))
`,
        "test/unit/behaviour.test.ts": behaviouralOnly,
      },
      ["test/unit/shape.test.ts", "test/unit/behaviour.test.ts"],
      ["src/target.ts:1-3"]
    )

    expect(retained).toEqual(["test/unit/behaviour.test.ts"])
  })
})
