import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RegistryAppCard } from "./registry-app-card"

vi.mock("@/apps/external-url", () => ({
  openSubmittedAppExternalUrl: vi.fn(),
  parseSubmittedAppExternalUrl: (url: string) => new URL(url),
}))

afterEach(cleanup)

function renderAppCard(
  app: React.ComponentProps<typeof RegistryAppCard>["app"]
) {
  const router = createMemoryRouter(
    [
      { path: "/apps", element: <RegistryAppCard app={app} /> },
      { path: "/apps/timeline", element: <div>Timeline route</div> },
    ],
    { initialEntries: ["/apps"] }
  )

  return {
    ...render(<RouterProvider router={router} />),
    router,
  }
}

describe("RegistryAppCard", () => {
  it("uses the same outer icon footprint on both sides of the flow", () => {
    const { container } = renderAppCard({
      id: "peak-think",
      name: "Peak Think",
      icon: "P",
      description: "Correlate sleep patterns with ChatGPT conversations.",
      category: "Health",
      dataRequired: [{ token: "chatgpt", label: "ChatGPT" }],
      dataAccess: {
        protocol: "vana-grant-session",
        capabilities: ["grant-session"],
      },
      status: "live",
      externalUrl: "https://example.com",
      scopes: ["chatgpt.conversations"],
    })

    const flow = container.querySelector('[data-slot="icon-flow"]')
    expect(flow).toBeTruthy()

    const adaptiveIcons = flow?.querySelectorAll('[data-slot="adaptive-icon"]')
    expect(adaptiveIcons).toHaveLength(2)
    expect(adaptiveIcons?.[1]?.className).not.toContain("p-1")
    expect((adaptiveIcons?.[0] as HTMLElement | undefined)?.style.width).toBe(
      "32px"
    )
    expect((adaptiveIcons?.[1] as HTMLElement | undefined)?.style.width).toBe(
      "32px"
    )
  })

  it("shows the category badge without repeating platform badges", () => {
    renderAppCard({
      id: "peak-think",
      name: "Peak Think",
      icon: "P",
      description: "Correlate sleep patterns with ChatGPT conversations.",
      category: "Health",
      dataRequired: [{ token: "chatgpt", label: "ChatGPT" }],
      dataAccess: {
        protocol: "vana-grant-session",
        capabilities: ["grant-session"],
      },
      status: "live",
      externalUrl: "https://example.com",
      scopes: ["chatgpt.conversations"],
    })

    expect(screen.getAllByText("Health").length).toBeGreaterThan(0)
    expect(screen.getByText("Vana grant/session")).toBeTruthy()
    expect(screen.queryByText("ChatGPT")).toBeNull()
    expect(screen.queryByText("Open app")).toBeNull()
  })

  it("renders builder attribution when provided", () => {
    renderAppCard({
      id: "peak-think",
      name: "Peak Think",
      icon: "P",
      builderName: "Ada Lovelace",
      builderUrl: "https://example.com/ada",
      description: "Correlate sleep patterns with ChatGPT conversations.",
      category: "Health",
      dataRequired: [{ token: "chatgpt", label: "ChatGPT" }],
      dataAccess: {
        protocol: "vana-grant-session",
        capabilities: ["grant-session"],
      },
      status: "live",
      externalUrl: "https://example.com",
      scopes: ["chatgpt.conversations"],
    })

    expect(screen.getByText(/by/i)).toBeTruthy()
    expect(
      screen.getByText(content => content.includes("Ada Lovelace"))
    ).toBeTruthy()
  })

  it("shows the coming soon badge in the top metadata row", () => {
    renderAppCard({
      id: "future-think",
      name: "Future Think",
      icon: "F",
      description: "An upcoming app.",
      category: "AI",
      dataRequired: [{ token: "linkedin", label: "LinkedIn" }],
      dataAccess: {
        protocol: "vana-grant-session",
        capabilities: ["grant-session"],
      },
      status: "coming-soon",
      scopes: ["linkedin.profile"],
    })

    expect(screen.getAllByText("AI").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Coming Soon").length).toBeGreaterThan(0)
  })

  it("derives provider-backed platform logos from scope tokens", () => {
    const { container } = renderAppCard({
      id: "macrocart",
      name: "MacroCart",
      icon: "M",
      description: "Track nutrition from Amazon and Shop orders.",
      category: "Nutrition",
      dataRequired: [
        { token: "amazon", label: "Amazon" },
        { token: "shop", label: "Shop" },
      ],
      dataAccess: {
        protocol: "vana-grant-session",
        capabilities: ["grant-session"],
      },
      status: "live",
      externalUrl: "https://example.com",
      scopes: ["amazon.orders", "shop.orders"],
    })

    const imageSources = Array.from(container.querySelectorAll("img")).map(
      image => image.getAttribute("src")
    )

    expect(
      imageSources.some(src =>
        src?.startsWith("https://img.logo.dev/amazon.com?")
      )
    ).toBe(true)
    expect(
      imageSources.some(src =>
        src?.startsWith("https://img.logo.dev/shop.app?")
      )
    ).toBe(true)
  })

  it("navigates to an internal first-party app route", async () => {
    const { router } = renderAppCard({
      id: "timeline",
      name: "Timeline",
      icon: "T",
      description: "Browse dated records.",
      category: "First-party",
      dataRequired: [],
      dataAccess: {
        protocol: "pdpp",
        capabilities: ["personal-data-read"],
      },
      status: "live",
      route: "/apps/timeline",
    })

    expect(screen.getByText("Uses PDPP")).toBeTruthy()
    screen.getByRole("button", { name: "Open Timeline" }).click()

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/apps/timeline")
    })
    expect(screen.getByText("Timeline route")).toBeTruthy()
  })
})
