// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ACCEPTANCE TEST for the converge path, at the ARTIFACT BOUNDARY.
//
// WHY THIS EXISTS SEPARATELY FROM THE REHEARSAL
//
// converge-release-rehearsal.mjs proves the driver loads from the right
// checkout, reads the registry, selects the right packages, and resolves paths
// inside the tagged tree. Those are real regression controls. But every one of
// them observes the driver's OWN NARRATION — its log lines, its exit code, the
// paths it prints. None of them inspects what the release actually produces.
//
// That distinction is the whole reason this file exists. A release-root change
// is only proved by producing an artifact and reading it back:
//
//   "the driver printed the tagged package directory"
//        is NOT
//   "the tarball contains the tagged implementation and correct metadata".
//
// So this test drives the REAL entrypoint through the REAL preparation path and
// then throws the driver's output away and inspects the PACKAGE npm actually
// transmitted.
//
// WHAT IS REAL HERE, AND WHAT IS NOT
//
// Real: both checkouts, each with its own `npm ci` from its own lockfile and
// no inherited build outputs; the real driver; the real registry read that
// decides which packages are missing; the real manifest edits (version and
// sibling pin); the real sibling build; the real `npm publish`, which runs the
// real prepack, compiles the real sources, and packs the real tarball.
//
// Redirected: the DESTINATION of the publish, and nothing else. A local HTTP
// registry on 127.0.0.1 serves the packument reads and accepts the PUT, and
// the tarball it receives is the artifact this test asserts on. That is the
// one external side effect a test must not perform for real — publishing to
// npm is irreversible, because npm versions are immutable.
//
//   - `@pdpp:registry` points the scope at the local server. A scoped registry
//     is the only override that beats the manifests' own
//     `publishConfig.registry`, which is pinned to registry.npmjs.org at the
//     tag. Nothing in the tag's sources is edited to achieve this.
//   - `--provenance=false` because provenance needs a real CI OIDC provider
//     and npm refuses with EUSAGE off a runner. This is the one production
//     behaviour this test cannot exercise, and it is stated as a limit rather
//     than papered over.
//
// THE PARTIALLY-PUBLISHED STATE IS REAL, NOT STUBBED
//
// The local registry is SEEDED with @pdpp/connector-protocol at the release
// version before the driver runs, and serves 404 for the other two. So the
// driver's own `npm view` reads a genuinely half-published registry and
// genuinely SKIPs the live sibling — which is the exact state that broke it:
// a skipped publish runs no prepack, so nothing builds that sibling's dist/,
// so the dependents' prepacks fail with TS2307. The skip is not simulated.
//
// WHAT IS ASSERTED, ON THE TARBALL
//
//   1. VERSION      the packed package.json carries the release version, not
//                   the committed 0.0.1 placeholder.
//   2. SIBLING PIN  collector-runtime's @pdpp/connector-protocol dependency is
//                   the exact release version. Without this the published
//                   package resolves an ancient real 0.0.1 from the registry
//                   and installs broken while looking fine.
//   3. COMPILED     the required compiled files are present, so prepack really
//                   built rather than packing an empty dist/.
//   4. PROVENANCE   the packed code is the TAG's implementation, not current
//                   tooling's. local-collector vendors connector-protocol's
//                   compiled source into its own tarball, and that file gained
//                   exported symbols after the tag — so the tarball itself
//                   says which tree built it. See TAGGED_ABSENT_SYMBOLS.
//
// MUST-FAIL CONTROLS, AT THE SAME BOUNDARY
//
// A test that cannot fail proves nothing, and a control that only changes an
// expected string proves nothing either. Both controls below break the
// BEHAVIOUR and are then caught by the artifact assertions above:
//
//   A. WRONG SOURCE ROOT — point CONVERGE_PACKAGE_SOURCE at the tooling
//      checkout. The driver runs happily; the tarball then contains current
//      tooling's implementation, and assertion 4 rejects it. This is the
//      immutability violation the two-root split exists to prevent, so it must
//      be detected at the artifact, not at a log line.
//   B. OMITTED DEPENDENCY REWRITE — disable the sibling pin in the driver. The
//      publish still succeeds and still produces a tarball; assertion 2
//      rejects it. This is the defect that installs cleanly and is broken.
//
// RUNNING IT
//
//   npm run release:converge:accept
//
// Two independent `npm ci` runs dominate the ~5 minute cold runtime. Optional
// environment:
//
//   ACCEPTANCE_CACHE=<dir>   cache the two INSTALLED checkouts and re-clone
//                            from them each run (~90 s instead of ~5 min).
//                            Only the installs are reused: every run still
//                            gets its own copy, clears build outputs, restores
//                            the tag's manifests, starts a fresh registry, and
//                            copies in the working tree's driver.
//   ACCEPTANCE_TMPDIR=<dir>  where to put scratch. Prefer a disk-backed path;
//                            /tmp is RAM-backed on some machines and this uses
//                            several GB.
//   ACCEPTANCE_TAG=<tag>     converge a different tag (with
//                            ACCEPTANCE_TAG_COMMIT). The provenance
//                            discriminator is checked against both trees
//                            first, so an unsuitable pair fails loudly rather
//                            than passing vacuously.

