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
 * The prefix the setup file writes a refused identity under.
 *
 * Kept byte-identical to `UNMAPPABLE_KEY_PREFIX` in
 * `test-identity-setup.ts`; that file cannot import from here, because it is
 * loaded into the test environment and this module pulls in Stryker's
 * host-side packages. `test-identity.test.ts` asserts the two agree.
 */
export const UNMAPPABLE_KEY_PREFIX = " stryker-6210-unmappable:"

/**
 * Builds the validated map from stock id to corrected identity, or explains
 * why the run cannot be reconciled.
 *
 * Three separate ways identity can fail, all of which end the run rather than
 * producing a mapping that looks clean:
 *
 *   - **Unmappable.** The setup file refused a title containing `" > "`. It
 *     could not have produced a lossless key, and the flattened lookup would
 *     not have found its reported test anyway.
 *   - **Collision.** Two corrected keys flatten onto one stock id --
 *     `describe("a b") > it("c")` and `describe("a") > it("b c")` both report
 *     as `file#a b c`. The stock id is all the reported test carries, so one of
 *     the two would take the other's coverage under a reconciled-looking name.
 *   - **Alias.** Two reported tests share one stock id. Then one corrected key
 *     stands for two distinct tests, and the coverage recorded against it
 *     cannot be said to belong to either.
 *
 * The alias check is what requires the full reported inventory rather than only
 * the covered keys: two tests can collide on a stock id while only one of them
 * is covered, and inspecting coverage alone would never see the second.
 *
 * @param {readonly string[]} correctedIds coverage keys written by the setup file
 * @param {readonly { id: string }[]} reportedTests the full dry-run inventory
 * @returns {{ ok: true, correctedByStockId: Map<string, { id: string, name: string }> }
 *   | { ok: false, message: string }}
 */
export function buildIdentityMap(correctedIds, reportedTests) {
  const unmappable = correctedIds
    .filter(id => id.startsWith(UNMAPPABLE_KEY_PREFIX))
    .map(id => id.slice(UNMAPPABLE_KEY_PREFIX.length))
    .sort()

  /** @type {Map<string, Set<string>>} */
  const correctedByStock = new Map()
  for (const correctedId of correctedIds) {
    if (correctedId.startsWith(UNMAPPABLE_KEY_PREFIX)) continue
    const { file, name } = splitTestId(correctedId)
    const stockId = `${file}#${toStockRunnerName(name)}`
    const seen = correctedByStock.get(stockId) ?? new Set()
    seen.add(correctedId)
    correctedByStock.set(stockId, seen)
  }

  const collisions = [...correctedByStock.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([stockId, keys]) => ({ stockId, correctedIds: [...keys].sort() }))
    .sort((left, right) => left.stockId.localeCompare(right.stockId))

  /** @type {Map<string, number>} */
  const reportedCounts = new Map()
  for (const test of reportedTests) {
    reportedCounts.set(test.id, (reportedCounts.get(test.id) ?? 0) + 1)
  }
  const aliases = [...reportedCounts.entries()]
    .filter(([stockId, count]) => count > 1 && correctedByStock.has(stockId))
    .map(([stockId]) => stockId)
    .sort()

  // Every corrected key has to name a test that was actually reported. A key
  // with no reported test is an observation the run cannot place -- the
  // literal-title case reaches here as an orphan when the setup file's refusal
  // is bypassed, and so would any future divergence in how the two sides build
  // an identity.
  const unmatched = [...correctedByStock.keys()]
    .filter(stockId => !reportedCounts.has(stockId))
    .sort()

  if (
    unmappable.length > 0 ||
    collisions.length > 0 ||
    aliases.length > 0 ||
    unmatched.length > 0
  ) {
    return {
      ok: false,
      message: describeIrreconcilableIdentity({
        unmappable,
        collisions,
        aliases,
        unmatched,
      }),
    }
  }

  /** @type {Map<string, { id: string, name: string }>} */
  const correctedByStockId = new Map()
  for (const [stockId, keys] of correctedByStock) {
    const correctedId = [...keys][0]
    correctedByStockId.set(stockId, {
      id: correctedId,
      name: splitTestId(correctedId).name,
    })
  }
  return { ok: true, correctedByStockId }
}

/**
 * The message the run fails with when identity cannot be reconciled.
 *
 * Names the tests involved in each case, because every repair is a rename in
 * the test suite and the operator has to know which titles to change.
 *
 * @param {{
 *   unmappable: readonly string[],
 *   collisions: readonly { stockId: string, correctedIds: string[] }[],
 *   aliases: readonly string[],
 *   unmatched: readonly string[],
 * }} findings
 * @returns {string}
 */
