// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A Stryker test-runner plugin that wraps the stock Vitest runner so the test
 * identities it reports agree with the ones Vitest 5 filters on.
 *
 * Upstream: https://github.com/stryker-mutator/stryker-js/issues/6210
 *
 * The defect. @stryker-mutator/vitest-runner 10.0.0 identifies a test by
 * joining its suite chain with a single space, and hands that string to Vitest
 * as `testNamePattern`. Vitest 5 matches the pattern against `fullTestName`,
 * which it joins with " > " (`getFullName(task, separator = " > ")` in
 * vitest/dist/task-utils.js, applied at `interpretTaskModes` via
 * `t.fullTestName.match(namePattern)`). A space-joined pattern matches nothing:
 * every test is set to `mode=skip`, per-test coverage comes back empty, and
 * Stryker falls back to re-running the whole suite for every mutant. The
 * runner's peer range is `vitest >=2.0.0`, so the incompatible pair installs
 * without a warning.
 *
 * The repair has two halves, because the runner builds the identity twice and
 * Stryker requires the two to be byte-equal (`testsById.get(testId)` in
 * core/dist/src/mutants/test-coverage.js is an exact-string lookup):
 *
 *   - In the test environment, `stryker-setup.js` records the running test's
 *     identity as a coverage key. `scripts/mutation-falsification/test-identity-setup.ts`, a
 *     Vitest setup file, rewrites that key to Vitest's separator.
 *   - Here on the host, the runner's `convertTestToTestResult` builds
 *     `TestResult.id` for each test it reports. This plugin rewrites those ids
 *     to match. Stryker then finds coverage for each test and derives a
 *     `testFilter` whose names are the ones Vitest's pattern match accepts.
 *
 * Fixing either half alone leaves the run no better off: a corrected coverage
 * key with an uncorrected test id finds no test, and Stryker logs
 * "Found test with id ... in coverage data, but not in the test results".
 *
 * Why a plugin rather than a patch. `plugins` and `PluginKind.TestRunner` are
 * Stryker's documented extension point, and the stock runner is reached through
 * its package's public export (`strykerPlugins`) rather than a deep import of
 * its `dist` -- that path is not in the package's `exports` map. Nothing under
 * `node_modules` is modified, so a reinstall cannot silently drop the repair,
 * and `npm ci` needs no lifecycle script for it to hold.
 *
 * Registered by `stryker.scripts.config.mjs` as `testRunner: "vitest-6210"`.
 * `assertStockRunnerStillJoinsWithSpaces` fails once upstream ships its fix,
 * which is the signal to delete this file, the setup file, and the two config
 * references rather than to keep a wrapper that repairs nothing.
 */

import {
  commonTokens,
  declareFactoryPlugin,
  PluginKind,
  tokens,
} from "@stryker-mutator/api/plugin"
import { DryRunStatus } from "@stryker-mutator/api/test-runner"
import { strykerPlugins as vitestRunnerPlugins } from "@stryker-mutator/vitest-runner"

/** The separator Vitest 5 builds `fullTestName` with. */
export const VITEST_FULL_NAME_SEPARATOR = " > "

/** The separator the stock runner joins a suite chain with. */
export const STOCK_RUNNER_SEPARATOR = " "

/** The name the stock runner registers itself under. */
const STOCK_RUNNER_NAME = "vitest"

/** The name this wrapper registers under, named by the cohort configuration. */
export const WRAPPED_RUNNER_NAME = "vitest-6210"

/**
 * The stock runner's factory, taken from its package's public export rather
 * than by importing `dist/src/vitest-test-runner.js`. That path is absent from
 * the package's `exports` map, so reaching for it would be reaching past the
 * interface the package offers.
 */
export function stockVitestRunnerFactory() {
  const declaration = vitestRunnerPlugins.find(
    plugin =>
      plugin.kind === PluginKind.TestRunner && plugin.name === STOCK_RUNNER_NAME
  )
  if (!declaration?.factory) {
    throw new Error(
      `@stryker-mutator/vitest-runner no longer exports a ${PluginKind.TestRunner} ` +
        `plugin named "${STOCK_RUNNER_NAME}". Re-check stryker-js#6210 before ` +
        `restoring this wrapper.`
    )
  }
  return declaration.factory
}

/**
 * Splits a test id into its file path and its suite-chain name.
 *
 * The runner's ids are `<file>#<name>`, and a `#` may appear inside a test's
 * own name, so the split is on the first separator only -- the same rule the
 * runner's own `fromTestId` applies.
 *
 * @param {string} id
 * @returns {{ file: string, name: string }}
 */
