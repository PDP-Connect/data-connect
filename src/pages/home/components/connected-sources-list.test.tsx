// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Platform } from "@/types"
import { MemoryRouter } from "react-router-dom"
import { ConnectedSourcesList } from "./connected-sources-list"

const PLATFORM: Platform = {
  id: "chatgpt",
  company: "OpenAI",
  name: "ChatGPT",
  filename: "chatgpt",
  description: "ChatGPT export",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: "https://chatgpt.com",
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
  runtime: "playwright",
}

describe("ConnectedSourcesList sync click guard", () => {
  it("describes the local Personal Server without linking to its legacy page", () => {
    render(
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>
          <ConnectedSourcesList
            platforms={[]}
            runs={[]}
            onSyncSource={() => undefined}
            onOpenRuns={() => undefined}
          />
        </TooltipProvider>
      </MemoryRouter>
    )

    expect(screen.getByRole("paragraph").textContent).toContain(
      "Your Personal Server is ready"
    )
    expect(screen.queryByRole("link", { name: "Personal Server" })).toBeNull()
    expect(screen.getByRole("link", { name: "run apps" })).toBeTruthy()
  })

  it("releases in-flight guard when onSyncSource throws synchronously", () => {
    const onSyncSource = vi.fn(() => {
      throw new Error("sync start failed")
    })
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)

    render(
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>
          <ConnectedSourcesList
            platforms={[PLATFORM]}
            runs={[]}
            onSyncSource={onSyncSource}
            onOpenRuns={() => undefined}
          />
        </TooltipProvider>
      </MemoryRouter>
    )

    const syncButton = screen.getByRole("button", {
      name: /fetch latest data for chatgpt/i,
    })
    expect(document.querySelector('[data-slot="source-row-list"]')).toBeTruthy()

    fireEvent.click(syncButton)
    fireEvent.click(syncButton)

    expect(onSyncSource).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })
})
