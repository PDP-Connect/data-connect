// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
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
  assertPackagedNode,
  assertPackagedRuntime,
  collectRelevantWindowsInstallerEntries,
  listDebEntries,
  parseArgs,
  readMacBundleExecutable,
  selectMacAppExecutables,
} from "./verify-bundled-personal-server.mjs"

const runtimeEntries = [
  "usr/bin/pdpp-node",
  "usr/lib/DataConnect/connectors/lock.json",
  "usr/lib/DataConnect/connectors/collection-profiles/github-pdpp/profile/collection-profile.json",
  "usr/lib/DataConnect/connectors/collection-profiles/github-pdpp/dist/collection-profile.mjs",
  "usr/lib/DataConnect/connectors/collection-profiles/github-pdpp/provenance.json",
  "usr/lib/DataConnect/connectors/collection-profiles/chatgpt-pdpp/profile/collection-profile.json",
  "usr/lib/DataConnect/connectors/collection-profiles/chatgpt-pdpp/dist/collection-profile.mjs",
  "usr/lib/DataConnect/connectors/collection-profiles/chatgpt-pdpp/provenance.json",
  "usr/lib/DataConnect/licenses/pdpp-node-LICENSE",
  "usr/lib/DataConnect/personal-server/dist/personal-server",
  "usr/lib/DataConnect/personal-server/dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "usr/lib/DataConnect/playwright-runner/dist/playwright-runner",
  "usr/lib/DataConnect/pdpp-runtime/connector-loader.mjs",
  "usr/lib/DataConnect/pdpp-runtime/connector-loader-bootstrap.mjs",
  "usr/lib/DataConnect/pdpp-runtime/node_modules/p-queue/package.json",
  "usr/lib/DataConnect/pdpp-runtime/node_modules/p-queue/dist/index.js",
  "usr/lib/DataConnect/pdpp-runtime/node_modules/patchright/package.json",
  "usr/lib/DataConnect/pdpp-runtime/node_modules/patchright/index.mjs",
]

const windowsRuntimeEntries = runtimeEntries
  .filter(entry => entry !== "usr/bin/pdpp-node")
  .map(entry =>
    entry
      .replace("usr/lib/DataConnect/", "")
      .replace(
        "personal-server/dist/personal-server",
        "personal-server/dist/personal-server.exe"
      )
      .replace(
        "playwright-runner/dist/playwright-runner",
        "playwright-runner/dist/playwright-runner.exe"
      )
  )

const macRuntimeEntries = windowsRuntimeEntries.map(entry =>
  `Contents/Resources/${entry}`
    .replace("personal-server.exe", "personal-server")
    .replace("playwright-runner.exe", "playwright-runner")
)

