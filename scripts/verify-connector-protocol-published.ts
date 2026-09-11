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
// THIS IS THE STEP THAT FAILED v2.2.1.
//
// `npm publish` returning success does not mean every read replica can
// resolve the version yet — this repo has measured ~3 minutes of propagation
// lag. A prior revision of this script was a single un-retried `npm view`, so
// it asked once, immediately after the publish it was gating, and a lag it
// had no budget for read as "not published". It aborted the run between
// connector-protocol's publish and collector-runtime's, which is precisely
// how the registry ended up holding one third of v2.2.1 under a tag claiming
// all of it.
//
// So the read is routed through the same two primitives the rest of the
// pipeline uses rather than hand-rolling a third registry client here:
//
//   - registryStateFor (via awaitPublished) classifies the answer into
//     PUBLISHED / MISSING / UNKNOWN and parses npm's actual `--json` output
//     shape. The old inline `JSON.parse(...) !== version` comparison could
//     not: `npm view <spec> version --json` answers with an ARRAY (["2.2.1"])
//     on npm 11+, so that comparison fails a live version outright. That bug
//     was latent only because the runner still ships npm 10, which answers
//     with a bare string.
//
//   - awaitPublished retries a MISSING answer across the propagation budget
//     before believing it, and rethrows UNKNOWN immediately — waiting cannot
//     turn "I could not tell" into an answer, and a registry outage must not
//     be able to stall a release for three minutes and then mislabel it.
//
// The barrier still fails closed. What changed is that it now fails only when
// connector-protocol is genuinely not there, not when it is merely not there
// YET.

import { awaitPublished } from "./verify-release-complete.js"
import { RegistryUnknownError } from "./release-registry-state.js"

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

  try {
    await awaitPublished(PACKAGE_NAME, version)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // An unanswerable registry and a genuinely absent package are different
    // failures, and the operator reading this log needs to know which one
    // stopped the release.
    if (error instanceof RegistryUnknownError) {
      fail(
        `could not determine whether ${spec} is live — refusing to publish collector-runtime ` +
          `against a connector-protocol release whose state is UNKNOWN.\n${detail}`
      )
    }
    fail(
      `${spec} is not resolvable from the registry — refusing to publish collector-runtime against ` +
        `a connector-protocol release that isn't live yet.\n${detail}`
    )
  }

  process.stdout.write(`[verify-connector-protocol-published] confirmed ${spec} is live on the registry\n`)
}

await main()
