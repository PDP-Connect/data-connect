import assert from "node:assert/strict"
import { once } from "node:events"
import test from "node:test"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { registerProtectedRoutes } from "../protected-routes.js"

const DEV_TOKEN = "desktop-dev-token"
const OWNER = "0x1234567890abcdef1234567890abcdef12345678"

async function startServer({ revokeError } = {}) {
  const app = new Hono()
  const revocations = []
  const localRevocations = []
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
  await once(server, "listening")

  registerProtectedRoutes({
    app,
    devToken: DEV_TOKEN,
    gatewayClient: {
      async revokeGrant(request) {
        revocations.push(request)
        if (revokeError) throw revokeError
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
    onLegacyGrantRevoked(grantId) {
      localRevocations.push(grantId)
    },
  })

  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    revocations,
    localRevocations,
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
    assert.deepEqual(server.localRevocations, [])

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
  assert.deepEqual(server.localRevocations, ["grant-1"])

  const statusResponse = await fetch(`${server.origin}/status`, { headers })
  assert.equal(statusResponse.status, 200)
  assert.deepEqual(await statusResponse.json(), {
    status: "healthy",
    owner: OWNER,
    port: Number(new URL(server.origin).port),
  })
})

test("revokes the local token when the Gateway revoke fails", async t => {
  const server = await startServer({
    revokeError: new Error("gateway unavailable"),
  })
  t.after(() => server.close())

  const response = await fetch(`${server.origin}/v1/grants/grant-1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${DEV_TOKEN}` },
  })

  assert.equal(response.status, 500)
  assert.deepEqual(server.localRevocations, ["grant-1"])
  assert.deepEqual(
    server.revocations.map(({ grantId }) => grantId),
    ["grant-1"]
  )
})

test("does not call Gateway when local revocation cannot be recorded", async t => {
  const app = new Hono()
  const revocations = []
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
  await once(server, "listening")
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
  )

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
    onLegacyGrantRevoked() {
      throw new Error("local store unavailable")
    },
  })

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v1/grants/grant-1`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    }
  )

  assert.equal(response.status, 500)
  assert.equal((await response.json()).error, "local store unavailable")
  assert.deepEqual(revocations, [])
})