export function splitTestId(id) {
  const index = id.indexOf("#")
  if (index === -1) return { file: id, name: "" }
  return { file: id.slice(0, index), name: id.slice(index + 1) }
}

/**
 * Rewrites a corrected coverage key into the id the stock runner reports.
 *
 * This direction is computable where the reverse is not: the runner's
 * space-joined name cannot be re-split, because a space inside a test's own
 * name is indistinguishable from a separator. Computing it this way is what
 * lets the wrapper find the reported test that a corrected key belongs to.
 *
 * It is not, however, injective. Two different suite chains can collapse onto
 * one stock name -- `["a b", "c"]` and `["a", "b c"]` both flatten to
 * `a b c` -- and the stock name is all Stryker has to match on. See
 * `findAmbiguousStockIds`: the wrapper refuses such a run rather than picking
 * one of the chains.
 *
 * @param {string} correctedName a suite chain joined with " > "
 * @returns {string} the same chain joined the way the stock runner joins it
 */
export function toStockRunnerName(correctedName) {
  return correctedName
    .split(VITEST_FULL_NAME_SEPARATOR)
    .join(STOCK_RUNNER_SEPARATOR)
    .trim()
}

/**
 * Finds the stock ids that more than one corrected coverage key maps onto.
 *
 * The stock runner's id is lossy: it joins the suite chain with a single space,
 * so `describe("a b") > it("c")` and `describe("a") > it("b c")` are both
 * reported as `file#a b c`. Keyed by that id, the second corrected key would
 * overwrite the first, and both tests would then be rewritten to whichever key
 * happened to come last -- one test carrying another's coverage, reported as a
 * clean reconciliation.
 *
 * There is no way to recover the true chain from a stock id, so this is not
 * something the wrapper can repair. It reports the collisions instead, and
 * `dryRun` refuses the run. Mutation evidence attributed to the wrong test is
 * worse than no mutation evidence, because nothing downstream can tell.
 *
 * @param {readonly string[]} correctedIds coverage keys written by the setup file
 * @returns {Array<{ stockId: string, correctedIds: string[] }>} sorted, empty when unambiguous
 */
export function findAmbiguousStockIds(correctedIds) {
  /** @type {Map<string, Set<string>>} */
  const byStockId = new Map()
  for (const correctedId of correctedIds) {
    const { file, name } = splitTestId(correctedId)
    const stockId = `${file}#${toStockRunnerName(name)}`
    const seen = byStockId.get(stockId) ?? new Set()
    seen.add(correctedId)
    byStockId.set(stockId, seen)
  }

  return [...byStockId.entries()]
    .filter(([, correctedForStockId]) => correctedForStockId.size > 1)
    .map(([stockId, correctedForStockId]) => ({
      stockId,
      correctedIds: [...correctedForStockId].sort(),
    }))
    .sort((left, right) => left.stockId.localeCompare(right.stockId))
}

/**
 * The message `dryRun` fails with when identity cannot be reconciled.
 *
 * Names the colliding tests, because the repair is a rename in the test suite
 * and the operator has to know which titles to change.
 *
 * @param {ReturnType<typeof findAmbiguousStockIds>} collisions
 * @returns {string}
 */
export function describeAmbiguousIdentity(collisions) {
  const detail = collisions
    .map(
      ({ stockId, correctedIds }) =>
        `  ${JSON.stringify(stockId)} <- ${correctedIds
          .map(id => JSON.stringify(id))
          .join(", ")}`
    )
    .join("\n")

  return (
    `Cannot reconcile test identity for stryker-js#6210: ${collisions.length} ` +
    `test id(s) reported by the Vitest runner correspond to more than one test. ` +
    `The runner joins a suite chain with a single space, so distinct chains ` +
    `such as "a b" > "c" and "a" > "b c" collapse onto one id, and coverage ` +
    `cannot be attributed to the test that produced it:\n${detail}\n` +
    `Rename one test in each group so the space-joined chains differ.`
  )
}

/**
 * Behavioural check that the defect this wrapper repairs is still live.
 *
 * Asserts on what the stock runner does, not on its source text: it reports a
 * test whose suite chain is known, and the reported name is compared against
 * both joins. A wrapper that silently repairs nothing is worse than an absent
 * one -- it would keep claiming a repair, and the day the shapes diverge again
 * nothing would say so.
 *
 * @param {readonly import('@stryker-mutator/api/test-runner').TestResult[]} tests
 * @param {Record<string, unknown>} perTest coverage keys from the same dry run
 * @returns {string | undefined} a description of the mismatch, or undefined
 */
