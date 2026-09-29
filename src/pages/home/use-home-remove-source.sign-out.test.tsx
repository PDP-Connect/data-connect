// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router-dom"
import { expect, it, vi } from "vitest"
import { setPlatforms, setRuns, store } from "@/state/store"
import type { Platform } from "@/types"
import { useHomeRemoveSource } from "./use-home-remove-source"
const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => mockInvoke(...a),
}))
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  )),
  useNavigate: () => vi.fn(),
}))
const base = {
  company: "GitHub",
  name: "GitHub",
  description: "",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: null,
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
}
const legacy = {
  ...base,
  id: "github-playwright",
  filename: "github-playwright",
  runtime: "playwright-runtime",
} as Platform
const pdpp = {
  ...base,
  id: "github-pdpp",
  filename: "github-pdpp",
  runtime: "pdpp-network",
  requiresBrowser: false,
  connectionId: "default",
} as Platform
it("signs out the migrated GitHub row's legacy browser session", async () => {
  store.dispatch(setPlatforms([legacy, pdpp]))
  store.dispatch(setRuns([]))
  mockInvoke.mockImplementation(async (c: string) =>
    c === "list_browser_sessions"
      ? [{ connectorId: "github-playwright" }]
      : c === "reference_server_has_connection"
        ? false
        : undefined
  )
  const { result } = renderHook(() => useHomeRemoveSource(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <Provider store={store}>
        <MemoryRouter>{children}</MemoryRouter>
      </Provider>
    ),
  })
  act(() => result.current.request(pdpp))
  await waitFor(() => expect(result.current.canSignOut).toBe(true))
  await act(() => result.current.signOut())
  expect(mockInvoke.mock.calls.map(([c]) => c)).toContain(
    "clear_browser_session"
  )
})

it("does not offer sign out on a minted GitHub account for the sibling legacy session", async () => {
  const mintedAccount: Platform = {
    ...legacy,
    id: "github-pdpp",
    filename: "github-pdpp",
    runtime: "pdpp-network",
    requiresBrowser: false,
    connectionId: "connection-bbbb",
  }
  store.dispatch(setPlatforms([legacy, mintedAccount]))
  store.dispatch(setRuns([]))
  mockInvoke.mockImplementation(async (c: string) =>
    c === "list_browser_sessions"
      ? [{ connectorId: "github-playwright" }]
      : c === "reference_server_has_connection"
        ? false
        : undefined
  )
  const { result } = renderHook(() => useHomeRemoveSource(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <Provider store={store}>
        <MemoryRouter>{children}</MemoryRouter>
      </Provider>
    ),
  })
  act(() => result.current.request(mintedAccount))
  await waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith("list_browser_sessions")
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current.canSignOut).toBe(false)
})
