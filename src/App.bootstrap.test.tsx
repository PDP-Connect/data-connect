// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom

// Characterizes what the legacy frontend (src/App.tsx) actually runs when its
// window exists. The default unified desktop build never creates that window
// (see create_legacy_main_window in src-tauri/src/lib.rs), so this test only
// exercises the legacy-mode code path; the native command start_personal_server
// itself rejects unified mode (see ensure_legacy_runtime in
// src-tauri/src/commands/server.rs).

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { flushTelemetry, persistAndFlush } from "@/lib/telemetry/client"
import { trackHostCompleted, trackHostStarted } from "@/lib/telemetry/events"
import { TooltipProvider } from "@/components/ui/tooltip"
// Imported statically so the ~400 ms cold transform of the whole app graph is
// paid at file import (which has no per-test timeout), not inside the 5 s test
// budget. Nothing in the graph reads the Tauri marker at import time; every
// isTauriRuntime() check runs inside a hook or handler.
import App from "./App"
import { deriveIconUrls } from "./apps/icon-url"

const invokedCommands: string[] = []

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    invokedCommands.push(cmd)
    switch (cmd) {
      case "check_connector_updates":
        return []
      case "load_runs":
        return []
      case "get_platforms":
        return []
      case "check_connected_platforms":
        return {}
      case "get_personal_server_status":
        return { running: false, port: null }
      case "start_personal_server":
        return { running: true, port: 8080 }
      default:
        return undefined
    }
  },
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}))

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "legacy-bootstrap-test",
}))

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
}))

vi.mock("@/lib/telemetry/client", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/client")>()),
  flushTelemetry: vi.fn(async () => {}),
  persistAndFlush: vi.fn(),
}))

vi.mock("@/lib/telemetry/events", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/events")>()),
  trackHostCompleted: vi.fn(),
  trackHostStarted: vi.fn(),
}))

describe("legacy App bootstrap", () => {
  afterEach(() => {
    cleanup()
    invokedCommands.length = 0
    vi.restoreAllMocks()
    vi.mocked(flushTelemetry).mockClear()
    vi.mocked(persistAndFlush).mockClear()
    vi.mocked(trackHostCompleted).mockClear()
    vi.mocked(trackHostStarted).mockClear()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__
  })

  it("mounting the legacy app starts its own runtime", async () => {
    window.history.pushState({}, "", "/")
    // usePersonalServer() gates its auto-start effect on isTauriRuntime(),
    // which checks for this marker. Real Tauri webviews inject it; jsdom does not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__TAURI_INTERNALS__ = {}

    render(
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(invokedCommands).toContain("start_personal_server")
      expect(invokedCommands).toContain("check_connector_updates")
    })
  })

  it("records host completion and flushes with keepalive on pagehide", async () => {
    window.history.pushState({}, "", "/__loading")
    render(
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>
    )

    await waitFor(() => expect(trackHostStarted).toHaveBeenCalledTimes(1))
    expect(trackHostCompleted).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("pagehide"))
    expect(trackHostCompleted).toHaveBeenCalledTimes(1)
    expect(trackHostCompleted).toHaveBeenCalledWith(expect.any(Number))
    expect(persistAndFlush).toHaveBeenCalledTimes(1)
    expect(flushTelemetry).toHaveBeenLastCalledWith({ keepalive: true })
  })

  it("stops observing pagehide when the app unmounts", async () => {
    window.history.pushState({}, "", "/__loading")
    const { unmount } = render(
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>
    )

    await waitFor(() => expect(trackHostStarted).toHaveBeenCalledTimes(1))
    unmount()
    window.dispatchEvent(new Event("pagehide"))
    expect(trackHostCompleted).not.toHaveBeenCalled()
    expect(persistAndFlush).not.toHaveBeenCalled()
  })
})

it("places valid four-digit early calendar years on the timeline", async () => {
  const { deriveTimeline } = await import("./apps/timeline/timeline-derivation")
  const result = deriveTimeline({ streams: [{
    stream: { id: "archive", label: "Archive", fields: [{ name: "date", format: "date" }],
      primaryKey: [], timestampFields: ["date"] },
    records: [
      { id: "date", data: { date: "0099-01-01" } },
      { id: "datetime", data: { date: "0004-02-29T12:00:00Z" } },
      { id: "invalid", data: { date: "0003-02-29" } },
    ],
    hasMore: false,
  }] }, { maxRecords: 10, maxStreams: 1 })
  expect(result.dayGroups.map(group => group.dayKey)).toEqual(["0099-01-01", "0004-02-29"])
  expect(result.undatedRecords.map(record => record.recordId)).toEqual(["invalid"])
})

describe("app icon candidates", () => {
  it("keeps an explicit icon first, deduplicates it, and resolves fallbacks at the app origin", () => {
    expect(deriveIconUrls("https://app.example/workspace/home", "  https://app.example/favicon.ico  ")).toEqual([
      "https://app.example/favicon.ico",
      "https://app.example/icon.svg",
      "https://app.example/icon.png",
      "https://app.example/apple-touch-icon.png",
    ])
  })

  it("retains a valid explicit icon when the app address cannot be resolved", () => {
    expect(deriveIconUrls("not-an-app-url", "  https://icons.example/app.png  ")).toEqual([
      "https://icons.example/app.png",
    ])
    expect(deriveIconUrls(null, "   ")).toEqual([])
  })
})
