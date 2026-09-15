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
 * Registered by the scripts and client Stryker configurations as
 * `testRunner: "vitest-6210"`.
 * `assertStockRunnerStillJoinsWithSpaces` fails once upstream ships its fix,
 * which is the signal to delete this file, the setup file, and their config
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
 * `buildIdentityMap`'s collision check: the wrapper refuses such a run rather
 * than picking one of the chains.
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
 * Detects the identities the setup file's structured boundary would refuse,
 * reading the reported inventory rather than the coverage keys.
 *
 * This is the half of the refusal that does NOT travel through coverage, and it
 * has to exist separately for a mechanical reason: the setup file's refusal is
 * written to `globalThis.__stryker__.currentTestId`, which the sandbox turns
 * into a coverage key, and a test that executes no instrumented code produces
 * no coverage entry at all. Its refusal is then simply absent here. There is no
 * in-memory channel to carry it instead -- Vitest runs the suite in a forked
 * worker (`vitest/dist/workers/forks.js`), so the setup file's `globalThis` is
 * not the host's, and the only worker-to-host channel the stock runner reads is
 * `suite.meta`, which this wrapper never sees: it wraps the whole runner and
 * receives `{ tests, mutantCoverage }` and nothing else. Manufacturing a
 * coverage hit to carry the refusal would be worse -- it would invent a
 * mutant-to-test attribution that never happened.
 *
 * So the refusal is recomputed here from data that is always present. The
 * predicate is the same one the hook applies, and it is exact rather than an
 * approximation: the stock runner joins a suite chain with a single space
 * (`nameParts.join(' ').trim()` in its `collectTestName`), so a `" > "` inside
 * a name it reported cannot have come from the join. It can only have come from
 * a literal `" > "` inside one chain part -- which is precisely what the hook
 * refuses, one step earlier, where the chain is still structured.
 *
 * The hook's refusal is still the better one where both fire: it names the
 * structured chain, so the operator sees which level carries the separator.
 * This one names the reported id. They are reported together and neither is
 * dropped.
 *
 * @param {readonly { id: string, name?: string }[]} reportedTests
 * @returns {string[]} reported ids whose own title carries the separator
 */
export function reportedIdsCarryingSeparator(reportedTests) {
  return reportedTests
    .filter(test => {
      const { name } = splitTestId(test.id)
      return name.includes(VITEST_FULL_NAME_SEPARATOR)
    })
    .map(test => test.id)
    .sort()
}

