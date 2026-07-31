import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type StorageModule = typeof import("./storage")

let storage: StorageModule

const pendingApprovalKey = "v1_pending_approval"

beforeEach(async () => {
  localStorage.clear()
  vi.resetModules()
  storage = await import("./storage")
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("legacy pending approval cleanup", () => {
  it("removes relay-secret recovery records instead of replaying them", () => {
    localStorage.setItem(
      pendingApprovalKey,
      JSON.stringify({
        sessionId: "sess-123",
        grantId: "grant-456",
        secret: "CANARY_RELAY_SECRET",
        userAddress: "0x123",
        scopes: ["chatgpt.conversations"],
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    )

    storage.clearLegacyPendingApproval()

    expect(localStorage.getItem(pendingApprovalKey)).toBeNull()
    expect(JSON.stringify(localStorage)).not.toContain("CANARY_RELAY_SECRET")
  })
})

describe("PDPP grant compensation recovery", () => {
  it("persists only non-secret identifiers needed to retry a revocation", () => {
    storage.savePendingPdppGrantCompensation({
      sessionId: "sess-123",
      grantId: "grant-456",
      userAddress: "0x123",
    })

    expect(storage.getPendingPdppGrantCompensations()).toEqual([
      { sessionId: "sess-123", grantId: "grant-456", userAddress: "0x123" },
    ])
    expect(JSON.stringify(localStorage)).not.toContain("secret")
    expect(JSON.stringify(localStorage)).not.toContain("pdpp_at_")

    storage.clearPendingPdppGrantCompensation()
    expect(storage.getPendingPdppGrantCompensations()).toEqual([])
  })

  it("keeps recovery records for independent failed sessions", () => {
    storage.savePendingPdppGrantCompensation({
      sessionId: "sess-a",
      grantId: "grant-a",
      userAddress: "0xa",
    })
    storage.savePendingPdppGrantCompensation({
      sessionId: "sess-b",
      grantId: "grant-b",
      userAddress: "0xb",
    })

    storage.clearPendingPdppGrantCompensation({
      sessionId: "sess-b",
      grantId: "grant-b",
    })

    expect(storage.getPendingPdppGrantCompensations()).toEqual([
      { sessionId: "sess-a", grantId: "grant-a", userAddress: "0xa" },
    ])
  })
})
