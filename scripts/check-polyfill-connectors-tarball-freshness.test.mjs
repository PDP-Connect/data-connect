// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import {
  currentPin,
  daysBetween,
  diffFileDigests,
  evaluate,
  LAST_ACCEPTED_PIN,
  normalizeVendoredPackageJson,
  sumsEntry,
} from "./check-polyfill-connectors-tarball-freshness.mjs"

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
    expect(daysBetween("2026-09-18T12:00:00Z", "2026-09-18T00:00:00Z")).toBe(
      -0.5
    )
  })
})

describe("check-polyfill-connectors-tarball-freshness decision", () => {
  const pin = LAST_ACCEPTED_PIN
  const clean = {
    pin,
    tarballSha256: "aa",
    recordedSha256: "aa",
    tarballIntegrity: "sha512-x",
    lockIntegrity: "sha512-x",
    pinOnUpstreamMain: true,
    pinWithinAcceptedRange: true,
    contentDifferences: [],
  }
  const driftAt = mainDate => ({
    mainSha: "b".repeat(40),
    commitsBehind: 217,
    pinDate: "2026-09-22T20:30:04Z",
    mainDate,
  })

  it("gives the same verdict for the same pin whatever the upstream date or wall clock", () => {
    vi.useFakeTimers()
    try {
      const verdicts = [
        "2026-09-25T00:00:00Z",
        "2026-10-15T00:00:00Z",
        "2027-06-01T00:00:00Z",
      ].map(date => {
        vi.setSystemTime(new Date(date))
        return evaluate({ ...clean, drift: driftAt(date) })
      })
      for (const verdict of verdicts) {
        expect(verdict.errors).toEqual([])
        expect(verdict.warnings).toHaveLength(1)
        expect(verdict.warnings[0]).toMatch(
          /217 commits .* behind .*Informational only/
        )
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not warn when the pin is upstream main", () => {
    expect(
      evaluate({
        ...clean,
        drift: { ...driftAt("2026-10-15T00:00:00Z"), commitsBehind: 0 },
      })
    ).toEqual({
      errors: [],
      warnings: [],
    })
  })

  it("fails on a digest, lockfile, pin or content mismatch", () => {
    const failures = [
      { tarballSha256: "bb" },
      { lockIntegrity: "sha512-y" },
      { pinOnUpstreamMain: false },
      { pinWithinAcceptedRange: false },
      { contentDifferences: ["content differs: manifests/heb.json"] },
    ]
    for (const override of failures) {
      expect(evaluate({ ...clean, ...override }).errors).toHaveLength(1)
    }
  })

  it("reports added, removed and changed files", () => {
    expect(
      diffFileDigests({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })
    ).toEqual(["content differs: b", "missing from vendored tarball: c"])
  })

  it("repacks package.json the way the revendor script does", () => {
    const upstream = JSON.stringify({
      dependencies: {
        "@pdpp/collector-runtime": "file:./vendor/a.tgz",
        "@pdpp/connector-protocol": "file:b",
        "@pdpp/reference-contract": "file:c",
        x: "1",
      },
      devDependencies: { "@pdpp/reference-contract": "file:c", y: "2" },
      bundledDependencies: ["@pdpp/collector-runtime"],
      overrides: {
        "@pdpp/collector-runtime": { "@pdpp/reference-contract": "file:c" },
      },
    })
    expect(JSON.parse(normalizeVendoredPackageJson(upstream))).toEqual({
      dependencies: {
        "@pdpp/collector-runtime": "*",
        "@pdpp/connector-protocol": "*",
        "@pdpp/reference-contract": "*",
        x: "1",
      },
      devDependencies: { y: "2" },
      overrides: {
        "@pdpp/collector-runtime": {
          "@pdpp/reference-contract": "*",
          "@pdpp/connector-protocol": "*",
        },
      },
    })
  })

  it("finds the tarball's entry in SHA256SUMS", () => {
    expect(sumsEntry("11  other.tgz\n22  pkg.tgz\n", "pkg.tgz")).toBe("22")
    expect(sumsEntry("11  other.tgz\n", "pkg.tgz")).toBeUndefined()
  })
})
