// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LINKS } from "@/config/links"
import { SettingsAbout } from "./settings-about"

describe("SettingsAbout", () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
  })

  it("persists development visibility and shows browser refresh feedback", async () => {
    vi.useFakeTimers()
    const onCheckBrowserStatus = vi.fn()

    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="idle"
          nodeTestResult={null}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "bundled" }}
          pathsDebug={null}
          personalServer={{ status: "stopped", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={onCheckBrowserStatus}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="idle"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={vi.fn()}
        />
      </TooltipProvider>
    )

    const developmentToggle = screen.getByRole("switch", {
      name: "Show development connectors",
    })
    expect(developmentToggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(developmentToggle)
    expect(developmentToggle.getAttribute("aria-checked")).toBe("true")
    expect(localStorage.getItem("dataconnect_show_development_connectors")).toBe(
      "true"
    )
    fireEvent.click(developmentToggle)
    expect(
      localStorage.getItem("dataconnect_show_development_connectors")
    ).toBeNull()

    expect(screen.getByText("Bundled Chromium found")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    expect(onCheckBrowserStatus).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    expect(
      (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("shows loading state while personal server is starting", () => {
    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="idle"
          nodeTestResult={null}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "system" }}
          pathsDebug={null}
          personalServer={{ status: "starting", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={vi.fn()}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="idle"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(
      (screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("closes node test success details when close is clicked", () => {
    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="success"
          nodeTestResult={{
            nodejs: "v22.0.0",
            platform: "darwin",
            arch: "arm64",
            hostname: "mbp.local",
            cpus: 10,
            memory: "16 GB",
            uptime: "12m",
          }}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "system" }}
          pathsDebug={null}
          personalServer={{ status: "stopped", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={vi.fn()}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="idle"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByText(/Hostname:/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByText(/Hostname:/)).toBeNull()
  })

  it("shows explicit telemetry copy", () => {
    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="idle"
          nodeTestResult={null}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "system" }}
          pathsDebug={null}
          personalServer={{ status: "stopped", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={vi.fn()}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="idle"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(
      screen.getByText("Share anonymous usage & reliability data")
    ).toBeTruthy()
    expect(
      screen.getByText("Helps improve connector reliability and app quality.")
    ).toBeTruthy()
    expect(
      screen.getByText(
        /No payload contents, file paths, Personal Server URLs, or account-linked identity are sent\./
      )
    ).toBeTruthy()
  })

  it("routes resource links to docs", () => {
    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="idle"
          nodeTestResult={null}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "system" }}
          pathsDebug={null}
          personalServer={{ status: "stopped", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={vi.fn()}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="idle"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={vi.fn()}
        />
      </TooltipProvider>
    )

    const resourceLinks = screen.getAllByRole("link", { name: "Open" })
    expect(resourceLinks).toHaveLength(1)
    for (const link of resourceLinks) {
      expect(link.getAttribute("href")).toBe(LINKS.docs)
    }
  })

  it("confirms deletion and triggers personal server data clear action", () => {
    const onClearPersonalServerData = vi.fn()
    render(
      <TooltipProvider delayDuration={120}>
        <SettingsAbout
          appVersion="1.2.3"
          logPath="/tmp/logs"
          nodeTestStatus="idle"
          nodeTestResult={null}
          nodeTestError={null}
          browserStatus={{ available: true, browser_type: "system" }}
          pathsDebug={null}
          personalServer={{ status: "stopped", port: null, error: null }}
          simulateNoChrome={false}
          onTestNodeJs={vi.fn()}
          onCheckBrowserStatus={vi.fn()}
          onDebugPaths={vi.fn()}
          onClearDebugPaths={vi.fn()}
          onRestartPersonalServer={vi.fn()}
          onStopPersonalServer={vi.fn()}
          onSimulateNoChromeChange={vi.fn()}
          onOpenLogFolder={vi.fn()}
          telemetryEnabled={true}
          onTelemetryEnabledChange={vi.fn()}
          clearPersonalServerDataStatus="success"
          clearPersonalServerDataError={null}
          onClearPersonalServerData={onClearPersonalServerData}
        />
      </TooltipProvider>
    )

    expect(
      screen.getByText("Deleted. You can re-import from Home.")
    ).toBeTruthy()

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0])
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(onClearPersonalServerData).toHaveBeenCalledTimes(1)
  })
})
