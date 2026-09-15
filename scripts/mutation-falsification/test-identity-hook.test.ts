// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the setup half of the stryker-js#6210 repair.
//
// `test-identity.test.ts` covers the plugin half -- the identity arithmetic the
// wrapper performs on the ids it reports. The other half is
// `test-identity-setup.ts`, whose `beforeEach` rewrites the coverage key the
// sandbox records. Stryker joins the two by exact string, so a separator that
// disagrees with the plugin's silently unjoins every coverage key: `perTest`
// comes back empty and the cohort reports no-coverage instead of trials. That
// is loud rather than a false pass, but nothing executable rejected it -- with
// the separator changed to a single space the suite stayed green.
//
// The setup file exports nothing; it registers its hook on import. So this
// drives the real hook rather than a copy of its arithmetic, by two routes:
//
//   - Most tests let the hook run the way it normally does -- it is registered
//     by importing the module, ahead of every hook this file registers -- and
//     read the id it wrote for the test that is currently running.
//   - The refusal tests capture the registered callback (see `hookCallback`)
//     and call it with a task built here. That route exists because the refusal
//     is triggered by a test's own TITLE carrying `" > "`, and a title like
//     that cannot stay in this cohort's inventory: the wrapper refuses the
//     whole run over it, correctly. Driving the same callback with a synthetic
//     task keeps the hook itself under test without making the cohort
//     unrunnable.

import { afterAll, describe, expect, it, vi } from "vitest"

import { UNMAPPABLE_KEY_PREFIX } from "./test-identity-setup.ts"

import { VITEST_FULL_NAME_SEPARATOR } from "./vitest-runner-plugin.mjs"

// The registered `beforeEach` callback, captured from the real module.
//
// The setup file exports nothing callable -- it registers its hook on import
// and that is its whole interface. To drive that hook against a task this file
// builds, `vitest`'s `beforeEach` is stubbed for the duration of one fresh
// import, so the callback the module registers is handed here instead of to the
// runner. What is captured is the real function from the real file; only the
// registration is intercepted.
//
// The stub is installed with `vi.doMock`, which is not hoisted, and torn down
// immediately after the import so the rest of this file -- and every other file
// in the run -- registers hooks normally.
let hookCallback: (context: { task: unknown }) => void = () => {
  throw new Error("the setup file's beforeEach callback was never captured")
}

vi.doMock("vitest", async () => {
  const actual = await vi.importActual<typeof import("vitest")>("vitest")
  return {
    ...actual,
    beforeEach: (callback: (context: { task: unknown }) => void) => {
      hookCallback = callback
    },
  }
})
vi.resetModules()
await import("./test-identity-setup.ts")
vi.doUnmock("vitest")
vi.resetModules()

/** `INSTRUMENTER_CONSTANTS.NAMESPACE`, as the setup file inlines it. */
const STRYKER_NAMESPACE = "__stryker__"

interface StrykerNamespace {
  currentTestId?: string
}

function namespace(): StrykerNamespace {
  return (globalThis as Record<string, unknown>)[
    STRYKER_NAMESPACE
  ] as StrykerNamespace
}

// Seeded at module scope, not in a `beforeEach`. The setup file's hook is
// registered at import time, which puts it ahead of every hook this file
// registers -- seeding from a local `beforeEach` would run after the hook had
// already read the namespace and returned.
//
// The namespace object is MODIFIED, not replaced. Under a real mutation run
// Stryker's own setup file has already installed this object and captured its
// reference for mutant activation, hit counting and coverage; assigning a fresh
// `{currentTestId}` over it would leave the runner holding the old one. Only
// the one field this fixture owns is touched, and its prior value is put back
// after the suite.
const runnerNamespace = ((globalThis as Record<string, unknown>)[
  STRYKER_NAMESPACE
] ??= {}) as StrykerNamespace
const priorTestId = runnerNamespace.currentTestId
runnerNamespace.currentTestId = "pending"

afterAll(() => {
  if (priorTestId === undefined) {
    delete runnerNamespace.currentTestId
  } else {
    runnerNamespace.currentTestId = priorTestId
  }
})

