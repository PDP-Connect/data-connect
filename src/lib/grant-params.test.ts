import { describe, expect, it } from "vitest"
import {
  buildGrantSearchParams,
  getClaimedAuthorizationMismatch,
  getGrantParamsFromSearchParams,
  parseScopesParam,
} from "./grant-params"

describe("grant-params", () => {
  it("parses scopes from JSON array", () => {
    expect(parseScopesParam('["read:a","read:b"]')).toEqual([
      "read:a",
      "read:b",
    ])
  })

  it("parses scopes from JSON string and comma-delimited fallback", () => {
    expect(parseScopesParam('"read:a,read:b"')).toEqual(["read:a", "read:b"])
    expect(parseScopesParam("read:a,read:b")).toEqual(["read:a", "read:b"])
  })

  it("returns undefined for invalid scopes", () => {
    expect(parseScopesParam("")).toBeUndefined()
    expect(parseScopesParam("[1]")).toBeUndefined()
  })

  it("rejects a claim for another session or different scope terms", () => {
    expect(
      getClaimedAuthorizationMismatch("session-a", ["read:a"], {
        sessionId: "session-b",
        scopes: ["read:a"],
      })
    ).toContain("does not match this authorization URL")
    expect(
      getClaimedAuthorizationMismatch("session-a", ["read:a"], {
        sessionId: "session-a",
        scopes: ["read:b"],
      })
    ).toContain("requested scopes do not match")
  })

  it("accepts the same scope terms regardless of serialization order", () => {
    expect(
      getClaimedAuthorizationMismatch("session-a", ["read:b", "read:a"], {
        sessionId: "session-a",
        scopes: ["read:a", "read:b"],
      })
    ).toBeNull()
  })

  it("builds and reads grant search params", () => {
    const searchParams = buildGrantSearchParams({
      sessionId: "grant-session-1",
      appId: "rickroll",
      scopes: ["read:a", "read:b"],
      status: "success",
    })

    expect(searchParams.get("sessionId")).toBe("grant-session-1")
    expect(searchParams.get("appId")).toBe("rickroll")
    expect(searchParams.get("scopes")).toBe('["read:a","read:b"]')
    expect(searchParams.get("status")).toBe("success")

    const roundTrip = getGrantParamsFromSearchParams(searchParams)
    expect(roundTrip).toEqual({
      sessionId: "grant-session-1",
      appId: "rickroll",
      scopes: ["read:a", "read:b"],
      status: "success",
    })
  })

  it("parses and round-trips secret param", () => {
    const searchParams = buildGrantSearchParams({
      sessionId: "sess-1",
      secret: "my-secret-token",
    })

    expect(searchParams.get("secret")).toBe("my-secret-token")

    const roundTrip = getGrantParamsFromSearchParams(searchParams)
    expect(roundTrip.secret).toBe("my-secret-token")
  })

  it("preserves explicit malformed authorization details so consent fails closed", () => {
    const params = getGrantParamsFromSearchParams(
      new URLSearchParams({ authorizationDetails: "not-json" })
    )
    expect(params.authorizationDetails).toBeNull()
    expect(buildGrantSearchParams(params).get("authorizationDetails")).toBe(
      "null"
    )
  })

  it("round-trips the builder signature for PDPP authorization details", () => {
    const searchParams = buildGrantSearchParams({
      sessionId: "sess-1",
      authorizationDetailsSignature: "0xsigned",
      authorizationDetails: [],
    })

    expect(searchParams.get("authorizationDetailsSig")).toBe("0xsigned")
    expect(
      getGrantParamsFromSearchParams(searchParams).authorizationDetailsSignature
    ).toBe("0xsigned")
  })

  it("omits secret from search params when not provided", () => {
    const searchParams = buildGrantSearchParams({
      sessionId: "sess-1",
    })

    expect(searchParams.has("secret")).toBe(false)

    const roundTrip = getGrantParamsFromSearchParams(searchParams)
    expect(roundTrip.secret).toBeUndefined()
  })
})
