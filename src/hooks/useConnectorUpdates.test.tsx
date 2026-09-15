// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectorUpdateInfo } from "@/types"
import { useConnectorUpdates } from "./useConnectorUpdates"

const dispatch = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())

let state = {
  app: {
    connectorUpdates: [] as ConnectorUpdateInfo[],
    lastUpdateCheck: null as string | null,
    isCheckingUpdates: false,
  },
}

vi.mock("react-redux", () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke }))

function makeUpdate(
  overrides: Partial<ConnectorUpdateInfo> = {}
): ConnectorUpdateInfo {
  return {
    tier: "supported",
    requiredBindings: [],
    setupModality: null,
    runnable: true,
    unavailableReason: null,
    id: "new-source",
    name: "New source",
    description: "New source connector",
    company: "New source",
    currentVersion: null,
    latestVersion: "1.0.0",
    hasUpdate: false,
    isNew: true,
    ...overrides,
  }
}

describe("useConnectorUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state = {
      app: {
        connectorUpdates: [],
        lastUpdateCheck: null,
        isCheckingUpdates: false,
      },
    }
    invoke.mockResolvedValue(undefined)
  })

  it("retains a new connector update until the installed platform reloads", async () => {
    state.app.connectorUpdates = [makeUpdate()]
    const { result } = renderHook(() => useConnectorUpdates())

    await act(async () => {
      await expect(result.current.downloadConnector("new-source")).resolves.toBe(
        true
      )
    })

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "app/removeConnectorUpdate" })
    )
  })

  it("removes an existing connector update after a successful download", async () => {
    state.app.connectorUpdates = [
      makeUpdate({
        isNew: false,
        hasUpdate: true,
        currentVersion: "0.9.0",
      }),
    ]
    const { result } = renderHook(() => useConnectorUpdates())

    await act(async () => {
      await result.current.downloadConnector("new-source")
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: "app/removeConnectorUpdate",
      payload: "new-source",
    })
  })
})