import { execFile, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createGunzip } from "node:zlib"
import { Readable } from "node:stream"

const run = promisify(execFile)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const TAG = process.env.ACCEPTANCE_TAG ?? "v2.2.1"
const TAG_COMMIT = process.env.ACCEPTANCE_TAG_COMMIT ?? "07173d030ee6be0270aed0120f90f317b5ce5e94"
const VERSION = TAG.replace(/^v/, "")

const LIVE_SIBLING = "@pdpp/connector-protocol"
const EXPECTED_PUBLISHED = ["@pdpp/collector-runtime", "@pdpp/local-collector"]

// Symbols exported by connector-protocol's auth module at CURRENT HEAD that do
// NOT exist at the tag (they were added to packages/connector-protocol/src/auth.ts
// after v2.2.1 was cut). local-collector's build vendors connector-protocol's
// compiled source into its own dist/, which `files: ["dist/"]` then packs — so
// their presence in the tarball is positive proof the pack came from a tree
// NEWER than the tag.
//
// Derived from the repository's real history rather than from a marker this
// test plants, so it cannot be satisfied by a test-only fixture. Verified in
// both directions before being relied on: absent from a tag build, present in
// a HEAD build.
const TAGGED_ABSENT_SYMBOLS = ["resolveLoginCredentials", "noStoredCredentialReason"]

// The vendored path inside local-collector's tarball that carries them.
const VENDORED_PROTOCOL_SOURCE = "package/dist/connector-protocol/src/auth.js"

// Extra compiled files each package must ship, beyond the entrypoints its own
// manifest declares (those are derived at runtime — see
// requiredEntrypointsFromManifest). Checked because an empty or stale dist/
// packs successfully and fails only at install time.
const EXTRA_REQUIRED_FILES = {
  "@pdpp/collector-runtime": [
    "package/dist/collector-runner.js",
    "package/dist/local-device-client.js",
  ],
  "@pdpp/local-collector": [VENDORED_PROTOCOL_SOURCE],
}

// Every file the packed manifest itself points at — `main`, `bin`, and each
// `exports` target. Derived from the manifest rather than hardcoded so this
// asserts what the package PROMISES to ship, and keeps meaning the same thing
// if the compiled layout changes. A tarball whose own declared entrypoints are
// missing is broken on install, whatever else it contains.
function requiredEntrypointsFromManifest(manifest) {
  const targets = new Set()
  const add = value => {
    if (typeof value === "string" && value.endsWith(".js")) {
      targets.add(`package/${value.replace(/^\.\//, "")}`)
    }
  }
  add(manifest.main)
  for (const target of Object.values(manifest.bin ?? {})) add(target)
  const walk = node => {
    if (typeof node === "string") return add(node)
    if (node && typeof node === "object") for (const child of Object.values(node)) walk(child)
  }
  walk(manifest.exports)
  return [...targets]
}

function log(message) {
  process.stdout.write(`[acceptance] ${message}\n`)
}

class AcceptanceFailure extends Error {}

function fail(message) {
  throw new AcceptanceFailure(message)
}

// The test must not be able to publish for real even if everything below is
// wrong. Refusing on a credential present is cheaper than trusting the
// registry redirect alone.
function refuseIfCredentialed() {
  for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG__AUTH", "NPM_CONFIG_TOKEN"]) {
    if (process.env[name]) {
      fail(`${name} is set — refusing to run a publish acceptance test in a credentialed environment`)
    }
  }
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

