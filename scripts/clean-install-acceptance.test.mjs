// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CONSOLE_PORT_FILE,
  OWNER_SET_MARKER,
  UNIFIED_DB,
  checkOnce,
} from "./clean-install-acceptance.mjs"

function fakeConsole(overrides = {}) {
  const routes = {
    "/": res => {
      res.writeHead(307, { location: "/owner/login?return_to=%2F" })
      res.end()
    },
    "/.well-known/oauth-authorization-server": res => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          issuer: "http://127.0.0.1:1",
          token_endpoint: "http://127.0.0.1:1/token",
        })
      )
    },
    "/.well-known/oauth-protected-resource": res => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ resource: "http://127.0.0.1:2" }))
    },
    ...overrides,
  }
  const server = createServer((req, res) => {
    const route = routes[req.url]
    if (route) return route(res)
    res.writeHead(404)
    res.end()
  })
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(server))
  )
}

describe("clean-install acceptance", () => {
  let dir
  let server
  let logFile

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clean-install-"))
    mkdirSync(path.join(dir, "unified"))
    logFile = path.join(dir, "DataConnect.log")
    writeFileSync(
      logFile,
      "[INFO] Owner credential: load_or_create exit duration_ms=12 ok=true\n"
    )
    writeFileSync(path.join(dir, UNIFIED_DB), "x")
  })

  afterEach(() => {
    server?.close()
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  async function startConsole(overrides) {
    server = await fakeConsole(overrides)
    writeFileSync(
      path.join(dir, CONSOLE_PORT_FILE),
      JSON.stringify({ port: server.address().port })
    )
  }

  it("accepts a first-run install whose sidecars answer", async () => {
    await startConsole()
    const { failures, evidence } = await checkOnce(dir, { logFile })
    expect(failures).toEqual([])
    expect(evidence.consoleRoot.status).toBe(307)
  })

  it("rejects an install where the owner password is already set", async () => {
    await startConsole()
    writeFileSync(path.join(dir, OWNER_SET_MARKER), "{}")
    const { failures } = await checkOnce(dir, { logFile })
    expect(failures.join()).toContain(OWNER_SET_MARKER)
  })

  it("rejects a console that serves the dashboard without owner login", async () => {
    await startConsole({
      "/": res => {
        res.writeHead(200)
        res.end("dashboard")
      },
    })
    const { failures } = await checkOnce(dir, { logFile })
    expect(failures.join()).toContain("expected 307 to /owner/login")
  })

  it("rejects a console whose reference-implementation proxy fails", async () => {
    await startConsole({
      "/.well-known/oauth-authorization-server": res => {
        res.writeHead(502)
        res.end()
      },
    })
    const { failures } = await checkOnce(dir, { logFile })
    expect(failures.join()).toContain("AS metadata via console")
  })

  it("rejects an install whose owner credential failed to load", async () => {
    await startConsole()
    writeFileSync(
      logFile,
      "[INFO] Owner credential: load_or_create exit duration_ms=12 ok=false\n"
    )
    const { failures } = await checkOnce(dir, { logFile })
    expect(failures.join()).toContain("owner credential as ready")
  })

  it("rejects an install whose console never wrote its port", async () => {
    const { failures } = await checkOnce(dir, { logFile })
    expect(failures.join()).toContain(CONSOLE_PORT_FILE)
  })
})
