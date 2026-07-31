import { requireDesktopAuth } from "../../protected-routes.js"
import { verifyWeb3SignedRequester } from "./web3-signed.js"

function errorResponse(c, error) {
  return c.json(
    {
      error: error?.message || String(error),
      code: error?.code || "invalid_request",
    },
    400
  )
}

/** Routes are intentionally thin: all policy and persistence stay in the adapter. */
export function registerGithubAuthorizationRoutes({ app, devToken, adapter }) {
  const desktopAuth = requireDesktopAuth(devToken)

  // This route is public only in the HTTP sense. The bearer is released exactly
  // once after a fresh proof from the approved builder address; Session Relay's
  // poll payload remains intentionally unauthenticated and never carries it.
  app.post("/v1/pdpp/credentials/:sessionId/redeem", async c => {
    const sessionId = c.req.param("sessionId")
    const path = `/v1/pdpp/credentials/${encodeURIComponent(sessionId)}/redeem`
    try {
      const requester = await verifyWeb3SignedRequester({
        authorization: c.req.header("authorization"),
        expectedOrigin: new URL(c.req.url).origin,
        expectedPath: path,
      })
      return c.json(
        adapter.redeemSessionCredential({
          sessionId,
          clientId: requester,
        })
      )
    } catch {
      return c.json(
        { error: "Credential redemption was rejected", code: "invalid_grant" },
        403
      )
    }
  })

  app.post("/v1/pdpp/consent-requests", desktopAuth, async c => {
    try {
      const body = await c.req.json()
      return c.json(
        adapter.createConsentRequest({
          sessionId: body.session_id,
          scopes: body.scopes,
          authorizationDetails: body.authorization_details,
        }),
        201
      )
    } catch (error) {
      return errorResponse(c, error)
    }
  })
  app.post(
    "/v1/pdpp/consent-requests/:requestId/approve",
    desktopAuth,
    async c => {
      try {
        const body = await c.req.json()
        return c.json(
          adapter.issueApprovedGrantForRedemption({
            requestId: c.req.param("requestId"),
            legacyGrantId: body.legacy_grant_id,
            subjectId: body.subject_id,
            clientId: body.client_id,
          }),
          201
        )
      } catch (error) {
        return errorResponse(c, error)
      }
    }
  )
  app.post("/v1/pdpp/local-timeline/consent-requests", desktopAuth, async c => {
    try {
      const body = await c.req.json()
      return c.json(
        adapter.createLocalTimelineConsentRequest({
          sessionId: body.session_id,
          subjectId: body.subject_id,
        }),
        201
      )
    } catch (error) {
      return errorResponse(c, error)
    }
  })
  app.post(
    "/v1/pdpp/local-timeline/consent-requests/:requestId/approve",
    desktopAuth,
    async c => {
      try {
        const body = await c.req.json()
        return c.json(
          adapter.issueLocalTimelineGrant({
            requestId: c.req.param("requestId"),
            sessionId: body.session_id,
            subjectId: body.subject_id,
          }),
          201
        )
      } catch (error) {
        return errorResponse(c, error)
      }
    }
  )
  app.post("/v1/pdpp/local-timeline/revoke", desktopAuth, async c => {
    try {
      const body = await c.req.json()
      return c.json({
        revoked: adapter.revokeLocalTimelineSession({
          sessionId: body.session_id,
          subjectId: body.subject_id,
        }),
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })
  app.post("/v1/pdpp/introspect", c =>
    c.json(adapter.introspectPublicBearer(c.req.header("authorization")))
  )
}
