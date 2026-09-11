// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MEASURED_PROPAGATION_LAG_MS,
  PROPAGATION_RETRY_ATTEMPTS,
  PROPAGATION_RETRY_DELAY_MS,
  PROPAGATION_RETRY_ELAPSED_MS,
  isRegistryMissingError,
  normalizeViewedVersion,
  withPropagationRetry,
} from "./npm-propagation-retry.ts"
import {
  VersionMismatchError,
  assertConnectorProtocolPublished,
} from "./verify-connector-protocol-published.ts"

// The exact stderr npm produced in run 34557906186, the run that pushed the
// v2.2.1 tag, published @pdpp/connector-protocol, and then died here. Copied
// verbatim from that job's log so this test fails against the real string
// npm emits, not a paraphrase of it.
const REAL_E404_STDERR = [
  "npm error code E404",
  "npm error 404 No match found for version 2.2.1",
  "npm error 404",
  "npm error 404  '@pdpp/connector-protocol@2.2.1' is not in this registry.",
].join("\n")

function e404(): Error {
  return new Error(
    `Command failed: npm view @pdpp/connector-protocol@2.2.1 version --json\n${REAL_E404_STDERR}`
  )
}

const noSleep = () => Promise.resolve()

describe("propagation retry budget", () => {
  // The off-by-one this constant exists to prevent: N attempts sleep only
  // N-1 times. The inherited 6 x 30s budget therefore waited 150s against a
  // lag measured at ~180s, i.e. it would have retried itself into failure.
  it("waits longer than the propagation lag measured against the real registry", () => {
    expect(PROPAGATION_RETRY_ELAPSED_MS).toBe(
      (PROPAGATION_RETRY_ATTEMPTS - 1) * PROPAGATION_RETRY_DELAY_MS
    )
    expect(PROPAGATION_RETRY_ELAPSED_MS).toBeGreaterThan(MEASURED_PROPAGATION_LAG_MS)
  })

  it("actually sleeps that long across a full run of E404s", async () => {
    const slept: number[] = []
    await expect(
      withPropagationRetry("@pdpp/connector-protocol@2.2.1", () => Promise.reject(e404()), {
        sleep: async ms => {
          slept.push(ms)
        },
      })
    ).rejects.toThrow(/giving up resolving/)

    expect(slept).toHaveLength(PROPAGATION_RETRY_ATTEMPTS - 1)
    expect(slept.reduce((a, b) => a + b, 0)).toBe(PROPAGATION_RETRY_ELAPSED_MS)
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(MEASURED_PROPAGATION_LAG_MS)
  })
})

describe("withPropagationRetry", () => {
  it("resolves once the registry catches up, on the exact E404 that broke v2.2.1", async () => {
    let calls = 0
    const resolved = await withPropagationRetry(
      "@pdpp/connector-protocol@2.2.1",
      () => {
        calls += 1
        return calls < 4 ? Promise.reject(e404()) : Promise.resolve("2.2.1")
      },
      { sleep: noSleep }
    )
    expect(resolved).toBe("2.2.1")
    expect(calls).toBe(4)
  })

  // The old single-check logic, reproduced. This is what the barrier did
  // before: one read, 157ms after publish returned, no retry. The same input
  // the retry survives above fails it outright.
  it("is what the old single-check logic could not do", async () => {
    const singleCheck = async (attempt: () => Promise<string>) => attempt()
    await expect(singleCheck(() => Promise.reject(e404()))).rejects.toThrow("E404")
  })

  it("does not retry a non-404 registry error", async () => {
    let calls = 0
    await expect(
      withPropagationRetry(
        "@pdpp/connector-protocol@2.2.1",
        () => {
          calls += 1
          return Promise.reject(new Error("npm error code E500 registry unavailable"))
        },
        { sleep: noSleep }
      )
    ).rejects.toThrow(/E500 registry unavailable/)
    expect(calls).toBe(1)
  })

  // Rethrown unchanged, not rewrapped: callers distinguish a mismatch from a
  // timeout by the error's type, and wrapping would erase that.
  it("does not retry a version mismatch, and preserves its type", async () => {
    let calls = 0
    class Mismatch extends Error {}
    await expect(
      withPropagationRetry(
        "@pdpp/connector-protocol@2.2.1",
        () => {
          calls += 1
          return Promise.reject(new Mismatch('resolved version "2.1.1" does not match expected "2.2.1"'))
        },
        { sleep: noSleep }
      )
    ).rejects.toThrow(Mismatch)
    expect(calls).toBe(1)
  })

  it("rejects rather than returning undefined when the budget runs out", async () => {
    await expect(
      withPropagationRetry("@pdpp/connector-protocol@2.2.1", () => Promise.reject(e404()), {
        sleep: noSleep,
      })
    ).rejects.toThrow(`after ${PROPAGATION_RETRY_ATTEMPTS} attempt(s)`)
  })

  it("classifies only E404 as missing", () => {
    expect(isRegistryMissingError(e404())).toBe(true)
    expect(isRegistryMissingError(new Error("E500"))).toBe(false)
    expect(isRegistryMissingError(new Error("ETIMEDOUT"))).toBe(false)
  })
})

