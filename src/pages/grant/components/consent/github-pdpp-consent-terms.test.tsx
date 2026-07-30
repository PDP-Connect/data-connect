import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { GithubPdppConsentTerms } from "./github-pdpp-consent-terms"

afterEach(cleanup)

describe("GithubPdppConsentTerms", () => {
  it("renders server-normalized GitHub terms with semantic sections", () => {
    render(
      <GithubPdppConsentTerms
        terms={{
          type: "https://pdpp.org/data-access",
          source: { kind: "connector", id: "github" },
          access_mode: "continuous",
          purpose_code: "https://example.test/research",
          purpose_description: "Research a repository index",
          retention: { max_duration: "P30D", on_expiry: "delete" },
          streams: [
            {
              name: "repositories",
              view: "basic",
              fields: ["id", "name"],
              resources: ["repo:octo/hello"],
              time_range: {
                since: "2026-01-01T00:00:00.000Z",
                until: "2026-02-01T00:00:00.000Z",
              },
            },
          ],
        }}
      />
    )

    expect(
      screen.getByRole("heading", { name: "GitHub authorization request" })
    ).toBeTruthy()
    expect(screen.getByRole("heading", { name: "repositories" })).toBeTruthy()
    expect(screen.getByText("id, name")).toBeTruthy()
    expect(screen.getByText("repo:octo/hello")).toBeTruthy()
    expect(screen.getByText("Continuous")).toBeTruthy()
    expect(screen.getByText("Research a repository index")).toBeTruthy()
    expect(screen.getByText("delete after P30D")).toBeTruthy()
  })
})
