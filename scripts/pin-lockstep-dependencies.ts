// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// .releaserc.yaml runs one semantic-release invocation that computes a single
// nextRelease.version and applies it to every lockstep package through one
// @semantic-release/npm pkgRoot entry each. That plugin's prepare step only
// runs `npm version <version>` in each pkgRoot; it never rewrites a package's
// `dependencies`. Left alone, a dependency between two of these packages
// keeps whatever the workspace manifest commits: collector-runtime's
// `"@pdpp/connector-protocol": "0.0.1"` would resolve the LAST release, not
// THIS one, broken whenever connector-protocol's new release adds exports
// collector-runtime imports (see PR #36); mcp-server's `"@pdpp/cli": "*"`
// would accept any published cli at all.
//
// This script is wired as a prepareCmd step in .releaserc.yaml, placed
// before the @semantic-release/npm prepare entries so it runs first in the
// shared `prepare` lifecycle (semantic-release runs each lifecycle's plugin
// steps sequentially in plugins-array order). It rewrites every dependency
// one lockstep package has on another to the exact version this release run
// computed, in the ephemeral CI checkout only. This pipeline has no
// @semantic-release/git step, so nothing here is committed back; the
// committed manifests serve local workspace installs, not what npm
// pack/publish ships.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMainModule } from "./is-main-module.js"
import { lockstepPackages } from "./lockstep-packages.js"

const TAG = "[pin-lockstep-dependencies]"

export interface PinnedDependency {
  root: string
  dependency: string
  from: string
}

export function pinLockstepDependencies(version: string, cwd: string = process.cwd()): PinnedDependency[] {
  const pinned: PinnedDependency[] = []
  for (const pkg of lockstepPackages(cwd)) {
    if (pkg.dependsOn.length === 0) continue
    const path = join(cwd, pkg.root, "package.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { dependencies: Record<string, string> }
    for (const dependency of pkg.dependsOn) {
      pinned.push({ dependency, from: manifest.dependencies[dependency] as string, root: pkg.root })
      manifest.dependencies[dependency] = version
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return pinned
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const version = process.argv[2]
  if (!version) {
    process.stderr.write(`${TAG} Usage: pin-lockstep-dependencies.ts <version>\n`)
    process.exit(1)
  }
  for (const { root, dependency, from } of pinLockstepDependencies(version)) {
    process.stdout.write(`${TAG} pinned ${dependency} from ${from} to ${version} in ${root}/package.json\n`)
  }
}
