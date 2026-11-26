// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Explicit publish-ordering barrier: .releaserc.yaml wires this as a
// publishCmd step (@semantic-release/exec) placed directly before the
// @semantic-release/npm publish entry of a package that depends on other
// lockstep packages, and passes that package's root. It reads the package's
// own `dependencies`, keeps the ones that are lockstep packages
// (scripts/lockstep-packages.ts), and refuses to let its publish proceed
// unless each of them is live at the exact version this release computed.
// Today that guards @pdpp/collector-runtime (on connector-protocol) and
// @pdpp/mcp-server (on cli and read-core).
//
// semantic-release's publish lifecycle awaits each plugin step in
// plugins-array order (pReduce), and npm's own `publish` command doesn't
// return until the registry has accepted the tarball — so this ordering
// already holds implicitly. This script turns it into an explicit, fail-loud
// precondition instead of relying on plugin-array position never being
// disturbed: it re-fetches each dependency from the registry
// semantic-release is actually publishing to (not a hardcoded URL). Without
// this, an install racing between the publishes (or a future reordering bug)
// could resolve the dependent against a version that doesn't exist yet, or
// against a stale one.
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
// a dependency is genuinely not there, not when it is merely not there YET.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { awaitPublished, type PropagationWait } from "./verify-release-complete.js"
import { RegistryUnknownError } from "./release-registry-state.js"
import { isMainModule } from "./is-main-module.js"
import { lockstepPackages } from "./lockstep-packages.js"

const TAG = "[verify-lockstep-dependencies-published]"

function fail(message: string): never {
  process.stderr.write(`${TAG} ${message}\n`)
  process.exit(1)
}

// An unanswerable registry and a genuinely absent package are different
// failures, and the operator reading this log needs to know which one
// stopped the release. Exported so the distinction is testable without
// driving a process exit — and so the mutation gate can reach it, since
// `vitest --related` discovers covering tests through the import graph.
export function barrierFailureMessage(dependent: string, spec: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof RegistryUnknownError) {
    return (
      `could not determine whether ${spec} is live — refusing to publish ${dependent} ` +
      `against a release whose state is UNKNOWN.\n${detail}`
    )
  }
  return (
    `${spec} is not resolvable from the registry — refusing to publish ${dependent} against ` +
    `a release that isn't live yet.\n${detail}`
  )
}

/** The dependent's name and the lockstep packages it depends on, from the working tree. */
export function barrierFor(root: string, cwd: string = process.cwd()): { dependent: string; dependencies: string[] } {
  const pkg = lockstepPackages(cwd).find((candidate) => candidate.root === root)
  if (!pkg) {
    const manifest = JSON.parse(readFileSync(join(cwd, root, "package.json"), "utf8")) as { name?: string }
    throw new Error(`${manifest.name ?? root} is not a lockstep package in .releaserc.yaml`)
  }
  if (pkg.dependsOn.length === 0) {
    throw new Error(`${pkg.name} depends on no lockstep package, so this barrier guards nothing; remove it`)
  }
  return { dependencies: pkg.dependsOn, dependent: pkg.name }
}

export async function main(wait: PropagationWait = {}) {
  const [version, root] = process.argv.slice(2)
  if (!version || !root) {
    fail("Usage: verify-lockstep-dependencies-published.ts <version> <dependent package root>")
  }

  let barrier: { dependent: string; dependencies: string[] }
  try {
    barrier = barrierFor(root)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  for (const name of barrier.dependencies) {
    const spec = `${name}@${version}`
    try {
      await awaitPublished(name, version, wait)
    } catch (error) {
      fail(barrierFailureMessage(barrier.dependent, spec, error))
    }
    process.stdout.write(`${TAG} confirmed ${spec} is live on the registry\n`)
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main()
}
