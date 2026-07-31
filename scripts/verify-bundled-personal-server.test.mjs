import { execFileSync, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import {
  assertBinaryArchitecture,
  assertPackagedBrowser,
  assertPackagedRuntime,
  collectRelevantWindowsInstallerEntries,
  listDebEntries,
  parseArgs,
} from "./verify-bundled-personal-server.mjs"

const runtimeEntries = [
  "usr/lib/data-connect/resources/personal-server/dist/personal-server",
  "usr/lib/data-connect/resources/personal-server/dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "usr/lib/data-connect/resources/playwright-runner/dist/playwright-runner",
  "usr/lib/data-connect/resources/pdpp-runtime/connector-loader.mjs",
  "usr/lib/data-connect/resources/pdpp-runtime/connector-loader-bootstrap.mjs",
  "usr/lib/data-connect/resources/pdpp-runtime/node_modules/p-queue/package.json",
  "usr/lib/data-connect/resources/pdpp-runtime/node_modules/p-queue/dist/index.js",
  "usr/lib/data-connect/resources/pdpp-runtime/node_modules/patchright/package.json",
  "usr/lib/data-connect/resources/pdpp-runtime/node_modules/patchright/index.mjs",
]

const linuxBrowserEntry =
  "usr/lib/data-connect/resources/playwright-runner/dist/browsers/chromium-1228/chrome-linux64/chrome"

describe("bundled personal-server verifier", () => {
  it("accepts an artifact with the helper and native dependency", () => {
    expect(() =>
      assertPackagedRuntime(runtimeEntries, "DataConnect.deb")
    ).not.toThrow()
  })

  it("rejects an artifact missing the native dependency", () => {
    expect(() =>
      assertPackagedRuntime(
        runtimeEntries.filter(entry => !entry.includes("better_sqlite3.node")),
        "DataConnect.exe"
      )
    ).toThrow("better-sqlite3")
  })

  it("rejects an artifact missing a PDPP runtime dependency", () => {
    expect(() =>
      assertPackagedRuntime(
        runtimeEntries.filter(entry => !entry.includes("p-queue/package.json")),
        "DataConnect.deb"
      )
    ).toThrow("p-queue")
  })

  it("requires a real packaged browser executable", () => {
    expect(() =>
      assertPackagedBrowser(
        [...runtimeEntries, linuxBrowserEntry],
        "DataConnect.deb",
        "linux"
      )
    ).not.toThrow()
    expect(() =>
      assertPackagedBrowser(runtimeEntries, "DataConnect.deb", "linux")
    ).toThrow("packaged Chromium executable")
  })

  it("rejects a helper built for the other macOS architecture", () => {
    expect(() =>
      assertBinaryArchitecture(
        "Mach-O 64-bit executable x86_64",
        "arm64",
        "personal-server"
      )
    ).toThrow("expected arm64")
    expect(() =>
      assertBinaryArchitecture(
        "Mach-O 64-bit executable arm64",
        "x86_64",
        "playwright-runner"
      )
    ).toThrow("expected x86_64")
  })

  it("enables strict signature checks only when explicitly requested", () => {
    const commonArgs = [
      "--platform",
      "macos",
      "--expected-arch",
      "arm64",
      "--bundle-root",
      "bundle",
    ]
    expect(parseArgs(commonArgs).verifyCodeSignature).toBe(false)
    expect(
      parseArgs([...commonArgs, "--verify-code-signature"]).verifyCodeSignature
    ).toBe(true)
  })

  it("streams a large Windows installer listing and retains only required entries", async () => {
    const entries = await collectRelevantWindowsInstallerEntries(
      process.execPath,
      [
        "-e",
        `
          const noise = "x".repeat(200)
          for (let index = 0; index < 10_000; index += 1) {
            console.log(\`2026-07-31 ..... \${noise}-\${index}\`)
          }
          for (const entry of ${JSON.stringify([
            ...runtimeEntries,
            "usr/lib/data-connect/resources/playwright-runner/dist/browsers/chromium-1228/chrome-win64/chrome.exe",
          ])}) {
            console.log(\`2026-07-31 ..... \${entry.replaceAll("/", "\\\\")}\`)
          }
        `,
      ]
    )

    expect(entries).toHaveLength(10)
    expect(() =>
      assertPackagedRuntime(entries, "DataConnect.exe")
    ).not.toThrow()
    expect(() =>
      assertPackagedBrowser(entries, "DataConnect.exe", "windows")
    ).not.toThrow()
  })

  it("reports a streamed Windows listing command failure", async () => {
    await expect(
      collectRelevantWindowsInstallerEntries(process.execPath, [
        "-e",
        'process.stderr.write("7z failure sentinel"); process.exit(7)',
      ])
    ).rejects.toThrow("7z failure sentinel")
  })

  it("waits for a delayed final listing line after the child exit event", async () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const entriesPromise = collectRelevantWindowsInstallerEntries(
      "7z",
      ["l", "fixture.exe"],
      () => child
    )

    child.stdout.write(`${runtimeEntries.join("\n")}\n`)
    child.stderr.end()
    child.emit("close", 0)
    setImmediate(() => {
      child.stdout.end(
        "resources/playwright-runner/dist/browsers/chromium-1228/chrome-win64/chrome.exe"
      )
    })

    const entries = await entriesPromise
    expect(entries).toHaveLength(10)
    expect(() =>
      assertPackagedBrowser(entries, "DataConnect.exe", "windows")
    ).not.toThrow()
  })

  const hasDpkgDeb = spawnSync("dpkg-deb", ["--version"]).status === 0
  it.runIf(hasDpkgDeb)(
    "lists a package with a large payload without buffering its archive",
    () => {
      const temporaryRoot = mkdtempSync(join(process.cwd(), ".verify-deb-"))
      try {
        const packageRoot = join(temporaryRoot, "package")
        const resources = join(packageRoot, "usr", "lib", "data-connect")
        mkdirSync(join(packageRoot, "DEBIAN"), { recursive: true })
        writeFileSync(
          join(packageRoot, "DEBIAN", "control"),
          "Package: data-connect-verifier-test\nVersion: 1.0.0\nArchitecture: all\nMaintainer: test@example.com\nDescription: verifier regression fixture\n"
        )
        for (const entry of runtimeEntries) {
          const file = join(packageRoot, entry)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, "fixture")
        }
        const browser = join(packageRoot, linuxBrowserEntry)
        mkdirSync(dirname(browser), { recursive: true })
        writeFileSync(browser, "fixture")
        const largePayload = join(resources, "realistic-large-payload.bin")
        writeFileSync(largePayload, "")
        truncateSync(largePayload, 160 * 1024 * 1024)

        const artifact = join(temporaryRoot, "fixture.deb")
        execFileSync("dpkg-deb", ["--build", packageRoot, artifact])
        expect(() =>
          assertPackagedRuntime(listDebEntries(artifact), "fixture.deb")
        ).not.toThrow()
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    30_000
  )
})
