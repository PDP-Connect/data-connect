// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from "node:zlib"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CLOUDFLARED_VERSION,
  TARGETS,
  parseArgs,
  sidecarFilename,
  stagePdppCloudflared,
} from "./stage-pdpp-cloudflared.mjs"

function tarWithSingleFile(entryName, contents) {
  const header = Buffer.alloc(512)
  header.write(entryName, 0, "utf8")
  // The size field is 12 bytes (124-136): an 11-digit zero-padded octal
  // string followed by a NUL terminator. `Buffer.alloc` already zero-fills,
  // so writing only the 11-char string leaves byte 135 correctly at \0 --
  // an earlier draft explicitly wrote "0" there instead, which turned
  // "00000000041\0" into "000000000410" (octal 264, not 41) and silently
  // extracted the wrong byte range.
  header.write(contents.length.toString(8).padStart(11, "0"), 124, "utf8")
  const paddedSize = Math.ceil(contents.length / 512) * 512
  const body = Buffer.alloc(paddedSize)
  contents.copy(body)
  const tar = Buffer.concat([header, body, Buffer.alloc(1024)])
  return gzipSync(tar)
}

describe("stage PDPP cloudflared sidecar", () => {
  it("names every configured target with Tauri's target-qualified sidecar shape", () => {
    for (const [target] of TARGETS) {
      const windows = target.includes("windows")
      expect(sidecarFilename(target)).toBe(
        `pdpp-cloudflared-${target}${windows ? ".exe" : ""}`
      )
    }
  })

  it("covers exactly the targets release.yml's build matrix builds for", () => {
    expect([...TARGETS.keys()].sort()).toEqual(
      [
        "aarch64-apple-darwin",
        "aarch64-unknown-linux-gnu",
        "x86_64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-gnu",
      ].sort()
    )
  })

  it("every pinned checksum is a well-formed lowercase 64-char hex SHA-256", () => {
    for (const [, entry] of TARGETS) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("stages a raw-binary target (Linux/Windows shape) after verifying its checksum", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-cloudflared-sidecar-"))
    try {
      mkdirSync(join(root, "src-tauri", "vendor-licenses"), {
        recursive: true,
      })
      writeFileSync(
        join(root, "src-tauri", "vendor-licenses", "cloudflared-LICENSE"),
        "Apache-2.0 fixture"
      )
      const fixtureBytes = Buffer.from("fixture cloudflared binary")
      const target = "x86_64-unknown-linux-gnu"
      const entry = TARGETS.get(target)
      const originalSha256 = entry.sha256
      entry.sha256 = (
        await import("node:crypto")
      ).createHash("sha256").update(fixtureBytes).digest("hex")
      try {
        const staged = await stagePdppCloudflared({
          target,
          projectRoot: root,
          fetchBuffer: async () => fixtureBytes,
        })
        expect(staged.executable).toBe(
          join(root, "src-tauri/binaries/pdpp-cloudflared-x86_64-unknown-linux-gnu")
        )
        expect(readFileSync(staged.executable)).toEqual(fixtureBytes)
        expect(readFileSync(staged.license, "utf8")).toBe(
          "Apache-2.0 fixture"
        )
      } finally {
        entry.sha256 = originalSha256
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("extracts the binary from a tar.gz archive before checking its checksum (the macOS shape)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-cloudflared-sidecar-"))
    try {
      mkdirSync(join(root, "src-tauri", "vendor-licenses"), {
        recursive: true,
      })
      writeFileSync(
        join(root, "src-tauri", "vendor-licenses", "cloudflared-LICENSE"),
        "Apache-2.0 fixture"
      )
      const fixtureBytes = Buffer.from("fixture darwin cloudflared binary")
      const archive = tarWithSingleFile("cloudflared", fixtureBytes)
      const target = "aarch64-apple-darwin"
      const entry = TARGETS.get(target)
      const originalSha256 = entry.sha256
      entry.sha256 = (
        await import("node:crypto")
      ).createHash("sha256").update(fixtureBytes).digest("hex")
      try {
        const staged = await stagePdppCloudflared({
          target,
          projectRoot: root,
          fetchBuffer: async () => archive,
        })
        expect(readFileSync(staged.executable)).toEqual(fixtureBytes)
      } finally {
        entry.sha256 = originalSha256
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses to stage a binary whose checksum does not match the pinned value", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-cloudflared-sidecar-"))
    try {
      mkdirSync(join(root, "src-tauri", "vendor-licenses"), {
        recursive: true,
      })
      writeFileSync(
        join(root, "src-tauri", "vendor-licenses", "cloudflared-LICENSE"),
        "Apache-2.0 fixture"
      )
      await expect(
        stagePdppCloudflared({
          target: "x86_64-unknown-linux-gnu",
          projectRoot: root,
          fetchBuffer: async () => Buffer.from("not the real binary"),
        })
      ).rejects.toThrow(/Checksum mismatch/)
      expect(
        existsSync(
          join(
            root,
            "src-tauri/binaries/pdpp-cloudflared-x86_64-unknown-linux-gnu"
          )
        )
      ).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses to stage a tar.gz-extracted binary whose checksum does not match the pinned value", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-cloudflared-sidecar-"))
    try {
      mkdirSync(join(root, "src-tauri", "vendor-licenses"), {
        recursive: true,
      })
      writeFileSync(
        join(root, "src-tauri", "vendor-licenses", "cloudflared-LICENSE"),
        "Apache-2.0 fixture"
      )
      const archive = tarWithSingleFile(
        "cloudflared",
        Buffer.from("not the real darwin binary")
      )
      await expect(
        stagePdppCloudflared({
          target: "aarch64-apple-darwin",
          projectRoot: root,
          fetchBuffer: async () => archive,
        })
      ).rejects.toThrow(/Checksum mismatch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects an unsupported target", async () => {
    await expect(
      stagePdppCloudflared({ target: "riscv64-unknown-linux-gnu" })
    ).rejects.toThrow(/Unsupported cloudflared sidecar target/)
  })

  it("parses the release workflow arguments", () => {
    expect(parseArgs(["--target", "aarch64-apple-darwin"])).toEqual({
      target: "aarch64-apple-darwin",
    })
  })

  it("pins a real, specific cloudflared release version, not a moving 'latest'", () => {
    expect(CLOUDFLARED_VERSION).toMatch(/^\d{4}\.\d+\.\d+$/)
  })

  it("gates the supported local production build on the same staging contract", () => {
    const buildScript = readFileSync(
      resolve(process.cwd(), "scripts/build-prod.js"),
      "utf8"
    )
    expect(buildScript).toContain(
      "stagePdppCloudflared({\n      target: tauriTarget.target,\n      projectRoot: ROOT,\n    })"
    )
  })
})
