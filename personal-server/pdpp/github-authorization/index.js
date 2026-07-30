import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { loadInstalledGithubManifest } from "../installed-manifest.js"
import { validateGithubAuthorizationDetails } from "./policy.js"
import { openGithubAuthorizationStore } from "./store.js"

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
} = {}) {
  const store = openGithubAuthorizationStore({ databasePath, now, random })
  const currentManifest = () => readVerifiedManifest(activeManifestPath)
  const publicIdentity = token => {
    try {
      const found = store.findActiveGrant(token, currentManifest())
      return found
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
    issueApprovedGrant({ requestId, legacyGrantId, subjectId, clientId }) {
      return store.issueGrant({
        requestId,
        legacyGrantId,
        subjectId,
        clientId,
        manifest: currentManifest(),
      })
    },
    resolveForResourceServer(token) {
      try {
        const found = store.findActiveGrant(token, currentManifest())
        return found
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
    close: store.close,
  }
}

export { PDPP_DATA_ACCESS_TYPE } from "./policy.js"
