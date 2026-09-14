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
// drives the real hook rather than a copy of its arithmetic: importing the
// module registers the same `beforeEach` the mutation cohort loads, and the
// assertions below read the id it actually wrote.

import { afterAll, describe, expect, it } from "vitest"

import { UNMAPPABLE_KEY_PREFIX } from "./test-identity-setup.ts"

import { VITEST_FULL_NAME_SEPARATOR } from "./vitest-runner-plugin.mjs"

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

  // The structured boundary, driven through the real hook with a real title.
  // This test's own name carries the separator, so its chain cannot be
  // recovered from the joined string -- it is indistinguishable from
  // `describe("carries") > it("a literal separator")` one level deeper. The
  // hook must record the refusal marker rather than a key that looks ordinary,
  // because one step later nothing can tell the two apart.
  it("carries > a literal separator", () => {
    const recorded = namespace().currentTestId ?? ""

    expect(recorded.startsWith(UNMAPPABLE_KEY_PREFIX)).toBe(true)
    expect(recorded).toContain("carries > a literal separator")
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
