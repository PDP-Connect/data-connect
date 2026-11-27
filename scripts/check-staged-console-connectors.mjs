// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Checks that a staged console can load the optional @pdpp/polyfill-connectors
// modules it needs, using only files inside the stage.
//
// The console bundles reference-implementation/server/polyfill-connectors-
// runtime.ts. If that module cannot resolve a connector package module, nothing
// fails loudly: the runtime module treats a missing package as "package
// absent", so credential checks quietly fall back to their defaults. A build
// machine always has the package in its checkout, so the probe blocks every
// resolution that leaves the stage, the same as on an owner's machine.
//
// The probe runs in a child process with the launcher's cwd (the directory of
// server.js, see writeLauncher in ensure-console-stack.js). It installs every
// server chunk into the bundle's webpack runtime, evaluates the modules that
// require the credential probe, and reports what they resolved. Evaluation takes a few
// milliseconds and starts no server.

import { spawnSync } from "node:child_process"
import { readdirSync, realpathSync } from "node:fs"
import { createRequire, registerHooks } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

const PACKAGE_PREFIX = "@pdpp/polyfill-connectors/"
// Only the bundled polyfill-connectors-runtime.ts names this subpath, so it
// selects the modules to evaluate.
const CREDENTIAL_PROBE_SPECIFIER = `${PACKAGE_PREFIX}credential-probe`
// The subpaths whose members the console bundle reads. Keep in step with
// CONSOLE_CONNECTOR_PACKAGE_MODULES in ensure-console-stack.js.
const REQUIRED_CONSOLE_CONNECTOR_SPECIFIERS = [
  `${PACKAGE_PREFIX}static-secret-credential-capture`,
  CREDENTIAL_PROBE_SPECIFIER,
]
const RESULT_PREFIX = "[check-staged-console-connectors] result "

function isInside(root, candidate) {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function confineResolutionToStage(stageRoot, resolutions) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const isPackageModule = specifier.startsWith(PACKAGE_PREFIX)
      const recordFailure = () => {
        if (isPackageModule && !(specifier in resolutions)) {
          resolutions[specifier] = null
        }
      }
      let result
      try {
        result = nextResolve(specifier, context)
      } catch (error) {
        recordFailure()
        throw error
      }
      if (
        result.url.startsWith("file:") &&
        !isInside(stageRoot, fileURLToPath(result.url))
      ) {
        recordFailure()
        const error = new Error(
          `Cannot find module '${specifier}' inside the staged console (it resolved outside the stage, to ${result.url})`
        )
        error.code = "MODULE_NOT_FOUND"
        throw error
      }
      if (isPackageModule) resolutions[specifier] = result.url
      return result
    },
  })
}

async function probe(serverDirectory, stageRoot) {
  const resolutions = {}
  confineResolutionToStage(stageRoot, resolutions)

  const requireFromServer = createRequire(join(serverDirectory, "server.js"))
  const webpackRequire = requireFromServer("./.next/server/webpack-runtime.js")
  const chunksDirectory = join(serverDirectory, ".next", "server", "chunks")
  for (const name of readdirSync(chunksDirectory).sort()) {
    if (name.endsWith(".js")) {
      webpackRequire.C(requireFromServer(join(chunksDirectory, name)))
    }
  }
  const moduleIds = Object.keys(webpackRequire.m).filter(id =>
    String(webpackRequire.m[id]).includes(
      JSON.stringify(CREDENTIAL_PROBE_SPECIFIER)
    )
  )
  // Evaluating each module records which package subpaths it resolved.
  for (const id of moduleIds) {
    webpackRequire(id)
  }
  return {
    moduleIds,
    resolutions,
  }
}

/**
 * Throws unless the staged console under `stageRoot` resolves the connector
 * package modules it needs from inside the stage.
 */
export function assertStagedConsoleConnectors({
  stageRoot,
  serverRelativePath,
  label = "staged console",
}) {
  const root = resolve(stageRoot)
  const serverDirectory = dirname(join(root, serverRelativePath))
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), serverDirectory, root],
    {
      cwd: serverDirectory,
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
    }
  )
  const line = (child.stdout ?? "")
    .split("\n")
    .find(output => output.startsWith(RESULT_PREFIX))
  if (child.status !== 0 || !line) {
    throw new Error(
      `${label}: the connector module probe failed (status ${child.status}): ${child.stderr || child.stdout}`
    )
  }
  const result = JSON.parse(line.slice(RESULT_PREFIX.length))
  const problems = []
  if (result.moduleIds.length === 0) {
    problems.push(`no bundled module requires ${CREDENTIAL_PROBE_SPECIFIER}`)
  }
  for (const specifier of REQUIRED_CONSOLE_CONNECTOR_SPECIFIERS) {
    if (!result.resolutions[specifier]) {
      problems.push(`${specifier} does not resolve inside the stage`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${label} cannot load @pdpp/polyfill-connectors: ${problems.join("; ")}`
    )
  }
  return result
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [serverDirectory, stageRoot] = process.argv.slice(2)
  // Node reports resolved modules by real path (macOS tmpdir is a symlink).
  const result = await probe(
    resolve(serverDirectory),
    realpathSync(resolve(stageRoot))
  )
  // Bundled modules may leave timers behind; exit once the result is out.
  process.stdout.write(`\n${RESULT_PREFIX}${JSON.stringify(result)}\n`, () =>
    process.exit(0)
  )
}