describe("test identity setup hook", () => {
  describe("nested suite", () => {
    // The discriminating case. The hook walks `suite` outward and joins with
    // Vitest's separator, so this test's recorded id has to carry the chain
    // `test identity setup hook > nested suite > ...`. Set the setup file's
    // separator to a single space -- the stock runner's, and the value that
    // left this suite green before this file existed -- and this fails.
    it("records the suite chain joined with Vitest's separator", () => {
      const recorded = namespace().currentTestId ?? ""
      const [file, name] = splitOnFirstHash(recorded)

      expect(file).toContain("test-identity-hook.test.ts")
      expect(name).toBe(
        [
          "test identity setup hook",
          "nested suite",
          "records the suite chain joined with Vitest's separator",
        ].join(VITEST_FULL_NAME_SEPARATOR)
      )
    })

    // States the failure mode directly rather than only implying it: the
    // recorded name must not be the space-joined identity the stock runner
    // builds, because that is the string Vitest's `testNamePattern` cannot
    // match.
    it("does not record the stock runner's space-joined identity", () => {
      const [, name] = splitOnFirstHash(namespace().currentTestId ?? "")

      expect(name).toContain(VITEST_FULL_NAME_SEPARATOR)
      expect(name).not.toBe(
        "test identity setup hook nested suite " +
          "does not record the stock runner's space-joined identity"
      )
    })
  })

  // The structured boundary, driven through the REAL hook -- the same callback
  // the mutation cohort registers -- but against a task built here rather than
  // against this test's own title.
  //
  // It used to be a real title: `it("carries > a literal separator")`. That
  // cannot stay. The cohort runs the whole root suite, so the fixture sat in
  // the inventory the wrapper validates, and `reportedIdsCarryingSeparator`
  // refuses exactly such an id -- correctly, since nothing downstream can tell
  // that chain from one suite level deeper. The fixture was in fact the live
  // instance of the defect this round repairs: it executes no instrumented
  // code, so its refusal never reached the host and the run passed regardless.
  // A title that makes the cohort unrunnable is not a control worth keeping in
  // that form.
  //
  // What the control is actually for is the hook's decision, and that is
  // preserved: `hookCallback` is the real registered function, and the task is
  // the shape Vitest hands it. Only the route to the callback is synthetic.
  it("refuses a title that carries the separator", () => {
    const recorded = driveHook({
      name: "carries > a literal separator",
      suite: { name: "test identity setup hook" },
      file: { filepath: "scripts/mutation-falsification/synthetic.test.ts" },
    })

    expect(recorded.startsWith(UNMAPPABLE_KEY_PREFIX)).toBe(true)
    expect(recorded).toContain("carries > a literal separator")
    // The refusal names the chain with a separator that is NOT Vitest's, so the
    // marker can never be mistaken for a corrected identity.
    expect(recorded).toContain("test identity setup hook | carries > a literal separator")
  })

  // The same hook, same route, on an ordinary chain: the marker must not be
  // written. Without this the test above would pass against a hook that refused
  // everything.
  it("does not refuse an ordinary chain driven the same way", () => {
    const recorded = driveHook({
      name: "checks value",
      suite: { name: "outer" },
      file: { filepath: "scripts/mutation-falsification/synthetic.test.ts" },
    })

    expect(recorded).toBe(
      "scripts/mutation-falsification/synthetic.test.ts#outer > checks value"
    )
  })

  // A test one suite deep, asserted against a literal rather than the
  // constant: the two above would both still pass if the plugin's exported
  // separator and the setup file's drifted together, since they read the same
  // value on both sides. This one fails if either moves.
  it("records a top-level test under the file it came from", () => {
    const [file, name] = splitOnFirstHash(namespace().currentTestId ?? "")

    expect(file).toContain("test-identity-hook.test.ts")
    expect(name).toBe(
      "test identity setup hook > records a top-level test under the file it came from"
    )
  })
})

// The hook builds `filepath#name`, and a test name may contain a `#`, so the
// split is on the first one only -- the same rule `splitTestId` applies in the
// plugin.
function splitOnFirstHash(id: string): [string, string] {
  const boundary = id.indexOf("#")
  if (boundary === -1) return [id, ""]
  return [id.slice(0, boundary), id.slice(boundary + 1)]
}

/** The part of Vitest's task shape the hook walks, as the hook declares it. */
interface SyntheticTask {
  name: string
  suite?: SyntheticTask
  file?: { filepath?: string }
}

/**
 * Runs the setup file's real `beforeEach` against a task built here, and
 * returns the id it recorded.
 *
 * The callback is the registered one, captured by importing the setup module
 * with `vitest`'s `beforeEach` stubbed for the duration of that import. So the
 * function under test is the same object the mutation cohort runs -- a copy of
 * its arithmetic would assert nothing about the file that ships.
 *
 * A fresh import is needed because the module registers on import and exports
 * no callback; `vi.resetModules()` makes the second import re-execute rather
 * than return the cached registration.
 *
 * The namespace field is saved and restored around the call: the hook writes to
 * the same `currentTestId` the surrounding suite's assertions read, and leaving
 * a synthetic id there would corrupt whichever test ran next.
 */
function driveHook(task: SyntheticTask): string {
  const before = runnerNamespace.currentTestId
  try {
    runnerNamespace.currentTestId = "pending"
    hookCallback({ task } as never)
    return runnerNamespace.currentTestId ?? ""
  } finally {
    runnerNamespace.currentTestId = before
  }
}
