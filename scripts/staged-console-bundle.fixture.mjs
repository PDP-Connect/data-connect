// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test fixtures for check-staged-console-connectors.mjs: a minimal Next server
// bundle whose one module requires the optional connector package the way the
// bundled polyfill-connectors-runtime.ts does, and a minimal connector package.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const WEBPACK_RUNTIME = `"use strict"
const factories = {}
const cache = {}
function webpackRequire(id) {
  if (cache[id]) return cache[id].exports
  const module = (cache[id] = { exports: {} })
  factories[id](module, module.exports, webpackRequire)
  return module.exports
}
webpackRequire.m = factories
webpackRequire.C = chunk => Object.assign(factories, chunk.modules)
module.exports = webpackRequire
`

/**
 * Writes `.next/server` under `runtimeDirectory` (the directory of server.js).
 * `resolveFrom` is the base the bundled module resolves the package from: null
 * for the process cwd (the fixed runtime), or an absolute file path (the
 * build-time `import.meta.url` webpack wrote into the shipped bundle).
 * `predicate` is the roster predicate the module exports: "supported"
 * (isSupportedBrowserCollectorConnector) or "scaffold"
 * (isKnownScaffoldConnector).
 */
export function writeConsoleServerBundle(
  runtimeDirectory,
  { predicate = "supported", resolveFrom = null } = {}
) {
  const serverDirectory = join(runtimeDirectory, ".next", "server")
  mkdirSync(join(serverDirectory, "chunks"), { recursive: true })
  writeFileSync(join(serverDirectory, "webpack-runtime.js"), WEBPACK_RUNTIME)
  writeFileSync(
    join(serverDirectory, "chunks", "100.js"),
    `"use strict"
exports.id = 100
exports.ids = [100]
exports.modules = {
  100: (module, exports) => {
    const { createRequire } = require("node:module")
    const { join } = require("node:path")
    const base = ${JSON.stringify(resolveFrom)}
    const load = createRequire(base ?? join(process.cwd(), "noop.js"))
    const optional = specifier => {
      try {
        return load(specifier)
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") return null
        throw error
      }
    }
    const roster = optional("@pdpp/polyfill-connectors/connector-conformance-roster")
    optional("@pdpp/polyfill-connectors/static-secret-credential-capture")
    optional("@pdpp/polyfill-connectors/credential-probe")
    const ready = roster?.PRODUCTION_READY_CONNECTORS ?? {}
    const scaffolds = roster?.KNOWN_SCAFFOLD_CONNECTORS ?? []
    exports.predicate = ${JSON.stringify(predicate)} === "supported"
      ? connector => Object.hasOwn(ready, connector)
      : connector => scaffolds.includes(connector)
  },
}
`
  )
}

/**
 * Writes package.json and the three modules the console bundle reads into
 * `packageDirectory` (an `@pdpp/polyfill-connectors` directory).
 */
export function writeConnectorPackageModules(packageDirectory) {
  mkdirSync(join(packageDirectory, "src"), { recursive: true })
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@pdpp/polyfill-connectors",
        type: "module",
        exports: {
          "./connector-conformance-roster":
            "./src/connector-conformance-roster.js",
          "./credential-probe": "./src/credential-probe.js",
          "./static-secret-credential-capture":
            "./src/static-secret-credential-capture.js",
        },
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(packageDirectory, "src", "connector-conformance-roster.js"),
    'export const PRODUCTION_READY_CONNECTORS = { reddit: { testFile: "reddit.test.ts" } }\nexport const KNOWN_SCAFFOLD_CONNECTORS = ["anthropic"]\n'
  )
  writeFileSync(
    join(packageDirectory, "src", "credential-probe.js"),
    'export function credentialValidationMode() { return "first_sync" }\n'
  )
  writeFileSync(
    join(packageDirectory, "src", "static-secret-credential-capture.js"),
    "export function normalizeStaticSecretCredentialCapture() { return null }\n"
  )
}
