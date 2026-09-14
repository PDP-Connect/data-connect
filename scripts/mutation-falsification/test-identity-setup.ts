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
// `t.fullTestName.match(namePattern)`). A space-joined pattern therefore
// matches nothing: every test is set to `mode=skip`, `perTest` coverage comes
// back empty, and Stryker re-runs the whole suite for each mutant. The runner's
// peer range is `vitest >=2.0.0`, so the incompatible pair installs clean.
//
// This file is a Vitest setup file -- a documented extension point -- listed
// under `test.setupFiles` in `vite.mutation-scripts.config.ts`. It is not a
// patch of the runner.
//
// It is registered only there, and only the scripts mutation configuration
// selects that file. The rewrite below is correct only for a run whose reported
// test ids are rewritten to match it, which is what `testRunner: "vitest-6210"`
// does. Registering this file in the shared `vite.config.ts` would rewrite the
// coverage keys of every cohort, including those on the stock `vitest` runner,
// whose reported ids would stay space-joined; Stryker's exact-string
// `testsById.get(testId)` would then fail to join and their coverage would be
// discarded.
//
// Why a setup file is the right seam. The runner prepends its own sandbox setup
// file to each project's `setupFiles` (`project.config.setupFiles = [localSetup,
// ...project.config.setupFiles]` in vitest-test-runner.js `init()`), so ours is
// registered after it, and Vitest runs `beforeEach` hooks in registration
// order. The runner's hook writes the space-joined identity to
// `globalThis.__stryker__.currentTestId`; ours then overwrites it with the same
// identity joined the way Vitest 5 filters on. Coverage is attributed to that
// corrected id, so the `testFilter` Stryker later derives from coverage is a
// pattern Vitest actually matches.
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
 * Rebuilds the runner's test identity with Vitest's separator.
 *
 * Deliberately the same walk the runner performs in its `collectTestName`
 * (dist/src/test-helpers.js): the test's own name, prefixed by each enclosing
 * suite name outward. Only the join differs. The file name is not included --
 * the runner's id carries the file path on the other side of a `#`, and the
 * pattern it builds is unanchored, so a suite-chain substring of Vitest's
 * `fullTestName` is what matches.
 */
function fullNameOf(task: NamedTask): string {
  const parts = [task.name]
  let current = task.suite
  while (current) {
    parts.unshift(current.name)
    current = current.suite
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
  namespace.currentTestId = `${filepath}#${fullNameOf(task)}`
})
