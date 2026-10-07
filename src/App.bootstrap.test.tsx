// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Characterizes what the legacy frontend (src/App.tsx) actually runs when its
// window exists. The default unified desktop build never creates that window
// (see create_legacy_main_window in src-tauri/src/lib.rs), so this test only
// exercises the legacy-mode code path; the native command start_personal_server
// itself rejects unified mode (see ensure_legacy_runtime in
// src-tauri/src/commands/server.rs).

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

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

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => null,
  onOpenUrl: async () => () => {},
}))

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
}))

describe("legacy App bootstrap", () => {
  afterEach(() => {
    cleanup()
    invokedCommands.length = 0
    vi.restoreAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__
  })

  it("mounting the legacy app starts its own runtime", async () => {
    window.history.pushState({}, "", "/")
    // usePersonalServer() gates its auto-start effect on isTauriRuntime(),
    // which checks for this marker. Real Tauri webviews inject it; jsdom does not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__TAURI_INTERNALS__ = {}

    const { default: App } = await import("./App")

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
})
