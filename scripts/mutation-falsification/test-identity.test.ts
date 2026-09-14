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

import { DryRunStatus, MutantRunStatus } from "@stryker-mutator/api/test-runner"
import type {
  KilledMutantRunResult,
  MutantRunResult,
} from "@stryker-mutator/api/test-runner"

import {
  buildIdentityMap,
  correctedByStockIdFrom,
  describeUnexpectedAgreement,
  SeparatorReconcilingTestRunner,
  STOCK_RUNNER_SEPARATOR,
  splitTestId,
  stockVitestRunnerFactory,
  toStockRunnerName,
  UNMAPPABLE_KEY_PREFIX,
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

  // The tripwire warns instead of silently repairing nothing. It is a
  // heuristic, not the premise check -- that one reads the runner's shipped
  // identity builder, above.
  it("reports when the stock runner has started joining like Vitest", () => {
    const corrected = [
      { name: "outer > inner", id: "a#outer > inner" },
      { name: "outer > other", id: "a#outer > other" },
    ]
    expect(
      describeUnexpectedAgreement(corrected, { "a#outer > inner": {} })
    ).toContain("appears to be fixed upstream")

    const stillDefective = [{ name: "outer inner", id: "a#outer inner" }]
    expect(
      describeUnexpectedAgreement(stillDefective, { "a#outer > inner": {} })
    ).toBeUndefined()
  })

  // The false positive the tripwire used to produce. One ordinary `it("a > b")`
  // makes a single reported name carry the separator under the UNFIXED runner,
  // and warning that upstream looks fixed says the opposite of the truth. What
  // upstream's fix would produce is every multi-level name carrying it.
  it("does not mistake one literal title for an upstream fix", () => {
    const literalAmongOrdinary = [
      { name: "outer a > b", id: "a#outer a > b" },
      { name: "outer checks value", id: "a#outer checks value" },
    ]

    expect(
      describeUnexpectedAgreement(literalAmongOrdinary, {
        "a#outer checks value": {},
      })
    ).toBeUndefined()
  })
})

