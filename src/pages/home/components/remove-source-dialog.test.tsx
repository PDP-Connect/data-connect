// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Platform } from "@/types"
import { RemoveSourceDialog } from "./remove-source-dialog"

const AMAZON: Platform = {
  id: "amazon-pdpp",
  company: "amazon",
  name: "Amazon",
  filename: "amazon-pdpp",
  description: "",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: null,
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
  runtime: "pdpp-network",
  requiresBrowser: true,
}

function renderDialog(
  props: Partial<Parameters<typeof RemoveSourceDialog>[0]> = {}
) {
  const handlers = {
    onCancel: vi.fn(),
    onSignOut: vi.fn(),
    onRemoveLocalData: vi.fn(),
    onOpenServerRepairs: vi.fn(),
  }
  render(
    <RemoveSourceDialog
      platform={AMAZON}
      canSignOut
      hasServerConnection={false}
      pending={null}
      error={null}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe("RemoveSourceDialog", () => {
  afterEach(cleanup)

  it("offers sign-out and local removal for a browser source", () => {
    const handlers = renderDialog()
    const dialog = screen.getByRole("alertdialog")

    expect(dialog.textContent).toContain(
      "Sign out deletes the saved Amazon browser session on this computer."
    )
    expect(dialog.textContent).toContain("Signs out, then deletes the data")
    expect(dialog.textContent).toContain(
      "Server copies, if any, are managed in Server & Repairs."
    )
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Remove and delete local data" })
    )
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1)
    expect(handlers.onRemoveLocalData).toHaveBeenCalledTimes(1)
    expect(handlers.onCancel).not.toHaveBeenCalled()
  })

  it("hides sign-out and its claim for a source without a browser session", () => {
    renderDialog({ canSignOut: false })
    const dialog = screen.getByRole("alertdialog")

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull()
    expect(dialog.textContent).not.toContain("browser session")
    expect(dialog.textContent).toContain("Deletes the data this app saved")
    expect(
      screen.getByRole("button", { name: "Remove and delete local data" })
    ).toBeTruthy()
  })

  it("links to Server & Repairs only when the server holds a connection", () => {
    renderDialog()
    expect(
      screen.queryByRole("button", { name: "Open Server & Repairs" })
    ).toBeNull()
    cleanup()

    const handlers = renderDialog({ hasServerConnection: true })
    fireEvent.click(
      screen.getByRole("button", { name: "Open Server & Repairs" })
    )
    expect(handlers.onOpenServerRepairs).toHaveBeenCalledTimes(1)
  })

  it("shows the error and disables every choice while an action runs", () => {
    renderDialog({ pending: "sign-out", error: "Profile is in use" })

    expect(screen.getByRole("alert").textContent).toBe("Profile is in use")
    expect(
      screen.getByRole("button", { name: "Signing out…" }).hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "Remove and delete local data" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")
    ).toBe(true)
  })

  it("aligns the description with the title", () => {
    renderDialog()
    const description = screen.getByText(
      "Choose what to remove from this computer."
    )
    expect(description.className).toContain("w-full")
    expect(description.className).toContain("text-left")
  })
})