export function describeIrreconcilableIdentity({
  unmappable,
  collisions,
  aliases,
  unmatched,
}) {
  const sections = []

  if (unmappable.length > 0) {
    sections.push(
      `${unmappable.length} test title(s) contain ${JSON.stringify(
        VITEST_FULL_NAME_SEPARATOR
      )}, which is the separator Vitest joins a suite chain with. A title ` +
        `carrying it is indistinguishable from an extra suite level, so the ` +
        `identity cannot be mapped back:\n` +
        unmappable.map(chain => `  ${JSON.stringify(chain)}`).join("\n") +
        `\nRename each test so its own title does not contain the separator.`
    )
  }

  if (collisions.length > 0) {
    sections.push(
      `${collisions.length} stock test id(s) correspond to more than one ` +
        `corrected identity. The runner joins a suite chain with a single ` +
        `space, so distinct chains such as "a b" > "c" and "a" > "b c" ` +
        `collapse onto one id:\n` +
        collisions
          .map(
            ({ stockId, correctedIds }) =>
              `  ${JSON.stringify(stockId)} <- ${correctedIds
                .map(id => JSON.stringify(id))
                .join(", ")}`
          )
          .join("\n") +
        `\nRename one test in each group so the space-joined chains differ.`
    )
  }

  if (aliases.length > 0) {
    sections.push(
      `${aliases.length} stock test id(s) are reported by more than one test, ` +
        `so one corrected identity would stand for several tests:\n` +
        aliases.map(stockId => `  ${JSON.stringify(stockId)}`).join("\n") +
        `\nRename the duplicates so each test has its own id.`
    )
  }

  if (unmatched.length > 0) {
    sections.push(
      `${unmatched.length} coverage key(s) do not correspond to any reported ` +
        `test, so the coverage recorded against them cannot be attributed:\n` +
        unmatched.map(stockId => `  ${JSON.stringify(stockId)}`).join("\n")
    )
  }

  return (
    `Cannot reconcile test identity for stryker-js#6210. Mutation evidence ` +
    `attributed to the wrong test is worse than no mutation evidence, because ` +
    `nothing downstream can tell:\n\n${sections.join("\n\n")}`
  )
}

/**
 * Builds the stock-id to corrected-id lookup a mutant run rewrites killers with.
 *
 * Stryker derives `testFilter` from the coverage the dry run reconciled, so its
 * entries are already the corrected ids -- computing the stock form of each is
 * the whole mapping, and it needs no state carried from the dry run. That
 * matters because mutants run in a pool of child processes and the instance
 * that reconciled the dry run is not the one running the mutant.
 *
 * A stock id that two filter entries compute to is DROPPED rather than
 * resolved: the same losslessness rule the dry run enforces. The dry run would
 * have refused such an inventory outright, so this is a belt-and-braces guard
 * against a filter assembled from somewhere else; dropping leaves the killer
 * under its stock id, which then fails to resolve downstream rather than
 * resolving to the wrong test.
 *
 * @param {readonly string[] | undefined} testFilter corrected ids for this mutant
 * @param {ReadonlyMap<string, { id: string }>} fromDryRun the same-process map
 * @returns {Map<string, string>} corrected id, keyed by stock id
 */
export function correctedByStockIdFrom(testFilter, fromDryRun = new Map()) {
  /** @type {Map<string, string>} */
  const corrected = new Map()
  for (const [stockId, entry] of fromDryRun) corrected.set(stockId, entry.id)

  /** @type {Set<string>} */
  const ambiguous = new Set()
  for (const correctedId of testFilter ?? []) {
    const { file, name } = splitTestId(correctedId)
    const stockId = `${file}#${toStockRunnerName(name)}`
    const existing = corrected.get(stockId)
    if (existing !== undefined && existing !== correctedId) {
      ambiguous.add(stockId)
      continue
    }
    corrected.set(stockId, correctedId)
  }
  for (const stockId of ambiguous) corrected.delete(stockId)

  return corrected
}

