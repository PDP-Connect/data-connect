import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { loadInstalledGithubManifest } from "../installed-manifest.js"
import {
  createLocalTimelineAuthorizationRequest,
  LOCAL_TIMELINE_CLIENT_ID,
  validateGithubAuthorizationDetails,
} from "./policy.js"
import { openGithubAuthorizationStore } from "./store.js"

const LOCAL_TIMELINE_ACCESS_EXPIRES_IN_SECONDS = 8 * 60 * 60
// `single_use` authorizes exactly one token issuance (the persisted consent
// request enforces that). It does not consume a record read. The token remains
// usable only for this server-chosen, bounded lifetime.
const SINGLE_USE_ACCESS_EXPIRES_IN_SECONDS = 8 * 60 * 60
const CREDENTIAL_HANDOFF_EXPIRES_IN_SECONDS = 15 * 60

function inactive() {
  return { active: false }
}

function readVerifiedManifest(activeManifestPath) {
  const installed = loadInstalledGithubManifest({ activeManifestPath })
  return {
    version: installed.version,
    digest: createHash("sha256")
      .update(readFileSync(installed.manifestPath))
      .digest("hex"),
    manifest: installed.manifest,
  }
}

/** A separate UAT authorization composition; it intentionally does not alter query-core pdpp/index.js. */
export function createGithubAuthorizationAdapter({
  databasePath,
  activeManifestPath,
  now,
  random,
  singleUseAccessExpiresInSeconds = SINGLE_USE_ACCESS_EXPIRES_IN_SECONDS,
  credentialHandoffExpiresInSeconds = CREDENTIAL_HANDOFF_EXPIRES_IN_SECONDS,
} = {}) {
  const store = openGithubAuthorizationStore({
    databasePath,
    now,
    random,
    singleUseAccessExpiresInSeconds,
    credentialHandoffExpiresInSeconds,
  })
  const clock = now ?? (() => new Date())
  const currentManifest = () => readVerifiedManifest(activeManifestPath)
  const publicIdentity = token => {
    try {
      const found = store.findActiveGrant(token, currentManifest())
      return found?.inactiveReason
        ? { active: false, inactive_reason: found.inactiveReason }
        : found
          ? {
              active: true,
              pdpp_token_kind: "client",
              subject_id: found.grant.subject_id,
              client_id: found.grant.client_id,
            }
          : inactive()
    } catch {
      return inactive()
    }
  }
  return {
    createConsentRequest({ sessionId, scopes, authorizationDetails }) {
      const manifest = currentManifest()
      const terms = validateGithubAuthorizationDetails({
        authorizationDetails,
        manifest: manifest.manifest,
        scopes,
      })
      return store.createRequest({ sessionId, scopes, terms, manifest })
    },
    createLocalTimelineConsentRequest({ sessionId, subjectId }) {
      const manifest = currentManifest()
      const local = createLocalTimelineAuthorizationRequest(manifest.manifest)
      const terms = validateGithubAuthorizationDetails({
        ...local,
        manifest: manifest.manifest,
        localTimeline: true,
      })
      return {
        ...store.createRequest({
          sessionId,
          subjectId,
          clientId: LOCAL_TIMELINE_CLIENT_ID,
          scopes: local.scopes,
          terms,
          manifest,
        }),
        access_expires_in_seconds: LOCAL_TIMELINE_ACCESS_EXPIRES_IN_SECONDS,
      }
    },
    issueApprovedGrant({ requestId, legacyGrantId, subjectId, clientId }) {
      return store.issueGrant({
        requestId,
        legacyGrantId,
        subjectId,
        clientId,
        manifest: currentManifest(),
      })
    },
    issueApprovedGrantForRedemption({
      requestId,
      legacyGrantId,
      subjectId,
      clientId,
    }) {
      const issued = store.issueGrant({
        requestId,
        legacyGrantId,
        subjectId,
        clientId,
        issueToken: false,
        manifest: currentManifest(),
      })
      return {
        grant_id: issued.grant.grant_id,
        session_id: issued.session_id,
        token_type: "Bearer",
      }
    },
    redeemSessionCredential({ sessionId, clientId }) {
      return store.redeemSessionCredential({
        sessionId,
        clientId,
        manifest: currentManifest(),
      })
    },
    issueLocalTimelineGrant({ requestId, sessionId, subjectId }) {
      return store.issueGrant({
        requestId,
        // The legacy field is retained for the existing schema and legacy
        // revocation bridge. It is never surfaced as a legacy grant.
        legacyGrantId: `local-timeline:${requiredLocalSession(sessionId)}`,
        sessionId,
        subjectId,
        clientId: LOCAL_TIMELINE_CLIENT_ID,
        expiresAt: new Date(
          clock().getTime() + LOCAL_TIMELINE_ACCESS_EXPIRES_IN_SECONDS * 1000
        ).toISOString(),
        manifest: currentManifest(),
      })
    },
    resolveForResourceServer(token) {
      try {
        const found = store.findActiveGrant(token, currentManifest())
        return found?.inactiveReason
          ? { active: false, inactive_reason: found.inactiveReason }
          : found
            ? {
                active: true,
                pdpp_token_kind: "client",
                subject_id: found.grant.subject_id,
                client_id: found.grant.client_id,
                grant: found.grant,
              }
            : inactive()
      } catch {
        return inactive()
      }
    },
    introspectPublic: publicIdentity,
    introspectPublicBearer(authorization) {
      const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")
      return match ? publicIdentity(match[1]) : inactive()
    },
    revokeByLegacyGrantId: store.revokeByLegacyGrantId,
    revokeLocalTimelineSession({ sessionId, subjectId }) {
      return store.revokeBoundSession({
        sessionId,
        subjectId,
        clientId: LOCAL_TIMELINE_CLIENT_ID,
      })
    },
    close: store.close,
  }
}

function requiredLocalSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("session_id is required")
  }
  return sessionId.trim()
}

export { PDPP_DATA_ACCESS_TYPE } from "./policy.js"
