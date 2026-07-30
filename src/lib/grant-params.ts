export type GrantParams = {
  handoffId?: string
  sessionId?: string
  secret?: string
  appId?: string
  scopes?: string[]
  status?: GrantStatusParam
  masterKeySignature?: string
  authorizationDetails?:
    | import("@/services/pdppAuthorization").PdppAuthorizationDetail[]
    | null
}

export type GrantStatusParam = "success"

function parseAuthorizationDetails(
  value: string | null
): GrantParams["authorizationDetails"] | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? (parsed as import("@/services/pdppAuthorization").PdppAuthorizationDetail[])
      : null
  } catch {
    return null
  }
}

export type ClaimedAuthorization = {
  sessionId: string
  scopes: string[]
}

function isValidScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

export function parseScopesParam(
  scopesParam: string | null
): string[] | undefined {
  if (!scopesParam) return undefined

  try {
    const parsed = JSON.parse(scopesParam)
    if (isValidScopes(parsed)) {
      return parsed
    }
    if (typeof parsed === "string") {
      const commaSplit = parsed
        .split(",")
        .map(scope => scope.trim())
        .filter(Boolean)
      if (commaSplit.length > 0) {
        return commaSplit
      }
    }
  } catch {
    const commaSplit = scopesParam
      .split(",")
      .map(scope => scope.trim())
      .filter(Boolean)
    if (commaSplit.length > 0) {
      return commaSplit
    }
  }

  return undefined
}

function hasSameScopeTerms(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false

  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((scope, index) => scope === sortedRight[index])
}

/**
 * URL parameters are only an untrusted request until Session Relay returns the
 * claimed authorization. Keep this check at both the collection and consent
 * boundaries so navigation state cannot substitute another session's terms.
 */
export function getClaimedAuthorizationMismatch(
  canonicalSessionId: string,
  requestedScopes: string[] | undefined,
  claimed: ClaimedAuthorization
): string | null {
  if (claimed.sessionId !== canonicalSessionId) {
    return "The claimed session does not match this authorization URL. Please restart the flow from the app."
  }

  if (requestedScopes && !hasSameScopeTerms(requestedScopes, claimed.scopes)) {
    return "The requested scopes do not match the session authorization. Please restart the flow from the app."
  }

  return null
}

export function getGrantParamsFromSearchParams(
  searchParams: URLSearchParams
): GrantParams {
  const sessionId = searchParams.get("sessionId") || undefined
  const handoffId = searchParams.get("handoff") || undefined
  const secret = searchParams.get("secret") || undefined
  const appId = searchParams.get("appId") || undefined
  const scopes = parseScopesParam(searchParams.get("scopes"))
  const status =
    searchParams.get("status") === "success" ? ("success" as const) : undefined
  const masterKeySignature = searchParams.get("masterKeySig") || undefined
  const authorizationDetails = parseAuthorizationDetails(
    searchParams.get("authorizationDetails")
  )

  return {
    handoffId,
    sessionId,
    secret,
    appId,
    scopes,
    status,
    masterKeySignature,
    authorizationDetails,
  }
}

export function buildGrantSearchParams(params: GrantParams): URLSearchParams {
  const searchParams = new URLSearchParams()

  if (params.handoffId) {
    searchParams.set("handoff", params.handoffId)
    return searchParams
  }

  if (params.sessionId) {
    searchParams.set("sessionId", params.sessionId)
  }

  if (params.secret) {
    searchParams.set("secret", params.secret)
  }

  if (params.appId) {
    searchParams.set("appId", params.appId)
  }

  if (params.scopes && params.scopes.length > 0) {
    searchParams.set("scopes", JSON.stringify(params.scopes))
  }

  if (params.status) {
    searchParams.set("status", params.status)
  }

  if (params.masterKeySignature) {
    searchParams.set("masterKeySig", params.masterKeySignature)
  }

  if (params.authorizationDetails !== undefined) {
    searchParams.set(
      "authorizationDetails",
      JSON.stringify(params.authorizationDetails)
    )
  }

  return searchParams
}
