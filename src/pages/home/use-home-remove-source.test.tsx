// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  setConnectedPlatforms,
  setPlatforms,
  setRuns,
  store,
} from "@/state/store"
import type { Platform, Run } from "@/types"
import { useHomeRemoveSource } from "./use-home-remove-source"

const mockInvoke = vi.fn()
const mockNavigate = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => mockNavigate }
})

function platform(overrides: Partial<Platform>): Platform {
  return {
    id: "amazon-pdpp",
    company: "amazon",
    name: "Amazon",
    filename: "amazon-pdpp",
    description: "",
    isUpdated: false,
    logoURL: "",
    needsConnection: true,
    connectURL: null,
    connectSelector: null,
    exportFrequency: null,
    vectorize_config: null,
    runtime: "pdpp-network",
    ...overrides,
  }
}

const BROWSER = platform({ requiresBrowser: true })
const NON_BROWSER = platform({
  id: "ynab-pdpp",
  company: "ynab",
  name: "YNAB",
  filename: "ynab-pdpp",
  requiresBrowser: false,
  setup: { modality: "static_secret", credentialCapture: { fields: [] } },
})
const OTHER = platform({
  id: "spotify-pdpp",
  company: "spotify",
  name: "Spotify",
  filename: "spotify-pdpp",
})

function run(id: string, source: Platform, extra: Partial<Run> = {}): Run {
  return {
    id,
    platformId: source.id,
    filename: source.filename,
    company: source.company,
    name: source.name,
    isConnected: true,
    startDate: "2026-09-01T00:00:00.000Z",
    status: "success",
    url: "",
    logs: "",
    exportPath: `/data/exported_data/${source.company}/${source.name}/${id}`,
    ...extra,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      <MemoryRouter>{children}</MemoryRouter>
    </Provider>
  )
}

type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>

function answer(handlers: Handlers) {
  mockInvoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command]
      if (!handler) throw new Error(`unexpected command ${command}`)
      return handler(args)
    }
  )
}

const localRemovalHandlers: Handlers = {
  reference_server_has_connection: () => false,
  list_browser_sessions: () => [],
  reset_installed_pdpp_browser_profile: () => undefined,
  clear_browser_session: () => undefined,
  clear_pdpp_collection_state: () => undefined,
  delete_exported_run: () => undefined,
  check_connected_platforms: () => ({
    "amazon-pdpp": false,
    "ynab-pdpp": false,
    "spotify-pdpp": true,
  }),
}

function commands() {
  return mockInvoke.mock.calls.map(([command, args]) => [command, args])
}

