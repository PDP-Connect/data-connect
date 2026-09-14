// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the local repair of stryker-js#6210.
//
// The scripts cohort produced no usable mutation evidence for as long as that
// defect was live: @stryker-mutator/vitest-runner builds a test identity by
// joining the suite chain with a single space, Vitest 5 matches
// `testNamePattern` against a name joined with " > ", so the per-test filter
// selected nothing and covered mutants were reported as survivors having run
// zero tests.
//
// The repair is two extension points -- a Stryker test-runner plugin and a
// Vitest setup file -- and these tests assert the three facts it rests on: the
// Vitest behaviour it targets, the stock runner still having the defect, and
// the wrapper's own identity arithmetic. If the second stops holding, upstream
// has shipped a fix and the repair should be deleted rather than adapted.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  describeAmbiguousIdentity,
  describeUnexpectedAgreement,
  findAmbiguousStockIds,
  SeparatorReconcilingTestRunner,
  STOCK_RUNNER_SEPARATOR,
  splitTestId,
  stockVitestRunnerFactory,
  toStockRunnerName,
  VITEST_FULL_NAME_SEPARATOR,
  WRAPPED_RUNNER_NAME,
} from "./vitest-runner-plugin.mjs"

const require = createRequire(import.meta.url)

describe("stryker-js#6210 repair", () => {
  // The premise the repair rests on. If this fails, Vitest changed its
  // separator and the repair is now the thing that is wrong -- a more useful
  // failure than a mutation run that quietly reports nothing.
  it("targets the separator Vitest builds fullTestName with", () => {
    const taskUtils = readFileSync(
      resolve(
        dirname(require.resolve("vitest/package.json")),
        "dist",
        "task-utils.js"
      ),
      "utf8"
    )

    expect(taskUtils).toContain('function getFullName(task, separator = " > ")')
    expect(taskUtils).toContain("t.fullTestName.match(namePattern)")
    expect(VITEST_FULL_NAME_SEPARATOR).toBe(" > ")
  })

  // The defect is still live. The check is on the runner's shipped identity
  // builder rather than on a version number, because the version that fixes it
  // is not known in advance.
  it("still finds the stock runner joining a suite chain with one space", () => {
    const helpers = readFileSync(
      resolve(
        dirname(require.resolve("@stryker-mutator/vitest-runner/package.json")),
        "dist",
        "src",
        "test-helpers.js"
      ),
      "utf8"
    )

    expect(
      helpers,
      "The stock Vitest runner no longer joins with a single space, so " +
        "stryker-js#6210 appears to be fixed. Delete " +
        "scripts/mutation-falsification/vitest-runner-plugin.mjs, " +
        "scripts/mutation-falsification/test-identity-setup.ts, and their references in " +
        "stryker.scripts.config.mjs and vite.mutation-scripts.config.ts."
    ).toContain("nameParts.join(' ').trim()")
    expect(STOCK_RUNNER_SEPARATOR).toBe(" ")
  })

  // The wrapper reaches the stock runner through the package's public export,
  // not a deep import of its dist. This asserts that route still resolves.
  it("reaches the stock runner through its public plugin export", () => {
    expect(typeof stockVitestRunnerFactory()).toBe("function")
    expect(WRAPPED_RUNNER_NAME).toBe("vitest-6210")
  })

  // Stryker matches a coverage key against a reported test id by exact string
  // (testsById.get(testId)), so the wrapper's rewrite has to be exact. A test
  // name containing a space is the case that makes the reverse direction
  // impossible and this direction necessary.
  it("maps a corrected name back to the one the stock runner reports", () => {
    expect(toStockRunnerName("outer > inner > does a thing")).toBe(
      "outer inner does a thing"
    )
  })

  // Ids are split on the first `#` only, because a test name may contain one.
  it("splits a test id on the first separator only", () => {
    expect(splitTestId("scripts/a.test.ts#suite > names a #tag")).toEqual({
      file: "scripts/a.test.ts",
      name: "suite > names a #tag",
    })
  })

  // The wrapper warns instead of silently repairing nothing.
  it("reports when the stock runner has started joining like Vitest", () => {
    const corrected = [{ name: "outer > inner", id: "a#outer > inner" }]
    expect(
      describeUnexpectedAgreement(corrected, { "a#outer > inner": {} })
    ).toContain("appears to be fixed upstream")

    const stillDefective = [{ name: "outer inner", id: "a#outer inner" }]
    expect(
      describeUnexpectedAgreement(stillDefective, { "a#outer > inner": {} })
    ).toBeUndefined()
  })
})

