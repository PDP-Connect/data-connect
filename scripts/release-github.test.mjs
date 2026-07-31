import { describe, expect, it } from "vitest"

import { parseArgs, releaseCommitCommand } from "./release-github.mjs"

describe("release helper", () => {
  it("DCO signs release commits by default", () => {
    const args = parseArgs(["--version", "1.2.3"])

    expect(releaseCommitCommand("v1.2.3", args)).toBe(
      'git commit -s -m "release: v1.2.3"'
    )
  })

  it("adds an AI assistance trailer only when requested", () => {
    const args = parseArgs(["--version", "1.2.3", "--assisted-by-ai"])

    expect(args.assistedByAi).toBe(true)
    expect(releaseCommitCommand("v1.2.3", args)).toBe(
      'git commit -s -m "release: v1.2.3" -m "Assisted-by: AI"'
    )
  })
})
