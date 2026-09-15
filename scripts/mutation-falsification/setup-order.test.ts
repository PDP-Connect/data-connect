// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the ORDER the two halves of the stryker-js#6210 repair register in.
//
// The repair is order-sensitive and was previously only assumed to hold.
// Stryker's sandbox setup file writes the space-joined identity to
// `globalThis.__stryker__.currentTestId`; ours overwrites it with the corrected
// one. Vitest runs `beforeEach` hooks in registration order, and registration
// order is import order -- so ours has to be imported second.
//
// Vitest's default `sequence.setupFiles` is `"parallel"`, and its scheduler
// imports the files with `Promise.all`. Under `Promise.all` the file that
// finishes importing first registers first, whichever is listed first. If ours
// wins that race the runner's hook runs LAST and restores the space-joined id
// -- the exact format the repair exists to eliminate, with no symptom beyond
// coverage silently failing to join.
//
// `vite.mutation-scripts.config.ts` sets `sequence.setupFiles: "list"`, which
// makes the scheduler take its sequential branch. These tests drive the
// scheduler's real policy against deliberately controlled import completion, so
// the bad schedule is observed rather than argued about.

import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)

/** A hook registration, in the order the hooks would run. */
type Registered = string[]

/**
 * Vitest's own scheduling policy, read off its source rather than restated.
 *
 * The test drives this shape with controlled import completion, so the branch
 * under test is the one Vitest really takes. Reading the source keeps the
 * premise honest: if upstream stops using `Promise.all` for `"parallel"`, the
 * assertion below stops holding and says so.
 */
async function runSetupFiles(
  sequence: "parallel" | "list",
  files: readonly { path: string; importFile: () => Promise<void> }[]
): Promise<void> {
  if (sequence === "parallel") {
    await Promise.all(files.map(async (file) => file.importFile()))
  } else {
    for (const file of files) await file.importFile()
  }
}

/**
 * The two setup files, each registering its hook when its import completes.
 *
 * `settleAfter` is what makes the race observable: a file that resolves after a
 * longer delay finishes importing later and therefore registers later,
 * regardless of the order it was listed in.
 */
function setupFiles(
  registered: Registered,
  stockSettlesAfter: number,
  localSettlesAfter: number
) {
  const register = async (name: string, settleAfter: number) => {
    await new Promise((resolve) => setTimeout(resolve, settleAfter))
    registered.push(name)
  }
  return [
    { path: "stryker-setup.js", importFile: () => register("stock", stockSettlesAfter) },
    {
      path: "test-identity-setup.ts",
      importFile: () => register("local", localSettlesAfter),
    },
  ]
}

/**
 * The id left behind after both hooks have run in registration order.
 *
 * The stock hook writes the space-joined identity; ours rewrites it with
 * Vitest's separator. Running them in the wrong order leaves the stock format,
 * which is the failure this file exists to reject.
 */
function finalTestId(registered: Registered): string {
  let currentTestId = ""
  for (const hook of registered) {
    currentTestId =
      hook === "stock"
        ? "f.test.ts#outer checks value"
        : "f.test.ts#outer > checks value"
  }
  return currentTestId
}

describe("setup file registration order", () => {
  // The premise, read off the installed Vitest rather than assumed. If this
  // stops holding, the config setting below is no longer the thing that
  // protects the repair.
  it("schedules parallel setup files with Promise.all", () => {
    // Located by searching the chunk directory rather than by a pinned
    // filename: Vitest content-hashes these chunks, so the name moves between
    // releases while the scheduler does not.
    const chunks = resolve(
      dirname(require.resolve("vitest/package.json")),
      "dist",
      "chunks"
    )
    const scheduler = readdirSync(chunks)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(resolve(chunks, name), "utf8"))
      .find((source) => source.includes("async function runSetupFiles("))

    expect(
      scheduler,
      "Vitest no longer ships a runSetupFiles scheduler in dist/chunks; " +
        "re-check how setup files are ordered before trusting " +
        "sequence.setupFiles: \"list\"."
    ).toBeDefined()
    expect(scheduler).toContain(
      'if (config.sequence.setupFiles === "parallel") await Promise.all('
    )
    expect(scheduler).toContain(
      'else for (const fsPath of files) await runner.importFile(fsPath, "setup")'
    )
  })

  it("registers in completion order when parallel and the stock file finishes first", async () => {
    const registered: Registered = []
    await runSetupFiles("parallel", setupFiles(registered, 0, 10))

    expect(registered).toEqual(["stock", "local"])
    expect(finalTestId(registered)).toBe("f.test.ts#outer > checks value")
  })

  // The bad schedule. Ours finishes importing first, so the stock hook runs
  // last and restores the space-joined identity Vitest's pattern cannot match.
  // Listed order is unchanged -- only completion timing differs.
  it("restores the stock identity when parallel and the local file finishes first", async () => {
    const registered: Registered = []
    await runSetupFiles("parallel", setupFiles(registered, 10, 0))

    expect(registered).toEqual(["local", "stock"])
    expect(finalTestId(registered)).toBe("f.test.ts#outer checks value")
  })

  // `"list"` is immune to that timing: the scheduler awaits each import before
  // starting the next, so registration follows the listed order even when the
  // local file would have finished first.
  it("registers in listed order under list, whatever the completion timing", async () => {
    const registered: Registered = []
    await runSetupFiles("list", setupFiles(registered, 10, 0))

    expect(registered).toEqual(["stock", "local"])
    expect(finalTestId(registered)).toBe("f.test.ts#outer > checks value")
  })

  // The config is what selects the safe branch, so it is asserted rather than
  // left to the three scheduling cases above to imply.
  it("is requested by the scripts cohort configuration", async () => {
    const config = await import("../../vite.mutation-scripts.config.ts")
    const test = (config.default as { test?: Record<string, unknown> }).test

    expect(test?.sequence).toMatchObject({ setupFiles: "list" })
    // `mergeConfig` concatenates, so the root's own setup file is still here
    // and ours is appended. What matters for ordering is that ours is LAST of
    // the configured files -- the runner prepends its own ahead of all of them
    // at `init()`.
    const configured = test?.setupFiles as string[]
    expect(configured.at(-1)).toBe(
      "./scripts/mutation-falsification/test-identity-setup.ts"
    )
  })
})
