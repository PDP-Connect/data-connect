// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// .releaserc.yaml runs one semantic-release invocation that computes a single
// nextRelease.version and applies it to BOTH @pdpp/connector-protocol and
// @pdpp/collector-runtime via two separate @semantic-release/npm pkgRoot
// entries — the two packages are lockstep-versioned by that shared version,
// every release. @semantic-release/npm's prepare step only runs
// `npm version <version>` in each pkgRoot; it never rewrites a package's
// `dependencies`. Left alone, collector-runtime's package.json keeps
// whatever exact version string is committed in the repo
// (currently "0.0.1"), so a published collector-runtime install resolves
// connector-protocol from the LAST release, not THIS one — broken whenever
// connector-protocol's new release adds exports collector-runtime imports
// (see PR #36).
//
// This script is wired as a prepareCmd step in .releaserc.yaml, placed
// before the two @semantic-release/npm prepare entries so it runs first in
// the shared `prepare` lifecycle (semantic-release runs each lifecycle's
// plugin steps sequentially in plugins-array order). It rewrites
// collector-runtime's dependency on connector-protocol to the exact version
// this release run computed, in the ephemeral CI checkout only — this
// pipeline has no @semantic-release/git step, so nothing here is committed
// back to the repo; the committed package.json version is a floor for local
// installs, not what npm pack/publish actually ships.

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const DEPENDENCY_NAME = "@pdpp/connector-protocol"
const PKG_PATH = resolve(process.cwd(), "packages/collector-runtime/package.json")

function fail(message: string): never {
  process.stderr.write(`[pin-collector-runtime-protocol-dependency] ${message}\n`)
  process.exit(1)
}

const version = process.argv[2]
if (!version) {
  fail("Usage: pin-collector-runtime-protocol-dependency.ts <version>")
}

const raw = readFileSync(PKG_PATH, "utf8")
const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }

if (!pkg.dependencies?.[DEPENDENCY_NAME]) {
  fail(`${PKG_PATH} has no "${DEPENDENCY_NAME}" dependency to pin`)
}

pkg.dependencies[DEPENDENCY_NAME] = version
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`)

process.stdout.write(
  `[pin-collector-runtime-protocol-dependency] pinned ${DEPENDENCY_NAME} to ${version} in ${PKG_PATH}\n`
)
