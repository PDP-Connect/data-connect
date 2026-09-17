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
  removeConnectorUpdate: vi.fn(),
}))

const personalServerState = vi.hoisted(() => ({
  status: "running" as "running" | "starting" | "stopped" | "error",
  statusRef: {
    current: "running" as "running" | "starting" | "stopped" | "error",
  },
  restartServer: vi.fn().mockResolvedValue(true),
}))

const reduxState = vi.hoisted(() => ({
  pendingConnectorChanges: [] as string[],
}))

vi.mock("@/hooks/useConnectorUpdates", () => ({
  useConnectorUpdates: () => updateState,
}))

vi.mock("@/hooks/usePersonalServer", () => ({
  usePersonalServer: () => personalServerState,
}))

vi.mock("react-redux", () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ app: reduxState }),
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

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    platformId: "other-source",
    filename: "other-source",
    company: "Other",
    name: "Other source",
    startDate: new Date(0).toISOString(),
    status: "running",
    url: "",
    isConnected: true,
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

const CONNECTED_PLATFORM: Platform = {
  id: "connected-source",
  company: "Connected",
  name: "Connected source",
  filename: "connected-source",
  description: "Connected source",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: null,
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
  runtime: "playwright",
}

afterEach(() => {
  cleanup()
  updateState.updates = []
  updateState.downloadConnector.mockClear()
  updateState.checkForUpdates.mockClear()
  updateState.removeConnectorUpdate.mockClear()
  personalServerState.restartServer.mockClear()
  personalServerState.status = "running"
  personalServerState.statusRef.current = "running"
  reduxState.pendingConnectorChanges = []
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

    const reason = screen.getByText(
      "Not available on this device · Requires unavailable binding: desktop_session"
    )
    expect(reason).toBeTruthy()
    expect(reason.className).toContain("whitespace-normal")
    expect(reason.className).not.toContain("truncate")
    expect(
      screen.getByRole("button", { name: /Connect Desktop-only/ })
    ).toHaveProperty("disabled", true)
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull()
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

    screen.getByRole("button", { name: /Add New source/i }).click()

    await waitFor(() => {
      expect(updateState.downloadConnector).toHaveBeenCalledWith("New source")
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
    })
  })

  it.each(["running", "pending"] as const)(
    "defers the serving restart while a %s import is active",
    async status => {
      updateState.updates = [makeUpdate("New source")]

      render(
        <AvailableSourcesList {...emptyProps} runs={[makeRun({ status })]} />
      )

      screen.getByRole("button", { name: /Add New source/i }).click()

      await waitFor(() => {
        expect(updateState.downloadConnector).toHaveBeenCalledWith("New source")
      })

      expect(personalServerState.restartServer).not.toHaveBeenCalled()
      expect(
        screen.getByText("Will apply after the current import finishes")
      ).toBeTruthy()
      expect(
        screen.getByRole("button", { name: /Applying… New source/i })
      ).toHaveProperty("disabled", true)
    }
  )

  it("restarts and reloads platforms after the last active import ends", async () => {
    updateState.updates = [makeUpdate("New source")]
    const onReloadPlatforms = vi.fn()
    const { rerender } = render(
      <AvailableSourcesList
        {...emptyProps}
        runs={[makeRun({ status: "running" })]}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Add New source/i }).click()
    await waitFor(() => {
      expect(
        screen.getByText("Will apply after the current import finishes")
      ).toBeTruthy()
    })

    rerender(
      <AvailableSourcesList
        {...emptyProps}
        runs={[makeRun({ status: "success" })]}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    await waitFor(() => {
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
    })
  })

  it("does not restart twice when the terminal run state rerenders", async () => {
    updateState.updates = [makeUpdate("New source")]
    const onReloadPlatforms = vi.fn()
    const { rerender } = render(
      <AvailableSourcesList
        {...emptyProps}
        runs={[makeRun()]}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Add New source/i }).click()
    await waitFor(() => {
      expect(
        screen.getByText("Will apply after the current import finishes")
      ).toBeTruthy()
    })

    const terminalProps = {
      ...emptyProps,
      runs: [makeRun({ status: "partial" })],
      onReloadPlatforms,
    }
    rerender(<AvailableSourcesList {...terminalProps} />)
    rerender(<AvailableSourcesList {...terminalProps} />)

    await waitFor(() => {
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
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
    screen.getByRole("button", { name: /Add New source/i }).click()

    const applyingNotice = await screen.findByText("Applying connector change…")
    expect(applyingNotice.className).toContain("fixed")

    resolveRestart(true)
    await waitFor(() => {
      expect(screen.queryByText("Applying connector change…")).toBeNull()
    })
  })

  it("recomposes once after an install completes across server startup", async () => {
    updateState.updates = [makeUpdate("New source")]
    personalServerState.status = "starting" as const
    personalServerState.statusRef.current = "starting"
    let resolveDownload!: (installed: boolean) => void
    updateState.downloadConnector.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveDownload = resolve
        })
    )
    const onReloadPlatforms = vi.fn()
    const { rerender } = render(
      <AvailableSourcesList
        {...emptyProps}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Add New source/i }).click()
    await waitFor(() => {
      expect(updateState.downloadConnector).toHaveBeenCalledWith("New source")
    })

    personalServerState.status = "running" as const
    personalServerState.statusRef.current = "running"
    rerender(
      <AvailableSourcesList
        {...emptyProps}
        onReloadPlatforms={onReloadPlatforms}
      />
    )
    resolveDownload(true)

    await waitFor(() => {
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
    })
  })

  it("keeps a failed restart unapplied and retries the recompose", async () => {
    updateState.updates = [makeUpdate("New source")]
    const onReloadPlatforms = vi.fn()
    personalServerState.restartServer
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    render(
      <AvailableSourcesList
        {...emptyProps}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Add New source/i }).click()

    const retryButton = await screen.findByRole("button", {
      name: /Installed but not applied.*New source.*Retry/i,
    })
    expect(retryButton).toHaveProperty("disabled", false)
    expect(screen.queryByText("Applying connector change…")).toBeNull()
    expect(onReloadPlatforms).not.toHaveBeenCalled()

    retryButton.click()

    await waitFor(() => {
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(2)
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
    })
  })

  it("retries a failed restart when the Personal Server is already in error", async () => {
    updateState.updates = [makeUpdate("New source")]
    personalServerState.status = "error"
    personalServerState.statusRef.current = "error"
    personalServerState.restartServer
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const onReloadPlatforms = vi.fn()

    render(
      <AvailableSourcesList
        {...emptyProps}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Add New source/i }).click()
    const retryButton = await screen.findByRole("button", {
      name: /Installed but not applied.*New source.*Retry/i,
    })
    expect(personalServerState.restartServer).toHaveBeenCalledTimes(1)
    expect(onReloadPlatforms).not.toHaveBeenCalled()

    retryButton.click()
    await waitFor(() => {
      expect(personalServerState.restartServer).toHaveBeenCalledTimes(2)
      expect(onReloadPlatforms).toHaveBeenCalledTimes(1)
    })
  })

  it("keeps a connected source retryable after its catalog update disappears", async () => {
    const platform = CONNECTED_PLATFORM
    updateState.updates = [
      makeUpdate("connected-source", {
        isNew: false,
        hasUpdate: true,
        currentVersion: "0.9.0",
      }),
    ]
    personalServerState.restartServer.mockResolvedValueOnce(false)
    const onReloadPlatforms = vi.fn()
    const { rerender } = render(
      <AvailableSourcesList
        {...emptyProps}
        platforms={[platform]}
        connectedPlatformIds={[platform.id]}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    screen.getByRole("button", { name: /Update connected-source/i }).click()
    await screen.findByRole("button", {
      name: /Installed but not applied.*Connected source.*Retry/i,
    })

    updateState.updates = []
    rerender(
      <AvailableSourcesList
        {...emptyProps}
        platforms={[platform]}
        connectedPlatformIds={[platform.id]}
        onReloadPlatforms={onReloadPlatforms}
      />
    )

    expect(
      screen.getByRole("button", {
        name: /Installed but not applied.*Connected source.*Retry/i,
      })
    ).toBeTruthy()
    expect(onReloadPlatforms).not.toHaveBeenCalled()
  })
})