describe("useHomeRemoveSource", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockNavigate.mockReset()
    store.dispatch(setPlatforms([BROWSER, NON_BROWSER, OTHER]))
    store.dispatch(
      setConnectedPlatforms({
        "amazon-pdpp": true,
        "ynab-pdpp": true,
        "spotify-pdpp": true,
      })
    )
    store.dispatch(
      setRuns([
        run("amazon-1", BROWSER),
        run("amazon-2", BROWSER, { status: "error", exportPath: undefined }),
        run("ynab-1", NON_BROWSER),
        run("spotify-1", OTHER),
      ])
    )
  })

  it("signs a browser source out without touching its data", async () => {
    answer(localRemovalHandlers)
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    expect(result.current.canSignOut).toBe(true)
    await act(() => result.current.signOut())

    expect(commands()).toEqual([
      ["reference_server_has_connection", { connectorKey: "amazon" }],
      ["list_browser_sessions", undefined],
      [
        "reset_installed_pdpp_browser_profile",
        { connectorId: "amazon-pdpp", connectionId: "amazon-pdpp-owner" },
      ],
    ])
    expect(result.current.platform).toBeNull()
    expect(store.getState().app.runs.map(entry => entry.id)).toContain(
      "amazon-1"
    )
  })

  it("keeps the dialog open and shows why a sign-out was refused", async () => {
    answer({
      ...localRemovalHandlers,
      reset_installed_pdpp_browser_profile: () => {
        throw "PDPP browser profile is in use by a running collection"
      },
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await act(() => result.current.signOut())

    expect(result.current.platform).toBe(BROWSER)
    expect(result.current.pending).toBeNull()
    expect(result.current.error).toBe(
      "PDPP browser profile is in use by a running collection"
    )
  })

  it("does not offer sign-out for a source without a browser session", async () => {
    answer(localRemovalHandlers)
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(NON_BROWSER))
    expect(result.current.canSignOut).toBe(false)
    await act(() => result.current.signOut())

    expect(commands()).toEqual([
      ["reference_server_has_connection", { connectorKey: "ynab" }],
      ["list_browser_sessions", undefined],
    ])
  })

  it("signs out of a legacy browser source when its saved session exists", async () => {
    const linkedin = platform({
      id: "linkedin-playwright",
      company: "linkedin",
      name: "LinkedIn",
      filename: "linkedin-playwright",
      runtime: "playwright-runtime",
    })
    answer({
      ...localRemovalHandlers,
      list_browser_sessions: () => [{ connectorId: "linkedin-playwright" }],
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(linkedin))
    await waitFor(() => expect(result.current.canSignOut).toBe(true))
    await act(() => result.current.signOut())

    expect(commands()).toContainEqual([
      "clear_browser_session",
      { connectorId: "linkedin-playwright" },
    ])
    expect(result.current.platform).toBeNull()
  })

  it("clears both ChatGPT browser profiles when signing out of its merged row", async () => {
    const chatgpt = platform({
      id: "chatgpt-pdpp",
      company: "openai",
      name: "ChatGPT",
      filename: "chatgpt-pdpp",
      runtime: "pdpp-network",
      requiresBrowser: true,
    })
    const chatgptLegacy = platform({
      id: "chatgpt-playwright",
      company: "openai",
      name: "ChatGPT",
      filename: "chatgpt-playwright",
      runtime: "playwright-runtime",
    })
    store.dispatch(setPlatforms([chatgpt, chatgptLegacy]))
    answer({
      ...localRemovalHandlers,
      list_browser_sessions: () => [{ connectorId: "chatgpt-playwright" }],
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(chatgpt))
    await act(() => result.current.signOut())

    expect(commands()).toContainEqual([
      "reset_installed_pdpp_browser_profile",
      { connectorId: "chatgpt-pdpp", connectionId: "chatgpt-pdpp-owner" },
    ])
    expect(commands()).toContainEqual([
      "clear_browser_session",
      { connectorId: "chatgpt-playwright" },
    ])
  })

  it("signs out, clears state, deletes exports and drops runs for a browser source", async () => {
    answer(localRemovalHandlers)
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await act(() => result.current.removeLocalData())

    expect(commands()).toEqual([
      ["reference_server_has_connection", { connectorKey: "amazon" }],
      ["list_browser_sessions", undefined],
      [
        "reset_installed_pdpp_browser_profile",
        { connectorId: "amazon-pdpp", connectionId: "amazon-pdpp-owner" },
      ],
      ["clear_pdpp_collection_state", { connectorId: "amazon-pdpp" }],
      [
        "delete_exported_run",
        { exportPath: "/data/exported_data/amazon/Amazon/amazon-1" },
      ],
      [
        "check_connected_platforms",
        { platformIds: ["amazon-pdpp", "ynab-pdpp", "spotify-pdpp"] },
      ],
    ])
    expect(store.getState().app.runs.map(entry => entry.id)).toEqual([
      "ynab-1",
      "spotify-1",
    ])
    expect(store.getState().app.connectedPlatforms["amazon-pdpp"]).toBe(false)
    expect(result.current.platform).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("removes a non-browser source without a sign-out call", async () => {
    answer(localRemovalHandlers)
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(NON_BROWSER))
    await act(() => result.current.removeLocalData())

    expect(commands()).toEqual([
      ["reference_server_has_connection", { connectorKey: "ynab" }],
      ["list_browser_sessions", undefined],
      ["clear_pdpp_collection_state", { connectorId: "ynab-pdpp" }],
      [
        "delete_exported_run",
        { exportPath: "/data/exported_data/ynab/YNAB/ynab-1" },
      ],
      [
        "check_connected_platforms",
        { platformIds: ["amazon-pdpp", "ynab-pdpp", "spotify-pdpp"] },
      ],
    ])
    expect(store.getState().app.runs.map(entry => entry.id)).toEqual([
      "amazon-1",
      "amazon-2",
      "spotify-1",
    ])
    expect(result.current.platform).toBeNull()
  })

  it("removes Claude runs without removing Claude Code runs", async () => {
    const claude = platform({
      id: "claude-export-playwright",
      company: "anthropic",
      name: "Claude",
      filename: "claude-export-playwright",
      runtime: "playwright-runtime",
    })
    const claudeCode = platform({
      id: "claude-code-local",
      company: "anthropic",
      name: "Claude Code",
      filename: "claude-code-local",
      runtime: "playwright-runtime",
    })
    const claudeRun = run("claude-1", claude)
    const claudeCodeRun = run("claude-code-1", claudeCode)
    store.dispatch(setPlatforms([claude, claudeCode]))
    store.dispatch(setRuns([claudeRun, claudeCodeRun]))
    answer({
      ...localRemovalHandlers,
      check_connected_platforms: () => ({
        "claude-export-playwright": false,
        "claude-code-local": true,
      }),
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(claude))
    await act(() => result.current.removeLocalData())

    expect(commands()).toContainEqual([
      "delete_exported_run",
      { exportPath: claudeRun.exportPath },
    ])
    expect(commands()).not.toContainEqual([
      "delete_exported_run",
      { exportPath: claudeCodeRun.exportPath },
    ])
    expect(store.getState().app.runs.map(entry => entry.id)).toEqual([
      "claude-code-1",
    ])
  })

  it("removes runs for both ChatGPT connector IDs", async () => {
    const chatgpt = platform({
      id: "chatgpt-pdpp",
      company: "openai",
      name: "ChatGPT",
      filename: "chatgpt-pdpp",
      runtime: "pdpp-network",
      requiresBrowser: true,
    })
    const chatgptLegacy = platform({
      id: "chatgpt-playwright",
      company: "openai",
      name: "ChatGPT",
      filename: "chatgpt-playwright",
      runtime: "playwright-runtime",
    })
    const pdppRun = run("chatgpt-pdpp-1", chatgpt)
    const legacyRun = run("chatgpt-playwright-1", chatgptLegacy)
    store.dispatch(setPlatforms([chatgpt, chatgptLegacy]))
    store.dispatch(setRuns([pdppRun, legacyRun]))
    answer({
      ...localRemovalHandlers,
      check_connected_platforms: () => ({
        "chatgpt-pdpp": false,
        "chatgpt-playwright": false,
      }),
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(chatgpt))
    await act(() => result.current.removeLocalData())

    expect(commands()).toContainEqual([
      "delete_exported_run",
      { exportPath: pdppRun.exportPath },
    ])
    expect(commands()).toContainEqual([
      "delete_exported_run",
      { exportPath: legacyRun.exportPath },
    ])
    expect(store.getState().app.runs).toEqual([])
  })

  it("deletes nothing when the sign-out is refused and surfaces the error", async () => {
    answer({
      ...localRemovalHandlers,
      reset_installed_pdpp_browser_profile: () => {
        throw new Error("PDPP browser profile is in use")
      },
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await act(() => result.current.removeLocalData())

    expect(commands().map(([command]) => command)).toEqual([
      "reference_server_has_connection",
      "list_browser_sessions",
      "reset_installed_pdpp_browser_profile",
    ])
    expect(store.getState().app.runs).toHaveLength(4)
    expect(result.current.platform).toBe(BROWSER)
    expect(result.current.error).toBe("PDPP browser profile is in use")
  })

  it("says so when the source still has saved files after removal", async () => {
    answer({
      ...localRemovalHandlers,
      check_connected_platforms: () => ({
        "amazon-pdpp": true,
        "ynab-pdpp": false,
        "spotify-pdpp": true,
      }),
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await act(() => result.current.removeLocalData())

    expect(result.current.platform).toBe(BROWSER)
    expect(result.current.error).toBe(
      "Some saved files for Amazon are still on this computer, so it still shows in this list."
    )
  })

  it("links to the server danger zone only when the server holds a connection", async () => {
    answer({ ...localRemovalHandlers, reference_server_has_connection: () => true })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await waitFor(() => expect(result.current.hasServerConnection).toBe(true))
    act(() => result.current.openServerRepairs())

    expect(mockNavigate).toHaveBeenCalledWith(
      "/server-repairs?path=%2Fsources%2Famazon%23danger-zone"
    )
    expect(result.current.platform).toBeNull()
  })

  it("hides the server link when the check fails or no key is known", async () => {
    answer({
      ...localRemovalHandlers,
      reference_server_has_connection: () => {
        throw new Error("reference server unreachable")
      },
    })
    const { result } = renderHook(() => useHomeRemoveSource(), { wrapper })

    act(() => result.current.request(BROWSER))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
    expect(result.current.hasServerConnection).toBe(false)
    act(() => result.current.openServerRepairs())
    expect(mockNavigate).not.toHaveBeenCalled()

    mockInvoke.mockClear()
    act(() => result.current.request(platform({ runtime: "vanilla" })))
    expect(commands()).toEqual([["list_browser_sessions", undefined]])
    expect(result.current.hasServerConnection).toBe(false)
  })
})