const linuxBrowserEntry =
  "usr/lib/DataConnect/playwright-runner/dist/browsers/chromium-1228/chrome-linux64/chrome"

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

  it("rejects an artifact missing a bundled PDPP connector", () => {
    expect(() =>
      assertPackagedRuntime(
        runtimeEntries.filter(entry => !entry.includes("chatgpt-pdpp")),
        "DataConnect.deb"
      )
    ).toThrow("chatgpt-pdpp")
  })

  it("requires packaged runtime paths on exact segment boundaries", () => {
    expect(() =>
      assertPackagedRuntime(
        runtimeEntries.map(entry =>
          entry.endsWith("connectors/lock.json")
            ? entry.replace("connectors/lock.json", "not-connectors/lock.json")
            : entry
        ),
        "DataConnect.deb"
      )
    ).toThrow("connectors/lock.json")
  })

  it("rejects a complete runtime tree under an unrecognized root", () => {
    for (const wrongRoot of ["attacker", "resources-not-really"]) {
      expect(() =>
        assertPackagedRuntime(
          windowsRuntimeEntries.map(entry => `${wrongRoot}/${entry}`),
          "DataConnect.exe"
        )
      ).toThrow("connectors/lock.json")
    }
  })

  it("accepts only the macOS app resource root", () => {
    expect(() =>
      assertPackagedRuntime(macRuntimeEntries, "DataConnect.app")
    ).not.toThrow()
    expect(() =>
      assertPackagedRuntime(
        macRuntimeEntries.map(entry => `attacker/${entry}`),
        "DataConnect.dmg"
      )
    ).toThrow("connectors/lock.json")
  })

  it("requires the platform-native Node sidecar path", () => {
    expect(() =>
      assertPackagedNode(runtimeEntries, "DataConnect.deb", "linux")
    ).not.toThrow()
    expect(() =>
      assertPackagedNode(["pdpp-node.exe"], "DataConnect.exe", "windows")
    ).not.toThrow()
    expect(() =>
      assertPackagedNode(
        ["Contents/MacOS/pdpp-node"],
        "DataConnect.dmg",
        "macos"
      )
    ).not.toThrow()
    expect(() =>
      assertPackagedNode(runtimeEntries, "DataConnect.exe", "windows")
    ).toThrow("packaged Node.js sidecar")
    expect(() =>
      assertPackagedNode(
        ["attacker/usr/bin/pdpp-node"],
        "DataConnect.deb",
        "linux"
      )
    ).toThrow("packaged Node.js sidecar")
  })

  it("requires Tauri's exact root-installed Windows x64 Node sidecar", () => {
    const tauriNsisListing = [
      "2026-07-31 23:39:00 ....A 124835376 50000000 pdpp-node.exe",
    ]
    expect(() =>
      assertPackagedNode(tauriNsisListing, "DataConnect.exe", "windows")
    ).not.toThrow()

    for (const wrongEntry of [
      "resources/pdpp-node.exe",
      "pdpp-node-x86_64-pc-windows-msvc.exe",
      "not-pdpp-node.exe",
      "pdpp-node-arm64.exe",
    ]) {
      expect(() =>
        assertPackagedNode([wrongEntry], "DataConnect.exe", "windows")
      ).toThrow("packaged Node.js sidecar")
    }
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
    expect(() =>
      assertPackagedBrowser(
        [`attacker/${linuxBrowserEntry}`],
        "DataConnect.deb",
        "linux"
      )
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

  it("uses CFBundleExecutable when the macOS app contains its Node sidecar", () => {
    const invocation = []
    expect(
      readMacBundleExecutable(
        "DataConnect.app/Contents/Info.plist",
        (command, args) => {
          invocation.push(command, args)
          return "DataConnect\n"
        }
      )
    ).toBe("DataConnect")
    expect(invocation).toEqual([
      "plutil",
      [
        "-extract",
        "CFBundleExecutable",
        "raw",
        "-o",
        "-",
        "DataConnect.app/Contents/Info.plist",
      ],
    ])
    expect(() =>
      readMacBundleExecutable("DataConnect.app/Contents/Info.plist", () => "\n")
    ).toThrow("empty CFBundleExecutable")
    expect(
      selectMacAppExecutables(
        ["DataConnect", "pdpp-node"],
        "DataConnect",
        "DataConnect.app"
      )
    ).toEqual({
      appExecutable: "DataConnect",
      nodeSidecar: "pdpp-node",
    })
  })

  it("rejects a missing or ambiguous CFBundleExecutable file", () => {
    expect(() =>
      selectMacAppExecutables(["pdpp-node"], "DataConnect", "DataConnect.app")
    ).toThrow("must identify exactly one app executable")
    expect(() =>
      selectMacAppExecutables(
        ["DataConnect", "DataConnect", "pdpp-node"],
        "DataConnect",
        "DataConnect.app"
      )
    ).toThrow("must identify exactly one app executable")
  })

  it("requires a distinct, exact Node sidecar beside the macOS app executable", () => {
    expect(() =>
      selectMacAppExecutables(["DataConnect"], "DataConnect", "DataConnect.app")
    ).toThrow("exactly one pdpp-node sidecar")
    expect(() =>
      selectMacAppExecutables(["pdpp-node"], "pdpp-node", "DataConnect.app")
    ).toThrow("must be distinct from pdpp-node")
    expect(() =>
      assertBinaryArchitecture(
        "Mach-O 64-bit executable arm64",
        "arm64",
        "pdpp-node"
      )
    ).not.toThrow()
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
            ...windowsRuntimeEntries,
            "resources/pdpp-node.exe",
            "pdpp-node.exe",
            "playwright-runner/dist/browsers/chromium-1228/chrome-win64/chrome.exe",
          ])}) {
            console.log(\`2026-07-31 ..... \${entry.replaceAll("/", "\\\\")}\`)
          }
        `,
      ]
    )

    expect(entries).toHaveLength(19)
    expect(() =>
      assertPackagedRuntime(entries, "DataConnect.exe")
    ).not.toThrow()
    expect(() =>
      assertPackagedNode(entries, "DataConnect.exe", "windows")
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

    child.stdout.write(`${windowsRuntimeEntries.join("\n")}\n`)
    child.stderr.end()
    child.emit("close", 0)
    setImmediate(() => {
      child.stdout.end(
        "pdpp-node.exe\nplaywright-runner/dist/browsers/chromium-1228/chrome-win64/chrome.exe"
      )
    })

    const entries = await entriesPromise
    expect(entries).toHaveLength(19)
    expect(() =>
      assertPackagedNode(entries, "DataConnect.exe", "windows")
    ).not.toThrow()
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
        const resources = join(packageRoot, "usr", "lib", "DataConnect")
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
