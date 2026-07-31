import { beforeEach, describe, expect, it } from "vitest"
import { getTelemetryEnabled, setTelemetryEnabled } from "./client"

describe("telemetry consent", () => {
  beforeEach(() => localStorage.clear())

  it("is disabled until the user explicitly opts in", () => {
    expect(getTelemetryEnabled()).toBe(false)
    setTelemetryEnabled(true)
    expect(getTelemetryEnabled()).toBe(true)
  })

  it("remains disabled after an explicit opt out", () => {
    setTelemetryEnabled(true)
    setTelemetryEnabled(false)
    expect(getTelemetryEnabled()).toBe(false)
  })
})
