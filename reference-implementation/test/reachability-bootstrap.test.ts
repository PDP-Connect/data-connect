// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ReachabilityService } from "../server/reachability/service.ts"
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts"

test("server startup forwards the trusted reachability service to authenticated owner routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reachability-bootstrap-"))
  const before = process.env.PDPP_DATA_DIR
  process.env.PDPP_DATA_DIR = root
  const { startServer } = await import("../server/index.ts")
  const expected = { "fixture.authority": { known: true, value: false } }
  let reads = 0
  const service = {
    capabilities: () => {
      reads++
      return expected
    },
  } as unknown as ReachabilityService
  const server = await startServer({
    asPort: 0,
    rsPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    reachability: { service, usage: () => ({ kind: "attached" }) },
  })
  const post = async (path: string, body: Record<string, string>) =>
    (
      await fetch(`http://127.0.0.1:${server.asPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<Record<string, string>>
  try {
    const device = await post("/oauth/device_authorization", {
      client_id: "cli_longview",
    })
    await fetch(`http://127.0.0.1:${server.asPort}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_code: device.user_code,
        subject_id: "owner_local",
      }),
    })
    assert.equal(typeof device.device_code, "string")
    const token = await post("/oauth/token", {
      client_id: "cli_longview",
      device_code: device.device_code!,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    assert.equal(typeof token.access_token, "string")
    const result = await fetch(
      `http://127.0.0.1:${server.rsPort}/v1/owner/reachability/host-capabilities`,
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    )
    assert.equal(result.status, 200, await result.clone().text())
    assert.deepEqual(await result.json(), { data: expected })
    assert.equal(reads, 1)
  } finally {
    server.asServer.closeAllConnections()
    server.rsServer.closeAllConnections()
    await Promise.all([
      new Promise(resolve => server.asServer.close(resolve)),
      new Promise(resolve => server.rsServer.close(resolve)),
    ])
    if (before === undefined) delete process.env.PDPP_DATA_DIR
    else process.env.PDPP_DATA_DIR = before
    await rm(root, { recursive: true, force: true })
  }
})
