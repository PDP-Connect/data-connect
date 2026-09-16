// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Platform } from "../types"

const mockInvoke = vi.fn()
const mockDispatch = vi.fn()
let currentRuns: Array<Record<string, unknown>> = []
let currentPendingConnectorChanges: string[] = []

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
    selector({
      app: {
        runs: currentRuns,
        pendingConnectorChanges: currentPendingConnectorChanges,
      },
    }),
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
    currentPendingConnectorChanges = []
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

  it.each([
    {
      label: "a structured auth_failed error class",
      error: { errorClass: "auth_failed" },
      expected: true,
    },
    {
      label: "a 401 Unauthorized message",
      error: new Error("host returned 401 Unauthorized"),
      expected: true,
    },
    {
      label: "an invalid token message",
      error: new Error("invalid token"),
      expected: true,
    },
    {
      label: "a network failure message",
      error: new Error("Network request failed"),
      expected: false,
    },
  ])(
    "classifies $label as authentication failure: $expected",
    async ({ error, expected }) => {
      const { isAuthenticationFailure } = await import("./useConnector")

      expect(isAuthenticationFailure(error)).toBe(expected)
    }
  )

  it("blocks a new run while its connector change is pending", async () => {
    currentPendingConnectorChanges = ["chatgpt"]
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    let returnedRunId: string | null | undefined
    await act(async () => {
      returnedRunId = await result.current.startImport(TEST_PLATFORM)
    })

    expect(returnedRunId).toBeNull()
    expect(startRun).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
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

  it("keeps the installed host error in the run status message", async () => {
    mockInvoke.mockRejectedValue(
      new Error("Import directory does not belong to this connection")
    )
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport({
        ...TEST_PLATFORM,
        id: "apple-health-pdpp",
        runtime: "pdpp-network",
      })
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(updateRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "apple-health-pdpp-1700000000000",
        status: "error",
        statusMessage: "Import directory does not belong to this connection",
      })
    )
  })

  it("passes a prepared manual import to the installed host without credentials", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport(
        {
          ...TEST_PLATFORM,
          id: "apple-health-pdpp",
          company: "Apple",
          name: "Apple Health",
          filename: "apple-health-pdpp",
          runtime: "pdpp-network",
        },
        { importDirectory: "/private/imports/run-1" }
      )
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      {
        request: {
          runId: "apple-health-pdpp-1700000000000",
          connectorId: "apple-health-pdpp",
          collectionMode: "incremental",
          streams: [],
          githubToken: null,
          connectionId: "apple-health-pdpp-owner",
          setupSecrets: null,
          importDirectory: "/private/imports/run-1",
        },
      }
    )
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

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      {
        request: {
          runId: "github-pdpp-1700000000000",
          connectorId: "github-pdpp",
          collectionMode: "incremental",
          streams: [],
          githubToken: "ghp_transient",
          connectionId: null,
          setupSecrets: null,
        },
      }
    )
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

  it("hands ChatGPT static secrets only to the installed PDPP host invoke", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport(
        {
          ...TEST_PLATFORM,
          id: "chatgpt-pdpp",
          filename: "chatgpt-pdpp",
          runtime: "pdpp-network",
        },
        {
          setupSecrets: {
            username: "owner@example.com",
            password: "transient-password",
          },
        }
      )
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      {
        request: expect.objectContaining({
          connectorId: "chatgpt-pdpp",
          connectionId: "chatgpt-pdpp-owner",
          setupSecrets: {
            username: "owner@example.com",
            password: "transient-password",
          },
        }),
      }
    )
    expect(startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ setupSecrets: expect.anything() })
    )
  })

  it("assigns an owner connection to a browser PDPP connector without setup fields", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport({
        ...TEST_PLATFORM,
        id: "anthropic-pdpp",
        filename: "anthropic-pdpp",
        runtime: "pdpp-network",
        setup: null,
      })
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      expect.objectContaining({
        request: expect.objectContaining({
          connectorId: "anthropic-pdpp",
          connectionId: "anthropic-pdpp-owner",
        }),
      })
    )
  })

  it("keeps a URI connector id while deriving safe stable host identifiers", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { installedPdppConnectionId, useConnector } =
      await import("./useConnector")
    const platform: Platform = {
      ...TEST_PLATFORM,
      id: "https://registry.pdpp.dev/connectors/not-bundled",
      company: "Example",
      name: "Unbundled connector",
      filename: "not-bundled",
      runtime: "pdpp-network",
    }
    const connectionId = installedPdppConnectionId(platform)

    expect(connectionId).toMatch(/^pdpp-[0-9a-f]{8}-owner$/)
    expect(installedPdppConnectionId(platform)).toBe(connectionId)

    const { result } = renderHook(() => useConnector())
    await act(async () => {
      await result.current.startImport(platform)
    })

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^pdpp-[0-9a-f]{8}-1700000000000$/),
        platformId: platform.id,
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      {
        request: expect.objectContaining({
          runId: expect.stringMatching(/^pdpp-[0-9a-f]{8}-1700000000000$/),
          connectorId: platform.id,
          connectionId,
        }),
      }
    )
  })

  it("passes generic static secrets to installed PDPP host invokes", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const { useConnector } = await import("./useConnector")
    const { result } = renderHook(() => useConnector())

    await act(async () => {
      await result.current.startImport(
        {
          ...TEST_PLATFORM,
          id: "ynab-pdpp",
          filename: "ynab-pdpp",
          runtime: "pdpp-network",
          setup: {
            modality: "static_secret",
            credentialCapture: {
              fields: [{ name: "secret", required: true, secret: true }],
            },
          },
        },
        {
          setupSecrets: {
            secret: "ynab_transient_pat",
          },
        }
      )
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      "start_installed_pdpp_connector_run",
      {
        request: expect.objectContaining({
          connectorId: "ynab-pdpp",
          connectionId: "ynab-pdpp-owner",
          setupSecrets: {
            secret: "ynab_transient_pat",
          },
        }),
      }
    )
    expect(startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ setupSecrets: expect.anything() })
    )
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
    expect(mockInvoke).toHaveBeenCalledWith(
      "stop_installed_pdpp_connector_run",
      {
        runId: "github-pdpp-run",
      }
    )
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "stop_connector_run",
      expect.anything()
    )
  })
})
