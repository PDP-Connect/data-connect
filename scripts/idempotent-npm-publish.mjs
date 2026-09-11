// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A drop-in replacement for `@semantic-release/npm` that makes the publish
// step IDEMPOTENT: publishing a version that is already live is a success
// that publishes nothing, instead of an E403 that kills the release.
//
// WHY THIS EXISTS
//
// semantic-release pushes the git tag BEFORE it publishes anything. From
// semantic-release@25.0.9's index.js:
//
//     await plugins.prepare(context)
//     // Create the tag before calling the publish plugins as some require the tag to exists
//     await tag(nextRelease.gitTag, nextRelease.gitHead, ...)
//     await push(options.repositoryUrl, ...)
//     logger.success(`Created tag ${nextRelease.gitTag}`)
//     const releases = await plugins.publish(context)
//
// That ordering is not configurable, and it is not the defect. The tag is
// the pipeline's only DURABLE RECORD OF INTENT — the one artifact that
// survives a crashed runner and says which version this release meant to
// produce. Removing it, or deferring it until after all three publishes,
// would delete the very thing that lets a re-run finish the job: with no
// tag, a re-run recomputes a DIFFERENT version, and the packages already
// published at the old version are stranded at a version their siblings
// will never reach.
//
// The defect is that the publish step was not re-runnable. `npm publish` is
// unconditional in @semantic-release/npm's lib/publish.js — it has no
// already-published check — and npm versions are IMMUTABLE, so republishing
// a live version fails with E403. One package live and two missing was
// therefore a terminal state: the ordinary path could not re-run (E403 on
// the first package, never reaching the missing two).
//
// So the fix is not to move the tag. It is to make the thing the tag points
// at CONVERGEABLE. This plugin is half of that; scripts/resolve-release-version.ts
// is the other half (it makes a re-run resolve the incomplete tag's version
// rather than "no relevant changes").
//
// Together they give the property the design is actually after:
//
//     Running the release repeatedly always moves the registry toward
//     the tag's version, and never away from it, regardless of where a
//     previous run stopped.
//
// WHAT THIS PLUGIN DOES AND DOES NOT CHANGE
//
// verifyConditions and prepare are re-exported from @semantic-release/npm
// UNCHANGED. Only publish is wrapped. The wrapper asks the registry whether
// this exact package@version is already live:
//
//   published -> skip. Return the same release descriptor the real plugin
//                would have returned, so semantic-release's release list,
//                GitHub release notes, and success step see a complete
//                release rather than a hole.
//   missing   -> delegate to @semantic-release/npm's real publish.
//   unknown   -> throw. A registry that did not answer must never be read as
//                "not published" (see release-registry-state.ts).
//
// WHY NOT SKIP THE PREPARE STEP TOO: prepare writes the version into the
// package.json that publish reads, and it is what the pin step and the
// packed-consumer checks depend on. It is a pure local-filesystem operation
// in an ephemeral CI checkout, so re-running it is already idempotent. Only
// the registry-mutating step needs guarding.
//
// CRASH SAFETY: every crash point leaves a state this plugin converges from.
//   - killed between publish 1 and 2  -> re-run skips 1, publishes 2 and 3.
//   - killed after all publishes, before the GitHub release -> re-run skips
//     all three and proceeds to the release step.
//   - registry unreachable mid-publish -> UNKNOWN throws; nothing is
//     published on a guess, and a later re-run re-reads a registry that is
//     answering again.
//
// This is an .mjs module (not .ts) on purpose: semantic-release imports
// plugins directly with `import()`, with no TypeScript loader in scope, so a
// plugin entry point has to be natively loadable by Node.

import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const require = createRequire(import.meta.url)
const run = promisify(execFile)

// Imported lazily inside the functions rather than at module scope so that
// loading this plugin never depends on @semantic-release/npm's own module
// init order.
async function realNpmPlugin() {
  return import("@semantic-release/npm")
}

const PROVENANCE_NOTE = "already live on the registry"

