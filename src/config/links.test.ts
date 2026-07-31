import { describe, expect, it } from "vitest"
import { LINKS } from "./links"

describe("shipped product links", () => {
  it("does not route users to the legacy Vana GitHub organization", () => {
    for (const url of Object.values(LINKS)) {
      expect(url).not.toMatch(/github\.com\/vana-com\//i)
    }
  })
})
