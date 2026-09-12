// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The postcondition of the whole release pipeline: after any run that
// produced or converged on a release, ALL THREE lockstep packages are live at
// that version.
//
// This exists because "the release job exited 0" is not the same claim as
// "the release happened". The v2.2.1 failure is the proof: the run reported a
// created tag and one successful publish, then died, and nothing in the
// pipeline ever asserted the difference. The tag said the release existed;
// the registry disagreed; no step was responsible for noticing.
//
// So this step makes the lockstep invariant — the three packages share a
// version — an ENFORCED postcondition rather than a property the pipeline
// hopes it maintained. A run that leaves the set incomplete fails here, with
// the missing packages named, instead of succeeding quietly and leaving the
// discovery to whoever installs next.
//
// It is deliberately the LAST step of both publishing paths, and deliberately
// re-reads the registry rather than trusting anything the publish steps
// reported about themselves. The maker is not the judge: a publish step
// asserting its own success is exactly the assumption that failed.
//
// PROPAGATION: `npm publish` returning success does not mean every read
// replica can resolve the version yet — this repo has measured ~3 minutes for
// a just-published version to become fetchable. A bare check here would fail
// on a release that is actually fine. So a MISSING answer is retried with a
// bounded wait before it is believed, while an UNKNOWN answer (the registry
// did not answer at all) fails immediately, because waiting cannot turn "I
// could not tell" into an answer.

import {
  LOCKSTEP_PACKAGES,
  registryStateFor,
  RegistryUnknownError,
  type LockstepPackage,
} from "./release-registry-state.js"

// 8 attempts sleep 7 times = 210s of waiting, above the ~180s propagation lag
// measured for this repo's packages. N attempts sleep N-1 times, so a budget
// quoted as "attempts x delay" overstates the wait by one delay; the numbers
// here are chosen against the real elapsed figure, not the nominal product.
const PROPAGATION_ATTEMPTS = 8

// The real delay, and the only value any release run uses. The override exists
// so a test can drive the retry through the actual scripts — as child
// processes, where no sleep function can be injected — without waiting out a
// real propagation budget. A missing, non-numeric, or non-positive value keeps
// the real delay, so a typo cannot silently collapse the budget to nothing.
function propagationDelayMs(): number {
  const override = Number(process.env.PDPP_PROPAGATION_DELAY_MS)
  return Number.isFinite(override) && override > 0 ? override : 30_000
}

const PROPAGATION_DELAY_MS = propagationDelayMs()

export const PROPAGATION_BUDGET_MS = (PROPAGATION_ATTEMPTS - 1) * PROPAGATION_DELAY_MS

function fail(message: string): never {
  process.stderr.write(`[verify-release-complete] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[verify-release-complete] ${message}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Resolves once the package is live, or throws after the propagation budget.
// An UNKNOWN registry answer is rethrown immediately rather than retried.
export async function awaitPublished(
  name: LockstepPackage,
  version: string,
  sleepFn: (ms: number) => Promise<void> = sleep
): Promise<void> {
  for (let attempt = 1; attempt <= PROPAGATION_ATTEMPTS; attempt++) {
    let state: "published" | "missing"
    try {
      state = await registryStateFor(name, version)
    } catch (error) {
      if (error instanceof RegistryUnknownError) throw error
      throw error
    }

    if (state === "published") return

    if (attempt === PROPAGATION_ATTEMPTS) {
      throw new Error(
        `${name}@${version} is still not resolvable after ${attempt} attempts ` +
          `(~${Math.round(PROPAGATION_BUDGET_MS / 1000)}s) — the release is incomplete`
      )
    }

    log(`${name}@${version} not yet resolvable (attempt ${attempt}/${PROPAGATION_ATTEMPTS}), waiting...`)
    await sleepFn(PROPAGATION_DELAY_MS)
  }
}

async function main(): Promise<void> {
  const version = process.argv[2]
  if (!version) {
    fail("Usage: verify-release-complete.ts <version>")
  }

  log(`asserting all ${LOCKSTEP_PACKAGES.length} lockstep packages are live at ${version}`)

  const missing: string[] = []
  for (const name of LOCKSTEP_PACKAGES) {
    try {
      await awaitPublished(name, version)
      log(`  ok  ${name}@${version}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // An unanswerable registry is not the same failure as a missing
      // package, and must not be reported as one.
      if (error instanceof RegistryUnknownError) {
        fail(`could not determine whether ${name}@${version} is live: ${detail}`)
      }
      missing.push(name)
      log(`  MISSING  ${name}@${version}`)
    }
  }

  if (missing.length > 0) {
    fail(
      `lockstep release ${version} is INCOMPLETE — missing: ${missing.join(", ")}. ` +
        `The tag claims a release the registry does not hold. Re-run the release workflow on main: ` +
        `it will converge on this version and publish only what is missing.`
    )
  }

  log(`lockstep release ${version} is complete`)
}

if (process.argv[1] && process.argv[1].endsWith("verify-release-complete.ts")) {
  await main()
}
