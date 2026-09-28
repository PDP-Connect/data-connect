// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useBrowserStatus } from "./use-browser-status"

const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))
const SANDBOX_MESSAGE = "This Linux distribution blocks the sandbox of the browser that DataConnect bundles or downloads. Install Google Chrome or Chromium from a .deb package."

describe("useBrowserStatus", () => {
  beforeEach(() => { mockInvoke.mockReset() })

  it("shows the host message, not the download prompt, when the found browser cannot start", async () => {
    mockInvoke.mockResolvedValue({ available: false, browser_type: "bundled", needs_download: false,
      reason: "browser_sandbox_unavailable", message: SANDBOX_MESSAGE })
    const { result } = renderHook(() => useBrowserStatus())
    await waitFor(() => expect(result.current.status).not.toBe("checking"))
    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe(SANDBOX_MESSAGE)
    await act(async () => { result.current.retry() })
    await waitFor(() => expect(result.current.status).not.toBe("checking"))
    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe(SANDBOX_MESSAGE)
    expect(mockInvoke).not.toHaveBeenCalledWith("download_browser")
  })

  it("still offers the download when no browser is present", async () => {
    mockInvoke.mockResolvedValue({ available: false, browser_type: "none", needs_download: true })
    const { result } = renderHook(() => useBrowserStatus())
    await waitFor(() => expect(result.current.status).toBe("needs_browser"))
    expect(result.current.error).toBeNull()
  })
})
