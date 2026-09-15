// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reconciles the test identity Stryker's Vitest runner records with the one
// Vitest 5 filters on. Upstream defect:
// https://github.com/stryker-mutator/stryker-js/issues/6210
//
// @stryker-mutator/vitest-runner 10.0.0 identifies a test by joining its suite
// chain with a single space. It hands that string to Vitest as
// `testNamePattern`, and Vitest 5 matches the pattern against `fullTestName`,
// which it joins with " > " (`getFullName(task, separator = " > ")` in
// vitest/dist/task-utils.js, applied at `interpretTaskModes` via
// `t.fullTestName.match(namePattern)`). The runner's peer range is
// `vitest >=2.0.0`, so the incompatible pair installs clean.
//
// The mismatch bites in two distinct phases, and they are worth keeping apart:
//
//   - The DRY RUN records coverage against the runner's own space-joined key.
//     Whether `perTest` comes back populated depends on how that phase is run,
//     not on the pattern.
//   - Each MUTANT RUN then hands Stryker's per-test filter to Vitest as a
//     `testNamePattern`. A space-joined pattern matches no `fullTestName`, so
//     every test is set to `mode=skip` and the mutant is reported having run
//     zero tests.
//
// Issue #6210 reports the second: populated dry-run coverage alongside zero
// executed tests for covered mutants. That is not the same as an empty
// `perTest` with a full-suite fallback, which is a different failure of the
// same join. Tests here name the phase they observe.
//
// This file is a Vitest setup file -- a documented extension point -- listed
// under `test.setupFiles` in `vite.mutation-scripts.config.ts` and
// `vite.mutation-client.config.ts`. It is not a patch of the runner.
//
// It is registered only in those mutation configurations. The rewrite below
// is correct only for a run whose reported test ids are rewritten to match it,
// which is what `testRunner: "vitest-6210"`
// does. Registering this file in the shared `vite.config.ts` would rewrite the
// coverage keys of every cohort, including those on the stock `vitest` runner,
// whose reported ids would stay space-joined; Stryker's exact-string
// `testsById.get(testId)` would then fail to join and their coverage would be
// discarded.
//
// Why a setup file is the right seam. The runner prepends its own sandbox setup
// file to each project's `setupFiles` (`project.config.setupFiles = [localSetup,
// ...project.config.setupFiles]` in vitest-test-runner.js `init()`), so ours is
// listed after it, and Vitest runs `beforeEach` hooks in registration order.
// The runner's hook writes the space-joined identity to
// `globalThis.__stryker__.currentTestId`; ours then overwrites it with the same
// identity joined the way Vitest 5 filters on. Coverage is attributed to that
// corrected id, so the `testFilter` Stryker later derives from coverage is a
// pattern Vitest actually matches.
//
// Being listed second is not on its own enough to register second. Vitest's
// default `sequence.setupFiles` is `"parallel"`, which imports the files with
// `Promise.all` -- whichever finishes importing first registers first. If ours
// won that race the runner's hook would run last and restore the space-joined
// id. Both mutation Vitest configurations set `sequence.setupFiles: "list"` to
// make registration follow the listed order; `setup-order.test.ts` drives the
// scheduler's real policy against controlled import completion and shows both
// outcomes.
//
// This runs on every root-suite run, not only under Stryker. Outside a mutation
// run `globalThis.__stryker__` carries no `currentTestId` and nothing is
// written, so the hook is inert.

import { beforeEach } from "vitest"

/**
 * `INSTRUMENTER_CONSTANTS.NAMESPACE` from @stryker-mutator/api. Inlined rather
 * than imported because this file is loaded into the test environment, which
 * should not pull in Stryker's host-side packages.
 */
const STRYKER_NAMESPACE = "__stryker__"

/**
 * The separator Vitest 5 builds `fullTestName` with, and therefore the one a
 * `testNamePattern` has to be written in to match. Asserted against Vitest's
 * own source in `scripts/mutation-falsification/test-identity.test.ts`.
 */
const VITEST_FULL_NAME_SEPARATOR = " > "

/**
 * The part of Vitest's task shape this file walks: a name, and the enclosing
 * suite chain reached by following `suite` outward. Declared recursively
 * because the walk follows that field to the root -- typing it as `unknown`
 * and re-asserting at each step is what the loop below would otherwise need.
 *
 * Only the fields read here are named. Vitest's own task type carries much
 * more, and narrowing to what is used keeps this declaration honest about what
 * the hook depends on.
 */
interface NamedTask {
  name: string
  suite?: NamedTask
  file?: { filepath?: string }
}