// The stock runner's id is lossy, so the map from a corrected coverage key to
// it is not injective. The wrapper cannot invert that loss; what it must not do
// is pick one of the colliding keys and report a clean reconciliation, because
// the result is one test credited with another test's coverage and nothing
// downstream can tell.
//
// `buildIdentityMap` is the whole of that judgement. It is given the covered
// keys AND the full reported inventory, because some of these failures are not
// visible in coverage alone.
describe("test identity mapping", () => {
  const nested = [
    { id: "f.test.ts#outer checks value" },
    { id: "f.test.ts#outer checks other" },
  ]

  it("maps an ordinary nested inventory", () => {
    const identity = buildIdentityMap(
      ["f.test.ts#outer > checks value", "f.test.ts#outer > checks other"],
      nested
    )

    expect(identity.ok).toBe(true)
    if (!identity.ok) throw new Error(identity.message)
    expect([...identity.correctedByStockId].map(([stock, { id }]) => [stock, id])).toEqual([
      ["f.test.ts#outer checks value", "f.test.ts#outer > checks value"],
      ["f.test.ts#outer checks other", "f.test.ts#outer > checks other"],
    ])
  })

  it("does not confuse identical names in different files", () => {
    const identity = buildIdentityMap(["f.test.ts#a > b", "g.test.ts#a > b"], [
      { id: "f.test.ts#a b" },
      { id: "g.test.ts#a b" },
    ])

    expect(identity.ok).toBe(true)
    if (!identity.ok) throw new Error(identity.message)
    expect(identity.correctedByStockId.size).toBe(2)
  })

  // Counterexample 1. A single `it("a > b")` under `describe("outer")`. The
  // setup file refuses it at the structured boundary, so what arrives here is
  // the refusal marker rather than a key that looks ordinary. Before the
  // refusal existed this produced key `f#outer > a > b`, the wrapper flattened
  // it to `f#outer a b`, found no such reported test (the stock runner reports
  // `f#outer a > b`), and returned complete with an orphan.
  it("refuses a single test whose own title contains the separator", () => {
    const identity = buildIdentityMap(
      [`${UNMAPPABLE_KEY_PREFIX}f.test.ts#outer | a > b`],
      [{ id: "f.test.ts#outer a > b" }]
    )

    expect(identity.ok).toBe(false)
    if (identity.ok) throw new Error("expected a refusal")
    expect(identity.message).toContain("Cannot reconcile test identity")
    expect(identity.message).toContain("f.test.ts#outer | a > b")
  })

  // Counterexample 2. That same literal-title test and
  // `describe("outer") > describe("a") > it("b")` produce the SAME corrected
  // key `f#outer > a > b` before the wrapper sees them. One key cannot be
  // detected as two distinct keys, so the collision check could never catch
  // this pair -- which is why the literal title is refused one step earlier,
  // where the chain is still structured. Here the refusal marker and the
  // genuine nested key arrive together and the run still stops.
  it("refuses a literal title that would alias a genuine nested chain", () => {
    const identity = buildIdentityMap(
      [
        `${UNMAPPABLE_KEY_PREFIX}f.test.ts#outer | a > b`,
        "f.test.ts#outer > a > b",
      ],
      [{ id: "f.test.ts#outer a > b" }, { id: "f.test.ts#outer a b" }]
    )

    expect(identity.ok).toBe(false)
    if (identity.ok) throw new Error("expected a refusal")
    expect(identity.message).toContain("contain \" > \"")
  })

  // Counterexample 3. Two reported tests carry the same stock id, and only one
  // corrected coverage key exists. Nothing in the covered keys is ambiguous --
  // the ambiguity is entirely in the reported inventory, which is why
  // uniqueness is validated over the full inventory and not over coverage.
  it("refuses two reported tests rewritten to one identity", () => {
    const identity = buildIdentityMap(["f.test.ts#a > b"], [
      { id: "f.test.ts#a b" },
      { id: "f.test.ts#a b" },
    ])

    expect(identity.ok).toBe(false)
    if (identity.ok) throw new Error("expected a refusal")
    expect(identity.message).toContain("reported by more than one test")
    expect(identity.message).toContain("f.test.ts#a b")
  })

  it("detects two suite chains that collapse onto one reported id", () => {
    // `describe("a b") > it("c")` and `describe("a") > it("b c")`. Both are
    // reported by the stock runner as `file#a b c`.
    const identity = buildIdentityMap(
      ["f.test.ts#a b > c", "f.test.ts#a > b c"],
      [{ id: "f.test.ts#a b c" }]
    )

    expect(identity.ok).toBe(false)
    if (identity.ok) throw new Error("expected a refusal")
    expect(identity.message).toContain("f.test.ts#a b c")
    expect(identity.message).toContain("f.test.ts#a b > c")
    expect(identity.message).toContain("f.test.ts#a > b c")
  })

  // Every coverage key has to name a test that was actually reported. This is
  // the orphan the literal-title case used to produce, reached directly.
  it("refuses a coverage key with no reported test", () => {
    const identity = buildIdentityMap(["f.test.ts#outer > a > b"], [
      { id: "f.test.ts#outer a > b" },
    ])

    expect(identity.ok).toBe(false)
    if (identity.ok) throw new Error("expected a refusal")
    expect(identity.message).toContain("do not correspond to any reported")
  })

  // The two halves of the repair live in different module systems and cannot
  // import from one another -- the setup file is loaded into the test
  // environment and the plugin pulls in Stryker's host-side packages. The
  // marker is the only thing they exchange, so its two definitions are checked
  // against each other rather than assumed equal.
  it("agrees with the setup file on the refusal marker", () => {
    const setupSource = readFileSync(
      resolve(dirname(new URL(import.meta.url).pathname), "test-identity-setup.ts"),
      "utf8"
    )

    expect(setupSource).toContain(
      `export const UNMAPPABLE_KEY_PREFIX = ${JSON.stringify(UNMAPPABLE_KEY_PREFIX)}`
    )
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

    // Narrowed on the union's own discriminant rather than cast: the refusal
    // and timeout branches carry no `tests`, so reaching the assertion below is
    // itself part of the claim.
    if (result.status !== DryRunStatus.Complete) {
      throw new Error(`expected a reconciled run, got status ${result.status}`)
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

// The dry run rewrites the baseline's identities; a kill coming back under the
// stock id would name a test absent from the report's inventory. These assert
// the map is carried through, and that nothing else about the result is.
describe("killer identity carried through mutantRun", () => {
  // `MutantRunResult` is a union, and only the killed variant carries
  // `killedBy`. Narrowing on the status discriminant is what lets these read
  // the field, and a result that is not killed fails here rather than silently
  // asserting on `undefined`.
  function killed(result: MutantRunResult): KilledMutantRunResult {
    if (result.status !== MutantRunStatus.Killed) {
      throw new Error(`expected a killed result, got status ${result.status}`)
    }
    return result
  }

  function reconcilingRunner(mutantRunResult: Record<string, unknown>) {
    return new SeparatorReconcilingTestRunner(
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
        mutantRun: async () => mutantRunResult,
      } as never,
      { warn: () => {}, error: () => {}, debug: () => {} } as never
    )
  }

  it("rewrites a killer id the dry run reconciled", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["f.test.ts#outer checks value"],
      failureMessage: "expected 3 to equal 4",
      nrOfTests: 1,
    })
    await runner.dryRun({} as never)

    const result = await runner.mutantRun({
      testFilter: ["f.test.ts#outer > checks value"],
    } as never)

    expect(killed(result).killedBy).toEqual(["f.test.ts#outer > checks value"])
  })

  it("does not reclassify the status, counts or error it forwards", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["f.test.ts#outer checks value"],
      failureMessage: "expected 3 to equal 4",
      nrOfTests: 1,
    })
    await runner.dryRun({} as never)

    const result = await runner.mutantRun({
      testFilter: ["f.test.ts#outer > checks value"],
    } as never)

    expect(result.status).toBe(MutantRunStatus.Killed)
    expect(killed(result).failureMessage).toBe("expected 3 to equal 4")
    expect(killed(result).nrOfTests).toBe(1)
  })

  // A timeout and a runtime error carry no `killedBy` at all. They must be
  // forwarded exactly as they arrive -- normalising identity is not licence to
  // touch an observation that has no identity in it.
  it("forwards a timeout untouched", async () => {
    const timeout = { status: "timeout", reason: "timed out after 5000ms" }
    const runner = reconcilingRunner(timeout)
    await runner.dryRun({} as never)

    expect(await runner.mutantRun({} as never)).toEqual(timeout)
  })

  it("forwards a runtime error untouched", async () => {
    const runtimeError = { status: "runtimeError", errorMessage: "boom" }
    const runner = reconcilingRunner(runtimeError)
    await runner.dryRun({} as never)

    expect(await runner.mutantRun({} as never)).toEqual(runtimeError)
  })

  // An id the dry run never mapped is left as it is. It then fails to resolve
  // against the report's test table downstream, which is the point: an unknown
  // identity must not be rewritten into a known-looking one.
  it("leaves an unmapped killer id alone", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["g.test.ts#never seen"],
      nrOfTests: 1,
    })
    await runner.dryRun({} as never)

    const result = await runner.mutantRun({
      testFilter: ["f.test.ts#outer > checks value"],
    } as never)

    expect(killed(result).killedBy).toEqual(["g.test.ts#never seen"])
  })

  // The case that actually happens. Stryker runs mutants in a pool of child
  // processes, so the instance handling this mutant never saw the dry run and
  // holds no map. The filter Stryker passes carries the corrected ids, which is
  // enough to rebuild the mapping -- without it the killer would stay
  // space-joined and resolve to nothing in the report.
  it("rewrites a killer id in a process that never ran the dry run", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["f.test.ts#outer checks value"],
      nrOfTests: 1,
    })

    const result = await runner.mutantRun({
      testFilter: ["f.test.ts#outer > checks value"],
    } as never)

    expect(killed(result).killedBy).toEqual(["f.test.ts#outer > checks value"])
  })

  // The fourth cell, and the one that makes the policy deterministic: the same
  // instance that reconciled the dry run, handed a mutant with no filter. A
  // static mutant is exactly that -- no per-test coverage, so no `testFilter`
  // -- and Stryker reuses the dry run's worker for some of them. If the dry
  // run's map were consulted here, whether a static kill resolved would depend
  // on which worker the mutant happened to land on, and the same head would
  // report a different valid denominator at a different concurrency.
  it("does not rewrite a killer id from the dry run it ran itself", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["f.test.ts#outer checks value"],
      nrOfTests: 1,
    })
    await runner.dryRun({} as never)

    const result = await runner.mutantRun({ testFilter: undefined } as never)

    expect(killed(result).killedBy).toEqual(["f.test.ts#outer checks value"])
  })

  // With neither a dry run nor a filter there is nothing to map from, and the
  // wrapper is a pass-through -- the stock runner's behaviour.
  it("forwards killer ids unchanged with no map and no filter", async () => {
    const runner = reconcilingRunner({
      status: "killed",
      killedBy: ["f.test.ts#outer checks value"],
    })

    const result = await runner.mutantRun({} as never)

    expect(killed(result).killedBy).toEqual(["f.test.ts#outer checks value"])
  })
})

// The filter is the mapping's source in a child process, so its own
// losslessness rule is asserted directly.
describe("correctedByStockIdFrom", () => {
  it("computes the stock id each filter entry would be reported under", () => {
    expect([
      ...correctedByStockIdFrom(["f.test.ts#outer > checks value"]),
    ]).toEqual([["f.test.ts#outer checks value", "f.test.ts#outer > checks value"]])
  })

  // Two corrected ids flattening onto one stock id is the collision the dry run
  // refuses. Reached here, the entry is dropped rather than resolved: the
  // killer then stays space-joined and fails to resolve downstream, which is
  // the safe direction.
  it("drops a stock id two filter entries collapse onto", () => {
    expect(
      correctedByStockIdFrom(["f.test.ts#a b > c", "f.test.ts#a > b c"]).size
    ).toBe(0)
  })

  it("is empty with no filter and no dry-run map", () => {
    expect(correctedByStockIdFrom(undefined).size).toBe(0)
  })
})