/**
 * Builds the validated map from stock id to corrected identity, or explains
 * why the run cannot be reconciled.
 *
 * Five separate ways identity can fail, all of which end the run rather than
 * producing a mapping that looks clean:
 *
 *   - **Unmappable.** The setup file refused a title containing `" > "`. It
 *     could not have produced a lossless key, and the flattened lookup would
 *     not have found its reported test anyway.
 *   - **Unmappable, uncovered.** The same refusal for a test that executed no
 *     instrumented code, so the hook's marker never reached coverage. Detected
 *     here from the reported name instead -- see
 *     `reportedIdsCarryingSeparator`.
 *   - **Collision.** Two corrected keys flatten onto one stock id --
 *     `describe("a b") > it("c")` and `describe("a") > it("b c")` both report
 *     as `file#a b c`. The stock id is all the reported test carries, so one of
 *     the two would take the other's coverage under a reconciled-looking name.
 *   - **Alias.** Two reported tests share one stock id. Then one corrected key
 *     stands for two distinct tests, and the coverage recorded against it
 *     cannot be said to belong to either.
 *   - **Duplicate final id.** Two reported tests come out of the rewrite under
 *     one id. This is checked over the WHOLE rewritten inventory, covered or
 *     not, because the rewrite is what creates the duplicate: a covered
 *     `describe("outer") > it("checks value")` is rewritten to
 *     `f#outer > checks value`, which is already the reported id of an
 *     uncovered `it("outer > checks value")`. Neither id is a duplicate before
 *     the rewrite, so nothing that inspects only the inputs can see it.
 *
 * The last three are what require the full reported inventory rather than only
 * the covered keys: an uncovered test contributes no coverage key, and
 * inspecting coverage alone would never see it.
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

  // The refusal that could not travel through coverage. Recomputed from the
  // inventory so an uncovered test carrying the separator is refused on the
  // same terms as a covered one.
  const unmappableReported = reportedIdsCarryingSeparator(reportedTests)

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
  // Every duplicate STOCK id is refused, not only those that happen to carry
  // coverage. Two tests reported under one id are two tests one identity would
  // have to stand for, whether or not either of them reached instrumented code.
  const aliases = [...reportedCounts.entries()]
    .filter(([, count]) => count > 1)
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

  // Uniqueness of the FINAL ids, over the entire inventory. Every reported test
  // is put through the rewrite the dry run is about to perform -- a covered
  // test takes its corrected id, an uncovered one keeps the id it was reported
  // under -- and the results are counted. This is the only check that sees a
  // duplicate produced BY the rewrite rather than present in its inputs.
  //
  // Each group records the STOCK ids that landed on the shared final id, not
  // just the final id itself. Every repair here is a rename, and the stock id
  // is the one the operator can find in the suite -- naming only the collided
  // result would say what went wrong without saying which tests to change.
  /** @type {Map<string, string[]>} */
  const stockIdsByFinalId = new Map()
  for (const test of reportedTests) {
    const keys = correctedByStock.get(test.id)
    const finalId = keys?.size === 1 ? [...keys][0] : test.id
    const group = stockIdsByFinalId.get(finalId) ?? []
    group.push(test.id)
    stockIdsByFinalId.set(finalId, group)
  }
  const duplicateFinalIds = [...stockIdsByFinalId.entries()]
    .filter(([, stockIds]) => stockIds.length > 1)
    .map(([finalId, stockIds]) => ({ finalId, stockIds: [...stockIds].sort() }))
    .sort((left, right) => left.finalId.localeCompare(right.finalId))

  if (
    unmappable.length > 0 ||
    unmappableReported.length > 0 ||
    collisions.length > 0 ||
    aliases.length > 0 ||
    unmatched.length > 0 ||
    duplicateFinalIds.length > 0
  ) {
    return {
      ok: false,
      message: describeIrreconcilableIdentity({
        unmappable,
        unmappableReported,
        collisions,
        aliases,
        unmatched,
        duplicateFinalIds,
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
 *   unmappableReported?: readonly string[],
 *   collisions: readonly { stockId: string, correctedIds: string[] }[],
 *   aliases: readonly string[],
 *   unmatched: readonly string[],
 *   duplicateFinalIds?: readonly string[],
 * }} findings
 * @returns {string}
 */
export function describeIrreconcilableIdentity({
  unmappable,
  unmappableReported = [],
  collisions,
  aliases,
  unmatched,
  duplicateFinalIds = [],
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

  if (unmappableReported.length > 0) {
    sections.push(
      `${unmappableReported.length} reported test id(s) carry ` +
        `${JSON.stringify(VITEST_FULL_NAME_SEPARATOR)} in the name the stock ` +
        `runner built. That runner joins a suite chain with a single space, so ` +
        `the separator can only have come from a test's own title, and the ` +
        `identity cannot be mapped back. These are refused here rather than at ` +
        `the setup file's boundary because a test that executes no instrumented ` +
        `code records no coverage key, so its refusal never reaches the host:\n` +
        unmappableReported.map(id => `  ${JSON.stringify(id)}`).join("\n") +
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

  if (duplicateFinalIds.length > 0) {
    sections.push(
      `${duplicateFinalIds.length} test id(s) would be shared by more than one ` +
        `test after the rewrite. The duplicate is created BY the rewrite -- a ` +
        `covered nested test is corrected onto an id another test was already ` +
        `reported under -- so neither id is a duplicate before it:\n` +
        duplicateFinalIds
          .map(
            ({ finalId, stockIds }) =>
              `  ${JSON.stringify(finalId)} <- ${stockIds
                .map(id => JSON.stringify(id))
                .join(", ")}`
          )
          .join("\n") +
        `\nRename one test in each group so the corrected identities differ.`
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
 * the whole mapping.
 *
 * The filter is the ONLY source. No state is carried from the dry run, and that
 * is a deliberate policy rather than an implementation detail. Stryker hands
 * the dry run's process pool to the mutation executor, so one worker in every
 * run is the one that reconciled the dry run and still holds its map. Reading
 * that map here would make a mutant with no filter resolve on that worker and
 * not on any other, so the same head would report a different result at a
 * different concurrency. Rebuilding from the filter alone gives every worker
 * the same answer for the same mutant.
 *
 * A stock id that two filter entries compute to is DROPPED rather than
 * resolved: the same losslessness rule the dry run enforces. The dry run would
 * have refused such an inventory outright, so this is a belt-and-braces guard
 * against a filter assembled from somewhere else; dropping leaves the killer
 * under its stock id, which then fails to resolve downstream rather than
 * resolving to the wrong test.
 *
 * @param {readonly string[] | undefined} testFilter corrected ids for this mutant
 * @returns {Map<string, string>} corrected id, keyed by stock id
 */
export function correctedByStockIdFrom(testFilter) {
  /** @type {Map<string, string>} */
  const corrected = new Map()

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
      `the scripts and client Stryker and Vitest mutation configurations.`
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

    const identity = buildIdentityMap(Object.keys(perTest), result.tests)
    if (!identity.ok) {
      this.#log.error(identity.message)
      return {
        status: DryRunStatus.Error,
        errorMessage: identity.message,
      }
    }

    // Local to this call on purpose. Nothing about the dry run is retained on
    // the instance: `mutantRun` rebuilds from its own `testFilter`, so a
    // mutant's identities do not depend on whether it happened to land on the
    // worker that ran the dry run.
    const correctedByStockId = identity.correctedByStockId

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
   * The map is rebuilt from `options.testFilter` and from nothing else. Stryker
   * derives the filter from the coverage this wrapper reconciled, so its
   * entries are exactly the corrected ids this mutant's killers should be
   * reported under, and every instance handed the same mutant computes the same
   * map from it. Reading the dry run's map instead would make the answer depend
   * on WHICH worker ran the mutant: Stryker hands the dry run's process pool to
   * the mutation executor (core/dist/src/process/3-dry-run-executor.js), so one
   * worker in every run still holds that map while the others
   * (core/dist/src/test-runner/child-process-test-runner-proxy.js) do not.
   *
   * Status, counts, errors and every other field are forwarded untouched: this
   * normalises identity, it does not reclassify a result. An id with no entry
   * in the map is left as it is -- an unknown identity must not be rewritten
   * into a known-looking one.
   *
   * STATIC mutants are the case this deliberately cannot reach. They carry no
   * per-test coverage, so Stryker runs the whole suite with no `testFilter`,
   * and there is nothing to rebuild the mapping from -- on any worker. Their
   * killers stay space-joined. What a static kill means is decided downstream
   * by the projector, not here: `stryker-adapter.ts` holds every `static: true`
   * kill `inconclusive` under its own basis, so the classification does not
   * depend on this wrapper resolving an id, nor on how the run was scoped.
   */
  async mutantRun(options) {
    const result = await this.#inner.mutantRun(options)
    if (!Array.isArray(result.killedBy) || result.killedBy.length === 0) {
      return result
    }

    const corrected = correctedByStockIdFrom(options.testFilter)
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