export function describeUnexpectedAgreement(tests, perTest) {
  const coverageKeys = Object.keys(perTest)
  if (coverageKeys.length === 0 || tests.length === 0) return undefined
  // The setup file only ever writes a corrected key, so a corrected key proves
  // nothing on its own. What would prove upstream has shipped its fix is the
  // stock runner reporting a name already joined with Vitest's separator.
  const stockAlreadyCorrected = tests.some(test =>
    test.name.includes(VITEST_FULL_NAME_SEPARATOR)
  )
  if (stockAlreadyCorrected) {
    return (
      `The stock Vitest runner now reports names joined with ` +
      `${JSON.stringify(VITEST_FULL_NAME_SEPARATOR)}, so stryker-js#6210 appears ` +
      `to be fixed upstream. Delete scripts/mutation-falsification/vitest-runner-plugin.mjs, ` +
      `scripts/mutation-falsification/test-identity-setup.ts, and their references in ` +
      `stryker.scripts.config.mjs and vite.mutation-scripts.config.ts.`
    )
  }
  return undefined
}

/**
 * Delegating `TestRunner`. Every call forwards to a real stock runner; only the
 * identities in the dry-run result are rewritten.
 */
export class SeparatorReconcilingTestRunner {
  #inner
  #log

  /**
   * @param {import('@stryker-mutator/api/test-runner').TestRunner} inner
   * @param {import('@stryker-mutator/api/logging').Logger} log
   */
  constructor(inner, log) {
    this.#inner = inner
    this.#log = log
  }

  capabilities() {
    return this.#inner.capabilities()
  }

  async init() {
    return this.#inner.init()
  }

  /**
   * Rewrites each reported test's identity to the corrected form, so it matches
   * the coverage key the setup file wrote for the same test.
   *
   * The rewrite is driven from the coverage keys rather than guessed from the
   * reported name: for each corrected key, the id the stock runner would have
   * reported is computed, and the test carrying that id takes the corrected
   * one. A test with no coverage keeps its reported identity -- it is not in
   * any mutant's filter, so its identity never has to match anything.
   *
   * Fails the run if two coverage keys compute the same stock id. That mapping
   * is not injective, and silently keeping one of the two would attribute a
   * test's coverage to a different test under a name that looks reconciled.
   */
  async dryRun(options) {
    const result = await this.#inner.dryRun(options)
    const perTest = result.mutantCoverage?.perTest
    if (!result.tests?.length || !perTest) return result

    const warning = describeUnexpectedAgreement(result.tests, perTest)
    if (warning) this.#log.warn(warning)

    const correctedIds = Object.keys(perTest)
    const collisions = findAmbiguousStockIds(correctedIds)
    if (collisions.length > 0) {
      const message = describeAmbiguousIdentity(collisions)
      this.#log.error(message)
      return {
        status: DryRunStatus.Error,
        errorMessage: message,
      }
    }

    /** Corrected id, keyed by the id the stock runner reports for that test. */
    const correctedByStockId = new Map()
    for (const correctedId of correctedIds) {
      const { file, name } = splitTestId(correctedId)
      correctedByStockId.set(`${file}#${toStockRunnerName(name)}`, {
        id: correctedId,
        name,
      })
    }

    let reconciled = 0
    const tests = result.tests.map(test => {
      const corrected = correctedByStockId.get(test.id)
      if (!corrected) return test
      reconciled += 1
      return { ...test, id: corrected.id, name: corrected.name }
    })

    this.#log.debug(
      `stryker-js#6210 wrapper: reconciled ${reconciled} of ${result.tests.length} ` +
        `test identities against ${correctedByStockId.size} coverage keys.`
    )

    return { ...result, tests }
  }

  async mutantRun(options) {
    return this.#inner.mutantRun(options)
  }

  async dispose() {
    return this.#inner.dispose?.()
  }
}

/**
 * @param {import('@stryker-mutator/api/plugin').Injector} injector
 * @param {import('@stryker-mutator/api/logging').Logger} log
 */
function createWrappedVitestTestRunner(injector, log) {
  const inner = injector.injectFunction(stockVitestRunnerFactory())
  return new SeparatorReconcilingTestRunner(inner, log)
}
createWrappedVitestTestRunner.inject = tokens(
  commonTokens.injector,
  commonTokens.logger
)

export const strykerPlugins = [
  declareFactoryPlugin(
    PluginKind.TestRunner,
    WRAPPED_RUNNER_NAME,
    createWrappedVitestTestRunner
  ),
]
