// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ConnectorUpdatesRefreshButton } from "./connector-updates"

describe("ConnectorUpdatesRefreshButton", () => {
  it("refreshes the connector catalog and shows progress while checking", () => {
    const onRefresh = vi.fn()
    const { rerender } = render(
      <ConnectorUpdatesRefreshButton
        isCheckingUpdates={false}
        onRefresh={onRefresh}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(
      <ConnectorUpdatesRefreshButton isCheckingUpdates onRefresh={onRefresh} />
    )
    expect(
      (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