// --- registry state -------------------------------------------------------
//
// Deliberately duplicated in plain JS rather than importing the TypeScript
// release-registry-state.ts: this file is loaded by semantic-release's own
// `import()` with no TS loader available. The two are kept in lockstep by
// scripts/release-atomicity.test.ts, which asserts the classification rules
// here behave identically to the TypeScript module's.

export function isRegistryMissingError(detail) {
  return /\bcode\s+E404\b/.test(detail)
}

export function normalizeVersion(resolved) {
  if (typeof resolved === "string") return resolved
  if (Array.isArray(resolved) && resolved.length === 1 && typeof resolved[0] === "string") {
    return resolved[0]
  }
  return null
}

// "published" | "missing", or throws when the registry did not answer.
export async function registryState(packageName, version) {
  const spec = `${packageName}@${version}`

  let stdout
  try {
    ;({ stdout } = await run("npm", ["view", spec, "version", "--json"]))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isRegistryMissingError(detail)) return "missing"
    throw new Error(
      `[idempotent-npm-publish] registry did not answer for ${spec}, so its publish state is ` +
        `UNKNOWN — refusing to treat "I could not tell" as "not published".\n${detail}`
    )
  }

  const trimmed = stdout.trim()
  if (trimmed === "") return "missing"

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(`[idempotent-npm-publish] registry returned unparseable JSON for ${spec}: ${trimmed.slice(0, 200)}`)
  }

  const resolved = normalizeVersion(parsed)
  if (resolved === null) {
    throw new Error(`[idempotent-npm-publish] unexpected resolved-version shape for ${spec}: ${trimmed.slice(0, 200)}`)
  }
  if (resolved !== version) {
    throw new Error(
      `[idempotent-npm-publish] ${spec} resolved version "${resolved}" does not match requested "${version}"`
    )
  }

  return "published"
}

// --- plugin lifecycle -----------------------------------------------------

export async function verifyConditions(pluginConfig, context) {
  const plugin = await realNpmPlugin()
  return plugin.verifyConditions(pluginConfig, context)
}

export async function prepare(pluginConfig, context) {
  const plugin = await realNpmPlugin()
  return plugin.prepare(pluginConfig, context)
}

// Reads the package name from the pkgRoot this plugin entry is configured
// with, so the registry question is asked about the package actually being
// published rather than the workspace root.
function packageNameFor(pluginConfig, context) {
  const pkgRoot = pluginConfig.pkgRoot
  const cwd = context.cwd ?? process.cwd()
  const manifestPath = pkgRoot ? `${cwd}/${pkgRoot}/package.json` : `${cwd}/package.json`
  const pkg = require(manifestPath)
  return { name: pkg.name, private: pkg.private === true, manifestPath }
}

export async function publish(pluginConfig, context) {
  const { logger, nextRelease } = context
  const version = nextRelease.version
  const { name, private: isPrivate } = packageNameFor(pluginConfig, context)

  // A private package or an explicitly disabled publish is the real plugin's
  // decision to make, not this wrapper's. Delegate without asking the registry.
  if (isPrivate || pluginConfig.npmPublish === false) {
    const plugin = await realNpmPlugin()
    return plugin.publish(pluginConfig, context)
  }

  const state = await registryState(name, version)

  if (state === "published") {
    logger.log(
      `${name}@${version} is ${PROVENANCE_NOTE} — skipping publish. ` +
        `npm versions are immutable, so converging on this release means publishing only what is missing.`
    )
    // Exactly the shape @semantic-release/npm's lib/get-release-info.js
    // returns ({ name, url, channel }), so a skipped package is reported as a
    // completed release rather than as a hole in the release list. This repo
    // publishes to the default registry on the default channel, which is what
    // getChannel() maps to the `latest` dist-tag.
    const distTag = context.nextRelease.channel || "latest"
    return {
      name: `npm package (@${distTag} dist-tag)`,
      url: `https://www.npmjs.com/package/${name}/v/${version}`,
      channel: distTag,
    }
  }

  logger.log(`${name}@${version} is not on the registry — publishing.`)
  const plugin = await realNpmPlugin()
  return plugin.publish(pluginConfig, context)
}

export async function addChannel(pluginConfig, context) {
  const plugin = await realNpmPlugin()
  return plugin.addChannel(pluginConfig, context)
}
