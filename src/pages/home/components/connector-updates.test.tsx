// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Provider } from "react-redux"
import { store, setConnectorUpdates } from "@/state/store"
import type { ConnectorUpdateInfo } from "@/types"
import { ConnectorUpdates } from "./connector-updates"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@/components/icons/platform-icon", () => ({
  PlatformIcon: () => null,
}))

const connector = (
  id: string,
  extra: Partial<ConnectorUpdateInfo> = {}
): ConnectorUpdateInfo => ({
  id,
  name: id,
  description: "",
  company: "",
  currentVersion: null,
  latestVersion: "1.0.0",
  hasUpdate: false,
  isNew: true,
  tier: "supported",
  requiredBindings: ["network"],
  setupModality: null,
  runnable: true,
  unavailableReason: null,
  ...extra,
})
function panel(updates: ConnectorUpdateInfo[], reload = vi.fn()) {
  store.dispatch(setConnectorUpdates(updates))
  return render(
    <Provider store={store}>
      <ConnectorUpdates onReloadPlatforms={reload} />
    </Provider>
  )
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ConnectorUpdates", () => {
  it("shows availability when no connector updates are visible", () => {
    panel([])

    expect(
      screen.getByText("No connector updates or new connectors available")
    ).toBeTruthy()
  })

  it("orders updates, installable, and unavailable groups and hides development entries", () => {
    panel([
      connector("Unavailable", {
        runnable: false,
        requiredBindings: ["filesystem"],
        unavailableReason: "Unsupported binding: filesystem",
      }),
      connector("Development", { tier: "development" }),
      connector("New"),
      connector("Installed", {
        isNew: false,
        hasUpdate: true,
        currentVersion: "0.9.0",
      }),
    ])
    expect(
      screen
        .getAllByRole("region")
        .map(region => region.getAttribute("aria-label"))
    ).toEqual([
      "Installed with update available",
      "Installable",
      "Not available on this device",
    ])
    expect(screen.queryByText("Development")).toBeNull()
    const unavailable = screen.getByRole("region", {
      name: "Not available on this device",
    })
    expect(within(unavailable).getByText(/filesystem/)).toBeTruthy()
    expect(within(unavailable).queryByRole("button")).toBeNull()
  })

  it("shows development entries when the persisted setting is enabled", () => {
    localStorage.setItem("dataconnect_show_development_connectors", "true")
    panel([connector("Development", { tier: "development" })])
    expect(screen.getByText("Development")).toBeTruthy()
  })

  it("installs by id, shows pending progress, and reloads platforms on success", async () => {
    let finish!: () => void
    invoke.mockReturnValue(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const reload = vi.fn()
    panel([connector("New")], reload)
    fireEvent.click(screen.getByRole("button", { name: "Install" }))
    expect(invoke).toHaveBeenCalledWith("download_connector", { id: "New" })
    expect(
      (screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await act(async () => finish())
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("New")).toBeNull()
  })

  it.each(["Download failed", "Download cancelled"])(
    "keeps the connector retryable with inline error: %s",
    async message => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
      invoke.mockRejectedValue(message)
      const reload = vi.fn()
      panel([connector("New")], reload)
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Install" }))
      )
      expect(screen.getByRole("alert").textContent).toBe(message)
      expect(
        (screen.getByRole("button", { name: "Install" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
      expect(reload).not.toHaveBeenCalled()
      expect(errorLog).toHaveBeenCalledWith(
        "Failed to download connector:",
        message
      )
    }
  )
})
