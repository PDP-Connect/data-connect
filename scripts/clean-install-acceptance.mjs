#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Check a freshly installed, freshly launched DataConnect. The workflow has
// already proved the VM was fresh (no app-data dir before install).
//
// Owner-password-not-yet-set state (the only first-run claim made here):
// - the app ran: its log records the generated owner credential as ready
//   (kept in the OS keychain, or in a file only as fallback), and
// - no owner-set marker exists, so the owner has not set a password.
// This does NOT render or check the setup UI; that UI is behind owner sign-in.
//
// Bundled sidecars serving (not a first-run claim):
// - the RI created its encrypted database,
// - a logged-out console request is sent to owner sign-in (owner auth on),
// - the console proxies live RI authorization- and resource-server metadata.
// It never authenticates, so it cannot mask a broken owner-auth gate.
//
// Usage: node scripts/clean-install-acceptance.mjs --app-data-dir <dir> --log-file <DataConnect.log> [--timeout-ms 300000]

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { isMainModule } from "./is-main-module.js"

// Names mirror src-tauri/src/owner_credential.rs, console_port.rs and unified.rs.
export const OWNER_SET_MARKER = "owner-password-owner-set.json"
// Logged by load_or_create_secret_with_store in owner_credential.rs.
export const OWNER_CREDENTIAL_READY =
  /Owner credential: load_or_create exit duration_ms=\d+ ok=true/
export const CONSOLE_PORT_FILE = "console-port.json"
export const UNIFIED_DB = path.join("unified", "pdpp.sqlite")

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function readConsolePort(appDataDir) {
  const file = path.join(appDataDir, CONSOLE_PORT_FILE)
  if (!existsSync(file)) return null
  const port = JSON.parse(readFileSync(file, "utf8")).port
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "manual" })
  if (response.status !== 200)
    throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

// One pass over every assertion. Returns failures; empty means accepted.
export async function checkOnce(appDataDir, { logFile }) {
  const failures = []
  const evidence = {}
  const at = name => path.join(appDataDir, name)

  if (existsSync(at(OWNER_SET_MARKER))) {
    failures.push(
      `${OWNER_SET_MARKER} exists: owner password already set on a fresh install`
    )
  }
  if (!existsSync(at(UNIFIED_DB)))
    failures.push(`${UNIFIED_DB} was not created`)
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
  if (!OWNER_CREDENTIAL_READY.test(log)) {
    failures.push(`${logFile} does not record the owner credential as ready`)
  }

  const port = readConsolePort(appDataDir)
  evidence.consolePort = port
  if (port === null) {
    failures.push(
      `${CONSOLE_PORT_FILE} missing or invalid: console sidecar did not start`
    )
    return { failures, evidence }
  }
  const origin = `http://127.0.0.1:${port}`

  try {
    // Owner auth is on: a logged-out console request is sent to sign-in.
    // This is not evidence of the first-run setup UI.
    const root = await fetch(`${origin}/`, { redirect: "manual" })
    const location = root.headers.get("location") ?? ""
    evidence.consoleRoot = { status: root.status, location }
    if (
      root.status !== 307 ||
      !new URL(location, origin).pathname.startsWith("/owner/login")
    ) {
      failures.push(
        `console / returned ${root.status} ${location}; expected 307 to /owner/login`
      )
    }
  } catch (error) {
    failures.push(`console ${origin}/ unreachable: ${error.message}`)
  }

  // The console proxies these to the reference-implementation AS and RS, so a
  // valid body proves the RI sidecar is serving, not merely running.
  try {
    const as = await fetchJson(
      `${origin}/.well-known/oauth-authorization-server`
    )
    evidence.issuer = as.issuer
    if (
      typeof as.issuer !== "string" ||
      typeof as.token_endpoint !== "string"
    ) {
      failures.push("AS metadata lacks issuer/token_endpoint")
    }
  } catch (error) {
    failures.push(`AS metadata via console: ${error.message}`)
  }
  try {
    const rs = await fetchJson(`${origin}/.well-known/oauth-protected-resource`)
    evidence.resource = rs.resource
    if (typeof rs.resource !== "string")
      failures.push("RS metadata lacks resource")
  } catch (error) {
    failures.push(`RS metadata via console: ${error.message}`)
  }

  return { failures, evidence }
}

export async function waitForAcceptance(
  appDataDir,
  { logFile, timeoutMs, intervalMs = 3000, log = console.log }
) {
  const deadline = Date.now() + timeoutMs
  let result
  do {
    result = await checkOnce(appDataDir, { logFile })
    if (result.failures.length === 0) return result
    log(`waiting: ${result.failures.join("; ")}`)
    await sleep(intervalMs)
  } while (Date.now() < deadline)
  return result
}

async function main() {
  const { values } = parseArgs({
    options: {
      "app-data-dir": { type: "string" },
      "log-file": { type: "string" },
      "timeout-ms": { type: "string", default: "240000" },
    },
  })
  if (!values["app-data-dir"] || !values["log-file"]) {
    throw new Error("--app-data-dir and --log-file are required")
  }
  const result = await waitForAcceptance(values["app-data-dir"], {
    logFile: values["log-file"],
    timeoutMs: Number(values["timeout-ms"]),
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.log(`::error::${failure}`)
    process.exit(1)
  }
  console.log("Clean-install acceptance passed")
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