// `npm view <exact-spec> version --json` answers with a one-element ARRAY,
// not a bare string — verified against @pdpp/connector-protocol@2.2.1 on the
// live registry. Comparing the raw value to the expected version therefore
// reports a mismatch between two identical versions.
describe("normalizeViewedVersion", () => {
  it("unwraps npm's real single-element array answer", () => {
    expect(normalizeViewedVersion(["2.2.1"])).toBe("2.2.1")
  })

  it("leaves a bare string alone", () => {
    expect(normalizeViewedVersion("2.2.1")).toBe("2.2.1")
  })

  it("leaves an ambiguous answer ambiguous, so the caller still fails on it", () => {
    expect(normalizeViewedVersion(["2.2.1", "2.1.1"])).toEqual(["2.2.1", "2.1.1"])
    expect(normalizeViewedVersion([])).toEqual([])
    expect(normalizeViewedVersion([{ version: "2.2.1" }])).toEqual([{ version: "2.2.1" }])
  })
})

// The race is only fixed if the barrier that hit it actually RETRIES. These
// drive the real barrier function through its injectable registry seam
// rather than grepping its source: a barrier that imports the shared policy
// and then never calls it would pass a text check, and did when that check
// was sabotaged.
describe("the publish-ordering barrier retries through propagation lag", () => {
  it("resolves once the registry catches up, where the single check aborted v2.2.1", async () => {
    let calls = 0
    const slept: number[] = []
    await expect(
      assertConnectorProtocolPublished("2.2.1", {
        viewVersion: () => {
          calls += 1
          return calls < 5 ? Promise.reject(e404()) : Promise.resolve(["2.2.1"])
        },
        sleep: async ms => {
          slept.push(ms)
        },
        log: () => {},
      })
    ).resolves.toBeUndefined()
    expect(calls).toBe(5)
    expect(slept).toHaveLength(4)
  })

  // 157ms after publish returned, with the lag at ~3 minutes. One look was
  // never going to be enough.
  it("does not give up on the first E404", async () => {
    let calls = 0
    await assertConnectorProtocolPublished("2.2.1", {
      viewVersion: () => {
        calls += 1
        return calls === 1 ? Promise.reject(e404()) : Promise.resolve("2.2.1")
      },
      sleep: async () => {},
      log: () => {},
    })
    expect(calls).toBeGreaterThan(1)
  })

  it("waits out at least the measured propagation lag before giving up", async () => {
    const slept: number[] = []
    await expect(
      assertConnectorProtocolPublished("2.2.1", {
        viewVersion: () => Promise.reject(e404()),
        sleep: async ms => {
          slept.push(ms)
        },
        log: () => {},
      })
    ).rejects.toThrow(/giving up resolving/)
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(MEASURED_PROPAGATION_LAG_MS)
  })

  // Waiting cannot turn a wrong answer into a right one.
  it("fails a version mismatch immediately instead of retrying it", async () => {
    let calls = 0
    await expect(
      assertConnectorProtocolPublished("2.2.1", {
        viewVersion: () => {
          calls += 1
          return Promise.resolve("2.1.1")
        },
        sleep: async () => {},
        log: () => {},
      })
    ).rejects.toThrow(VersionMismatchError)
    expect(calls).toBe(1)
  })

  it("accepts npm's real array-shaped answer without a spurious mismatch", async () => {
    await expect(
      assertConnectorProtocolPublished("2.2.1", {
        viewVersion: () => Promise.resolve(["2.2.1"]),
        sleep: async () => {},
        log: () => {},
      })
    ).resolves.toBeUndefined()
  })

  it("does not define a second retry budget anywhere", () => {
    const barrier = readFileSync(
      resolve(process.cwd(), "scripts/verify-connector-protocol-published.ts"),
      "utf8"
    )
    const provenance = readFileSync(
      resolve(process.cwd(), "scripts/verify-npm-provenance.ts"),
      "utf8"
    )
    expect(barrier).not.toMatch(/PROPAGATION_RETRY_ATTEMPTS\s*=\s*\d/)
    expect(provenance).not.toMatch(/PROPAGATION_RETRY_ATTEMPTS\s*=\s*\d/)
    expect(provenance).toMatch(/from "\.\/npm-propagation-retry\.ts"/)
  })
})
