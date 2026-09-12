// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Rehearses the converge job's integration: the CURRENT release driver, run
// from OUTSIDE this checkout, against a REAL old tag, in no-publish mode.
//
// WHY A REHEARSAL AND NOT ANOTHER UNIT TEST
//
// The converge path's failure mode is not inside any one file. Every piece was
// individually correct at 752a30e63 — the driver ran, the tag checkout was the
// right tree, the YAML test's assertions all passed — and the job was still
// unrunnable, because `scripts/converge-release.ts` does not exist in the tree
// the job checked out to run it from (`scripts/` at 07173d030 has no such
// file). A defect that lives in the JOIN between two correct parts is only
// visible if something actually performs the join.
//
// So this drives the real entrypoint as a subprocess, the same way the
// workflow does, with the two roots pointing at two different real trees:
//
//   tooling   a checkout of the CURRENT revision — supplies the driver, tsx,
//             and node_modules/.bin/npm.
//   tagged    a checkout of the OLD TAG — supplies packages/*, and is the only
//             tree anything gets published from.
//
// WHAT PASSING MEANS
//
// The driver loaded all its dependencies, read the live registry, selected the
// packages that are genuinely missing at that version, resolved each one to a
// path INSIDE the tagged checkout, and stopped before any write.
//
// WHAT WOULD MAKE IT MEANINGLESS
//
// A rehearsal that cannot fail proves nothing, so this also runs the broken
// arrangement on purpose: the same command, from the tagged checkout, the way
// the job did before the split. That MUST fail to resolve the driver. If it
// ever succeeds, the tagged tree has acquired a driver from somewhere and this
// rehearsal has stopped discriminating — which is itself the finding.
//
// NO-PUBLISH IS ENFORCED IN THREE PLACES, not asserted in one: the driver runs
// with CONVERGE_RELEASE_DRY_RUN=true, this script refuses to run if an npm
// auth token is present in the environment, and the assertions below require
// the dry-run marker on every selected package and reject any line claiming a
// completed publish.

import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// The tag whose release stopped partway — the one this PR exists to converge.
// Pinned to the exact commit as well as the name so a moved tag is a loud
// failure rather than a silently different rehearsal.
const TAG = process.env.REHEARSAL_TAG ?? "v2.2.1"
const TAG_COMMIT = process.env.REHEARSAL_TAG_COMMIT ?? "07173d030ee6be0270aed0120f90f317b5ce5e94"

function log(message) {
  process.stdout.write(`[rehearsal] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[rehearsal] FAIL: ${message}\n`)
  process.exit(1)
}

// A rehearsal must not be able to publish even if something below is wrong.
// Refusing on a token present is cheaper than trusting the dry-run flag alone.
function refuseIfCredentialed() {
  for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG__AUTH", "NPM_CONFIG_TOKEN"]) {
    if (process.env[name]) {
      fail(`${name} is set — refusing to run a publish rehearsal in a credentialed environment`)
    }
  }
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

// Both checkouts are made OUTSIDE the repository, from the repository, so the
// rehearsal cannot accidentally read this working tree's files through a
// relative path. --shared keeps it cheap; these are read-mostly clones.
function checkoutAt(parent, name, ref) {
  const path = join(parent, name)
  execFileSync("git", ["clone", "--quiet", "--no-checkout", "--shared", REPO_ROOT, path])
  execFileSync("git", ["checkout", "--quiet", "--detach", ref], { cwd: path })
  return path
}

// node_modules is linked rather than installed: `npm ci` twice would dominate
// the runtime, and what the rehearsal is testing is which ROOT each resolution
// comes from, not whether npm can install. The link makes the tooling root's
// dependencies real to the subprocess, which is the property under test.
function linkDependencies(path) {
  const source = join(REPO_ROOT, "node_modules")
  if (!existsSync(source)) {
    fail(`${source} does not exist — run \`npm ci\` before rehearsing`)
  }
  symlinkSync(source, join(path, "node_modules"))
}

