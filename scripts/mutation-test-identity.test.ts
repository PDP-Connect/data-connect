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

import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  STOCK_RUNNER_SEPARATOR,
  VITEST_FULL_NAME_SEPARATOR,
  describeUnexpectedAgreement,
  splitTestId,
  stockVitestRunnerFactory,
  toStockRunnerName,
  WRAPPED_RUNNER_NAME,
} from "./mutation-vitest-runner-plugin.mjs"

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
        "task-utils.js",
      ),
      "utf8",
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
        "test-helpers.js",
      ),
      "utf8",
    )

    expect(
      helpers,
      "The stock Vitest runner no longer joins with a single space, so " +
        "stryker-js#6210 appears to be fixed. Delete " +
        "scripts/mutation-vitest-runner-plugin.mjs, " +
        "scripts/mutation-test-identity-setup.ts, and their references in " +
        "stryker.scripts.config.mjs and vite.config.ts.",
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
      "outer inner does a thing",
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
      describeUnexpectedAgreement(corrected, { "a#outer > inner": {} }),
    ).toContain("appears to be fixed upstream")

    const stillDefective = [{ name: "outer inner", id: "a#outer inner" }]
    expect(
      describeUnexpectedAgreement(stillDefective, { "a#outer > inner": {} }),
    ).toBeUndefined()
  })
})
