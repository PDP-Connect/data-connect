// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServerRepairs } from "./index"

const mockUseReferenceServer = vi.fn()

vi.mock("@/hooks/useReferenceServer", () => ({
  useReferenceServer: (...args: unknown[]) => mockUseReferenceServer(...args),
}))

afterEach(() => {
  cleanup()
})

describe("ServerRepairs", () => {
  beforeEach(() => {
    mockUseReferenceServer.mockReset()
  })

  it("renders one honest state when operator tools are not included", () => {
    mockUseReferenceServer.mockReturnValue({
      lifecycle: "error",
      error: null,
      origin: null,
      retry: vi.fn(),
    })

    render(
      <MemoryRouter>
        <ServerRepairs />
      </MemoryRouter>
    )

    expect(
      screen.getByText("Operator tools are not included in this build.")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })

  it.each([
    ["/sources/amazon#danger-zone", "/sources/amazon#danger-zone"],
    ["https://evil.example/sources", null],
    ["//evil.example/sources", null],
  ])("opens the console at a validated path (%s)", (path, expected) => {
    mockUseReferenceServer.mockReturnValue({
      lifecycle: "starting",
      error: null,
      origin: null,
      retry: vi.fn(),
    })

    render(
      <MemoryRouter
        initialEntries={[`/server-repairs?${new URLSearchParams({ path })}`]}
      >
        <ServerRepairs />
      </MemoryRouter>
    )

    expect(mockUseReferenceServer).toHaveBeenCalledWith(
      expect.anything(),
      expected
    )
  })
})
