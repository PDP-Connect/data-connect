// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Builds the semantic-release config for a FORCED release — the manual path
// for publishing `main` when the packages have shipped changes that no
// commit scope announced.
//
// Why this exists: .releaserc.yaml gates npm releases behind a
// connector-protocol / collector-runtime / local-collector commit scope,
// because this repo also carries a Tauri desktop app whose commits must
// never cut an npm release. That gate is correct and this script does not
// weaken it. But it makes one failure mode silent: when a real packaged
// change lands under an unscoped `fix:` or a `chore:` re-vendor commit, the
// dry run resolves no version, the quality and release jobs skip, and
// nothing publishes — with no failure anywhere to notice. That is not
// hypothetical: the connector fixes in 7bb096b16 and 30f268fba sat on `main`
// unpublished while @pdpp/local-collector on npm stayed at 2.1.1.
//
// What this does NOT do: invent a version number. The operator names a BUMP
// (patch/minor/major); semantic-release still derives the actual version
// from this repo's existing `v${version}` git tags, so a forced release
// lands exactly where an ordinary one would and cannot collide with or
// regress the published line.
//
// IMPORTANT — why the forced config is passed as OPTIONS, not `--extends`:
// semantic-release's config loader (lib/get-config.js) computes
// `{...configFile, ...cliOptions}` and then `{...extendsOptions, ...options}`.
// An extended config therefore loses every key the repository's own
// .releaserc.yaml defines, `plugins` included — so `--extends forced.json`
// from this repo resolves the GATED rules, not the forced one, and a forced
// dispatch publishes nothing. Reproduced against semantic-release 25.0.9:
// `getConfig(ctx, {extends: forced.json})` with cwd at the repo root yields
// the seven gated rules ending in the two `release: false` catch-alls, while
// `getConfig(ctx, {plugins: forced.plugins})` yields `[{release: "patch"}]`.
// cliOptions/API options are the only shape that wins over the file, which
// is why forced-release.ts's buildForcedReleaseOptions hands this straight to
// the programmatic API. scripts/forced-release.test.ts asserts this THROUGH
// the real loader, because a test against this builder's return value cannot
// see the difference — that blind spot is exactly how the `--extends` version
// shipped with a full green suite.
//
// NOT what this fixes, and still live on `main`: the v2.2.0 tag with no npm
// release was NOT the scope gate refusing a release. That run resolved and
// published connector-protocol@2.2.0 correctly, then aborted because
// scripts/verify-connector-protocol-published.ts does a single `npm view`
// with no retry and lost a race with registry propagation (the same lag
// npm-release.yml's own comment records as ~3 minutes for 2.1.1, and which
// scripts/verify-npm-provenance.ts already retries around). That is a
// separate defect on the publish barrier, out of this change's scope; the
// unscoped connector fixes since v2.2.0 are what this mechanism addresses.
//
// IMPORTANT — why the rules are REPLACED rather than prepended:
// .releaserc.yaml's gate ends in two `release: false` catch-alls. Per that
// file's header note (and reproduced directly against the installed
// @semantic-release/commit-analyzer), analyze-commit.js's rule-priority
// comparator ranks `false` ABOVE every real release type. So prepending a
// force rule to the existing list does not force anything: the catch-alls
// outrank it and the commits that need forcing are exactly the ones those
// catch-alls match. Reproduced: prepending `{release: "patch"}` to the real
// rules over the real unscoped commit subjects yields null, and so does
// "minor" — only "major" survives, which would make a naive implementation
// look like it works while silently publishing nothing for the patch case
// this mechanism exists to serve. Replacing releaseRules with a single
// unconditional rule is what actually forces the bump, and it is safe
// because this config is only ever built on the forced path.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"

export const FORCED_RELEASE_TYPES = ["patch", "minor", "major"] as const

export type ForcedReleaseType = (typeof FORCED_RELEASE_TYPES)[number]

export function isForcedReleaseType(value: string): value is ForcedReleaseType {
  return (FORCED_RELEASE_TYPES as readonly string[]).includes(value)
}

type PluginEntry = string | [string, Record<string, unknown>]

interface ReleaseConfig {
  plugins: PluginEntry[]
  [key: string]: unknown
}

export function loadReleaseConfig(cwd: string = process.cwd()): ReleaseConfig {
  return load(readFileSync(resolve(cwd, ".releaserc.yaml"), "utf8")) as ReleaseConfig
}

/**
 * Returns the release config with commit analysis replaced by an
 * unconditional `releaseType` bump. Every other plugin — the release-notes
 * generator, the dependency pin, both publish-ordering barriers, all three
 * @semantic-release/npm publishes, and the GitHub release — is left exactly
 * as .releaserc.yaml defines it, so a forced release publishes the same
 * artifacts, in the same order, through the same OIDC trusted publishing as
 * an ordinary one.
 */
export function buildForcedReleaseConfig(
  releaseType: ForcedReleaseType,
  cwd: string = process.cwd()
): ReleaseConfig {
  const config = loadReleaseConfig(cwd)

  const plugins = config.plugins.map((plugin): PluginEntry => {
    if (!Array.isArray(plugin) || plugin[0] !== "@semantic-release/commit-analyzer") {
      return plugin
    }
    const [name, options] = plugin
    // Replace the scope-gate releaseRules wholesale (see header): the spread
    // carries `preset` and `presetConfig` through, so forced release notes
    // keep the same per-package sectioning as an ordinary release, and the
    // explicit releaseRules below overwrites the gate's.
    return [name, { ...options, releaseRules: [{ release: releaseType }] }]
  })

  return { ...config, plugins }
}
