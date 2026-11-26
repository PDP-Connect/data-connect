// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The npm packages this repository publishes in lockstep, read from the one
// place that decides it: the `pkgRoot` of each @semantic-release/npm step in
// .releaserc.yaml, in publish order. Every other list (the registry checks,
// the provenance check, the dependency pin, the publish barriers) derives
// from this one, so adding a package to the release is one config entry.
//
// A release tag is judged by the packages its own commit published, not by
// today's config: `lockstepPackagesAtRef` reads .releaserc.yaml and each
// package.json from the tag, so a version cut before a package joined the
// stream is not reported as missing it.

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { load } from "js-yaml"
import { isMainModule } from "./is-main-module.js"

const run = promisify(execFile)

export interface LockstepPackage {
  name: string
  root: string
  /** Lockstep packages this one names in `dependencies`. */
  dependsOn: string[]
}

interface PackageJson {
  name?: unknown
  dependencies?: Record<string, string>
}

export function publishRootsFromConfig(configText: string): string[] {
  const config = load(configText) as { plugins?: unknown[] }
  const roots: string[] = []
  for (const plugin of config.plugins ?? []) {
    // semantic-release takes a plugin as a bare name or as [name, options]. A
    // bare npm step publishes the repository root, which is not a lockstep
    // package, so both forms must name a pkgRoot.
    const [name, options] = (Array.isArray(plugin) ? plugin : [plugin]) as [unknown, { pkgRoot?: unknown }?]
    if (name !== "@semantic-release/npm") continue
    if (typeof options?.pkgRoot !== "string" || options.pkgRoot === "") {
      throw new Error("every @semantic-release/npm step in .releaserc.yaml must name its pkgRoot")
    }
    roots.push(options.pkgRoot)
  }
  if (roots.length === 0) {
    throw new Error(".releaserc.yaml has no @semantic-release/npm step")
  }
  return roots
}

export function lockstepPackagesFrom(
  configText: string,
  readPackageJson: (root: string) => string
): LockstepPackage[] {
  const manifests = publishRootsFromConfig(configText).map((root) => {
    const pkg = JSON.parse(readPackageJson(root)) as PackageJson
    if (typeof pkg.name !== "string" || pkg.name === "") {
      throw new Error(`${root}/package.json has no name`)
    }
    return { name: pkg.name, root, dependencies: Object.keys(pkg.dependencies ?? {}) }
  })
  const names = new Set(manifests.map((manifest) => manifest.name))
  return manifests.map(({ name, root, dependencies }) => ({
    dependsOn: dependencies.filter((dependency) => names.has(dependency)),
    name,
    root,
  }))
}

/** The lockstep packages as the working tree's config declares them. */
export function lockstepPackages(cwd: string = process.cwd()): LockstepPackage[] {
  return lockstepPackagesFrom(readFileSync(join(cwd, ".releaserc.yaml"), "utf8"), (root) =>
    readFileSync(join(cwd, root, "package.json"), "utf8")
  )
}

/** The lockstep packages as the config at `ref` (a release tag) declared them. */
export async function lockstepPackagesAtRef(cwd: string, ref: string): Promise<LockstepPackage[]> {
  const show = async (path: string) => (await run("git", ["show", `${ref}:${path}`], { cwd })).stdout
  const configText = await show(".releaserc.yaml")
  const manifests = new Map<string, string>()
  for (const root of publishRootsFromConfig(configText)) {
    manifests.set(root, await show(`${root}/package.json`))
  }
  return lockstepPackagesFrom(configText, (root) => manifests.get(root) as string)
}

export function lockstepPackageNames(cwd: string = process.cwd()): string[] {
  return lockstepPackages(cwd).map((pkg) => pkg.name)
}

// `node --import tsx scripts/lockstep-packages.ts` prints the names, one per
// line, for workflow steps that pass them to another program.
if (isMainModule(import.meta.url, process.argv[1])) {
  process.stdout.write(`${lockstepPackageNames().join("\n")}\n`)
}