// --- the local registry ---------------------------------------------------
//
// Minimal on purpose. It answers only what `npm view` and `npm publish` need:
// a packument for a seeded package, 404 for anything else, and 201 for a PUT
// whose body it keeps. Keeping it in-process means the artifact under
// assertion is literally the bytes npm transmitted.
function startRegistry(seeded) {
  const received = new Map()
  const requests = []

  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      const name = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0])
      requests.push(`${req.method} ${name}`)

      if (req.method === "PUT") {
        let parsed
        try {
          parsed = JSON.parse(body.toString("utf8"))
        } catch (error) {
          res.writeHead(400).end(JSON.stringify({ error: String(error) }))
          return
        }
        received.set(parsed.name, parsed)
        res.writeHead(201, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, id: parsed.name }))
        return
      }

      // GET: a packument for the seeded package, so the driver's real
      // registry read reports it PUBLISHED and skips it.
      if (seeded.has(name)) {
        const version = seeded.get(name)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            _id: name,
            name,
            "dist-tags": { latest: version },
            versions: {
              [version]: { name, version, dist: { tarball: `http://127.0.0.1/${name}-${version}.tgz` } },
            },
          })
        )
        return
      }

      // Everything else is genuinely missing. npm turns this into the
      // `code E404` the driver classifies as MISSING.
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Not found" }))
    })
  })

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/`,
        received,
        requests,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

// --- tarball inspection ---------------------------------------------------

async function gunzip(buffer) {
  const chunks = []
  const stream = Readable.from(buffer).pipe(createGunzip())
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

// A tar reader, rather than shelling out to `tar`, so the assertions read the
// exact bytes of the attachment npm PUT and nothing on disk can influence
// them.
function readTar(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "")
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const start = offset + 512
    if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      entries.set(name, buffer.subarray(start, start + size))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return entries
}

// Pulls the tarball out of the packument npm PUT and unpacks it. This is the
// independent observation: the test stops reading the driver here and reads
// the artifact instead.
async function extractPublishedTarball(packument) {
  const attachments = packument._attachments ?? {}
  const names = Object.keys(attachments)
  if (names.length !== 1) {
    fail(`expected exactly one tarball attachment for ${packument.name}, got ${names.length}`)
  }
  const raw = Buffer.from(attachments[names[0]].data, "base64")
  return { filename: names[0], entries: readTar(await gunzip(raw)), size: raw.length }
}

// --- checkouts ------------------------------------------------------------

function checkoutAt(parent, name, ref) {
  const path = join(parent, name)
  execFileSync("git", ["clone", "--quiet", "--no-checkout", "--shared", REPO_ROOT, path])
  execFileSync("git", ["checkout", "--quiet", "--detach", ref], { cwd: path })
  return path
}

// Each checkout installs from its OWN lockfile, into its OWN node_modules.
// No symlink to a shared installation, which is what the previous rehearsal
// did for both roots: a shared node_modules cannot establish that the
// historical and current dependency graphs resolve independently, and its
// relative @pdpp workspace links silently resolve to the LINK TARGET's
// packages — current main's — rather than the tree it was linked into.
// Verified with `readlink -f`. That is a false-provenance hazard for exactly
// the assertion this test makes, so it is not used here at all.
function installIndependently(path, label) {
  log(`installing ${label} from its own lockfile (no shared node_modules)`)
  execFileSync("npm", ["ci"], { cwd: path, stdio: ["ignore", "ignore", "inherit"] })
}

// Each checkout must resolve its own workspace packages, from its own
// node_modules. This is the assertion that would have caught the shared-symlink
// arrangement: with one node_modules linked into both trees, the relative
// @pdpp links resolve to the LINK TARGET's packages — current main's — so a
// build in the "tagged" tree would compile against current sources while every
// log line still named the tagged directory. Verified with `readlink -f`.
function assertSelfContained(path, label) {
  const modules = join(path, "node_modules")
  if (!existsSync(modules)) fail(`${label}: no node_modules — dependencies were never installed here`)
  const real = execFileSync("readlink", ["-f", modules], { encoding: "utf8" }).trim()
  if (real !== modules) {
    fail(
      `${label}: node_modules is a link to ${real}, so this checkout shares an installation with ` +
        `another tree. Independent installs are the point.`
    )
  }
  for (const pkg of ["connector-protocol", "collector-runtime", "local-collector"]) {
    const link = join(modules, "@pdpp", pkg)
    if (!existsSync(link)) fail(`${label}: no @pdpp/${pkg} workspace link after install`)
    const resolved = execFileSync("readlink", ["-f", link], { encoding: "utf8" }).trim()
    const expected = join(path, "packages", pkg)
    if (resolved !== expected) {
      fail(
        `${label}: @pdpp/${pkg} resolves to ${resolved}, outside its own checkout (${expected}) — a ` +
          `build here would compile against another tree's sources`
      )
    }
  }
  log(`${label}: self-contained install, all three @pdpp links resolve inside it`)
}

