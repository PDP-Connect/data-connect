// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useClearLegacyPendingApproval } from "./usePendingApproval"
import * as sessionRelay from "../services/sessionRelay"

vi.mock("../services/sessionRelay", () => ({
  approveSession: vi.fn(),
}))

describe("useClearLegacyPendingApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("clears legacy relay-secret records without retrying approval", () => {
    localStorage.setItem(
      "v1_pending_approval",
      JSON.stringify({
        sessionId: "sess-retry",
        grantId: "grant-retry",
        secret: "CANARY_RELAY_SECRET",
        userAddress: "0xabc",
        scopes: ["chatgpt.conversations"],
        createdAt: new Date().toISOString(),
      })
    )

    renderHook(() => useClearLegacyPendingApproval())

    expect(sessionRelay.approveSession).not.toHaveBeenCalled()
    expect(localStorage.getItem("v1_pending_approval")).toBeNull()
  })
})
