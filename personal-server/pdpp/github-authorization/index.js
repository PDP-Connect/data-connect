// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { resolveSelectedInstalledManifest } from "../installed-manifest.js"
import {
  createLocalTimelineAuthorizationRequest,
  LOCAL_TIMELINE_CLIENT_ID,
  validateAuthorizationDetails,
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

function readVerifiedManifest(
  activeManifestPath,
  connectorId,
  expectedConnector,
  selectedInstall
) {
  const installed = resolveSelectedInstalledManifest({
    activeManifestPath,
    connectorId,
    expectedConnector,
    selectedInstall,
  })
  return {
    version: installed.version,
    digest: installed.manifestDigest,
    manifest: installed.manifest,
  }
}

/** Selected-install authorization composition. The route core remains unchanged. */
export function createPdppAuthorizationAdapter({
  databasePath,
  activeManifestPath,
  connectorId = "github-pdpp",
  expectedConnector,
  selectedInstall,
  scopeForStream,
  enableLocalTimeline = false,
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
  if (typeof scopeForStream !== "function") {
    throw new TypeError("scopeForStream must be a function")
  }
  const currentManifest = () =>
    readVerifiedManifest(
      activeManifestPath,
      connectorId,
      expectedConnector,
      selectedInstall
    )
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
      const terms = validateAuthorizationDetails({
        authorizationDetails,
        manifest: manifest.manifest,
        scopes,
        scopeForStream,
      })
      return store.createRequest({ sessionId, scopes, terms, manifest })
    },
    createLocalTimelineConsentRequest({ sessionId, subjectId }) {
      if (!enableLocalTimeline) {
        throw new Error(
          "The selected connector does not support Timeline consent"
        )
      }
      const manifest = currentManifest()
      const local = createLocalTimelineAuthorizationRequest(manifest.manifest)
      const terms = validateAuthorizationDetails({
        ...local,
        manifest: manifest.manifest,
        scopeForStream: stream => `pdpp.local.github.${stream}`,
        sourceIds: ["github", "https://registry.pdpp.org/connectors/github"],
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
      if (!enableLocalTimeline) {
        throw new Error(
          "The selected connector does not support Timeline consent"
        )
      }
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
      if (!enableLocalTimeline) {
        throw new Error(
          "The selected connector does not support Timeline consent"
        )
      }
      return store.revokeBoundSession({
        sessionId,
        subjectId,
        clientId: LOCAL_TIMELINE_CLIENT_ID,
      })
    },
    close: store.close,
  }
}

/** GitHub remains the default authorization composition for deployed clients. */
export function createGithubAuthorizationAdapter(options = {}) {
  const githubScopes = {
    user: "github.profile",
    repositories: "github.repositories",
    starred: "github.starred",
  }
  return createPdppAuthorizationAdapter({
    ...options,
    connectorId: options.connectorId ?? "github-pdpp",
    scopeForStream: stream => githubScopes[stream],
    enableLocalTimeline: true,
  })
}

function requiredLocalSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("session_id is required")
  }
  return sessionId.trim()
}

export { PDPP_DATA_ACCESS_TYPE } from "./policy.js"