// Restores every package manifest to exactly what the tag committed.
//
// The driver's manifest edits (version, sibling pin) are real writes that
// persist in the checkout, which is correct for an ephemeral CI checkout but
// wrong across the runs this script makes: without this, control B inherited
// the pin that the main scenario had already written and "passed" while the
// rewrite was disabled — a false negative that hid the control's own failure.
// Caught by running it. So each scenario starts from the tag's bytes.
function restoreTaggedManifests(path, label) {
  for (const pkg of ["connector-protocol", "collector-runtime", "local-collector"]) {
    const relative = `packages/${pkg}/package.json`
    // `git cat-file blob` rather than the trimming git() helper, so the file is
    // restored byte-for-byte including its trailing newline.
    const committed = execFileSync("git", ["cat-file", "blob", `${TAG_COMMIT}:${relative}`], {
      cwd: REPO_ROOT,
      maxBuffer: 8 * 1024 * 1024,
    })
    writeFileSync(join(path, relative), committed)
  }
  // Asserted, not assumed: the placeholder must be back, or a later scenario
  // is testing a manifest some earlier run already fixed.
  const manifest = JSON.parse(readFileSync(join(path, "packages/collector-runtime/package.json"), "utf8"))
  if (manifest.version === VERSION || manifest.dependencies?.[LIVE_SIBLING] === VERSION) {
    fail(`${label}: manifests still carry release values after restore — scenarios would contaminate`)
  }
  log(`${label}: manifests restored to ${TAG}'s committed bytes`)
}

// NO INHERITED BUILD OUTPUTS. The defect under test is that a skipped sibling
// is never built, so a dist/ left behind by anything else would mask it
// entirely — the pack would succeed for the wrong reason. Cleared after
// install (postinstall or a dependency's prepare can create them) and
// asserted absent, so the only dist/ that can exist at pack time is one this
// run produced.
function clearBuildOutputs(path, label) {
  const roots = ["connector-protocol", "collector-runtime", "local-collector"]
  for (const pkg of roots) {
    rmSync(join(path, "packages", pkg, "dist"), { recursive: true, force: true })
  }
  for (const pkg of roots) {
    const dist = join(path, "packages", pkg, "dist")
    if (existsSync(dist)) fail(`${label}: ${dist} still exists after clearing — build outputs would be inherited`)
  }
  log(`${label}: no inherited build outputs (all three packages' dist/ absent)`)
}

// --- assertions -----------------------------------------------------------

function assertPackedVersion(name, manifest) {
  if (manifest.version !== VERSION) {
    fail(
      `${name}: packed package.json says version ${JSON.stringify(manifest.version)}, expected ` +
        `${JSON.stringify(VERSION)}. The release would publish the committed placeholder under the ` +
        `tag's version.`
    )
  }
  log(`${name}: packed version is ${VERSION}`)
}

function assertSiblingPin(name, manifest) {
  const declared = manifest.dependencies?.[LIVE_SIBLING]
  if (declared === undefined) return // only collector-runtime declares it
  if (declared !== VERSION) {
    fail(
      `${name}: packed manifest pins ${LIVE_SIBLING} at ${JSON.stringify(declared)}, expected the exact ` +
        `release version ${JSON.stringify(VERSION)}. Published as-is it would resolve an ancient real ` +
        `0.0.1 from the registry — installing cleanly while being broken, with the lockstep invariant ` +
        `reading TRUE while false.`
    )
  }
  log(`${name}: packed manifest pins ${LIVE_SIBLING} at exactly ${VERSION}`)
}

