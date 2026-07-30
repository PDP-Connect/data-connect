import { requireDesktopAuth } from "../../protected-routes.js"

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
          adapter.issueApprovedGrant({
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
