import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { Hono } from "hono"
import { privateKeyToAccount } from "viem/accounts"

import { registerGithubAuthorizationRoutes } from "./http-routes.js"

const TEST_BUILDER = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123"
)

function hash(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

async function redemptionAuthorization({ origin, sessionId }) {
  const payloadBase64 = Buffer.from(
    JSON.stringify({
      aud: origin,
      bodyHash: hash(""),
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      method: "POST",
      uri: `/v1/pdpp/credentials/${encodeURIComponent(sessionId)}/redeem`,
    })
  ).toString("base64url")
  const signature = await TEST_BUILDER.signMessage({ message: payloadBase64 })
  return `Web3Signed ${payloadBase64}.${signature}`
}

function createRedemptionApp({ externalOrigin } = {}) {
  const app = new Hono()
  const redemptions = []
  registerGithubAuthorizationRoutes({
    app,
    devToken: "desktop-token",
    externalOrigin,
    adapter: {
      redeemSessionCredential(redemption) {
        redemptions.push(redemption)
        return { access_token: "pdpp_at_test", token_type: "Bearer" }
      },
    },
  })
  return { app, redemptions }
}

test("credential redemption accepts direct local request origin", async () => {
  const { app, redemptions } = createRedemptionApp()
  const authorization = await redemptionAuthorization({
    origin: "http://127.0.0.1:8080",
    sessionId: "direct-session",
  })

  const response = await app.request(
    "http://127.0.0.1:8080/v1/pdpp/credentials/direct-session/redeem",
    { method: "POST", headers: { authorization } }
  )

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(redemptions[0].sessionId, "direct-session")
  assert.equal(redemptions[0].clientId, TEST_BUILDER.address.toLowerCase())
})

test("credential redemption canonicalizes owned tunnel host to its HTTPS external origin", async () => {
  const { app } = createRedemptionApp({
    externalOrigin: "https://owner.server.vana.org",
  })
  const authorization = await redemptionAuthorization({
    origin: "https://owner.server.vana.org",
    sessionId: "tunnel-session",
  })

  const response = await app.request(
    "http://owner.server.vana.org/v1/pdpp/credentials/tunnel-session/redeem",
    { method: "POST", headers: { authorization } }
  )

  assert.equal(response.status, 200, await response.clone().text())
})

test("credential redemption ignores spoofed forwarding headers for external origin", async () => {
  const { app } = createRedemptionApp({
    externalOrigin: "https://owner.server.vana.org",
  })
  const authorization = await redemptionAuthorization({
    origin: "https://owner.server.vana.org",
    sessionId: "spoof-session",
  })

  const response = await app.request(
    "http://attacker.example/v1/pdpp/credentials/spoof-session/redeem",
    {
      method: "POST",
      headers: {
        authorization,
        "x-forwarded-host": "owner.server.vana.org",
        "x-forwarded-proto": "https",
      },
    }
  )

  assert.equal(response.status, 403)
})

test("credential redemption rejects HTTP downgrade proofs for owned tunnel host", async () => {
  const { app } = createRedemptionApp({
    externalOrigin: "https://owner.server.vana.org",
  })
  const authorization = await redemptionAuthorization({
    origin: "http://owner.server.vana.org",
    sessionId: "downgrade-session",
  })

  const response = await app.request(
    "http://owner.server.vana.org/v1/pdpp/credentials/downgrade-session/redeem",
    { method: "POST", headers: { authorization } }
  )

  assert.equal(response.status, 403)
})