function assertCompiledFiles(name, manifest, entries) {
  const declared = requiredEntrypointsFromManifest(manifest)
  if (declared.length === 0) {
    fail(`${name}: packed manifest declares no .js entrypoint, so there is nothing to verify was built`)
  }
  const required = [...new Set([...declared, ...(EXTRA_REQUIRED_FILES[name] ?? [])])]
  for (const file of required) {
    const content = entries.get(file)
    if (!content) {
      fail(
        `${name}: ${file} is not in the tarball, though the package points at it. prepack packed ` +
          `without building, so the published package would be broken on install.`
      )
    }
    if (content.length === 0) fail(`${name}: ${file} is present but empty`)
  }
  log(`${name}: ${required.length} compiled files present and non-empty (${declared.length} manifest-declared)`)
}

// THE PROVENANCE ASSERTION. Distinguishes the tag's implementation from
// current tooling's by reading the vendored protocol source the tarball
// carries, not by trusting which directory the driver said it used.
function assertTaggedSource(name, entries) {
  const vendored = entries.get(VENDORED_PROTOCOL_SOURCE)
  if (!vendored) return { checked: false }
  const text = vendored.toString("utf8")
  const leaked = TAGGED_ABSENT_SYMBOLS.filter(symbol => text.includes(symbol))
  if (leaked.length > 0) {
    fail(
      `${name}: the tarball's ${VENDORED_PROTOCOL_SOURCE} exports ${leaked.join(", ")}, which do NOT ` +
        `exist at ${TAG}. The pack came from a tree newer than the tag — current tooling's sources ` +
        `would be published under ${TAG}'s immutable version.`
    )
  }
  log(`${name}: vendored protocol source is ${TAG}'s (none of ${TAGGED_ABSENT_SYMBOLS.join(", ")} present)`)
  return { checked: true }
}

// Confirms the discriminator can actually discriminate. If current HEAD ever
// stops exporting these symbols, assertTaggedSource silently passes for every
// tree and this test quietly stops proving provenance — so the premise is
// checked rather than assumed.
function assertDiscriminatorIsLive() {
  const headSource = git(["show", "HEAD:packages/connector-protocol/src/auth.ts"])
  const missing = TAGGED_ABSENT_SYMBOLS.filter(symbol => !headSource.includes(symbol))
  if (missing.length > 0) {
    fail(
      `the provenance discriminator is no longer valid: ${missing.join(", ")} absent from HEAD's ` +
        `connector-protocol/src/auth.ts. Pick symbols that current tooling has and ${TAG} does not, ` +
        `or this test cannot tell the two trees apart.`
    )
  }
  const tagSource = git(["show", `${TAG_COMMIT}:packages/connector-protocol/src/auth.ts`])
  const present = TAGGED_ABSENT_SYMBOLS.filter(symbol => tagSource.includes(symbol))
  if (present.length > 0) {
    fail(`the provenance discriminator is invalid: ${present.join(", ")} already exist at ${TAG}`)
  }
  log(`discriminator valid: ${TAGGED_ABSENT_SYMBOLS.join(", ")} in HEAD, absent at ${TAG}`)
}

// --- the run --------------------------------------------------------------

