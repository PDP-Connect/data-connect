import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pdpp_github_consent_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS pdpp_github_grants (
  grant_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES pdpp_github_consent_requests(request_id),
  legacy_grant_id TEXT NOT NULL UNIQUE,
  grant_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS pdpp_github_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL REFERENCES pdpp_github_grants(grant_id),
  issued_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS pdpp_github_grants_legacy_idx ON pdpp_github_grants(legacy_grant_id);
`

export function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex")
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`)
  return value.trim()
}

export function openGithubAuthorizationStore({
  databasePath,
  now = () => new Date(),
  random = randomBytes,
}) {
  mkdirSync(dirname(databasePath), { recursive: true })
  const db = new Database(databasePath)
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA)
  const timestamp = () => now().toISOString()

  function createRequest({ sessionId, scopes, terms, manifest }) {
    const request = {
      request_id: `pdpp_request_${randomUUID()}`,
      session_id: requiredString(sessionId, "session_id"),
      scopes: [...scopes],
      authorization_details: terms,
      manifest_version: manifest.version,
      manifest_digest: manifest.digest,
    }
    db.prepare(
      `INSERT INTO pdpp_github_consent_requests(request_id, session_id, scopes_json, terms_json, manifest_version, manifest_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      request.request_id,
      request.session_id,
      JSON.stringify(request.scopes),
      JSON.stringify(terms),
      manifest.version,
      manifest.digest,
      timestamp()
    )
    return request
  }

  function issueGrant({
    requestId,
    legacyGrantId,
    subjectId,
    clientId,
    manifest,
  }) {
    const request = db
      .prepare(
        "SELECT * FROM pdpp_github_consent_requests WHERE request_id = ? AND consumed_at IS NULL"
      )
      .get(requiredString(requestId, "request_id"))
    if (!request)
      throw new Error("Authorization request is missing or already consumed")
    if (
      request.manifest_version !== manifest.version ||
      request.manifest_digest !== manifest.digest
    ) {
      throw new Error(
        "The verified installed GitHub manifest changed before approval"
      )
    }
    const grant = Object.freeze({
      version: "0.1.0",
      grant_id: `pdpp_grant_${randomUUID()}`,
      issued_at: timestamp(),
      subject_id: requiredString(subjectId, "subject_id"),
      client_id: requiredString(clientId, "client_id"),
      session_id: request.session_id,
      scopes: JSON.parse(request.scopes_json),
      manifest_version: request.manifest_version,
      manifest_digest: request.manifest_digest,
      authorization_details: JSON.parse(request.terms_json),
    })
    const accessToken = `pdpp_at_${random(32).toString("base64url")}`
    db.transaction(() => {
      db.prepare(
        "INSERT INTO pdpp_github_grants(grant_id, request_id, legacy_grant_id, grant_json, issued_at) VALUES (?, ?, ?, ?, ?)"
      ).run(
        grant.grant_id,
        request.request_id,
        requiredString(legacyGrantId, "legacy_grant_id"),
        JSON.stringify(grant),
        grant.issued_at
      )
      db.prepare(
        "INSERT INTO pdpp_github_tokens(token_id, token_hash, grant_id, issued_at) VALUES (?, ?, ?, ?)"
      ).run(
        `pdpp_token_${randomUUID()}`,
        tokenHash(accessToken),
        grant.grant_id,
        grant.issued_at
      )
      db.prepare(
        "UPDATE pdpp_github_consent_requests SET consumed_at = ? WHERE request_id = ?"
      ).run(timestamp(), request.request_id)
    })()
    return {
      grant,
      access_token: accessToken,
      token_type: "Bearer",
      pdpp_token_kind: "client",
    }
  }

  function findActiveGrant(token, manifest) {
    if (typeof token !== "string" || !token) return null
    const row = db
      .prepare(
        `SELECT g.grant_id, g.grant_json, g.revoked_at AS grant_revoked_at, t.revoked_at AS token_revoked_at
      FROM pdpp_github_tokens t JOIN pdpp_github_grants g ON g.grant_id = t.grant_id WHERE t.token_hash = ?`
      )
      .get(tokenHash(token))
    if (!row || row.grant_revoked_at || row.token_revoked_at) return null
    try {
      const grant = JSON.parse(row.grant_json)
      return grant.manifest_version === manifest.version &&
        grant.manifest_digest === manifest.digest
        ? { grantId: row.grant_id, grant }
        : null
    } catch {
      return null
    }
  }

  function revokeByLegacyGrantId(legacyGrantId) {
    return (
      db
        .prepare(
          "UPDATE pdpp_github_grants SET revoked_at = ? WHERE legacy_grant_id = ? AND revoked_at IS NULL"
        )
        .run(timestamp(), legacyGrantId).changes > 0
    )
  }

  return {
    createRequest,
    issueGrant,
    findActiveGrant,
    revokeByLegacyGrantId,
    close: () => db.close(),
  }
}
