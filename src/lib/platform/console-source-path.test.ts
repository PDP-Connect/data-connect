// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import type { Platform } from "@/types"
import {
  consoleDangerZonePath,
  isConsoleSourcesPath,
  serverRepairsHref,
} from "./console-source-path"

const platform = (id: string, runtime: string | null): Platform => ({
  id,
  company: id,
  name: id,
  filename: id,
  description: "",
  isUpdated: false,
  logoURL: "",
  needsConnection: true,
  connectURL: null,
  connectSelector: null,
  exportFrequency: null,
  vectorize_config: null,
  runtime,
})

describe("console source path", () => {
  it("maps an installed PDPP platform to its reference connector key", () => {
    expect(consoleDangerZonePath(platform("amazon-pdpp", "pdpp-network"))).toBe(
      "/sources/amazon#danger-zone"
    )
  })

  it("falls back to the sources list when the key is unknown", () => {
    expect(
      consoleDangerZonePath(
        platform("https://registry.pdpp.org/connectors/x", "pdpp-network")
      )
    ).toBe("/sources")
    expect(consoleDangerZonePath(platform("chatgpt", "playwright"))).toBe(
      "/sources"
    )
  })

  it("builds a Server & Repairs link carrying the path", () => {
    expect(serverRepairsHref("/sources/amazon#danger-zone")).toBe(
      "/server-repairs?path=%2Fsources%2Famazon%23danger-zone"
    )
  })

  it.each([
    "/sources",
    "/sources/amazon",
    "/sources/amazon#danger-zone",
    "/sources/cin_abc-1#danger-zone",
  ])("accepts %s", path => {
    expect(isConsoleSourcesPath(path)).toBe(true)
  })

  it.each([
    null,
    "",
    "https://evil.example/sources/amazon",
    "//evil.example/sources",
    "sources/amazon",
    "/sourcesx",
    "/sources/..",
    "/sources/%2e%2e",
    "/sources/%2F%2Fevil.example",
    "/sources/a/b",
    "/sources/amazon?x=1",
    "/settings",
    "javascript:alert(1)",
  ])("refuses %s", path => {
    expect(isConsoleSourcesPath(path)).toBe(false)
  })
})
