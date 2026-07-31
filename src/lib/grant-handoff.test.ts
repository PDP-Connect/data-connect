import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetGrantHandoffs,
  getGrantHandoff,
  redactBrowserGrantHandoff,
} from "./grant-handoff"

describe("grant handoff", () => {
  beforeEach(() => {
    _resetGrantHandoffs()
    window.history.replaceState(null, "", "/connect")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, "", "/connect")
    _resetGrantHandoffs()
  })

  it("replaces direct-link credentials before route effects can observe the URL", () => {
    window.history.replaceState(
      null,
      "",
      "/connect?sessionId=sess-1&secret=CANARY_RELAY_SECRET&masterKeySig=CANARY_MASTER_KEY_SIGNATURE"
    )

    redactBrowserGrantHandoff()

    const params = new URLSearchParams(window.location.search)
    const handoff = params.get("handoff")
    expect(handoff).toBeTruthy()
    expect(window.location.href).not.toContain("CANARY_RELAY_SECRET")
    expect(window.location.href).not.toContain("CANARY_MASTER_KEY_SIGNATURE")
    expect(getGrantHandoff(handoff ?? undefined)).toMatchObject({
      sessionId: "sess-1",
      secret: "CANARY_RELAY_SECRET",
      masterKeySignature: "CANARY_MASTER_KEY_SIGNATURE",
    })
  })

  it("fails closed when a handoff no longer exists", () => {
    expect(getGrantHandoff("missing")).toBeNull()
  })
})
