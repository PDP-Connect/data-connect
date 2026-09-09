// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Decides whether a restored incremental cache may be reused, by input identity.
//
// This is the entry point the mutation workflow calls between restoring a cache
// and running Stryker. The decision is `mayReuseCache`'s and nothing else's: the
// cache key that Actions matched is a coarse mechanism that can only ever be a
// hint, so the inputs recorded alongside a restored cache are compared against
// the inputs just frozen before those cached verdicts are allowed to be used.
//
// When they do not match, the incremental file is REMOVED rather than left for
// Stryker to find. A cache whose provenance cannot be established must not be
// consumed, and refusing it here is what makes that true in the run rather than
// only in the receipt.
//
// There is no age check and no cost check. Neither says anything about whether
// the cached verdicts describe the code now under test.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import {
  type ExecutionInputs,
  type IntentPacket,
  mayReuseCache,
  verifyIntentDigest,
} from "./select-pr-files.ts"

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined) {
    throw new Error(`missing required argument --${name}`)
  }
  return value
}

const intent = JSON.parse(readFileSync(argument("intent"), "utf8")) as IntentPacket
if (!verifyIntentDigest(intent)) {
  // The inputs this decision is made against have to be the frozen ones.
  throw new Error(`intent packet digest does not match its contents: ${intent.intentDigest}`)
}

const cachedInputsPath = argument("cached-inputs")
const incrementalFile = argument("incremental-file")

/**
 * The execution inputs recorded alongside a previously stored cache. Anything
 * unreadable or unparseable is `undefined`, which `mayReuseCache` treats as no
 * record at all -- an unattributable cache is not a matching one.
 */
function recordedInputs(): ExecutionInputs | undefined {
  if (!existsSync(cachedInputsPath)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(cachedInputsPath, "utf8")) as ExecutionInputs
  } catch {
    return undefined
  }
}

const decision = existsSync(incrementalFile)
  ? mayReuseCache(recordedInputs(), intent.executionInputs)
  : { reuse: false, reason: "no_cache_restored" }

if (!decision.reuse && existsSync(incrementalFile)) {
  // Refuse the cache in the run, not just in the receipt.
  rmSync(incrementalFile)
}

// Record the current inputs next to the cache, so the next run has something to
// compare against. This is what makes the decision possible at all: a cache
// carrying no statement of what produced it can never be reused.
writeFileSync(cachedInputsPath, `${JSON.stringify(intent.executionInputs, null, 2)}\n`)

writeFileSync(argument("out"), `${JSON.stringify(decision, null, 2)}\n`)

process.stdout.write(`cache_reuse=${decision.reuse}\ncache_reason=${decision.reason}\n`)
