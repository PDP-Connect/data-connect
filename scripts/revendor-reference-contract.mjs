#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const [checkoutArg, revision, ...extra] = process.argv.slice(2)
if (!checkoutArg || !/^[a-f0-9]{40}$/.test(revision ?? "") || extra.length) {
  throw new Error(
    "Usage: node scripts/revendor-reference-contract.mjs <pdpp-checkout> <full-commit-sha>"
  )
}
const checkout = resolve(checkoutArg)
const root = fileURLToPath(new URL("../", import.meta.url))
const vendor = join(root, "reference-implementation/vendor")
const lockPath = join(root, "package-lock.json")
const sumsPath = join(vendor, "SHA256SUMS")
const name = "@pdpp/reference-contract"
const lock = JSON.parse(await readFile(lockPath, "utf8"))
const locked = lock.packages["node_modules/@pdpp/reference-contract"]
if (!locked) throw new Error("Missing reference-contract package-lock entry")

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}):\n${result.stdout}${result.stderr}`
    )
  }
  return result.stdout.trim()
}

const commit = run("git", [
  "-C",
  checkout,
  "rev-parse",
  "--verify",
  `${revision}^{commit}`,
])
if (commit !== revision)
  throw new Error("Revision must be the exact commit SHA")
let compiler = join(root, "node_modules/typescript/bin/tsc")
let compilerCommand = process.execPath
try {
  await access(compiler)
} catch {
  compiler = join(root, "node_modules/.bin/tsc")
  compilerCommand = compiler
  await access(compiler)
}
const scratchRoot = join(homedir(), ".tmp")
await mkdir(scratchRoot, { recursive: true })
const scratch = await mkdtemp(join(scratchRoot, "reference-contract-vendor-"))

try {
  const archive = join(scratch, "source.tar")
  run("git", [
    "-C",
    checkout,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commit,
    "packages/reference-contract",
  ])
  run("tar", ["-xf", archive, "-C", scratch])
  await symlink(
    join(root, "node_modules"),
    join(scratch, "node_modules"),
    "dir"
  )
  const packageDir = join(scratch, "packages/reference-contract")
  const sourceDependencies = join(
    checkout,
    "packages/reference-contract/node_modules"
  )
  let buildDependencies = join(root, "node_modules")
  try {
    await access(sourceDependencies)
    await symlink(sourceDependencies, join(packageDir, "node_modules"), "dir")
    buildDependencies = sourceDependencies
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const packagePath = join(packageDir, "package.json")
  const pkg = JSON.parse(await readFile(packagePath, "utf8"))
  if (pkg.name !== name || pkg.version !== locked.version) {
    throw new Error(
      "Source package name/version differs from the pinned dependency"
    )
  }
  if (
    JSON.stringify(pkg.dependencies) !== JSON.stringify(locked.dependencies)
  ) {
    throw new Error(
      "Source dependencies differ from the lock; update dependencies separately"
    )
  }
  const buildConfig = join(packageDir, "tsconfig.vendor-build.json")
  await writeFile(
    buildConfig,
    `${JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: false,
          outDir: "./dist",
          rootDir: "./src",
          rewriteRelativeImportExtensions: true,
          declaration: true,
          incremental: false,
        },
        include: ["src/**/*.ts", "src/**/*.js"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2
    )}\n`
  )
  run(
    compilerCommand,
    [
      ...(compilerCommand === process.execPath ? [compiler] : []),
      "--project",
      buildConfig,
    ],
    packageDir
  )
  await rm(buildConfig)

  function compiledPath(path, declarations = false) {
    if (typeof path !== "string" || !/^\.\/src\/.*\.(ts|js)$/.test(path)) {
      throw new Error(`Unsupported source entrypoint: ${JSON.stringify(path)}`)
    }
    return path
      .replace(/^\.\/src\//, "./dist/")
      .replace(/\.(ts|js)$/, declarations ? ".d.ts" : ".js")
  }
  pkg.exports = Object.fromEntries(
    Object.entries(pkg.exports).map(([subpath, source]) => [
      subpath,
      { types: compiledPath(source, true), default: compiledPath(source) },
    ])
  )
  pkg.main = compiledPath(pkg.main)
  pkg.types = "./dist/index.d.ts"
  // npm otherwise inherits the source .gitignore and omits compiled dist/.
  pkg.files = [
    "dist",
    "src",
    "test",
    "scripts",
    "README.md",
    "tsconfig.json",
    "biome.jsonc",
  ]
  pkg.vendorSource = {
    repository: "https://github.com/PDP-Connect/pdpp",
    commit,
    path: "packages/reference-contract",
  }
  for (const entry of Object.values(pkg.exports)) {
    await access(join(packageDir, entry.types))
    await access(join(packageDir, entry.default))
  }
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  const packResult = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      packageDir
    )
  )
  // npm 12 keys JSON output by package name; earlier npm versions use an array.
  const packed = Array.isArray(packResult) ? packResult[0] : packResult[name]
  const filename = `pdpp-reference-contract-${pkg.version}.tgz`
  if (
    packed?.filename !== filename ||
    locked.resolved !== `file:reference-implementation/vendor/${filename}`
  ) {
    throw new Error("Packed filename differs from the pinned file dependency")
  }
  const packedFiles = new Set(packed.files.map(file => file.path))
  for (const path of [
    pkg.main,
    pkg.types,
    ...Object.values(pkg.exports).flatMap(entry => [
      entry.default,
      entry.types,
    ]),
  ]) {
    if (!packedFiles.has(path.replace(/^\.\//, ""))) {
      throw new Error(`Missing packed entrypoint: ${path}`)
    }
  }
  // Import from an extracted node_modules consumer, where Node cannot strip TS.
  const consumer = join(scratch, "consumer")
  const installedPackage = join(
    consumer,
    "node_modules/@pdpp/reference-contract"
  )
  await mkdir(installedPackage, { recursive: true })
  run("tar", [
    "-xzf",
    join(scratch, filename),
    "--strip-components=1",
    "-C",
    installedPackage,
  ])
  await symlink(
    buildDependencies,
    join(installedPackage, "node_modules"),
    "dir"
  )
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    for (const subpath of ${JSON.stringify(Object.keys(pkg.exports))}) {
      await import(subpath === "." ? "@pdpp/reference-contract" : "@pdpp/reference-contract" + subpath.slice(1))
    }
    const { generateDocs } = await import("@pdpp/reference-contract/docs")
    const { generateOpenApi } = await import("@pdpp/reference-contract/openapi")
    generateDocs()
    generateOpenApi()
    generateOpenApi({ includeReference: true })
  `,
    ],
    consumer
  )
  const contents = await readFile(join(scratch, filename))
  const sha256 = createHash("sha256").update(contents).digest("hex")
  locked.integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`
  const sums = await readFile(sumsPath, "utf8")
  let replaced = 0
  const updatedSums = sums.replace(
    /^([a-f0-9]{64})([ \t]+)(.+)$/gm,
    (line, _digest, spaces, path) => {
      if (
        path !== filename &&
        path !== `reference-implementation/vendor/${filename}`
      )
        return line
      replaced += 1
      return `${sha256}${spaces}${path}`
    }
  )
  if (replaced !== 1)
    throw new Error("Expected exactly one reference-contract SHA256SUMS entry")

  // All build and metadata checks finish before changing the committed artifacts.
  await writeFile(join(vendor, filename), contents)
  await writeFile(sumsPath, updatedSums)
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  process.stdout.write(
    `Vendored ${name} from PDP-Connect/pdpp@${commit}\nSHA256 ${sha256}\n`
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
