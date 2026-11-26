// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { request } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { startHostReachability } from "../server/reachability/host.ts"
import { SERVICE_CHALLENGE_PATH } from "../server/reachability/service-challenge.ts"
import { closeTestServer } from "./helpers/close-test-server.ts"
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts"

const KEY_ENV = { PDPP_CREDENTIAL_ENCRYPTION_KEY: "boot-test-key-material-0123456789" }

function temp(): string {
  return mkdtempSync(join(tmpdir(), "reachability-host-boot-"))
}
const base = (dataDir: string, env: NodeJS.ProcessEnv = KEY_ENV) => ({
  bindHost: "127.0.0.1",
  dataDir,
  env,
  owner: "host-test-owner",
  passwordConfigured: false,
  rsPort: 7663,
})
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}
function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ headers: { host }, host: "127.0.0.1", path, port }, (res) => {
      let body = ""
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }))
    })
    req.on("error", reject)
    req.end()
  })
}

test("the server row declares what a headless host can honestly do", async () => {
  const dataDir = temp()
  try {
    const host = await startHostReachability({ ...base(dataDir), profile: "server" })
    assert.ok(host)
    const caps = host.service?.capabilities()
    assert.deepEqual(caps?.["installer.execute"], { known: true, value: false })
    assert.deepEqual(caps?.["privilege.elevate"], { known: true, value: false })
    assert.deepEqual(caps?.["runtime.attached"], { known: true, value: true })
    assert.deepEqual(caps?.["runtime.durable"], { known: true, value: true })
    assert.deepEqual(caps?.["secrets.backend"], { known: true, value: true })
    assert.deepEqual(host.usage("attached"), { kind: "attached" })
    assert.equal(host.usage("durable").kind, "durable")
    assert.throws(() => host.usage("session"), { code: "invalid_input" })
    // The desktop-only bridges are absent: no settings bridge, no state-path report, no password hook.
    assert.equal(host.passwordSet, undefined)
    assert.equal(host.statePaths, undefined)
    assert.equal(typeof host.serviceVerifier, "function")
    assert.equal(host.service?.state().lifecycle.confinement.known, true)
  } finally {
    rmSync(dataDir, { force: true, recursive: true })
  }
})

test("a missing key still starts the server row with the sealed backend", async () => {
  const dataDir = temp()
  try {
    const host = await startHostReachability({ ...base(dataDir, {}), profile: "server" })
    assert.ok(host)
    assert.deepEqual(host.service?.capabilities()["secrets.backend"], { known: true, value: true })
  } finally {
    rmSync(dataDir, { force: true, recursive: true })
  }
})

test("no host row starts unless the process asks for one or a desktop supervisor is present", async () => {
  const dataDir = temp()
  try {
    // An embedding process (a test, a tool) that does not ask gets no route host.
    assert.equal(await startHostReachability(base(dataDir)), undefined)
    // A server cannot name a route target on an ephemeral port.
    assert.equal(await startHostReachability({ ...base(dataDir), profile: "server", rsPort: 0 }), undefined)
    // The desktop flag selects the desktop row, never the server row; without its supervisor it stays off.
    assert.equal(
      await startHostReachability({ ...base(dataDir, { ...KEY_ENV, PDPP_MANAGED_DESKTOP_HOST: "1" }), profile: "server" }),
      undefined
    )
  } finally {
    rmSync(dataDir, { force: true, recursive: true })
  }
})

test("the server answers the service challenge on its RS port only for an approved Host", async () => {
  const dataDir = temp()
  const previous = process.env.PDPP_DATA_DIR
  process.env.PDPP_DATA_DIR = dataDir
  const rsPort = await freePort()
  const { startServer } = await import("../server/index.ts")
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    reachabilityProfile: "server",
    rsPort,
  })
  try {
    const nonce = "ab".repeat(32)
    // The route is mounted on the RS port, but no review or route approves this Host.
    const answer = await get(rsPort, `${SERVICE_CHALLENGE_PATH}?nonce=${nonce}`, "vault.example.com")
    assert.equal(answer.status, 404, answer.body)
    // The challenge route's own refusal, not the resource server's generic not-found: the route is mounted.
    assert.equal(answer.body, '{"error":{"code":"not_found"}}')
    assert.equal((await get(rsPort, SERVICE_CHALLENGE_PATH, "vault.example.com")).status, 404)
    assert.equal((await get(rsPort, `${SERVICE_CHALLENGE_PATH}?nonce=${nonce}`, "bad host!")).status, 404)
  } finally {
    await server.stopReachability()
    await closeTestServer(server)
    if (previous === undefined) {
      delete process.env.PDPP_DATA_DIR
    } else {
      process.env.PDPP_DATA_DIR = previous
    }
    rmSync(dataDir, { force: true, recursive: true })
  }
})
