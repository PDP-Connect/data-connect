// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `npm run test:fast`: run only the unit tests the working tree can affect.
// Changed files = committed diff from the merge-base with origin/main (or
// TEST_FAST_BASE) + staged + unstaged + untracked. Each lane is the same
// sandboxed command its package already uses. This is a first signal, not a
// merge gate: the console selection is a text match that may over-select, and
// the reference-implementation suite is never run here.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

const CONSOLE = "apps/console/"
const ROOT_CHANGED_PREFIXES = [
  "src/",
  "src-tauri/",
  "scripts/",
  "playwright-runner/",
]
// A change to any of these can alter every root test.
const ROOT_TIER_TRIGGERS = new Set([
  "vite.config.ts",
  "src/test/setup.ts",
  "package.json",
  "package-lock.json",
])
const CONSOLE_CONFIG =
  /^apps\/console\/(package\.json|tsconfig[^/]*\.json|next\.config\.[^/]+|biome\.jsonc|postcss\.config\.[^/]+|tailwind\.config\.[^/]+|components\.json)$/
const CONSOLE_CODE = /\.(ts|tsx|mts|js|mjs|cjs)$/
const CONSOLE_TEST = /\.test\.(ts|mjs)$/
const NO_TESTS = file =>
  /\.md$/.test(file) ||
  file.startsWith("docs/") ||
  file.startsWith("e2e/") ||
  file.startsWith(".github/")

const dirOf = file => path.posix.dirname(file)
const stem = file =>
  path.posix
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/\.test$/, "")

function importedStems(source) {
  const stems = new Set()
  for (const match of source.matchAll(
    /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g
  )) {
    stems.add(path.posix.basename(match[1]).replace(/\.(m?[jt]sx?|cjs)$/, ""))
  }
  return stems
}

/**
 * Choose the console test files for the changed console files, or "all" when
 * a console change has no matching test or touches console config.
 * @param {string[]} changed repo-relative paths under apps/console/
 * @param {{ path: string, source: string }[]} consoleTests every console test file
 */
function selectConsoleTests(changed, consoleTests) {
  const selected = new Set()
  const imports = new Map(
    consoleTests.map(t => [t.path, importedStems(t.source)])
  )
  for (const file of changed) {
    if (CONSOLE_CONFIG.test(file)) return "all"
    if (CONSOLE_TEST.test(file)) {
      // A deleted test has nothing to run; tests that imported it are found below.
      if (consoleTests.some(t => t.path === file)) {
        selected.add(file)
        continue
      }
    }
    // Data, assets and other files no import names: run the whole suite.
    if (!CONSOLE_CODE.test(file) && !file.startsWith(`${CONSOLE}src/`)) return "all"
    const names = new Set([stem(file)])
    if (stem(file) === "index") names.add(path.posix.basename(dirOf(file)))
    const matches = consoleTests.filter(
      t =>
        dirOf(t.path) === dirOf(file) ||
        [...names].some(name => imports.get(t.path).has(name))
    )
    if (matches.length === 0) return "all"
    for (const t of matches) selected.add(t.path)
  }
  return [...selected].sort()
}

/**
 * Pure mapping from changed files to lanes. No git, no file reads.
 * @param {string[]} changed repo-relative paths
 * @param {{ base: string, consoleTests: { path: string, source: string }[], testedPackages: string[] }} context
 * @returns {{ lanes: { name: string, why: string, argv: string[] }[], notes: string[] }}
 */
