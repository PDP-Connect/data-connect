// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One npm-registry propagation policy, shared by every post-publish read in
// this repo.
//
// `npm publish` returning success means the registry ACCEPTED the tarball,
// not that every read replica can resolve it. Reads are eventually
// consistent, and this repo has measured the lag directly: ~3 minutes for
// @pdpp/local-collector@2.1.1 to become fetchable after its publish log said
// "Published". A post-publish read with no retry is therefore a race, not a
// check.
//
// That race is not hypothetical here. It is exactly what broke the v2.2.1
// release: scripts/verify-connector-protocol-published.ts did a single
// `npm view` 157 ms after connector-protocol's publish returned, got E404,
// and aborted the run — after the tag had already been pushed and one of
// three packages published. 2.2.1 is live and resolvable now, which proves
// the publish was fine and the guard was simply reading too early.
//
// verify-npm-provenance.ts already had the right shape. Extracting it here
// and using it in both places is what stops the two from drifting apart
// again.
//
// Budget. RETRY_ATTEMPTS attempts sleep only RETRY_ATTEMPTS-1 times, so the
// elapsed wait is (RETRY_ATTEMPTS - 1) * RETRY_DELAY_MS, NOT
// RETRY_ATTEMPTS * RETRY_DELAY_MS. The inherited 6 x 30 s therefore waited
// 150 s against a lag already measured at ~180 s — it would have retried
// itself into the same failure. 8 attempts gives 210 s, which clears the
// measured figure. npm-propagation-retry.test.ts asserts the elapsed wait
// against that measurement so the off-by-one cannot come back.
//
// Only E404 is retried. A version MISMATCH is not a propagation problem: the
// registry answered, with the wrong version. That is a real ordering fault
// and waiting cannot fix it, so callers must fail on it immediately rather
// than route it through here.

export const PROPAGATION_RETRY_ATTEMPTS = 8
export const PROPAGATION_RETRY_DELAY_MS = 30_000

/** Longest the retry budget will wait before giving up. */
export const PROPAGATION_RETRY_ELAPSED_MS =
  (PROPAGATION_RETRY_ATTEMPTS - 1) * PROPAGATION_RETRY_DELAY_MS

/** Lag measured directly against the real registry for @pdpp/local-collector@2.1.1. */
export const MEASURED_PROPAGATION_LAG_MS = 180_000

/**
 * `npm view <spec> version --json` does NOT always return a bare string. For
 * an exact-version spec that the registry resolves through its range
 * matcher, npm returns a one-element ARRAY: `["2.2.1"]`, not `"2.2.1"`.
 * Verified directly against @pdpp/connector-protocol@2.2.1 on the live
 * registry. A naive `resolved !== version` comparison therefore reports a
 * mismatch between two identical-looking versions — which, on the barrier,
 * would have aborted a publish for no reason, and on a resume would have
 * refused to read registry state at all.
 *
 * Anything other than a string or a single-element array of strings is left
 * alone, so a genuinely ambiguous answer still fails the caller's
 * comparison rather than being flattened into a false match.
 */
export function normalizeViewedVersion(resolved: unknown): unknown {
  if (Array.isArray(resolved) && resolved.length === 1 && typeof resolved[0] === "string") {
    return resolved[0]
  }
  return resolved
}

export function isRegistryMissingError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.includes("E404")
}

export interface PropagationRetryOptions {
  attempts?: number
  delayMs?: number
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Progress reporting; defaults to silence. */
  log?: (message: string) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Runs `attempt` until it resolves, retrying only while the registry says the
 * spec is missing (E404) and the budget holds. Any other error, and the last
 * E404, reject — this never converts a failure into a silent success.
 */
export async function withPropagationRetry<T>(
  spec: string,
  attempt: () => Promise<T>,
  options: PropagationRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? PROPAGATION_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? PROPAGATION_RETRY_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? (() => {})

  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt()
    } catch (error) {
      // A non-404 is not a propagation problem, so it is rethrown UNCHANGED
      // rather than rewrapped: callers classify on the error's type (a
      // version mismatch, say), and wrapping it in a generic Error would
      // erase that distinction and make every failure look like a timeout.
      if (!isRegistryMissingError(error)) throw error
      if (i === attempts) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`giving up resolving ${spec} after ${i} attempt(s): ${detail}`, {
          cause: error,
        })
      }
      log(`${spec} not yet resolvable on the registry (attempt ${i}/${attempts}), retrying...`)
      await sleep(delayMs)
    }
  }
  /* c8 ignore next */
  throw new Error("unreachable")
}
