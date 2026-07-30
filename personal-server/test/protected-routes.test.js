import assert from "node:assert/strict"
import { once } from "node:events"
import test from "node:test"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { registerProtectedRoutes } from "../protected-routes.js"

const DEV_TOKEN = "desktop-dev-token"
const OWNER = "0x1234567890abcdef1234567890abcdef12345678"

async function startServer() {
  const app = new Hono()
  const revocations = []
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
  await once(server, "listening")

  registerProtectedRoutes({
    app,
    devToken: DEV_TOKEN,
    gatewayClient: {
      async revokeGrant(request) {
        revocations.push(request)
      },
    },
    ownerAddress: OWNER,
    port: server.address().port,
    send() {},
    serverSigner: {
      async signGrantRevocation() {
        return "revocation-signature"
      },
    },
  })

  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    revocations,
    async close() {
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}

function tunnelHeaders() {
  return {
    Host: `${OWNER}.server.vana.org`,
    "X-Forwarded-For": "127.0.0.1",
    "X-Forwarded-Host": `${OWNER}.server.vana.org`,
    "X-Forwarded-Proto": "https",
  }
}

test("anonymous local and tunnel-shaped requests cannot revoke grants or read owner identity", async t => {
  const server = await startServer()
  t.after(() => server.close())

  for (const headers of [{}, tunnelHeaders()]) {
    const revokeResponse = await fetch(`${server.origin}/v1/grants/grant-1`, {
      method: "DELETE",
      headers,
    })
    assert.equal(revokeResponse.status, 401)
    assert.equal(server.revocations.length, 0)

    const statusResponse = await fetch(`${server.origin}/status`, { headers })
    assert.equal(statusResponse.status, 401)
    assert.equal((await statusResponse.text()).includes(OWNER), false)
  }
})

test("an authorized desktop request can revoke and read the owner status", async t => {
  const server = await startServer()
  t.after(() => server.close())

  const headers = { Authorization: `Bearer ${DEV_TOKEN}` }
  const revokeResponse = await fetch(`${server.origin}/v1/grants/grant-1`, {
    method: "DELETE",
    headers,
  })
  assert.equal(revokeResponse.status, 204)
  assert.deepEqual(server.revocations, [
    {
      grantId: "grant-1",
      grantorAddress: OWNER,
      signature: "revocation-signature",
    },
  ])

  const statusResponse = await fetch(`${server.origin}/status`, { headers })
  assert.equal(statusResponse.status, 200)
  assert.deepEqual(await statusResponse.json(), {
    status: "healthy",
    owner: OWNER,
    port: Number(new URL(server.origin).port),
  })
})
