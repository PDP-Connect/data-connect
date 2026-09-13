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
// This file is a Vitest setup file -- a documented extension point -- listed in
// `vite.config.ts` under `test.setupFiles`. It is not a patch of the runner.
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
 * own source in `scripts/mutation-test-identity.test.ts`.
 */
const VITEST_FULL_NAME_SEPARATOR = " > "

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
function fullNameOf(task: { name: string; suite?: unknown }): string {
  const parts = [task.name]
  let current = (task as { suite?: { name: string; suite?: unknown } }).suite
  while (current) {
    parts.unshift(current.name)
    current = current.suite
  }
  return parts.join(VITEST_FULL_NAME_SEPARATOR).trim()
}

beforeEach((context) => {
  const namespace = (
    globalThis as Record<string, unknown> & {
      [STRYKER_NAMESPACE]?: { currentTestId?: string }
    }
  )[STRYKER_NAMESPACE] as { currentTestId?: string } | undefined

  // Not a mutation run, or the runner's dry-run hook did not fire: nothing to
  // reconcile. Writing an id here would invent coverage attribution.
  if (!namespace || typeof namespace.currentTestId !== "string") return

  const task = context.task as { name: string; suite?: unknown; file?: { filepath?: string } }

  // Rebuild the whole id rather than editing the recorded one. The recorded id
  // is `filepath#space-joined-name`, and a space is not a separator that can be
  // told apart from a space inside a test's own name.
  const filepath = task.file?.filepath ?? "unknown.js"
  namespace.currentTestId = `${filepath}#${fullNameOf(task)}`
})
