// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What the test selection for one attempt amounted to, and whether the engine
// may start on it.
//
// `selected-tests.txt` cannot carry this by itself. An empty file means two
// different things: "no test changed in this revision, so nothing narrows the
// cohort's own suite" and "tests were selected but every one was withheld from
// the baseline". The runners read the first as "run the whole cohort", which is
// right for the first and wrong for the second -- it brings back exactly the
// tests that were withheld because they cannot run in the sandbox or cannot read
// the source they assert on. The distinction is therefore written down beside the
// file, by the step that knows it, and read back by the step that acts on it.

export type SelectionOutcome =
  /** One or more tests are listed; the runner runs exactly those. */
  | "selected"
  /**
   * No test changed in this revision, so there is nothing to narrow the cohort's
   * own suite. Running that whole suite is an explicit choice of the cohort's
   * configuration (`wholeCohortTests`, or the root Vitest project with per-test
   * coverage), recorded here rather than inferred from an empty list.
   */
  | "whole_cohort"
  /**
   * Tests were requested and every one was withheld. Running the cohort anyway
   * would run the withheld tests, so no engine run is attempted.
   */
  | "none_runnable"

const OUTCOMES: readonly SelectionOutcome[] = [
  "selected",
  "whole_cohort",
  "none_runnable",
]

/**
 * @param requested tests the revision (or the attempt bound's inventory) put in
 *   front of the withholding filters
 * @param runnable tests left after every filter
 */
export function classifySelection(
  requested: number,
  runnable: number
): SelectionOutcome {
  if (runnable > 0) {
    return "selected"
  }
  return requested > 0 ? "none_runnable" : "whole_cohort"
}

/** The engine-exit value the receipt records when the engine was not started. */
export const ENGINE_NOT_RUN = "not_run"

export type EnginePlan =
  | { readonly run: true }
  | {
      readonly run: false
      readonly engineExit: typeof ENGINE_NOT_RUN
      readonly reason: string
    }

/**
 * Whether Stryker may start. An outcome this function does not recognise is an
 * error, not a default: the one answer that must never be reached by accident is
 * "run everything".
 */
export function planEngineRun(outcome: string): EnginePlan {
  if (!OUTCOMES.includes(outcome as SelectionOutcome)) {
    throw new Error(
      `unrecognised test-selection outcome ${JSON.stringify(outcome)}; expected one of ` +
        `${OUTCOMES.join(", ")}. The engine is not started on a selection nobody classified.`
    )
  }
  if (outcome === "none_runnable") {
    return {
      run: false,
      engineExit: ENGINE_NOT_RUN,
      reason:
        "every test selected for this revision was withheld from the mutation baseline, so no " +
        "test can inform a mutant and the engine was not started. Running the cohort's whole " +
        "suite instead would run the withheld tests.",
    }
  }
  return { run: true }
}
