/**
 * Custom Personal Server routes that may disclose owner identity or mutate
 * Gateway state. They use the ephemeral dev token that createServer() already
 * emits for the desktop client's authenticated library routes.
 */

export function requireDesktopAuth(devToken) {
  return async (c, next) => {
    if (!devToken || c.req.header("authorization") !== `Bearer ${devToken}`) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    await next()
  }
}

export function registerProtectedRoutes({
  app,
  devToken,
  gatewayClient,
  ownerAddress,
  port,
  send,
  serverSigner,
  onLegacyGrantRevoked,
}) {
  const desktopAuth = requireDesktopAuth(devToken)

  app.delete("/v1/grants/:grantId", desktopAuth, async c => {
    if (!serverSigner) {
      return c.json(
        { error: "Server not configured for signing (no master key)" },
        500
      )
    }
    if (!gatewayClient) {
      return c.json({ error: "Gateway client not initialized" }, 500)
    }

    const grantId = c.req.param("grantId")

    try {
      const signature = await serverSigner.signGrantRevocation({
        grantorAddress: ownerAddress,
        grantId,
      })

      await gatewayClient.revokeGrant({
        grantId,
        grantorAddress: ownerAddress,
        signature,
      })

      // The local token is never revoked if the authoritative Gateway revoke
      // fails. Keeping this after the awaited Gateway call preserves that
      // principal-bound lifecycle invariant.
      await onLegacyGrantRevoked?.(grantId)

      return c.body(null, 204)
    } catch (err) {
      const message = err?.message || String(err)
      send({
        type: "log",
        message: `[DELETE /v1/grants/${grantId}] Error: ${message}`,
      })
      return c.json({ error: message }, 500)
    }
  })

  app.get("/status", desktopAuth, c =>
    c.json({
      status: "healthy",
      owner: ownerAddress || null,
      port,
    })
  )
}