/**
 * The prefix a refused identity is written under.
 *
 * A refusal has to survive the trip to the host, and the only channel back is
 * this one string. So the hook writes a key that cannot collide with a real
 * identity and that the wrapper recognises, rather than throwing -- a throw in
 * a `beforeEach` fails that one test and would be read downstream as an
 * ordinary test failure, not as an identity the run cannot trust.
 *
 * This channel reaches the host ONLY for a test that executes instrumented
 * code. `currentTestId` is what the sandbox attributes a coverage entry to, so
 * a test that hits no mutant produces no entry and its refusal is simply not
 * there to be read. There is no in-memory alternative: Vitest runs the suite in
 * a forked worker (`vitest/dist/workers/forks.js`), so this file's `globalThis`
 * is not the host's, and the only worker-to-host channel the stock runner reads
 * is `suite.meta`, which the wrapper never sees -- it wraps the whole runner
 * and receives `{ tests, mutantCoverage }`. Writing a synthetic coverage hit to
 * carry the refusal would invent a mutant-to-test attribution that never
 * happened, which is the thing this machinery exists to prevent.
 *
 * So the uncovered half of the refusal is recomputed on the host, from the
 * reported inventory, by `reportedIdsCarryingSeparator` in
 * `vitest-runner-plugin.mjs`. That check is exact rather than a fallback: the
 * stock runner joins a chain with a single space, so a `" > "` in a name it
 * built can only have come from a title. This hook's refusal remains the better
 * one where both fire, because it names the structured chain and so says which
 * suite level carries the separator.
 *
 * Kept byte-identical to the copy in `vitest-runner-plugin.mjs`, which cannot
 * be imported here: this file is loaded into the test environment and that
 * module pulls in Stryker's host-side packages. `test-identity.test.ts` asserts
 * the two agree.
 */
export const UNMAPPABLE_KEY_PREFIX = " stryker-6210-unmappable:"

/**
 * Collects the suite chain a task hangs from, outermost first.
 *
 * The same walk the runner performs in its `collectTestName`
 * (dist/src/test-helpers.js): the test's own name, prefixed by each enclosing
 * suite name outward. The file name is not included -- the runner's id carries
 * the file path on the other side of a `#`, and the pattern it builds is
 * unanchored, so a suite-chain substring of Vitest's `fullTestName` is what
 * matches.
 */
function chainOf(task: NamedTask): string[] {
  const parts = [task.name]
  let current = task.suite
  while (current) {
    parts.unshift(current.name)
    current = current.suite
  }
  return parts
}

/**
 * Rebuilds the runner's test identity with Vitest's separator, or refuses.
 *
 * This is the last point at which the chain is still structured. One step
 * later it is a single string, and a `" > "` inside a test's own title is
 * indistinguishable from the join -- `it("a > b")` under `describe("outer")`
 * and `describe("outer") > describe("a") > it("b")` produce the same key.
 * Nothing downstream can separate them, so neither can be trusted: the first
 * has no reported test to match (the stock runner reports `outer a > b`, which
 * does not flatten to the looked-for `outer a b`), and where both exist, one
 * key stands for two tests.
 *
 * Refusing here is what makes the mapping lossless. A chain whose parts contain
 * no separator round-trips: join with `" > "`, and the parts are recoverable.
 */
function fullNameOf(task: NamedTask): string | undefined {
  const parts = chainOf(task)
  if (parts.some(part => part.includes(VITEST_FULL_NAME_SEPARATOR))) {
    return undefined
  }
  return parts.join(VITEST_FULL_NAME_SEPARATOR).trim()
}

beforeEach(context => {
  const namespace = (
    globalThis as Record<string, unknown> & {
      [STRYKER_NAMESPACE]?: { currentTestId?: string }
    }
  )[STRYKER_NAMESPACE] as { currentTestId?: string } | undefined

  // Not a mutation run, or the runner's dry-run hook did not fire: nothing to
  // reconcile. Writing an id here would invent coverage attribution.
  if (!namespace || typeof namespace.currentTestId !== "string") return

  const task = context.task as NamedTask

  // Rebuild the whole id rather than editing the recorded one. The recorded id
  // is `filepath#space-joined-name`, and a space is not a separator that can be
  // told apart from a space inside a test's own name.
  const filepath = task.file?.filepath ?? "unknown.js"
  const corrected = fullNameOf(task)

  // A title carrying the separator cannot be mapped losslessly, and this is the
  // last place that is knowable. Record the refusal under a key the wrapper
  // refuses the run on, naming the chain so the operator knows which title to
  // rename. Leaving the stock id in place instead would let an unmappable test
  // pass as an ordinary one.
  namespace.currentTestId =
    corrected === undefined
      ? `${UNMAPPABLE_KEY_PREFIX}${filepath}#${chainOf(task).join(" | ")}`
      : `${filepath}#${corrected}`
})
