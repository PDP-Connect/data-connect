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

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

const PACKAGE_NAME = "@pdpp/connector-protocol"

function fail(message: string): never {
  process.stderr.write(`[verify-connector-protocol-published] ${message}\n`)
  process.exit(1)
}

async function main() {
  const version = process.argv[2]
  if (!version) {
    fail("Usage: verify-connector-protocol-published.ts <version>")
  }

  const spec = `${PACKAGE_NAME}@${version}`

  let stdout: string
  try {
    // Inherits process.env, including NPM_CONFIG_USERCONFIG/NPM_CONFIG_REGISTRY
    // if set — same registry resolution npm itself uses for the sibling
    // `npm publish`/`npm view` calls in this pipeline. No hardcoded URL.
    ;({ stdout } = await run("npm", ["view", spec, "version", "--json"]))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(
      `${spec} is not resolvable from the registry — refusing to publish collector-runtime against ` +
        `a connector-protocol release that isn't live yet.\n${detail}`
    )
  }

  const resolved = JSON.parse(stdout.trim()) as unknown
  if (resolved !== version) {
    fail(`${spec} resolved version "${String(resolved)}" does not match expected "${version}"`)
  }

  process.stdout.write(`[verify-connector-protocol-published] confirmed ${spec} is live on the registry\n`)
}

await main()
