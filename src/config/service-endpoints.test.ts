import { describe, expect, it } from "vitest"
import { configuredServiceUrl } from "./service-endpoints"

describe("configuredServiceUrl", () => {
  it("accepts HTTPS and loopback HTTP", () => {
    expect(
      configuredServiceUrl("SERVICE_URL", "https://service.example/path/")
    ).toBe("https://service.example/path")
    expect(configuredServiceUrl("SERVICE_URL", "http://localhost:8787")).toBe(
      "http://localhost:8787"
    )
    expect(configuredServiceUrl("SERVICE_URL", "http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787"
    )
    expect(configuredServiceUrl("SERVICE_URL", "http://[::1]:8787")).toBe(
      "http://[::1]:8787"
    )
  })

  it("rejects cleartext remote services and non-HTTP protocols", () => {
    expect(() =>
      configuredServiceUrl("SERVICE_URL", "http://service.example")
    ).toThrow("must use https unless it targets loopback")
    expect(() =>
      configuredServiceUrl("SERVICE_URL", "file:///tmp/service")
    ).toThrow("must use https unless it targets loopback")
  })
})
