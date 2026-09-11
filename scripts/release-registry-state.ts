// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The single place that answers "is this package live at this version on the
// registry?" for the whole release pipeline.
//
// Every part of the atomic-release design depends on this one question being
// answered honestly, so it is answered in exactly one place rather than
// re-derived at each call site:
//
//   - resolve-release-version.ts asks it to decide whether the newest tag
//     names a release that is actually complete, or one that stopped early
//     and must be converged on instead of bumped past.
//   - idempotent-npm-publish.mjs asks it to decide whether to skip a
//     package's `npm publish` (already live at this exact version) or run it.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: "I could not tell" is never
// "not published".
//
// A registry read has three outcomes, not two, and collapsing the third into
// either of the first two is how a release pipeline publishes the wrong
// thing:
//
//   PUBLISHED  the registry answered, and this exact version is live.
//   MISSING    the registry answered, and this version does not exist (E404).
//   UNKNOWN    the registry did not answer (E500, ETIMEDOUT, auth failure,
//              DNS, a proxy returning HTML). We learned nothing.
//
// UNKNOWN must propagate as a thrown error, never as MISSING. If UNKNOWN
// degraded to MISSING, a registry outage would make every package look
// unpublished, and the publish path would try to republish live versions —
// which npm rejects with E403 because a published version is immutable.
// Worse, on the version-resolution path it would make a COMPLETE release
// look partial and pull the pipeline into re-running a release that already
// finished.
//
// npm version-immutability is the constraint the whole design is built
// around: once `@pdpp/connector-protocol@2.2.1` exists, it can never be
// replaced, only skipped. So "already published" has to be a first-class,
// non-error outcome of the publish path rather than a failure to recover
// from. That is what makes re-running a release converge instead of crash.
//
// E404 CLASSIFICATION: npm emits the code as a discrete `npm error code E404`
// line. Matching the bare substring `E404` anywhere in the error text would
// misclassify an E500 whose body happens to quote `E404` as MISSING — the
// exact "I could not tell read as not published" failure this module exists
// to prevent. So the match is anchored on the `code E404` token that npm's
// own error formatter emits, and a non-404 error carrying the substring
// stays UNKNOWN. (Verified against the live registry: a genuine miss emits
// `npm error code E404`, and `npm view <pkg>@<v> version --json` returns a
// JSON *array* like `["2.2.1"]`, not a bare string — hence normalizeVersion
// below.)

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export const LOCKSTEP_PACKAGES = [
  "@pdpp/connector-protocol",
  "@pdpp/collector-runtime",
  "@pdpp/local-collector",
] as const

export type LockstepPackage = (typeof LOCKSTEP_PACKAGES)[number]

export type RegistryState = "published" | "missing"

// `npm view <spec> version --json` answers with a JSON array when the spec
// matched (`["2.2.1"]`), because a spec can in principle match several
// versions. A single-element array is the only shape that means "this exact
// version is live"; a multi-element array means the spec was a range and the
// caller asked the wrong question, so it is not silently flattened to its
// first element.
export function normalizeVersion(resolved: unknown): string | null {
  if (typeof resolved === "string") return resolved
  if (Array.isArray(resolved) && resolved.length === 1 && typeof resolved[0] === "string") {
    return resolved[0]
  }
  return null
}

// Anchored on npm's own `code E404` token rather than a bare `E404`
// substring — see the header note on E404 CLASSIFICATION.
export function isRegistryMissingError(detail: string): boolean {
  return /\bcode\s+E404\b/.test(detail)
}

export class RegistryUnknownError extends Error {
  constructor(spec: string, detail: string) {
    super(
      `registry did not answer for ${spec}, so its publish state is UNKNOWN — refusing to treat ` +
        `"I could not tell" as "not published".\n${detail}`
    )
    this.name = "RegistryUnknownError"
  }
}

// Returns "published" or "missing". Throws RegistryUnknownError for every
// other outcome — the caller must decide what an unanswerable registry means
// for its own step, and no caller may quietly assume "missing".
export async function registryStateFor(
  packageName: string,
  version: string
): Promise<RegistryState> {
  const spec = `${packageName}@${version}`

  let stdout: string
  try {
    // Inherits process.env, including NPM_CONFIG_USERCONFIG/NPM_CONFIG_REGISTRY,
    // so this resolves the same registry `npm publish` will use. No hardcoded URL.
    ;({ stdout } = await run("npm", ["view", spec, "version", "--json"]))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isRegistryMissingError(detail)) return "missing"
    throw new RegistryUnknownError(spec, detail)
  }

  const trimmed = stdout.trim()
  // An empty answer is npm's other way of saying "no such version" on some
  // registry implementations. Treated as MISSING because the registry did
  // answer — it answered with nothing.
  if (trimmed === "") return "missing"

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new RegistryUnknownError(spec, `registry returned unparseable JSON: ${trimmed.slice(0, 200)}`)
  }

  const resolved = normalizeVersion(parsed)
  if (resolved === null) {
    throw new RegistryUnknownError(spec, `unexpected shape for resolved version: ${trimmed.slice(0, 200)}`)
  }
  // The registry answered with a DIFFERENT version than the exact one asked
  // for. That is not propagation lag and waiting cannot fix it; it means the
  // spec resolved as a range. Surfacing it as UNKNOWN keeps it loud.
  if (resolved !== version) {
    throw new RegistryUnknownError(spec, `resolved version "${resolved}" does not match requested "${version}"`)
  }

  return "published"
}

export interface LockstepRegistryState {
  version: string
  published: LockstepPackage[]
  missing: LockstepPackage[]
}

// The registry's view of one lockstep version across all three packages.
// Any UNKNOWN propagates — a partial picture is not a picture.
export async function lockstepRegistryState(version: string): Promise<LockstepRegistryState> {
  const published: LockstepPackage[] = []
  const missing: LockstepPackage[] = []

  for (const name of LOCKSTEP_PACKAGES) {
    const state = await registryStateFor(name, version)
    if (state === "published") published.push(name)
    else missing.push(name)
  }

  return { version, published, missing }
}