// Drives the real driver once and returns what the registry received.
async function converge({ tooling, packageSource, registryUrl, userconfig, expectSuccess = true }) {
  const env = {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    CONVERGE_RELEASE_TAG: TAG,
    CONVERGE_PACKAGE_SOURCE: packageSource,
    // Deliberately NOT CONVERGE_RELEASE_DRY_RUN. This is the real publish
    // path; only its destination is redirected.
    NPM_CONFIG_USERCONFIG: userconfig,
    npm_config_userconfig: userconfig,
    npm_config_registry: registryUrl,
    // Redirects the publish destination and disables provenance, which the
    // packages' own publishConfig otherwise forces on (npm then refuses with
    // EUSAGE, since there is no OIDC provider off a runner). The driver fences
    // this to loopback URLs and refuses it under GITHUB_ACTIONS.
    CONVERGE_ACCEPTANCE_LOCAL_REGISTRY: registryUrl,
  }
  delete env.CONVERGE_RELEASE_DRY_RUN

  try {
    const { stdout, stderr } = await run("node", ["--import", "tsx", "scripts/converge-release.ts"], {
      cwd: tooling,
      env,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, output: stdout + stderr }
  } catch (error) {
    const output = String(error.stdout ?? "") + String(error.stderr ?? error)
    if (expectSuccess) fail(`the driver did not complete:\n${output}`)
    return { ok: false, output }
  }
}

// An npmrc that redirects the @pdpp scope to the local registry. Written
// outside every checkout so no tag source is edited to make the test work.
function writeNpmrc(dir, registryUrl) {
  const host = registryUrl.replace(/^https?:/, "").replace(/\/$/, "")
  const path = join(dir, "acceptance-npmrc")
  writeFileSync(
    path,
    [
      `@pdpp:registry=${registryUrl}`,
      `${host}/:_authToken=acceptance-token`,
      "provenance=false",
      "",
    ].join("\n")
  )
  return path
}

async function main() {
  refuseIfCredentialed()

  const resolvedTagCommit = git(["rev-parse", `${TAG}^{commit}`])
  if (resolvedTagCommit !== TAG_COMMIT) {
    fail(`${TAG} resolves to ${resolvedTagCommit}, not the expected ${TAG_COMMIT} — the release tag moved`)
  }
  assertDiscriminatorIsLive()

  // Two independent `npm ci` runs take about four minutes, which makes the
  // must-fail controls impractical to run as often as they should be. So the
  // PREPARED PAIR can be cached in a named directory and re-cloned from for
  // each run.
  //
  // The cache holds only the two INSTALLED checkouts. Every run still gets its
  // own copy, still clears build outputs, still starts a fresh registry, and
  // still copies in the working tree's driver — so no run inherits another's
  // dist/, manifest edits, or packed output, which is the property that would
  // make caching unsafe here. Off by default; the committed acceptance run and
  // the controls below all use it explicitly so they compare like with like.
  const cacheRoot = process.env.ACCEPTANCE_CACHE
    ? resolve(process.env.ACCEPTANCE_CACHE)
    : null
  const scratchParent = process.env.ACCEPTANCE_TMPDIR ?? tmpdir()
  const workdir = mkdtempSync(join(scratchParent, "converge-acceptance-"))
  let registry
  try {
    let tagged
    let tooling
    if (cacheRoot && existsSync(join(cacheRoot, "ready"))) {
      log(`reusing the prepared checkout pair from ${cacheRoot}`)
      tagged = join(workdir, "tagged-package-source")
      tooling = join(workdir, "release-tooling")
      execFileSync("cp", ["-a", join(cacheRoot, "tagged-package-source"), tagged])
      execFileSync("cp", ["-a", join(cacheRoot, "release-tooling"), tooling])
    } else {
      tagged = checkoutAt(workdir, "tagged-package-source", TAG)
      tooling = checkoutAt(workdir, "release-tooling", git(["rev-parse", "HEAD"]))
      installIndependently(tooling, "release-tooling (current)")
      installIndependently(tagged, `tagged-package-source (${TAG})`)
      if (cacheRoot) {
        log(`caching the prepared pair in ${cacheRoot}`)
        rmSync(cacheRoot, { recursive: true, force: true })
        mkdirSync(cacheRoot, { recursive: true })
        execFileSync("cp", ["-a", tagged, join(cacheRoot, "tagged-package-source")])
        execFileSync("cp", ["-a", tooling, join(cacheRoot, "release-tooling")])
        writeFileSync(join(cacheRoot, "ready"), `${TAG_COMMIT}\n`)
      }
    }

    // Re-asserted on every run, cached or not: each checkout's @pdpp workspace
    // links must resolve inside ITSELF. A cached pair that was copied wrong, or
    // a stale cache from another tag, fails here rather than silently packing
    // the wrong tree.
    assertSelfContained(tooling, "release-tooling (current)")
    assertSelfContained(tagged, `tagged-package-source (${TAG})`)

    // The driver under test is the WORKING TREE's, so an uncommitted
    // regression fails here instead of being skipped.
    for (const file of ["scripts/converge-release.ts", "scripts/release-registry-state.ts"]) {
      execFileSync("cp", [join(REPO_ROOT, file), join(tooling, file)])
    }

    clearBuildOutputs(tagged, `tagged-package-source (${TAG})`)
    clearBuildOutputs(tooling, "release-tooling (current)")
    restoreTaggedManifests(tagged, `tagged-package-source (${TAG})`)

    // The real partially-published state: the upstream sibling is live, so the
    // driver reads it as PUBLISHED and skips it; the other two are missing.
    registry = await startRegistry(new Map([[LIVE_SIBLING, VERSION]]))
    const userconfig = writeNpmrc(workdir, registry.url)
    log(`local registry at ${registry.url}, seeded with ${LIVE_SIBLING}@${VERSION}`)

    // ---- THE ACCEPTANCE SCENARIO -----------------------------------------
    const result = await converge({ tooling, packageSource: tagged, registryUrl: registry.url, userconfig })

    if (!/skipping @pdpp\/connector-protocol/.test(result.output)) {
      fail(
        "the driver did not skip the already-live sibling, so the scenario under test — a partially " +
          "published release — was never exercised"
      )
    }
    log(`${LIVE_SIBLING} was read as live from the registry and skipped`)

    // From here the driver's output is IGNORED. Everything else is read from
    // what the registry actually received.
    const publishedNames = [...registry.received.keys()].sort()
    if (publishedNames.join(",") !== EXPECTED_PUBLISHED.join(",")) {
      fail(
        `the registry received ${publishedNames.length ? publishedNames.join(", ") : "nothing"}; ` +
          `expected exactly ${EXPECTED_PUBLISHED.join(", ")}`
      )
    }
    if (registry.received.has(LIVE_SIBLING)) {
      fail(`${LIVE_SIBLING} was republished — npm versions are immutable and its content is already correct`)
    }
    log(`registry received exactly: ${publishedNames.join(", ")}`)

    let provenanceChecked = 0
    for (const name of EXPECTED_PUBLISHED) {
      const { filename, entries, size } = await extractPublishedTarball(registry.received.get(name))
      const manifestRaw = entries.get("package/package.json")
      if (!manifestRaw) fail(`${name}: tarball ${filename} has no package/package.json`)
      const manifest = JSON.parse(manifestRaw.toString("utf8"))

      if (manifest.name !== name) fail(`${name}: tarball declares name ${manifest.name}`)
      log(`${name}: inspecting ${filename} (${size} bytes, ${entries.size} entries)`)

      assertPackedVersion(name, manifest)
      assertSiblingPin(name, manifest)
      assertCompiledFiles(name, manifest, entries)
      if (assertTaggedSource(name, entries).checked) provenanceChecked += 1
    }

    if (provenanceChecked === 0) {
      fail(
        `no tarball carried ${VENDORED_PROTOCOL_SOURCE}, so nothing established that the packed code ` +
          `came from ${TAG} rather than from current tooling — the assertion this test exists for`
      )
    }
    log(`provenance verified from the artifact for ${provenanceChecked} package(s)`)

    // ---- MUST-FAIL CONTROL A: WRONG SOURCE ROOT --------------------------
    //
    // Point the driver at the TOOLING checkout instead of the tag. It has a
    // complete packages/* of its own, so the driver runs, builds and publishes
    // happily — and the artifact is then current tooling's implementation under
    // the tag's immutable version, which is the exact violation the two-root
    // split exists to prevent.
    //
    // This breaks the BEHAVIOUR, not an expected string: nothing about the
    // assertions changes, the tarball's contents do. If the acceptance
    // assertions passed here, they would not be evidence of anything.
    log("control A: repeating the scenario with the WRONG source root (the tooling checkout)")
    // Control A publishes FROM the tooling checkout, so that tree is what needs
    // a clean slate here.
    clearBuildOutputs(tooling, "release-tooling (current)")
    const controlRegistry = await startRegistry(new Map([[LIVE_SIBLING, VERSION]]))
    let controlADetected = false
    let controlADetail = ""
    try {
      const wrong = await converge({
        tooling,
        packageSource: tooling,
        registryUrl: controlRegistry.url,
        userconfig: writeNpmrc(workdir, controlRegistry.url),
        expectSuccess: false,
      })
      if (!wrong.ok) {
        // Acceptable but weaker: the driver refused before packing. Record it
        // rather than claiming the artifact assertion caught it.
        controlADetected = true
        controlADetail = "the driver refused before producing an artifact"
      } else {
        // It published. Now the artifact assertions must reject it.
        for (const name of EXPECTED_PUBLISHED) {
          const packument = controlRegistry.received.get(name)
          if (!packument) continue
          const { entries } = await extractPublishedTarball(packument)
          try {
            assertTaggedSource(name, entries)
          } catch (error) {
            if (error instanceof AcceptanceFailure) {
              controlADetected = true
              controlADetail = `artifact assertion rejected it: ${error.message.split("\n")[0]}`
              break
            }
            throw error
          }
        }
      }
    } finally {
      await controlRegistry.close()
    }
    if (!controlADetected) {
      fail(
        "CONTROL A DID NOT FAIL. Publishing from the wrong source root produced artifacts this test " +
          "accepted, so its pass above does not establish that the packed code came from the tag."
      )
    }
    log(`control A holds — wrong source root is rejected (${controlADetail})`)

    // ---- MUST-FAIL CONTROL B: OMITTED DEPENDENCY REWRITE -----------------
    //
    // Disable the sibling pin in the driver itself and rerun. The publish still
    // succeeds and still produces a real tarball — the failure is not a crash,
    // it is a WRONG ARTIFACT: collector-runtime@2.2.1 declaring
    // @pdpp/connector-protocol@0.0.1, which resolves an ancient real version
    // from the registry and installs cleanly while being broken. Only reading
    // the packed manifest catches it.
    log("control B: repeating the scenario with the sibling dependency rewrite DISABLED")
    const driverPath = join(tooling, "scripts/converge-release.ts")
    const original = readFileSync(driverPath, "utf8")
    const sabotaged = original.replace(
      "  if (name !== PINNED_DEPENDENT) return",
      "  if (name !== PINNED_DEPENDENT) return\n  return // CONTROL B: pin disabled"
    )
    if (sabotaged === original) {
      fail("control B could not disable the sibling pin — the driver's pin guard was not found")
    }
    writeFileSync(driverPath, sabotaged)

    const controlBRegistry = await startRegistry(new Map([[LIVE_SIBLING, VERSION]]))
    let controlBDetected = false
    let controlBDetail = ""
    try {
      clearBuildOutputs(tagged, `tagged-package-source (${TAG})`)
      // Critical: the main scenario already wrote the pin into this checkout.
      // Without restoring, control B would inherit a correct manifest and
      // report a false pass while the rewrite was disabled — observed.
      restoreTaggedManifests(tagged, `tagged-package-source (${TAG})`)
      const unpinned = await converge({
        tooling,
        packageSource: tagged,
        registryUrl: controlBRegistry.url,
        userconfig: writeNpmrc(workdir, controlBRegistry.url),
        expectSuccess: false,
      })
      if (!unpinned.ok) {
        controlBDetected = true
        controlBDetail = "the driver refused before producing an artifact"
      } else {
        const packument = controlBRegistry.received.get("@pdpp/collector-runtime")
        if (!packument) {
          fail("control B: @pdpp/collector-runtime was never published, so no artifact could be checked")
        }
        const { entries } = await extractPublishedTarball(packument)
        const manifest = JSON.parse(entries.get("package/package.json").toString("utf8"))
        try {
          assertSiblingPin("@pdpp/collector-runtime", manifest)
        } catch (error) {
          if (error instanceof AcceptanceFailure) {
            controlBDetected = true
            controlBDetail = `packed manifest declared ${LIVE_SIBLING}@${manifest.dependencies?.[LIVE_SIBLING]}`
          } else throw error
        }
      }
    } finally {
      await controlBRegistry.close()
      writeFileSync(driverPath, original)
    }
    if (!controlBDetected) {
      fail(
        "CONTROL B DID NOT FAIL. A converge with no sibling pin produced an artifact this test " +
          "accepted, so its pass above does not establish that the dependency rewrite happened."
      )
    }
    log(`control B holds — omitted dependency rewrite is rejected (${controlBDetail})`)

    log("ACCEPTANCE PASS — the converge path published the correct packages, built from the tagged")
    log("                  tree, at the release version, with the sibling pinned exactly; and both")
    log("                  artifact-boundary controls fail as they must")
  } finally {
    if (registry) await registry.close()
    rmSync(workdir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof AcceptanceFailure) {
    process.stderr.write(`[acceptance] FAIL: ${error.message}\n`)
  } else {
    process.stderr.write(`[acceptance] FAIL: ${error?.stack ?? error}\n`)
  }
  process.exitCode = 1
}
