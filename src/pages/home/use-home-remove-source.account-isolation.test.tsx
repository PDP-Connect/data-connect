// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Removing the legacy ChatGPT row must preserve every PDPP account's runs.
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, expect, it, vi } from "vitest"
import { setPlatforms, setRuns, store } from "@/state/store"
import type { Platform, Run } from "@/types"
import { useHomeRemoveSource } from "./use-home-remove-source"

const mockInvoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => mockInvoke(...a),
}))
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => vi.fn() }
})
const base = {
  company: "OpenAI",
  name: "ChatGPT",
  description: "",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: null,
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
}
const legacy: Platform = {
  ...base,
  id: "chatgpt-playwright",
  filename: "chatgpt-playwright",
  runtime: "playwright-runtime",
}
const a: Platform = {
  ...base,
  id: "chatgpt-pdpp",
  filename: "chatgpt-pdpp",
  runtime: "pdpp-network",
  requiresBrowser: true,
  connectionId: "chatgpt-pdpp-owner",
}
const b: Platform = {
  ...a,
  connectionId: "connection-bbbb",
  accountLabel: "Account 2",
}
const run = (id: string, p: Platform): Run => ({
  id,
  platformId: p.id,
  connectionId: p.connectionId,
  filename: p.filename,
  company: p.company,
  name: p.name,
  isConnected: true,
  startDate: "2026-09-01T00:00:00.000Z",
  status: "success",
  url: "",
  logs: "",
  exportPath: `/data/exported_data/OpenAI/ChatGPT/${id}`,
})
beforeEach(() => mockInvoke.mockReset())
it("removing the legacy ChatGPT row keeps every PDPP account's runs", async () => {
  store.dispatch(setPlatforms([legacy, a, b]))
  store.dispatch(
    setRuns([run("legacy-1", legacy), run("a-1", a), run("b-1", b)])
  )
  mockInvoke.mockImplementation(async (cmd: string) =>
    cmd === "check_connected_platforms"
      ? {}
      : cmd === "list_browser_sessions"
        ? []
        : cmd === "reference_server_has_connection"
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
  act(() => result.current.request(legacy))
  await act(() => result.current.removeLocalData())
  const deleted = mockInvoke.mock.calls
    .filter(([c]) => c === "delete_exported_run")
    .map(([, x]) => (x as { exportPath: string }).exportPath)
  expect(deleted).toContain("/data/exported_data/OpenAI/ChatGPT/legacy-1")
  expect(deleted).not.toContain("/data/exported_data/OpenAI/ChatGPT/a-1")
  expect(deleted).not.toContain("/data/exported_data/OpenAI/ChatGPT/b-1")
})
