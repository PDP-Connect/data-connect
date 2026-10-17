// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { Provider } from "react-redux"
import { TooltipProvider } from "@/components/ui/tooltip"
import { store } from "@/state/store"
import { LEGACY_HARNESS_ROUTES, LegacyHarnessRoutes } from "./App"

vi.mock("@tauri-apps/api/core", async () => {
  const bridge = await import("./mock-tauri")
  return { invoke: bridge.invoke }
})

vi.mock("@tauri-apps/api/event", async () => {
  const bridge = await import("./mock-tauri")
  return { listen: bridge.listen }
})

vi.mock("@tauri-apps/api/app", async () => {
  const bridge = await import("./mock-tauri")
  return { getVersion: bridge.getVersion }
})

vi.mock("@tauri-apps/plugin-http", async () => {
  const bridge = await import("./mock-tauri")
  return { fetch: bridge.fetch }
})

vi.mock("@tauri-apps/plugin-shell", async () => {
  const bridge = await import("./mock-tauri")
  return { open: bridge.open }
})

vi.mock("@tauri-apps/plugin-clipboard-manager", async () => {
  const bridge = await import("./mock-tauri")
  return { writeText: bridge.writeText }
})

const harnessEntries = ["/", ...LEGACY_HARNESS_ROUTES.map(route => route.href)]

describe("legacy UI harness routes", () => {
  afterEach(() => {
    cleanup()
  })

  it.each(harnessEntries)("mounts %s without throwing", entry => {
    render(
      <Provider store={store}>
        <TooltipProvider delayDuration={0}>
          <MemoryRouter initialEntries={[entry]}>
            <LegacyHarnessRoutes />
          </MemoryRouter>
        </TooltipProvider>
      </Provider>
    )

    expect(screen.getByRole("main").textContent).not.toBe("")
  })
})
