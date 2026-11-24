// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { useEffect } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router-dom"
import { PERSONAL_SERVER_AUTH_SESSION_ID } from "@/config/account-auth"
import { ROUTES } from "@/config/routes"
import { useDeepLink } from "./use-deep-link"

const mockDispatch = vi.fn()

vi.mock("react-redux", () => ({
  useDispatch: () => mockDispatch,
}))

vi.mock("viem", () => ({
  hashMessage: vi.fn(() => "0xmockhash"),
  recoverAddress: vi.fn(() => Promise.resolve("0xRecoveredAddress")),
}))

function DeepLinkHarness({
  onChange,
}: {
  onChange: (pathname: string, search: string) => void
}) {
  useDeepLink()
  const location = useLocation()

  useEffect(() => {
    onChange(location.pathname, location.search)
  }, [location, onChange])

  return null
}

describe("useDeepLink", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDispatch.mockReset()
  })

  it("normalizes deep link params into /connect URL", async () => {
    let latestPathname = ""
    let latestSearch = ""

    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <DeepLinkHarness
              onChange={(pathname, search) => {
                latestPathname = pathname
                latestSearch = search
              }}
            />
          ),
        },
      ],
      {
        initialEntries: [
          `${ROUTES.home}?sessionId=grant-session-1&appId=rickroll&scopes=read:a,read:b`,
        ],
      }
    )

    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(latestPathname).toBe(ROUTES.connect)
    })

    const searchParams = new URLSearchParams(latestSearch)
    expect(searchParams.get("sessionId")).toBe("grant-session-1")
    expect(searchParams.get("appId")).toBe("rickroll")
    expect(searchParams.get("scopes")).toBe('["read:a","read:b"]')
  })

  it("does not redirect when already on canonical /grant URL", async () => {
    let latestPathname = ""
    let latestSearch = ""
    const searchParams = new URLSearchParams({
      sessionId: "grant-session-2",
      appId: "rickroll",
      scopes: JSON.stringify(["read:a"]),
    })

    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <DeepLinkHarness
              onChange={(pathname, search) => {
                latestPathname = pathname
                latestSearch = search
              }}
            />
          ),
        },
      ],
      {
        initialEntries: [`${ROUTES.grant}?${searchParams.toString()}`],
      }
    )

    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(latestPathname).toBe(ROUTES.grant)
    })

    expect(latestSearch).toBe(`?${searchParams.toString()}`)
  })

  it("recovers auth from masterKeySig in URL params (fallback path)", async () => {
    let latestPathname = ""
    let latestSearch = ""

    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <DeepLinkHarness
              onChange={(pathname, search) => {
                latestPathname = pathname
                latestSearch = search
              }}
            />
          ),
        },
      ],
      {
        initialEntries: [
          `${ROUTES.connect}?sessionId=fallback-sess&masterKeySig=0xfallbacksig`,
        ],
      }
    )

    render(<RouterProvider router={router} />)

    // Should stay on /connect (already on target route)
    await waitFor(() => {
      expect(latestPathname).toBe(ROUTES.connect)
    })
    expect(latestSearch).not.toContain("0xfallbacksig")
    expect(new URLSearchParams(latestSearch).get("handoff")).toBeTruthy()

    const { recoverAddress } = await import("viem")
    expect(recoverAddress).toHaveBeenCalledWith({
      hash: "0xmockhash",
      signature: "0xfallbacksig",
    })

    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            walletAddress: "0xRecoveredAddress",
            masterKeySignature: "0xfallbacksig",
          }),
        })
      )
    })
  })

  it("keeps personal-server auth callbacks on /personal-server when already there", async () => {
    let latestPathname = ""

    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <DeepLinkHarness
              onChange={(pathname) => {
                latestPathname = pathname
              }}
            />
          ),
        },
      ],
      {
        initialEntries: [
          `${ROUTES.personalServer}?sessionId=${PERSONAL_SERVER_AUTH_SESSION_ID}&masterKeySig=0xfallbacksig`,
        ],
      }
    )

    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(latestPathname).toBe(ROUTES.personalServer)
    })
  })
})
