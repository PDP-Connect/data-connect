// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectorUpdateInfo, Platform, Run } from "@/types"
import { AvailableSourcesList } from "./available-sources-list"

const updateState = vi.hoisted(() => ({
  updates: [] as ConnectorUpdateInfo[],
  isCheckingUpdates: false,
  error: null as string | null,
  downloadErrors: {} as Record<string, string>,
  downloadConnector: vi.fn().mockResolvedValue(true),
  checkForUpdates: vi.fn().mockResolvedValue([]),
  isDownloading: vi.fn(() => false),
}))

const personalServerState = vi.hoisted(() => ({
  status: "running" as const,
  restartServer: vi.fn().mockResolvedValue(true),
}))

vi.mock("@/hooks/useConnectorUpdates", () => ({
  useConnectorUpdates: () => updateState,
}))

vi.mock("@/hooks/usePersonalServer", () => ({
  usePersonalServer: () => personalServerState,
}))

vi.mock("@/hooks/use-show-development-connectors", () => ({
  useShowDevelopmentConnectors: () => ({ showDevelopmentConnectors: true }),
}))

vi.mock("@/components/icons/platform-icon", () => ({
  PlatformIcon: () => <span aria-hidden="true" />,
}))

function makeUpdate(
  id: string,
  overrides: Partial<ConnectorUpdateInfo> = {}
): ConnectorUpdateInfo {
  return {
    id,
    name: id,
    description: `${id} connector`,
    company: id,
    currentVersion: null,
    latestVersion: "1.0.0",
    hasUpdate: false,
    isNew: true,
    tier: "supported",
    requiredBindings: [],
    setupModality: null,
    runnable: true,
    unavailableReason: null,
    ...overrides,
  }
}

const emptyProps = {
  platforms: [] as Platform[],
  runs: [] as Run[],
  onExport: vi.fn(),
  onStopRun: vi.fn(),
  connectedPlatformIds: [] as string[],
}

afterEach(() => {
  cleanup()
  updateState.updates = []
  updateState.downloadConnector.mockClear()
  updateState.checkForUpdates.mockClear()
  personalServerState.restartServer.mockClear()
})

describe("AvailableSourcesList catalog states", () => {
  it("shows Preview and Development tiers but does not add a Supported chip", () => {
    updateState.updates = [
      makeUpdate("Preview source", { tier: "preview" }),
      makeUpdate("Development source", { tier: "development" }),
      makeUpdate("Supported source", { tier: "supported" }),
    ]

    render(<AvailableSourcesList {...emptyProps} />)

    expect(screen.getByText("Preview")).toBeTruthy()
    expect(screen.getByText("Development")).toBeTruthy()
    expect(screen.queryByText("Supported")).toBeNull()
  })

  it("disables unavailable sources with the exact device reason and no install action", () => {
    updateState.updates = [
      makeUpdate("Desktop-only", {
        runnable: false,
        unavailableReason: "Requires unavailable binding: desktop_session",
      }),
    ]

    render(<AvailableSourcesList {...emptyProps} />)

    expect(
      screen.getByText(
        "Not available on this device · Requires unavailable binding: desktop_session"
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: /Connect Desktop-only/ })
    ).toHaveProperty("disabled", true)
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull()
  })

  it("installs a catalog source and reloads installed platforms", async () => {
    updateState.updates = [makeUpdate("New source")]
    const onReloadPlatforms = vi.fn()

    render(
      <AvailableSourcesList
        {...emptyProps}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Install New source/i }).click()

    await waitFor(() => {
      expect(updateState.downloadConnector).toHaveBeenCalledWith("New source")
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
    })
  })

  it("shows the serving restart state until the connector change is applied", async () => {
    updateState.updates = [makeUpdate("New source")]
    let resolveRestart!: (value: boolean) => void
    personalServerState.restartServer.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRestart = resolve
        })
    )

    render(<AvailableSourcesList {...emptyProps} />)
    screen.getByRole("button", { name: /Install New source/i }).click()

    expect(await screen.findByText("Applying connector change…")).toBeTruthy()

    resolveRestart(true)
    await waitFor(() => {
      expect(screen.queryByText("Applying connector change…")).toBeNull()
    })
  })
})