// The stock runner's id is lossy, so the map from a corrected coverage key to
// it is not injective. The wrapper cannot invert that loss; what it must not do
// is pick one of the colliding keys and report a clean reconciliation, because
// the result is one test credited with another test's coverage and nothing
// downstream can tell.
describe("ambiguous test identity", () => {
  it("detects two suite chains that collapse onto one reported id", () => {
    // `describe("a b") > it("c")` and `describe("a") > it("b c")`. Both are
    // reported by the stock runner as `file#a b c`.
    const collisions = findAmbiguousStockIds([
      "f.test.ts#a b > c",
      "f.test.ts#a > b c",
    ])

    expect(collisions).toEqual([
      {
        stockId: "f.test.ts#a b c",
        correctedIds: ["f.test.ts#a > b c", "f.test.ts#a b > c"],
      },
    ])
  })

  it("names the colliding tests in the failure it reports", () => {
    const message = describeAmbiguousIdentity(
      findAmbiguousStockIds(["f.test.ts#a b > c", "f.test.ts#a > b c"])
    )

    expect(message).toContain("Cannot reconcile test identity")
    expect(message).toContain("f.test.ts#a b c")
    expect(message).toContain("f.test.ts#a b > c")
    expect(message).toContain("f.test.ts#a > b c")
  })

  it("reports a title containing a literal separator as ambiguous", () => {
    // `describe("a") > it("b > c")` produces the corrected key `a > b > c` --
    // byte-identical to the key for `describe("a") > describe("b") > it("c")`.
    // The title's own " > " is indistinguishable from a suite boundary, so
    // this collides with the two-level chain rather than resolving against it.
    const collisions = findAmbiguousStockIds([
      "f.test.ts#a > b > c",
      "f.test.ts#a b > c",
    ])

    expect(collisions.map(collision => collision.stockId)).toEqual([
      "f.test.ts#a b c",
    ])
  })

  it("leaves an unambiguous inventory alone", () => {
    expect(
      findAmbiguousStockIds([
        "f.test.ts#outer > checks value",
        "f.test.ts#outer > checks other",
        "g.test.ts#outer > checks value",
      ])
    ).toEqual([])
  })

  it("does not confuse identical names in different files", () => {
    expect(
      findAmbiguousStockIds(["f.test.ts#a > b", "g.test.ts#a > b"])
    ).toEqual([])
  })

  // The refusal has to reach Stryker, not just the log: a dry run that returns
  // `complete` with collapsed ids would still produce a mutation score.
  it("fails the dry run rather than reconciling ambiguous identity", async () => {
    const runner = new SeparatorReconcilingTestRunner(
      {
        dryRun: async () => ({
          status: "complete",
          tests: [{ id: "f.test.ts#a b c", name: "a b c", status: "success" }],
          mutantCoverage: {
            static: {},
            perTest: { "f.test.ts#a b > c": {}, "f.test.ts#a > b c": {} },
          },
        }),
      } as never,
      { warn: () => {}, error: () => {}, debug: () => {} } as never
    )

    const result = await runner.dryRun({} as never)

    expect(result.status).toBe("error")
    expect((result as { errorMessage: string }).errorMessage).toContain(
      "Cannot reconcile test identity"
    )
  })

  // The ordinary case still reconciles, so the refusal above is not simply
  // refusing everything.
  it("still reconciles an unambiguous dry run", async () => {
    const runner = new SeparatorReconcilingTestRunner(
      {
        dryRun: async () => ({
          status: "complete",
          tests: [
            {
              id: "f.test.ts#outer checks value",
              name: "outer checks value",
              status: "success",
            },
          ],
          mutantCoverage: {
            static: {},
            perTest: { "f.test.ts#outer > checks value": {} },
          },
        }),
      } as never,
      { warn: () => {}, error: () => {}, debug: () => {} } as never
    )

    const result = await runner.dryRun({} as never)

    expect(result.status).toBe("complete")
    // Narrowed on the discriminant rather than cast: the refusal branch carries
    // no `tests`, so reaching the assertion below is itself part of the claim.
    if ("errorMessage" in result && result.errorMessage !== undefined) {
      throw new Error(`expected a reconciled run, got: ${result.errorMessage}`)
    }
    expect(result.tests).toEqual([
      {
        id: "f.test.ts#outer > checks value",
        name: "outer > checks value",
        status: "success",
      },
    ])
  })
})
