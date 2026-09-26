#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The vendored `reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz`
// tarball (README-documented pin, re-vendored by hand or via
// scripts/revendor-polyfill-connectors.sh) is a committed snapshot, not a live
// dependency: nothing re-fetches it. This check proves the snapshot is honest and
// reports how far it has drifted:
//
// Blocking (same result on any date for the same commit):
//   1. Digest: the tarball's SHA-256 matches vendor/SHA256SUMS and its SHA-512 SRI
//      matches the package-lock.json integrity.
//   2. Accepted pin: the README pin is on data-connectors main and is not newer than
//      LAST_ACCEPTED_PIN, the last upstream commit whose manifests this reference
//      implementation accepts.
//   3. Content: rebuilding the package at the pin (the revendor procedure) gives the
//      same file tree, byte for byte, as the vendored tarball. The gzip bytes are not
//      reproducible (tar/gzip timestamps), so the content is compared per file and the
//      digest in (1) binds the exact committed bytes.
//
// Non-blocking: how far the pin is behind data-connectors main (commits and days).
// This is a warning and a job summary line. It never fails CI, because upstream
// commits many times a day and later pins are rejected by this RI (see README), so a
// calendar threshold would fail every PR with no action available to the author.
//
// The owner has decided to deprecate @pdpp/polyfill-connectors for OCI-distributed
// connector artifacts; this check guards the snapshot until that migration lands.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VENDOR_DIR = join(ROOT, "reference-implementation", "vendor")
const README_PATH = join(VENDOR_DIR, "README.md")
const TARBALL_PATH = join(VENDOR_DIR, "pdpp-polyfill-connectors-0.0.1.tgz")
const SUMS_PATH = join(VENDOR_DIR, "SHA256SUMS")
const LOCK_PATH = join(ROOT, "package-lock.json")
const LOCK_KEY = "node_modules/@pdpp/polyfill-connectors"
const UPSTREAM_REMOTE =
  process.env.DATA_CONNECTORS_REMOTE ??
  "https://github.com/PDP-Connect/data-connectors.git"
const UPSTREAM_PACKAGE_DIR = "packages/polyfill-connectors"
// The last data-connectors commit before the 2026-09-22 connector cutover. Later
// commits change manifests this RI does not yet accept (README, 2026-09-25 entry).
// Raise this only in the same change that makes the RI accept the newer manifests.
export const LAST_ACCEPTED_PIN = "d2d9007a91cd7e5035d6d70e5273985354d8dfff"
const HOST_PROVIDED_DEPENDENCIES = [
  "@pdpp/collector-runtime",
  "@pdpp/connector-protocol",
  "@pdpp/reference-contract",
]
const PIN_PATTERN = /pin moved.*?commit\s*\n?`([0-9a-f]{40})`/gs
const TAG = "[check-polyfill-connectors-tarball-freshness]"

export function currentPin(readmeText) {
  const matches = [...readmeText.matchAll(PIN_PATTERN)]
  if (matches.length === 0) {
    throw new Error(
      `no "pin moved to ... commit" entry found in ${README_PATH}`
    )
  }
  return matches.at(-1)[1]
}

export function daysBetween(fromIso, toIso) {
  return (
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) /
    (1000 * 60 * 60 * 24)
  )
}

export function sumsEntry(sumsText, fileName) {
  const line = sumsText
    .split("\n")
    .find(entry => entry.trim().endsWith(`  ${fileName}`))
  return line ? line.trim().split(/\s+/)[0] : undefined
}

