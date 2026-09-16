#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { verifyReferenceStackRoot } from "./ensure-reference-stack.js"

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      server.close(error => {
        if (error) reject(error)
        else if (port) resolvePort(port)
        else reject(new Error("failed to allocate a free port"))
      })
    })
  })
}

async function waitForHealth(asPort, rsPort, child) {
  const deadline = Date.now() + 30_000
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`RI exited before health check (${child.exitCode})`)
    try {
      const asResponse = await fetch(`http://127.0.0.1:${asPort}/`)
      const rsResponse = await fetch(
        `http://127.0.0.1:${rsPort}/.well-known/oauth-protected-resource`
      )
      if (asResponse.status === 200 && rsResponse.status === 200) return
      lastError = new Error(
        `health routes returned HTTP ${asResponse.status}/${rsResponse.status}`
      )
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw lastError || new Error("RI health route did not respond")
}

function parseRoot(argv) {
  const rootIndex = argv.indexOf("--root")
  if (rootIndex === -1 || !argv[rootIndex + 1]) {
    throw new Error(
      "Usage: node scripts/reference-stack-smoke.mjs --root <staged-ri-root>"
    )
  }
  return resolve(argv[rootIndex + 1])
}

async function runSmoke(root) {
  verifyReferenceStackRoot(root)
  const dataDir = mkdtempSync(join(root, ".smoke-data-"))
  const asPort = await freePort()
  const rsPort = await freePort()
  const nodeBinary = process.env.PDPP_NODE_BINARY || process.execPath
  const child = spawn(nodeBinary, ["launch.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      AS_PORT: String(asPort),
      RS_PORT: String(rsPort),
      PDPP_DATA_DIR: dataDir,
      PDPP_DB_PATH: join(dataDir, "pdpp.sqlite"),
      PDPP_BIND_HOST: "127.0.0.1",
      PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
      PDPP_REFERENCE_OPERATIONAL_DEFAULTS: "1",
      PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: "inherit",
  })
  try {
    await waitForHealth(asPort, rsPort, child)
    console.log(
      `Reference stack health routes returned 200 on ${asPort}/${rsPort}`
    )
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await new Promise(resolveExit => child.once("exit", resolveExit))
    rmSync(dataDir, { force: true, recursive: true })
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSmoke(parseRoot(process.argv.slice(2))).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
