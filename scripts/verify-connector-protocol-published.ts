// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Explicit publish-ordering barrier: .releaserc.yaml wires this as a
// publishCmd step (@semantic-release/exec) placed BETWEEN the two
// @semantic-release/npm publish entries, so it runs after
// connector-protocol's `npm publish` step has returned and before
// collector-runtime's `npm publish` step starts. semantic-release's publish
// lifecycle awaits each plugin step in plugins-array order (pReduce), and
// npm's own `publish` command doesn't return until the registry has
// accepted the tarball — so this ordering already holds implicitly. This
// script turns it into an explicit, fail-loud precondition instead of
// relying on plugin-array position never being disturbed: it re-fetches
// connector-protocol from the registry semantic-release is actually
// publishing to (not a hardcoded URL) and refuses to let
// collector-runtime's publish proceed unless the exact version this
// release computed is live and fetchable. Without this, an install racing
// between the two publishes (or a future reordering bug) could resolve
// collector-runtime against a connector-protocol version that doesn't
// exist yet, or against a stale one, on the registry.
//
// PROPAGATION. This barrier originally did a SINGLE `npm view` with no
// retry, and that is what broke the v2.2.1 release: it read the registry
// 157 ms after connector-protocol's publish returned, against a lag this
// repo had already measured at ~3 minutes. It got E404 and aborted a run
// that had already pushed the tag and published one of three packages.
// 2.2.1 is live and resolvable today, which proves the publish was fine and
// this guard was simply reading too early. Registry reads are eventually
// consistent, so the check has to be a bounded retry, not a single look.
// The policy lives in scripts/npm-propagation-retry.ts and is shared with
// verify-npm-provenance.ts so the two cannot drift apart again.
//
// A version MISMATCH still fails immediately and is NOT retried: the
// registry answered, with the wrong version. That is a real ordering fault,
// and waiting cannot turn it into a right one.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isMainModule } from "./is-main-module.js"
import { normalizeViewedVersion, withPropagationRetry } from "./npm-propagation-retry.ts"

const run = promisify(execFile)

const PACKAGE_NAME = "@pdpp/connector-protocol"

function fail(message: string): never {
  process.stderr.write(`[verify-connector-protocol-published] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[verify-connector-protocol-published] ${message}\n`)
}

// Inherits process.env, including NPM_CONFIG_USERCONFIG/NPM_CONFIG_REGISTRY
// if set — same registry resolution npm itself uses for the sibling
// `npm publish`/`npm view` calls in this pipeline. No hardcoded URL.
async function npmViewVersion(spec: string): Promise<unknown> {
  const { stdout } = await run("npm", ["view", spec, "version", "--json"])
  return JSON.parse(stdout.trim())
}

export class VersionMismatchError extends Error {}

export interface AssertPublishedOptions {
  viewVersion?: (spec: string) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/**
 * Resolves once `version` of connector-protocol is live on the registry.
 * Rejects if the retry budget expires while it is still missing, or
 * immediately with a VersionMismatchError if the registry answers with a
 * different version.
 */
export async function assertConnectorProtocolPublished(
  version: string,
  options: AssertPublishedOptions = {}
): Promise<void> {
  const spec = `${PACKAGE_NAME}@${version}`
  const viewVersion = options.viewVersion ?? npmViewVersion
  const onLog = options.log ?? log

  const resolved = await withPropagationRetry(
    spec,
    async () => {
      // npm returns ["2.2.1"], not "2.2.1", for an exact-version spec it
      // resolves through its range matcher — see normalizeViewedVersion.
      // Without this, the barrier reports a mismatch between two identical
      // versions and aborts a publish that was fine.
      const value = normalizeViewedVersion(await viewVersion(spec))
      if (value !== version) {
        // Thrown past the retry, not into it: withPropagationRetry only
        // retries E404, and this message carries no E404 marker.
        throw new VersionMismatchError(
          `${spec} resolved version "${String(value)}" does not match expected "${version}"`
        )
      }
      return value
    },
    { sleep: options.sleep, log: onLog }
  )

  onLog(`confirmed ${PACKAGE_NAME}@${String(resolved)} is live on the registry`)
}

async function main() {
  const version = process.argv[2]
  if (!version) {
    fail("Usage: verify-connector-protocol-published.ts <version>")
  }

  try {
    await assertConnectorProtocolPublished(version)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(
      `${PACKAGE_NAME}@${version} is not resolvable from the registry — refusing to publish ` +
        `collector-runtime against a connector-protocol release that isn't live yet.\n${detail}`
    )
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main()
}
