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
