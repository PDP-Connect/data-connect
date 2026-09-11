#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Entry point for a forced npm release: publishes `main` at a named bump
// when the packages have shipped changes no commit scope announced.
// See scripts/forced-release-config.ts for why this mechanism exists, why it
// replaces (rather than prepends to) the commit-analyzer rules, and why the
// result is handed to semantic-release's programmatic API rather than
// `--extends` (an extended config loses to the repository's .releaserc.yaml,
// so `--extends` forced nothing at all).
//
// Refusals here are deliberate and are the reason this is a script rather
// than an inline `run:` block in the workflow: they hold no matter who
// invokes it or from where, and they are unit-testable without dispatching
// a real workflow run.

import { writeFileSync } from "node:fs"
import semanticRelease from "semantic-release"
import {
  buildForcedReleaseConfig,
  FORCED_RELEASE_TYPES,
  isForcedReleaseType,
  type ForcedReleaseType,
} from "./forced-release-config.ts"

const RELEASE_REF = "refs/heads/main"

export interface ForcedReleaseRequest {
  releaseType: string
  reason: string
  ref?: string
  actor?: string
  dryRun?: boolean
}

export interface ForcedReleasePlan {
  releaseType: ForcedReleaseType
  reason: string
  actor: string
  dryRun: boolean
}

export class ForcedReleaseRefusal extends Error {}

/**
 * Validates a forced-release request. Throws ForcedReleaseRefusal rather
 * than returning a result, so a bad request can never fall through to a
 * publish.
 */
export function planForcedRelease(request: ForcedReleaseRequest): ForcedReleasePlan {
  const { releaseType, ref, actor, dryRun = false } = request

  // Publishing is only ever legitimate from `main`. The workflow's own
  // `if: github.ref == 'refs/heads/main'` guard says the same thing, but a
  // dispatch can be aimed at any ref, so the refusal is enforced here too
  // rather than living only in a job condition someone could edit around.
  //
  // An ABSENT ref is refused as hard as a wrong one. Anything on a runner
  // sets GITHUB_REF, so the only caller that reaches here without it is a
  // developer shell — exactly the invocation that must not be able to reach
  // a publish just because there was no ref to compare. Refusing on
  // `undefined` is what makes "these hold no matter who invokes it or from
  // where" true rather than aspirational; previously an unset GITHUB_REF
  // sailed past this check and was stopped only by semantic-release's own
  // branch guard, one layer deeper than intended.
  if (ref !== RELEASE_REF) {
    throw new ForcedReleaseRefusal(
      ref === undefined
        ? `Refusing to force a release with no ref: set GITHUB_REF to ${RELEASE_REF}. Forced releases run only from ${RELEASE_REF} on CI.`
        : `Refusing to force a release from ${ref}: forced releases are only allowed from ${RELEASE_REF}.`
    )
  }

  if (!isForcedReleaseType(releaseType)) {
    throw new ForcedReleaseRefusal(
      `Invalid release_type ${JSON.stringify(releaseType)}: expected one of ${FORCED_RELEASE_TYPES.join(", ")}.`
    )
  }

  // Auditability: a forced release bypasses the commit-scope gate, so the
  // record of WHY cannot be left implicit in a dispatch someone has to go
  // digging for. An empty or whitespace-only reason is refused outright.
  const reason = request.reason?.trim() ?? ""
  if (reason.length === 0) {
    throw new ForcedReleaseRefusal(
      "Refusing to force a release without a reason: pass the reason input explaining why commit analysis found nothing to publish."
    )
  }

  return { releaseType, reason, actor: actor?.trim() || "unknown", dryRun }
}

/** Human-readable audit record, written to the job log and step summary. */
export function formatAuditRecord(plan: ForcedReleasePlan): string {
  return [
    "Forced npm release",
    `  bump:   ${plan.releaseType}`,
    `  actor:  ${plan.actor}`,
    `  reason: ${plan.reason}`,
    "  note:   commit analysis found no release; the scope gate in .releaserc.yaml was bypassed for this run only.",
  ].join("\n")
}

/**
 * Options for semantic-release's programmatic API. These are API options, so
 * the config loader merges them OVER .releaserc.yaml — which is the whole
 * point: handing the same object to `--extends` puts it UNDER the repository
 * file and the gated rules win. See forced-release-config.ts's header.
 */
export function buildForcedReleaseOptions(
  plan: ForcedReleasePlan,
  cwd: string = process.cwd()
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...buildForcedReleaseConfig(plan.releaseType, cwd) }
  if (plan.dryRun) {
    options.dryRun = true
    options.ci = false
  }
  return options
}

async function runForcedRelease(plan: ForcedReleasePlan): Promise<number> {
  const audit = formatAuditRecord(plan)
  console.log(audit)

  // Also record the audit trail on the run's summary page, where a reviewer
  // looking at "why did this version exist?" will actually land.
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Forced npm release\n\n\`\`\`\n${audit}\n\`\`\`\n`, {
      flag: "a",
    })
  }

  // Programmatic API rather than `npx semantic-release --extends`: only API
  // options override .releaserc.yaml. Its logs still go to this process's
  // stdout/stderr, so the workflow's `tee` + semantic-release-github-output.ts
  // dry-run parser reads the same "next release version is" line it always did.
  const result = await semanticRelease(buildForcedReleaseOptions(plan), {
    cwd: process.cwd(),
    env: process.env,
  })

  // A forced run that resolves nothing is the silent no-op this whole
  // mechanism exists to end, so it fails loudly instead of reporting success
  // with an audit record that claims a bypass which did not happen. This is
  // also the last line of defence if the forced rules ever stop taking
  // effect the way they did under `--extends`.
  if (!result) {
    console.error(
      `::error::Forced ${plan.releaseType} release resolved no version. The forced release rules did not take effect; nothing was published.`
    )
    return 1
  }

  return 0
}

async function main(): Promise<void> {
  const [releaseType = "", ...reasonParts] = process.argv.slice(2)
  let plan: ForcedReleasePlan
  try {
    plan = planForcedRelease({
      releaseType,
      reason: reasonParts.join(" "),
      ref: process.env.GITHUB_REF,
      actor: process.env.GITHUB_ACTOR,
      dryRun: process.env.FORCED_RELEASE_DRY_RUN === "true",
    })
  } catch (error) {
    if (error instanceof ForcedReleaseRefusal) {
      console.error(`::error::${error.message}`)
      process.exit(1)
    }
    throw error
  }
  process.exit(await runForcedRelease(plan))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
