#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs"
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

async function waitForConsole(port, child) {
  const url = `http://127.0.0.1:${port}/`
  let lastError = "console did not answer"
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html" },
        redirect: "manual",
      })
      const location = response.headers.get("location") || ""
      if (
        response.status === 200 ||
        (response.status >= 300 &&
          response.status < 400 &&
          location.includes("/owner/login"))
      ) {
        return { location, status: response.status }
      }
      lastError = `unexpected console response: ${response.status} ${location}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(lastError)
}

async function fetchConsole(port, pathname) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual" })
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