// Mirrors the package.json repack in scripts/revendor-polyfill-connectors.sh.
export function normalizeVendoredPackageJson(text) {
  const pkg = JSON.parse(text)
  for (const name of HOST_PROVIDED_DEPENDENCIES) {
    pkg.dependencies[name] = "*"
    if (pkg.devDependencies) delete pkg.devDependencies[name]
  }
  delete pkg.bundledDependencies
  delete pkg.bundleDependencies
  if (pkg.overrides?.["@pdpp/collector-runtime"]) {
    for (const name of [
      "@pdpp/connector-protocol",
      "@pdpp/reference-contract",
    ]) {
      pkg.overrides["@pdpp/collector-runtime"][name] = "*"
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

// Returns a list of differences between two { relativePath: sha256 } maps.
export function diffFileDigests(vendored, rebuilt) {
  const differences = []
  for (const path of Object.keys(vendored).sort()) {
    if (!(path in rebuilt))
      differences.push(`only in vendored tarball: ${path}`)
    else if (vendored[path] !== rebuilt[path])
      differences.push(`content differs: ${path}`)
  }
  for (const path of Object.keys(rebuilt).sort()) {
    if (!(path in vendored))
      differences.push(`missing from vendored tarball: ${path}`)
  }
  return differences
}

// Pure decision. Inputs are facts gathered by main(); the output has no clock input
// other than the dates passed in, and those only affect `warnings`, never `errors`.
export function evaluate({
  pin,
  tarballSha256,
  recordedSha256,
  tarballIntegrity,
  lockIntegrity,
  pinOnUpstreamMain,
  pinWithinAcceptedRange,
  contentDifferences,
  rebuildError,
  drift,
}) {
  const errors = []
  const warnings = []
  if (tarballSha256 !== recordedSha256) {
    errors.push(
      `tarball sha256 ${tarballSha256} does not match vendor/SHA256SUMS (${recordedSha256 ?? "no entry"})`
    )
  }
  if (tarballIntegrity !== lockIntegrity) {
    errors.push(
      `tarball integrity ${tarballIntegrity} does not match package-lock.json (${lockIntegrity ?? "no entry"})`
    )
  }
  if (!pinOnUpstreamMain) {
    errors.push(`pin ${pin} is not reachable from data-connectors main`)
  }
  if (!pinWithinAcceptedRange) {
    errors.push(
      `pin ${pin} is newer than LAST_ACCEPTED_PIN ${LAST_ACCEPTED_PIN}; this RI does not ` +
        `accept post-cutover manifests. Add RI support and raise LAST_ACCEPTED_PIN in the same change.`
    )
  }
  if (rebuildError) {
    errors.push(
      `could not rebuild pin ${pin} to compare content: ${rebuildError}`
    )
  } else if (contentDifferences.length > 0) {
    const shown = contentDifferences.slice(0, 20).join("\n  ")
    errors.push(
      `vendored tarball is not what pin ${pin} produces (${contentDifferences.length} differences):\n  ${shown}`
    )
  }
  if (drift && drift.commitsBehind > 0) {
    warnings.push(
      `pin ${pin} is ${drift.commitsBehind} commits and ${daysBetween(drift.pinDate, drift.mainDate).toFixed(1)} ` +
        `days behind data-connectors main (${drift.mainSha}). Informational only; re-vendor with ` +
        `scripts/revendor-polyfill-connectors.sh when the RI accepts a newer pin.`
    )
  }
  return { errors, warnings }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? "unknown"}: ${result.stderr}`
    )
  }
  return result.stdout.trim()
}

function isAncestor(ancestor, descendant) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: ROOT,
    }).status === 0
  )
}

function fileDigests(dir) {
  const digests = {}
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else
        digests[relative(dir, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex")
    }
  }
  walk(dir)
  return digests
}

// Rebuilds the package at `pin` with the steps of scripts/revendor-polyfill-connectors.sh.
function rebuildDigests(pin, scratch) {
  const source = join(scratch, "source")
  run("mkdir", ["-p", source])
  run("sh", ["-c", `git archive ${pin} | tar -x -C "${source}"`])
  const packageDir = join(source, UPSTREAM_PACKAGE_DIR)
  const env = {
    ...process.env,
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  }
  run("npm", ["ci", "--ignore-scripts"], { cwd: packageDir, env })
  run("npm", ["run", "generate:connector-index"], { cwd: packageDir, env })
  run("npm", ["pack", "--pack-destination", scratch], { cwd: packageDir, env })
  const unpacked = join(scratch, "rebuilt")
  run("mkdir", ["-p", unpacked])
  run("tar", ["-xzf", join(scratch, basename(TARBALL_PATH)), "-C", unpacked])
  const pkgJson = join(unpacked, "package", "package.json")
  writeFileSync(
    pkgJson,
    normalizeVendoredPackageJson(readFileSync(pkgJson, "utf8"))
  )
  rmSync(join(unpacked, "package", "vendor"), { recursive: true, force: true })
  rmSync(join(unpacked, "package", "node_modules"), {
    recursive: true,
    force: true,
  })
  // Whole extraction root: npm strips the first path component of every entry,
  // so a root other than package/ would still install.
  return fileDigests(unpacked)
}

function vendoredDigests(scratch) {
  const unpacked = join(scratch, "vendored")
  run("mkdir", ["-p", unpacked])
  run("tar", ["-xzf", TARBALL_PATH, "-C", unpacked])
  return fileDigests(unpacked)
}

function report({ errors, warnings }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  for (const warning of warnings) {
    console.log(`::warning title=polyfill-connectors pin drift::${warning}`)
    if (summaryPath)
      appendFileSync(
        summaryPath,
        `- polyfill-connectors pin drift: ${warning}\n`
      )
  }
  for (const error of errors) console.error(`${TAG} ${error}`)
  if (errors.length > 0) process.exitCode = 1
  else
    console.log(`${TAG} vendored tarball matches its pin, digest and lockfile`)
}

function main() {
  const pin = currentPin(readFileSync(README_PATH, "utf8"))
  const tarball = readFileSync(TARBALL_PATH)
  const lockEntry = JSON.parse(readFileSync(LOCK_PATH, "utf8")).packages[
    LOCK_KEY
  ]

  run("git", ["fetch", "--quiet", UPSTREAM_REMOTE, pin, LAST_ACCEPTED_PIN])
  run("git", ["fetch", "--quiet", UPSTREAM_REMOTE, "main"])
  const mainSha = run("git", ["rev-parse", "FETCH_HEAD"])

  const scratch = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "polyfill-pin-check-")
  )
  // A failed rebuild is reported next to the cheap rules, not instead of them, so a
  // pin moved past LAST_ACCEPTED_PIN names that cause.
  let contentDifferences = []
  let rebuildError
  try {
    contentDifferences = diffFileDigests(
      vendoredDigests(scratch),
      rebuildDigests(pin, scratch)
    )
  } catch (error) {
    rebuildError = error.message
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  report(
    evaluate({
      pin,
      tarballSha256: createHash("sha256").update(tarball).digest("hex"),
      recordedSha256: sumsEntry(
        readFileSync(SUMS_PATH, "utf8"),
        basename(TARBALL_PATH)
      ),
      tarballIntegrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      lockIntegrity: lockEntry?.integrity,
      pinOnUpstreamMain: isAncestor(pin, mainSha),
      pinWithinAcceptedRange: isAncestor(pin, LAST_ACCEPTED_PIN),
      contentDifferences,
      rebuildError,
      drift: {
        mainSha,
        commitsBehind: Number(
          run("git", ["rev-list", "--count", `${pin}..${mainSha}`])
        ),
        pinDate: run("git", ["log", "-1", "--format=%cI", pin]),
        mainDate: run("git", ["log", "-1", "--format=%cI", mainSha]),
      },
    })
  )
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  try {
    main()
  } catch (error) {
    console.error(`${TAG} ${error.message}`)
    process.exitCode = 1
  }
}