export function planLanes(changed, { base, consoleTests, testedPackages }) {
  const lanes = []
  const notes = []
  const rootWhy = []
  let rootTier = null
  const consoleChanged = []
  const packages = new Set()
  let referenceChanged = false

  for (const file of changed) {
    if (NO_TESTS(file)) continue
    if (file.startsWith("reference-implementation/")) {
      referenceChanged = true
    } else if (file.startsWith(CONSOLE)) {
      consoleChanged.push(file)
    } else if (file.startsWith("packages/")) {
      const name = file.split("/")[1]
      if (testedPackages.includes(name)) packages.add(name)
    } else if (ROOT_TIER_TRIGGERS.has(file)) {
      rootTier ??= `${file} changed`
    } else if (ROOT_CHANGED_PREFIXES.some(prefix => file.startsWith(prefix))) {
      rootWhy.push(file)
    } else {
      rootTier ??= `${file} is not mapped to a narrower lane`
    }
  }

  if (rootTier) {
    lanes.push({
      name: "root",
      why: `whole unit tier: ${rootTier}`,
      argv: ["npm", "run", "test:unit"],
    })
  } else if (rootWhy.length > 0) {
    lanes.push({
      name: "root",
      why: `vitest --changed ${base.slice(0, 10)} (${rootWhy.length} changed file(s))`,
      argv: [
        "npm",
        "run",
        "test:unit",
        "--",
        "--changed",
        base,
        "--passWithNoTests",
      ],
    })
  }

  if (consoleChanged.length > 0) {
    const selection = selectConsoleTests(consoleChanged, consoleTests)
    if (selection === "all") {
      lanes.push({
        name: "console",
        why: "whole suite: console config changed or a changed source file matches no test",
        argv: ["npm", "test", "--workspace", "apps/console"],
      })
    } else if (selection.length > 0) {
      lanes.push({
        name: "console",
        why: `${selection.length} test file(s) by name, directory or import match`,
        argv: [
          "npm",
          "run",
          "test:files",
          "--workspace",
          "apps/console",
          "--",
          ...selection.map(file => globLiteral(file.slice(CONSOLE.length))),
        ],
      })
    }
  }

  for (const name of [...packages].sort()) {
    lanes.push({
      name: `packages/${name}`,
      why: "package changed: its whole test script",
      argv: ["npm", "test", "--workspace", `packages/${name}`],
    })
  }

  if (referenceChanged) {
    notes.push(
      "reference-implementation changed: not run here (about 40 min). " +
        "Run `npm test --workspace reference-implementation` when you need it."
    )
  }
  return { lanes, notes }
}

// node --test reads file arguments as globs, and its glob has no escape:
// "[runId]" matches one character and a missing file runs zero tests with
// exit 0. "?" matches the literal character, so use it for glob characters.
const globLiteral = file => file.replace(/[[\]*?{}]/g, "?")

const git = (...args) =>
  spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 })

function gitLines(...args) {
  const result = git(...args, "-z")
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.split("\0").filter(Boolean)
}

function resolveBase() {
  if (process.env.TEST_FAST_BASE) return process.env.TEST_FAST_BASE
  const result = git("merge-base", "HEAD", "origin/main")
  if (result.status !== 0) {
    throw new Error(
      "no origin/main to compare with: fetch it or set TEST_FAST_BASE"
    )
  }
  return result.stdout.trim()
}

function changedFiles(base) {
  return [
    ...new Set([
      // --no-renames lists a moved file under its old and new paths, so tests
      // that still import the old one are selected too.
      ...gitLines("diff", "--name-only", "--no-renames", base, "HEAD"),
      ...gitLines("diff", "--name-only", "--no-renames", "HEAD"),
      ...gitLines("ls-files", "--others", "--exclude-standard"),
    ]),
  ].sort()
}

function consoleTestFiles(changed) {
  const tracked = gitLines(
    "ls-files",
    `${CONSOLE}*.test.ts`,
    `${CONSOLE}*.test.mjs`
  )
  const paths = new Set([
    ...tracked,
    ...changed.filter(f => CONSOLE_TEST.test(f) && f.startsWith(CONSOLE)),
  ])
  return [...paths]
    .filter(file => existsSync(file))
    .map(file => ({ path: file, source: readFileSync(file, "utf8") }))
}

function packagesWithTests() {
  return readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      try {
        return Boolean(
          JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"))
            .scripts?.test
        )
      } catch {
        return false
      }
    })
}

function main() {
  process.chdir(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  )
  const base = resolveBase()
  const changed = changedFiles(base)
  const { lanes, notes } = planLanes(changed, {
    base,
    consoleTests: consoleTestFiles(changed),
    testedPackages: packagesWithTests(),
  })

  console.log(
    `test:fast: ${changed.length} changed file(s) since ${base.slice(0, 10)}`
  )
  for (const note of notes) console.log(`note: ${note}`)
  if (lanes.length === 0) {
    console.log("no unit tests affected")
    return 0
  }
  lanes.forEach((lane, i) =>
    console.log(`  ${i + 1}. ${lane.name}: ${lane.why}`)
  )

  for (const lane of lanes) {
    const started = Date.now()
    console.log(`\n== ${lane.name}: ${lane.argv.join(" ")}`)
    const result = spawnSync(lane.argv[0], lane.argv.slice(1), {
      stdio: "inherit",
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const status = result.status ?? 1
    console.log(
      `== ${lane.name}: ${status === 0 ? "passed" : `failed (exit ${status})`} in ${seconds}s`
    )
    if (status !== 0) return status
  }
  return 0
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`test:fast: ${error.message}`)
    process.exitCode = 2
  }
}
