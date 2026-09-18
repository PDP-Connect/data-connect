// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { currentPin, daysBetween } from "./check-polyfill-connectors-tarball-freshness.mjs"

describe("check-polyfill-connectors-tarball-freshness", () => {
  it("extracts the most recent pinned commit from the vendor README's update log", () => {
    const readme = `
**Update (2026-09-06): pin moved to \`data-connectors\` commit
\`8372d0308678985adf86c1a664bc251f50dc7246\`** (\`main\`).

**Update (2026-09-10): pin moved to \`data-connectors\` commit
\`4c4c87fc337158ecfa640af3ebdbcceeafc7a0f3\`** (\`main\`, the merge commit of
data-connectors#92).
`
    expect(currentPin(readme)).toBe("4c4c87fc337158ecfa640af3ebdbcceeafc7a0f3")
  })

  it("throws when the README has no pin entry", () => {
    expect(() => currentPin("no pin here")).toThrow(/no "pin moved/)
  })

  it("computes fractional days between two commit dates", () => {
    expect(daysBetween("2026-09-10T00:00:00Z", "2026-09-18T00:00:00Z")).toBe(8)
    expect(daysBetween("2026-09-18T12:00:00Z", "2026-09-18T00:00:00Z")).toBe(-0.5)
  })
})
