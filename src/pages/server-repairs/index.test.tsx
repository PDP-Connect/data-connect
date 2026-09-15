// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServerRepairs } from "./index"

const mockUseReferenceServer = vi.fn()

vi.mock("@/hooks/useReferenceServer", () => ({
  useReferenceServer: () => mockUseReferenceServer(),
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

    render(<ServerRepairs />)

    expect(
      screen.getByText("Operator tools are not included in this build.")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })
})
