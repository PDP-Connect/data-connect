#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

function parseArgs(argv) {
  let profile = "release"
  let nodeBinary = join(PROJECT_ROOT, "src-tauri", "binaries", "pdpp-node")
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--profile") profile = argv[++index]
    else if (argument === "--node") nodeBinary = argv[++index]
    else throw new Error(`unknown argument: ${argument}`)
  }
  return { nodeBinary, profile }
}

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : null
  await new Promise((resolveClose, rejectClose) =>
    server.close(error => (error ? rejectClose(error) : resolveClose()))
  )
  if (!port) throw new Error("failed to allocate a free port")
  return port
}

function isOwnerLoginRedirect(location) {
  if (!location) return false
  try {
    return new URL(location, "http://127.0.0.1").pathname === "/owner/login"
  } catch {
    return false
  }
}

async function assertConsoleRootResponse(response) {
  const location = response.headers.get("location") || ""
  if (response.status >= 300 && response.status < 400) {
    if (!isOwnerLoginRedirect(location)) {
      throw new Error(
        `console root redirected outside the owner console: ${response.status} ${location}`
      )
    }
    return { location, status: response.status }
  }
  if (response.status !== 200) return null

  const contentType = response.headers.get("content-type") || ""
  const body = await response.text()
  if (
    !contentType.toLowerCase().includes("text/html") ||
    !/<(?:!doctype\s+html|html\b)/i.test(body)
  ) {
    throw new Error(
      `console root must be HTML, not JSON or another API response: ${response.status} ${contentType}`
    )
  }
  return { location, status: response.status }
}

async function waitForConsole(port, child) {
  const url = `http://127.0.0.1:${port}/`
  let lastError = "console did not answer"
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break
    let response
    try {
      response = await fetch(url, {
        headers: { accept: "text/html" },
        redirect: "manual",
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
      continue
    }

    const root = await assertConsoleRootResponse(response)
    const location = response.headers.get("location") || ""
    if (root) return root
    lastError = `unexpected console response: ${response.status} ${location}`
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(lastError)
}

async function fetchConsole(port, pathname) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual" })
}

async function assertAgentRoutes(port) {
  const catalogResponse = await fetchConsole(port, "/.well-known/skills/index.json")
  if (catalogResponse.status !== 200) {
    throw new Error(`agent skill catalog failed: ${catalogResponse.status}`)
  }
  const catalog = await catalogResponse.json()
  const files = catalog.skills?.flatMap(skill => skill.files || []) || []
  if (files.length === 0) throw new Error("agent skill catalog is empty")

  for (const file of files) {
    const pathname = new URL(file.url).pathname
    const response = await fetchConsole(port, pathname)
    if (response.status !== 200) {
      throw new Error(`traced agent skill file failed: ${pathname} (${response.status})`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    const digest = createHash("sha256").update(body).digest("hex")
    if (body.byteLength !== file.bytes || digest !== file.sha256) {
      throw new Error(`traced agent skill file does not match its catalog marker: ${pathname}`)
    }
  }

  const fullTextResponse = await fetchConsole(port, "/llms-full.txt")
  if (fullTextResponse.status !== 200) {
    throw new Error(`full agent skill index failed: ${fullTextResponse.status}`)
  }
  const fullText = await fullTextResponse.text()
  for (const file of files) {
    if (!fullText.includes(`## ${file.repo_path}`)) {
      throw new Error(`full agent skill index is missing ${file.repo_path}`)
    }
  }
}

export async function smokeConsoleStack({
  nodeBinary,
  profile = "release",
  projectRoot = PROJECT_ROOT,
} = {}) {
  const resolvedNodeBinary = resolve(
    nodeBinary || join(projectRoot, "src-tauri", "binaries", "pdpp-node")
  )
  if (!existsSync(resolvedNodeBinary)) {
    throw new Error(`Node sidecar is missing: ${resolvedNodeBinary}`)
  }

  const stageDirectory = join(
    projectRoot,
    "src-tauri",
    "target",
    profile,
    "reference-stack",
    "console"
  )
  const launcher = join(stageDirectory, "launch.mjs")
  if (!existsSync(launcher))
    throw new Error(`staged console launcher is missing: ${launcher}`)

  const referenceStub = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  referenceStub.listen(0, "127.0.0.1")
  await once(referenceStub, "listening")
  const referenceAddress = referenceStub.address()
  const referencePort =
    typeof referenceAddress === "object" && referenceAddress
      ? referenceAddress.port
      : null
  if (!referencePort)
    throw new Error("failed to allocate the reference stub port")

  const consolePort = await freePort()
  const referenceUrl = `http://127.0.0.1:${referencePort}`
  const child = spawn(resolvedNodeBinary, [launcher], {
    cwd: stageDirectory,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PDPP_AS_URL: referenceUrl,
      PDPP_REFERENCE_ORIGIN: `http://127.0.0.1:${consolePort}`,
      PDPP_RS_URL: referenceUrl,
      PORT: String(consolePort),
    },
    stdio: "inherit",
  })

  try {
    const response = await waitForConsole(consolePort, child)
    const favicon = await fetchConsole(consolePort, "/favicon.ico")
    if (
      favicon.status < 300 ||
      favicon.status >= 400 ||
      favicon.headers.get("location") !== "/brand/pdpp-favicon.svg"
    ) {
      throw new Error(
        `favicon redirect did not resolve: ${favicon.status} ${favicon.headers.get("location") || ""}`
      )
    }
    for (const pathname of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/example",
      "/.well-known/llms.txt",
    ]) {
      const rewrite = await fetchConsole(consolePort, pathname)
      if (rewrite.status !== 200)
        throw new Error(`rewrite failed for ${pathname}: ${rewrite.status}`)
    }
    await assertAgentRoutes(consolePort)
    return { response, stageDirectory }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await once(child, "exit").catch(() => undefined)
    }
    await new Promise((resolveClose, rejectClose) =>
      referenceStub.close(error =>
        error ? rejectClose(error) : resolveClose()
      )
    )
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  smokeConsoleStack(parseArgs(process.argv.slice(2)))
    .then(({ response, stageDirectory }) => {
      console.log(
        `[console-stack-smoke] ${response.status} ${response.location || "/"}`
      )
      console.log(`[console-stack-smoke] verified ${stageDirectory}`)
    })
    .catch(error => {
      console.error(`[console-stack-smoke] ${error.message}`)
      process.exitCode = 1
    })
}
