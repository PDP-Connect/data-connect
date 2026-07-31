import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Platform } from "../types"

const mockInvoke = vi.fn()
const mockDispatch = vi.fn()
let currentRuns: Array<Record<string, unknown>> = []

const startRun = vi.fn(payload => ({ type: "startRun", payload }))
const updateRunStatus = vi.fn(payload => ({ type: "updateRunStatus", payload }))
const stopRun = vi.fn(payload => ({ type: "stopRun", payload }))
const deleteRun = vi.fn(payload => ({ type: "deleteRun", payload }))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock("react-redux", () => ({
  useDispatch: () => mockDispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ app: { runs: currentRuns } }),
}))

vi.mock("../state/store", () => ({
  startRun,
  updateRunStatus,
  stopRun,
  deleteRun,
}))

const TEST_PLATFORM: Platform = {
  id: "chatgpt",
  company: "OpenAI",
  name: "ChatGPT",
  filename: "chatgpt",
  description: "ChatGPT export",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: "https://chatgpt.com",
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
  runtime: "playwright",
}

describe("useConnector.startImport", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    mockInvoke.mockReset()
    mockDispatch.mockReset()
    currentRuns = []
    startRun.mockClear()
    updateRunStatus.mockClear()
    stopRun.mockClear()
    deleteRun.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("removes transient run when backend rejects duplicate active run", async () => {
    mockInvoke.mockRejectedValue(new Error("DUPLICATE_ACTIVE_RUN"))
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    let returnedRunId: string | null | undefined
    await act(async () => {
      returnedRunId = await result.current.startImport(TEST_PLATFORM)
    })

    expect(returnedRunId).toBeNull()
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chatgpt-1700000000000" })
    )
    expect(deleteRun).toHaveBeenCalledWith("chatgpt-1700000000000")
    expect(updateRunStatus).not.toHaveBeenCalled()
  })

  it("marks run as error for non-duplicate start failures", async () => {
    mockInvoke.mockRejectedValue(new Error("connection failed"))
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    let returnedRunId: string | null | undefined
    await act(async () => {
      returnedRunId = await result.current.startImport(TEST_PLATFORM)
    })

    expect(returnedRunId).toBe("chatgpt-1700000000000")
    expect(updateRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "chatgpt-1700000000000",
        status: "error",
      })
    )
    expect(deleteRun).not.toHaveBeenCalled()
  })

  it("uses the installed PDPP connector command for pdpp-network platforms", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport({
        ...TEST_PLATFORM,
        id: "github-pdpp",
        company: "GitHub",
        name: "GitHub",
        filename: "github-pdpp",
        runtime: "pdpp-network",
        scopes: ["github.profile", "github.repositories"],
      })
    })

    expect(mockInvoke).toHaveBeenCalledWith("start_installed_pdpp_connector_run", {
      request: {
        runId: "github-pdpp-1700000000000",
        connectorId: "github-pdpp",
        collectionMode: "incremental",
        streams: [],
        githubToken: null,
      },
    })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_connector_run",
      expect.anything()
    )
  })

  it("passes a GitHub PAT only to the installed GitHub PDPP connector invoke", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport(
        {
          ...TEST_PLATFORM,
          id: "github-pdpp",
          company: "GitHub",
          name: "GitHub",
          filename: "github-pdpp",
          runtime: "pdpp-network",
        },
        { githubToken: "ghp_transient" }
      )
    })

    expect(mockInvoke).toHaveBeenCalledWith("start_installed_pdpp_connector_run", {
      request: {
        runId: "github-pdpp-1700000000000",
        connectorId: "github-pdpp",
        collectionMode: "incremental",
        streams: [],
        githubToken: "ghp_transient",
      },
    })
    expect(startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ githubToken: "ghp_transient" })
    )
  })

  it("returns the PDPP run id before the host command reaches its terminal response", async () => {
    let resolveHost: (() => void) | undefined
    mockInvoke.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveHost = resolve
        })
    )
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    let returnedRunId: string | null | undefined
    await act(async () => {
      returnedRunId = await result.current.startImport({
        ...TEST_PLATFORM,
        id: "github-pdpp",
        runtime: "pdpp-network",
      })
    })

    expect(returnedRunId).toBe("github-pdpp-1700000000000")
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "github-pdpp-1700000000000",
        status: "running",
      })
    )
    resolveHost?.()
  })

  it("preserves the legacy connector command for non-PDPP platforms", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport(TEST_PLATFORM)
    })

    expect(mockInvoke).toHaveBeenCalledWith("start_connector_run", {
      runId: "chatgpt-1700000000000",
      platformId: "chatgpt",
      filename: "chatgpt",
      company: "OpenAI",
      name: "ChatGPT",
      connectUrl: "https://chatgpt.com",
      runtime: "playwright",
      simulateNoChrome: false,
    })
  })

  it("uses the installed PDPP stop command for pdpp-network runs", async () => {
    currentRuns = [{ id: "github-pdpp-run", runtime: "pdpp-network" }]
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.stopExport("github-pdpp-run")
    })

    expect(stopRun).not.toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith("stop_installed_pdpp_connector_run", {
      runId: "github-pdpp-run",
    })
    expect(mockInvoke).not.toHaveBeenCalledWith("stop_connector_run", expect.anything())
  })
})
