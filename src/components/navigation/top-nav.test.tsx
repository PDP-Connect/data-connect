import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ROUTES } from "@/config/routes"
import { TopNav } from "./top-nav"

function renderTopNav(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TooltipProvider delayDuration={0}>
        <TopNav />
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe("TopNav", () => {
  it("keeps the Personal Server route out of primary navigation", () => {
    renderTopNav(ROUTES.personalServer)

    expect(screen.queryByRole("link", { name: "Server" })).toBeNull()
    expect(screen.getByRole("link", { name: "Home" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Apps" })).toBeTruthy()
  })
})
