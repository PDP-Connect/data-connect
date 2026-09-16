// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// --- Tauri mocks ---

const mockInvoke = vi.fn()
const mockFetch = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

type EventHandler = (event: { payload: unknown }) => void
const listeners = new Map<string, EventHandler>()

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    listeners.set(eventName, handler)
    return Promise.resolve(() => {
      listeners.delete(eventName)
    })
  }),
}))

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}))

// --- Redux mock ---

let authState = {
  walletAddress: null as string | null,
  masterKeySignature: null as string | null,
}

vi.mock("react-redux", () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ app: { auth: authState } }),
}))

vi.mock("../state/store", () => ({
  // RootState type stub — only needed for TS import
}))

// --- Helpers ---

function emit(event: string, payload: unknown) {
  const handler = listeners.get(event)
  if (!handler) throw new Error(`No listener for ${event}`)
  handler({ payload })
}

// Reset module-level state between tests by re-importing the hook.
// vitest caches modules, so we use `vi.resetModules()` + dynamic import.
async function importHook() {
  const mod = await import("./usePersonalServer")
  return mod.usePersonalServer
}

describe("usePersonalServer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    listeners.clear()
    mockInvoke.mockReset()
    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new Error("not ready"))
    authState = { walletAddress: null, masterKeySignature: null }
    // Simulate Tauri runtime so isTauriRuntime() returns true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__TAURI_INTERNALS__ = {}
    // Default: invoke succeeds with a running server
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "start_personal_server") {
        return Promise.resolve({ running: true, port: 8080 })
      }
      if (cmd === "stop_personal_server") {
        return Promise.resolve()
      }
      return Promise.resolve()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__
  })

  it("starts in unauthenticated mode on mount", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    // Let effects flush
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.objectContaining({
        masterKeySignature: null,
        ownerAddress: null,
      })
    )
    expect(result.current.status).toBe("starting")
  })

  it("upgrades a local server when credentials become available", async () => {
    const usePersonalServer = await importHook()

    const { rerender } = renderHook(() => usePersonalServer())

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.objectContaining({
        masterKeySignature: null,
        ownerAddress: null,
      })
    )

    // Sign in — set walletAddress + masterKeySignature
    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    rerender()

    // Phase 2 restart: stop + 500ms delay + start
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(mockInvoke).toHaveBeenCalledWith("stop_personal_server")
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.objectContaining({
        port: null,
        masterKeySignature: "sig123",
        ownerAddress: "0xabc",
      })
    )
  })

  it("downgrades a credentialed server to local-only mode on sign-out", async () => {
    const usePersonalServer = await importHook()

    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    const { result, rerender } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      emit("personal-server-ready", { port: 9090 })
      emit("personal-server-tunnel", { url: "https://owner.server.vana.org" })
      emit("personal-server-tunnel-failed", { message: "temporary failure" })
      emit("personal-server-dev-token", { token: "credentialed-dev-token" })
    })
    expect(result.current.tunnelUrl).toBe("https://owner.server.vana.org")
    expect(result.current.tunnelFailed).toBe(true)
    expect(result.current.devToken).toBe("credentialed-dev-token")

    mockInvoke.mockClear()
    authState = { walletAddress: null, masterKeySignature: null }
    rerender()

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(mockInvoke).toHaveBeenCalledWith("stop_personal_server")
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.objectContaining({
        ownerAddress: null,
        masterKeySignature: null,
      })
    )
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_personal_server",
      expect.objectContaining({ masterKeySignature: "sig123" })
    )
    expect(result.current.tunnelUrl).toBeNull()
    expect(result.current.tunnelFailed).toBe(false)
    expect(result.current.devToken).toBeNull()
  })

  it("coordinates a single local downgrade across hook instances", async () => {
    const usePersonalServer = await importHook()

    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    const first = renderHook(() => usePersonalServer())
    const second = renderHook(() => usePersonalServer())
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    mockInvoke.mockClear()
    authState = { walletAddress: null, masterKeySignature: null }
    first.rerender()
    second.rerender()
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "stop_personal_server")
    ).toHaveLength(1)
    expect(
      mockInvoke.mock.calls.filter(
        ([command, options]) =>
          command === "start_personal_server" &&
          (options as { masterKeySignature?: string | null }).masterKeySignature === null
      )
    ).toHaveLength(1)
  })

  it("keeps local serving running when its optional tunnel fails", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    act(() => {
      emit("personal-server-ready", { port: 8080 })
      emit("personal-server-tunnel-failed", { message: "not configured" })
    })

    expect(result.current.status).toBe("running")
    expect(result.current.port).toBe(8080)
    expect(result.current.tunnelUrl).toBeNull()
    expect(result.current.tunnelFailed).toBe(true)
  })

  it("does not restart again after server-registered for tunnel", async () => {
    const usePersonalServer = await importHook()

    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    mockInvoke.mockClear()
    act(() => {
      emit("server-registered", { status: 200, serverId: "srv-123" })
    })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Wrapper now handles registration+tunnel in one pass; no extra restart.
    expect(mockInvoke).not.toHaveBeenCalledWith("stop_personal_server")
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )
  })

  it("resets running.current on error event", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Simulate ready
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.status).toBe("running")

    // Simulate error event
    act(() => {
      emit("personal-server-error", { message: "Something went wrong" })
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Something went wrong")

    // After error, should be able to start again (running.current was reset)
    mockInvoke.mockClear()

    await act(async () => {
      await result.current.startServer(null)
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )
  })

  it("auto-restarts on crash with exponential backoff", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Simulate ready then crash
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    mockInvoke.mockClear()

    // Crash (exitCode=1)
    act(() => {
      emit("personal-server-exited", { exitCode: 1, crashed: true })
    })

    expect(result.current.status).toBe("starting")

    // Advance 2s (first backoff)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )
  })

  it("gives up after MAX_RESTART_ATTEMPTS crashes", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Ready
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    // Simulate 4 crashes (MAX_RESTART_ATTEMPTS = 3, so crash 4 should give up)
    for (let i = 1; i <= 3; i++) {
      mockInvoke.mockClear()
      act(() => {
        emit("personal-server-exited", { exitCode: 1, crashed: true })
      })

      expect(result.current.status).toBe("starting")

      // Advance the backoff timer
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.pow(2, i) * 1000)
      })

      expect(mockInvoke).toHaveBeenCalledWith(
        "start_personal_server",
        expect.any(Object)
      )
    }

    // 4th crash — should give up
    act(() => {
      emit("personal-server-exited", { exitCode: 1, crashed: true })
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toContain("crashed repeatedly")
  })

  it("preserves error status and message across remounts after max crash restarts", async () => {
    const usePersonalServer = await importHook()

    const { result, unmount } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.status).toBe("running")

    // Crash 3 times with auto-restart
    for (let i = 1; i <= 3; i++) {
      act(() => {
        emit("personal-server-exited", { exitCode: 1, crashed: true })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.pow(2, i) * 1000)
      })
    }

    // 4th crash — exceeds MAX_RESTART_ATTEMPTS
    act(() => {
      emit("personal-server-exited", { exitCode: 1, crashed: true })
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toContain("crashed repeatedly")

    // Simulate navigation: unmount then remount
    unmount()
    const { result: result2 } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Both status and error message should survive remount
    expect(result2.current.status).toBe("error")
    expect(result2.current.error).toBe(
      "Personal Server crashed repeatedly and could not be restarted"
    )
  })

  it("resets restart count on successful ready event", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Ready
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    // Crash twice
    for (let i = 1; i <= 2; i++) {
      act(() => {
        emit("personal-server-exited", { exitCode: 1, crashed: true })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.pow(2, i) * 1000)
      })
    }

    // Ready again — should reset the counter
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.status).toBe("running")

    // Now crash 3 more times — should still auto-restart (counter was reset)
    for (let i = 1; i <= 3; i++) {
      mockInvoke.mockClear()
      act(() => {
        emit("personal-server-exited", { exitCode: 1, crashed: true })
      })

      expect(result.current.status).toBe("starting")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.pow(2, i) * 1000)
      })
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_personal_server",
        expect.any(Object)
      )
    }
  })

  it("restartingRef is true during restart and false after ready event", async () => {
    const usePersonalServer = await importHook()

    const { result, rerender } = renderHook(() => usePersonalServer())

    // Let initial unauthenticated start complete
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Simulate the ready event from the first start
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.restartingRef.current).toBe(false)

    // Sign in — set walletAddress (restartingRef set synchronously during render)
    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    rerender()

    // restartingRef should be true synchronously (set during render body)
    expect(result.current.restartingRef.current).toBe(true)

    // Let Phase 2 restart complete (stop + 500ms delay + start)
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Still restarting — server hasn't emitted ready yet
    expect(result.current.restartingRef.current).toBe(true)

    // Simulate the ready event from the restarted server
    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })

    expect(result.current.restartingRef.current).toBe(false)
    expect(result.current.port).toBe(9090)
  })

  it("waits for the restarted server health check before resolving", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    mockFetch.mockResolvedValue({ ok: true })
    let restartPromise: Promise<boolean>
    await act(async () => {
      restartPromise = result.current.restartServer()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(mockInvoke).toHaveBeenCalledWith("stop_personal_server")
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )

    let settled = false
    restartPromise!.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })
    await act(async () => {
      await restartPromise!
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9090/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(settled).toBe(true)
    expect(result.current.restartingRef.current).toBe(false)
  })

  it("restarts from an error state even when the stop command fails", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      emit("personal-server-ready", { port: 8080 })
      emit("personal-server-error", { message: "previous restart failed" })
    })
    expect(result.current.status).toBe("error")

    mockInvoke.mockImplementation((command: string) => {
      if (command === "stop_personal_server") {
        return Promise.reject(new Error("stop failed"))
      }
      if (command === "start_personal_server") {
        return Promise.resolve({ running: true, port: 9090 })
      }
      return Promise.resolve()
    })
    mockFetch.mockResolvedValue({ ok: true })

    let restartPromise!: Promise<boolean>
    await act(async () => {
      restartPromise = result.current.restartServer()
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )

    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })
    await expect(restartPromise).resolves.toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9090/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("aborts a hung health request at the restart deadline", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    let healthSignal!: AbortSignal
    mockFetch.mockImplementationOnce(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          healthSignal = options.signal
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"))
          })
        })
    )

    let restartPromise!: Promise<boolean>
    await act(async () => {
      restartPromise = result.current.restartServer()
      await vi.advanceTimersByTimeAsync(500)
    })

    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      await restartPromise
    })

    expect(healthSignal.aborted).toBe(true)
    await expect(restartPromise).resolves.toBe(false)
    expect(result.current.restartingRef.current).toBe(false)
  })

  it("serializes concurrent restarts by generation", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })
    mockFetch.mockResolvedValue({ ok: true })

    let firstRestart!: Promise<boolean>
    let secondRestart!: Promise<boolean>
    await act(async () => {
      firstRestart = result.current.restartServer()
      secondRestart = result.current.restartServer()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "stop_personal_server")
    ).toHaveLength(1)

    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })
    await act(async () => {
      await firstRestart
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "stop_personal_server")
    ).toHaveLength(2)
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "start_personal_server")
    ).toHaveLength(3)

    act(() => {
      emit("personal-server-ready", { port: 9091 })
    })
    await expect(secondRestart).resolves.toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9091/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("stopServer failure does not prevent subsequent startServer", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.status).toBe("running")

    // Make stop_personal_server throw
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "stop_personal_server") {
        return Promise.reject(new Error("stop failed"))
      }
      if (cmd === "start_personal_server") {
        return Promise.resolve({ running: true, port: 8080 })
      }
      return Promise.resolve()
    })

    // Call stopServer (which will fail)
    await act(async () => {
      await result.current.stopServer()
    })

    // Now startServer should still work despite stop failure
    mockInvoke.mockClear()
    await act(async () => {
      await result.current.startServer(null)
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_personal_server",
      expect.any(Object)
    )
  })

  it("does not schedule tunnel restart when server-registered fires during Phase 2", async () => {
    const usePersonalServer = await importHook()

    const { result, rerender } = renderHook(() => usePersonalServer())

    // Sign in → Phase 2 begins
    authState = { walletAddress: "0xabc", masterKeySignature: "sig123" }
    rerender()

    // Let Phase 2 stop + 500ms + start proceed, but DON'T emit ready yet
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Phase 2 has called stop + start, server is 'starting'
    expect(result.current.status).toBe("starting")
    expect(result.current.restartingRef.current).toBe(true)

    // Record Phase 2 calls.
    const stopCallsAfterPhase2 = mockInvoke.mock.calls.filter(
      (c) => c[0] === "stop_personal_server"
    ).length
    const startCallsAfterPhase2 = mockInvoke.mock.calls.filter(
      (c) => c[0] === "start_personal_server"
    ).length

    // Gateway registration completes while Phase 2 is still starting
    act(() => {
      emit("server-registered", { status: 200, serverId: "srv-123" })
    })

    // Advance any timers the handler may have scheduled
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // No additional restart should be scheduled.
    const stopCallsAfterRegistered = mockInvoke.mock.calls.filter(
      (c) => c[0] === "stop_personal_server"
    ).length
    const startCallsAfterRegistered = mockInvoke.mock.calls.filter(
      (c) => c[0] === "start_personal_server"
    ).length
    expect(stopCallsAfterRegistered).toBe(stopCallsAfterPhase2)
    expect(startCallsAfterRegistered).toBe(startCallsAfterPhase2)

    // Phase 2 completes — ready event fires
    act(() => {
      emit("personal-server-ready", { port: 9090 })
    })

    expect(result.current.restartingRef.current).toBe(false)
  })

  it("sets status to stopped on graceful exit (not crash)", async () => {
    const usePersonalServer = await importHook()

    const { result } = renderHook(() => usePersonalServer())

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    act(() => {
      emit("personal-server-ready", { port: 8080 })
    })

    expect(result.current.status).toBe("running")

    // Graceful exit (exitCode=0)
    act(() => {
      emit("personal-server-exited", { exitCode: 0, crashed: false })
    })

    expect(result.current.status).toBe("stopped")
    expect(result.current.port).toBeNull()
  })
})
