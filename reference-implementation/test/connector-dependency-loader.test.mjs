// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { connectorChildArgs } from "../connector-dependency-loader.mjs"

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const loaderFiles = [
  "connector-dependency-loader.mjs",
  "connector-dependency-loader-bootstrap.mjs",
]

test("installed connectors import shared ESM dependencies from the staged RI", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "installed-connector-deps-"))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  const runtimeRoot = join(fixtureRoot, "reference-stack", "ri")
  const runtimeReferenceImplementation = join(runtimeRoot, "reference-implementation")
  const connectorRoot = join(
    fixtureRoot,
    "home",
    "data",
    "unified",
    "connectors",
    "reddit",
    "sha256:fixture"
  )
  const packageRoot = join(runtimeRoot, "node_modules", "patchright")
  const connectorEntrypoint = join(connectorRoot, "connector.mjs")
  mkdirSync(join(runtimeReferenceImplementation, "server"), {
    recursive: true,
  })
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(connectorRoot, { recursive: true })
  mkdirSync(join(runtimeRoot, "node_modules", "tsx"), { recursive: true })
  writeFileSync(join(runtimeReferenceImplementation, "server", "index.ts"), "export {}\n")
  for (const file of loaderFiles) {
    cpSync(join(sourceRoot, file), join(runtimeReferenceImplementation, file))
  }
  writeFileSync(
    join(runtimeRoot, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: "./index.mjs" })
  )
  writeFileSync(join(runtimeRoot, "node_modules", "tsx", "index.mjs"), "export {}\n")
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "patchright",
      type: "module",
      exports: { ".": { import: "./index.mjs" } },
    })
  )
  writeFileSync(
    join(packageRoot, "index.mjs"),
    'export const marker = "bundled patchright"\n'
  )
  writeFileSync(
    connectorEntrypoint,
    'const { marker } = await import("patchright"); process.stdout.write(marker)\n'
  )
  const unhooked = spawnSync(process.execPath, [connectorEntrypoint], {
    cwd: connectorRoot,
    encoding: "utf8",
    env: {},
  })
  assert.notEqual(unhooked.status, 0)
  assert.match(unhooked.stderr, /Cannot find package 'patchright'/)

  const packaged = spawnSync(
    process.execPath,
    connectorChildArgs(
      connectorEntrypoint,
      pathToFileURL(
        join(runtimeReferenceImplementation, "connector-dependency-loader-bootstrap.mjs")
      ).href
    ),
    {
      cwd: connectorRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    }
  )
  assert.equal(
    packaged.status,
    0,
    `generated RI launcher failed: ${packaged.stderr}`
  )
  assert.match(packaged.stdout, /bundled patchright$/)
})
