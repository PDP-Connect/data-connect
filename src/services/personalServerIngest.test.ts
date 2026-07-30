import { describe, expect, it } from "vitest"
import { extractScopeKeys } from "./personalServerIngest"

describe("extractScopeKeys", () => {
  it("excludes lossless PDPP records metadata from ingest scopes", () => {
    expect(
      extractScopeKeys({
        "github.profile": { login: "octocat" },
        "pdpp.recordsByStream": {
          user: [{ type: "RECORD", stream: "user" }],
        },
      })
    ).toEqual(["github.profile"])
  })
})
