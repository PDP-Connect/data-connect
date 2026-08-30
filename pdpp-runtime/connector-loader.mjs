// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const runtimeRoot = process.env.DATACONNECT_PDPP_RUNTIME_ROOT
if (!runtimeRoot) throw new Error("DATACONNECT_PDPP_RUNTIME_ROOT is required")

const resolveFromRuntime = createRequire(`${runtimeRoot}/package.json`)
const patchrightPackageUrl = pathToFileURL(
  resolveFromRuntime.resolve("patchright/package.json")
)
const patchrightPackage = JSON.parse(
  readFileSync(fileURLToPath(patchrightPackageUrl), "utf8")
)
const patchrightEsmEntry = patchrightPackage.exports?.["."]?.import
if (typeof patchrightEsmEntry !== "string") {
  throw new Error("Packaged patchright must declare an ESM import entry")
}

function resolveExternal(specifier) {
  if (specifier === "p-queue") {
    return pathToFileURL(resolveFromRuntime.resolve(specifier)).href
  }
  if (specifier === "patchright") {
    // createRequire.resolve() selects the require condition, which turns a
    // dynamic ESM import into a CommonJS namespace with chromium only under
    // default. The authoritative ChatGPT runtime destructures chromium, so
    // preserve patchright's declared import condition exactly.
    return new URL(patchrightEsmEntry, patchrightPackageUrl).href
  }
}

export async function resolve(specifier, context, nextResolve) {
  const external = resolveExternal(specifier)
  if (external) {
    return {
      url: external,
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