/**
 * Tripwire for the day upstream ships its fix. NOT proof that it has not.
 *
 * A wrapper that silently repairs nothing is worse than an absent one, so this
 * looks for the shape upstream's fix would produce: the stock runner reporting
 * a name already joined with Vitest's separator. It is a heuristic, and it is
 * deliberately not treated as an oracle -- the executable premise check lives
 * in `test-identity.test.ts`, which reads the runner's shipped identity builder.
 *
 * A reported name containing `" > "` is NOT on its own that shape. An ordinary
 * `it("a > b")` produces one under the unfixed runner too, and warning on it
 * says the opposite of the truth. What distinguishes the two is the whole
 * inventory: if upstream has switched separators then EVERY multi-level name
 * carries `" > "`, whereas a literal title is one name among many that do not.
 * So the check requires agreement across the reported tests rather than a
 * single sighting -- and those literal titles are refused upstream of here
 * anyway, at the setup file's structured boundary.
 *
 * @param {readonly import('@stryker-mutator/api/test-runner').TestResult[]} tests
 * @param {Record<string, unknown>} perTest coverage keys from the same dry run
 * @returns {string | undefined} a description of the mismatch, or undefined
 */
export function describeUnexpectedAgreement(tests, perTest) {
  const coverageKeys = Object.keys(perTest)
  if (coverageKeys.length === 0 || tests.length === 0) return undefined
  // The setup file only ever writes a corrected key, so a corrected key proves
  // nothing on its own. Only a name the STOCK runner built can say anything,
  // and only if every name it built agrees.
  const multiLevel = tests.filter(test =>
    test.name.includes(STOCK_RUNNER_SEPARATOR)
  )
  const stockAlreadyCorrected =
    multiLevel.length > 0 &&
    multiLevel.every(test => test.name.includes(VITEST_FULL_NAME_SEPARATOR))
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
   * The identity map the dry run validated, retained so `mutantRun` can put a
   * kill under the same identity the baseline was recorded under.
   *
   * Empty until a dry run reconciles. A `mutantRun` reached without one leaves
   * every id alone, which is the stock runner's behaviour.
   *
   * @type {Map<string, { id: string, name: string }>}
   */
  #correctedByStockId = new Map()

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

    const identity = buildIdentityMap(Object.keys(perTest), result.tests)
    if (!identity.ok) {
      this.#log.error(identity.message)
      return {
        status: DryRunStatus.Error,
        errorMessage: identity.message,
      }
    }

    this.#correctedByStockId = identity.correctedByStockId

    let reconciled = 0
    const tests = result.tests.map(test => {
      const corrected = this.#correctedByStockId.get(test.id)
      if (!corrected) return test
      reconciled += 1
      return { ...test, id: corrected.id, name: corrected.name }
    })

    this.#log.debug(
      `stryker-js#6210 wrapper: reconciled ${reconciled} of ${result.tests.length} ` +
        `test identities against ${this.#correctedByStockId.size} coverage keys.`
    )

    return { ...result, tests }
  }

  /**
   * Forwards the mutant run, rewriting only the killer identities.
   *
   * The dry run rewrote the baseline's ids, so a kill coming back under the
   * stock id names a test that is not in the report's inventory: the report
   * helper's `remapTestId` leaves unknown ids alone
   * (core/dist/src/reporters/mutation-test-report-helper.js), and the killer
   * ends up as a raw string next to a test table keyed by number. The kill is
   * real -- an assertion failed -- but the evidence cannot be linked to the
   * test that produced it.
   *
   * The map is rebuilt from `options.testFilter` rather than read off the dry
   * run's, because Stryker runs mutants in a pool of child processes
   * (core/dist/src/test-runner/child-process-test-runner-proxy.js) and the
   * instance that reconciled the dry run is not the instance running this
   * mutant. The filter is the right source anyway: Stryker derives it from the
   * coverage this wrapper reconciled, so its entries are exactly the corrected
   * ids this mutant's killers should be reported under. The dry run's map is
   * consulted first for the same-process case.
   *
   * Status, counts, errors and every other field are forwarded untouched: this
   * normalises identity, it does not reclassify a result. An id with no entry
   * in either map is left as it is -- an unknown identity must not be rewritten
   * into a known-looking one.
   *
   * STATIC mutants are the case this cannot reach. They carry no per-test
   * coverage, so Stryker runs the whole suite with no `testFilter`, and there
   * is nothing to rebuild the mapping from. Their killers stay space-joined and
   * do not resolve against the report's test table -- which the downstream
   * predicate reads as an unattributed kill and holds `inconclusive`. That is
   * the correct answer for them: the suite did fail, but nothing identifies
   * WHICH test owns the mutant, which is exactly what a static mutant's
   * whole-suite run cannot tell you.
   */
  async mutantRun(options) {
    const result = await this.#inner.mutantRun(options)
    if (!Array.isArray(result.killedBy) || result.killedBy.length === 0) {
      return result
    }

    const corrected = correctedByStockIdFrom(
      options.testFilter,
      this.#correctedByStockId
    )
    if (corrected.size === 0) return result

    return {
      ...result,
      killedBy: result.killedBy.map(id => corrected.get(id) ?? id),
    }
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