async function main() {
  refuseIfCredentialed()

  const resolvedTagCommit = git(["rev-parse", `${TAG}^{commit}`])
  if (resolvedTagCommit !== TAG_COMMIT) {
    fail(
      `${TAG} resolves to ${resolvedTagCommit}, not the expected ${TAG_COMMIT}. The release tag moved; ` +
        `a rehearsal against a different tree proves nothing about the one that was reviewed.`
    )
  }

  const workdir = mkdtempSync(join(tmpdir(), "converge-rehearsal-"))
  try {
    const tagged = checkoutAt(workdir, "tagged-package-source", TAG)
    const tooling = checkoutAt(workdir, "release-tooling", git(["rev-parse", "HEAD"]))

    // The driver under rehearsal is the WORKING TREE's, not the committed
    // one, so this fails on an uncommitted regression instead of quietly
    // rehearsing the last commit.
    for (const file of ["scripts/converge-release.ts", "scripts/release-registry-state.ts"]) {
      execFileSync("cp", [join(REPO_ROOT, file), join(tooling, file)])
    }

    linkDependencies(tooling)
    linkDependencies(tagged)

    // THE PREMISE. Everything below is only interesting because this holds:
    // the tagged tree has package sources and no driver to publish them with.
    const driverInTag = join(tagged, "scripts/converge-release.ts")
    if (existsSync(driverInTag)) {
      fail(
        `${TAG} unexpectedly contains scripts/converge-release.ts. This rehearsal's discriminating ` +
          `case depends on it being absent, so it can no longer tell a working split from a broken one.`
      )
    }
    log(`premise holds: ${TAG} (${TAG_COMMIT}) has packages/* and no converge-release.ts`)

    const env = {
      ...process.env,
      GITHUB_REF: "refs/heads/main",
      CONVERGE_RELEASE_TAG: TAG,
      CONVERGE_RELEASE_DRY_RUN: "true",
      CONVERGE_PACKAGE_SOURCE: tagged,
    }

    // ---- THE REHEARSAL ----------------------------------------------------
    log(`running the real driver from ${tooling}`)
    let stdout
    try {
      ;({ stdout } = await run("node", ["--import", "tsx", "scripts/converge-release.ts"], {
        cwd: tooling,
        env,
        maxBuffer: 32 * 1024 * 1024,
      }))
    } catch (error) {
      fail(`the driver did not complete from the tooling checkout:\n${error.stdout ?? ""}${error.stderr ?? error}`)
    }
    process.stdout.write(stdout)

    // It reached the point of deciding what to publish. A run that refused on
    // a bad root, or that found nothing missing, has not exercised the join.
    if (!/to publish:/.test(stdout)) {
      fail("the driver never reached a publish decision, so nothing was rehearsed")
    }

    // Every package it selected must resolve INSIDE the tagged checkout. This
    // is the assertion the old YAML test could not make: not "the checkout ref
    // is the tag", but "the thing about to be published came from the tag".
    const selected = [...stdout.matchAll(/\[dry-run\] would publish (\S+)@(\S+) from (\S+)/g)]
    if (selected.length === 0) {
      fail("no package was selected for publication — the rehearsal exercised no package root")
    }
    for (const [, name, version, root] of selected) {
      if (!root.startsWith(tagged + "/")) {
        fail(`${name}@${version} would be published from ${root}, which is outside the tagged checkout`)
      }
      if (!existsSync(join(root, "package.json"))) {
        fail(`${name}@${version} resolved to ${root}, which has no package.json`)
      }
      log(`selected ${name}@${version} from the tagged tree`)
    }

    // No-publish, checked against the output rather than assumed from the flag.
    if (/^\[converge-release\] published /m.test(stdout)) {
      fail("the rehearsal reported a completed publish — it was supposed to stop before any write")
    }

    // ---- THE DISCRIMINATING CASE ------------------------------------------
    // The same command the job ran BEFORE the split: driver invoked from the
    // tagged checkout. Dependencies are resolvable there (linked above), so a
    // failure here isolates to the missing driver and nothing else.
    log("discrimination: running the same command from the tree that lacks the driver")
    let brokenFailed = false
    let brokenDetail = ""
    try {
      await run("node", ["--import", "tsx", "scripts/converge-release.ts"], {
        cwd: tagged,
        env,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (error) {
      brokenFailed = true
      brokenDetail = String(error.stderr ?? error)
    }
    if (!brokenFailed) {
      fail(
        "the driver RAN from a tree that does not contain it. The rehearsal cannot distinguish a " +
          "working configuration from the broken one, so its pass above means nothing."
      )
    }
    if (!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(brokenDetail)) {
      fail(`the broken arrangement failed for an unrelated reason, not the missing driver:\n${brokenDetail}`)
    }
    log("discrimination holds: ERR_MODULE_NOT_FOUND on scripts/converge-release.ts")

    // ---- THE SECOND DISCRIMINATING CASE -----------------------------------
    // The first case only proves the driver must live somewhere other than the
    // tag. It does NOT prove the driver publishes from the tag, because the
    // rehearsal above passes CONVERGE_PACKAGE_SOURCE explicitly — so a driver
    // that quietly fell back to its own cwd would produce identical output and
    // pass. (Confirmed by sabotage: replacing the refusal with a cwd default
    // left every assertion above green.)
    //
    // The tooling checkout has a complete packages/* of its own, at current
    // main. That is the tree a fallback would publish under the tag's
    // immutable version. So: drop the variable, and require a refusal.
    log("discrimination: running without CONVERGE_PACKAGE_SOURCE")
    const { CONVERGE_PACKAGE_SOURCE: _dropped, ...envWithoutSource } = env
    let refused = false
    let refusalDetail = ""
    try {
      const { stdout: leaked } = await run("node", ["--import", "tsx", "scripts/converge-release.ts"], {
        cwd: tooling,
        env: envWithoutSource,
        maxBuffer: 32 * 1024 * 1024,
      })
      refusalDetail = leaked
    } catch (error) {
      refused = true
      refusalDetail = String(error.stdout ?? "") + String(error.stderr ?? error)
    }
    if (!refused) {
      fail(
        "with no package source supplied, the driver ran anyway — it fell back to its own checkout, " +
          `which would publish current main's sources under ${TAG}'s immutable version:\n${refusalDetail}`
      )
    }
    if (!/CONVERGE_PACKAGE_SOURCE is not set/.test(refusalDetail)) {
      fail(`the driver refused, but not because the package source was missing:\n${refusalDetail}`)
    }
    log("discrimination holds: refuses to infer a package source from its own checkout")

    log("PASS — current tooling converges the old tag's packages, cannot run from the tag alone, and")
    log("       will not substitute its own tree when the tagged source is not named")
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

await main()
