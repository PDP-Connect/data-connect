// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const srcTauri = resolve(__dirname, "..")
const profilePath = join(srcTauri, "apparmor", "dataconnect-chromium")
const postInstall = join(srcTauri, "scripts", "post-install.sh")
const postRemove = join(srcTauri, "scripts", "post-remove.sh")
const tauriConfig = JSON.parse(
  readFileSync(join(srcTauri, "tauri.conf.json"), "utf8")
)
const profileText = readFileSync(profilePath, "utf8")

/** Translate the AppArmor globs used in the attachment (`*`, `[..]`, `{a,b}`) to a RegExp. */
function attachmentRegExp(glob: string): RegExp {
  let pattern = ""
  for (const character of glob) {
    if (character === "*") pattern += "[^/]*"
    else if (character === "{") pattern += "(?:"
    else if (character === "}") pattern += ")"
    else if (character === ",") pattern += "|"
    else if (character === "[" || character === "]" || character === "-")
      pattern += character
    else pattern += character.replace(/[.+?^$()|\\/]/g, "\\$&")
  }
  return new RegExp(`^${pattern}$`)
}

const header = profileText.match(
  /^profile (\S+) (\S+) flags=\(unconfined\) \{$/m
)

/** The install path of the bundled Chromium in the .deb, from the Tauri config and the runner build layout. */
function debChromePath(revision: string, platformDir: string): string {
  const resources = tauriConfig.bundle.resources as Record<string, string>
  const runnerDist = resources["../playwright-runner/dist/"]
  expect(runnerDist).toBe("playwright-runner/dist/")
  return `/usr/lib/${tauriConfig.productName}/${runnerDist}browsers/chromium-${revision}/${platformDir}/chrome`
}

describe("bundled Chromium AppArmor profile", () => {
  it("has the shape of Ubuntu's own chrome profile", () => {
    expect(profileText).toMatch(/^abi <abi\/4\.0>,$/m)
    expect(profileText).toMatch(/^include <tunables\/global>$/m)
    expect(header?.[1]).toBe("dataconnect-chromium")
    expect(profileText).toMatch(/^ {2}userns,$/m)
    expect(profileText).toMatch(
      /^ {2}include if exists <local\/dataconnect-chromium>$/m
    )
    expect(profileText.trimEnd().endsWith("}")).toBe(true)
  })

  it("attaches to the Chromium path the .deb installs, and nothing else", () => {
    const attachment = attachmentRegExp(header?.[2] ?? "")
    expect(attachment.test(debChromePath("1200", "chrome-linux64"))).toBe(true)
    expect(attachment.test(debChromePath("1243", "chrome-linux64"))).toBe(true)
    expect(attachment.test(debChromePath("1243", "chrome-linux"))).toBe(true)
    expect(
      attachment.test(
        debChromePath("1243", "chrome-linux64").replace(
          /chrome$/,
          "chrome_crashpad_handler"
        )
      )
    ).toBe(false)
    expect(attachment.test(debChromePath("1243/x", "chrome-linux64"))).toBe(
      false
    )
    expect(attachment.test("/opt/google/chrome/chrome")).toBe(false)
  })

  // Set DATACONNECT_DEB to a built .deb to check the paths it really contains.
  const debPaths = () =>
    execFileSync("dpkg-deb", ["-c", process.env.DATACONNECT_DEB ?? ""], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\n")
      .map(line => `/${(line.split(/\s+/).at(5) ?? "").replace(/^\.?\//, "")}`)

  it.skipIf(!process.env.DATACONNECT_DEB)(
    "attaches to the Chromium inside a built .deb",
    () => {
      const chrome = debPaths().filter(path =>
        /\/chrome-linux(64)?\/chrome$/.test(path)
      )
      expect(chrome).toHaveLength(1)
      expect(attachmentRegExp(header?.[2] ?? "").test(chrome[0])).toBe(true)
    }
  )

  it.skipIf(!process.env.DATACONNECT_DEB)("is inside a built .deb", () => {
    expect(debPaths()).toContain(
      "/usr/share/data-connect/apparmor/dataconnect-chromium"
    )
  })

  // Outside /etc/apparmor.d: post-install copies it there only if it parses.
  it("is packaged at /usr/share/data-connect/apparmor/dataconnect-chromium", () => {
    expect(tauriConfig.bundle.linux.deb.files).toEqual({
      "/usr/share/data-connect/apparmor/dataconnect-chromium":
        "apparmor/dataconnect-chromium",
    })
  })

  const parser = "/usr/sbin/apparmor_parser"
  const parserRunnable = (() => {
    try {
      accessSync(parser, constants.X_OK)
      return true
    } catch {
      return false
    }
  })()

  // -Q parses without loading, so it needs no root.
  it.skipIf(!parserRunnable)("parses with apparmor_parser -Q", () => {
    const result = spawnSync(parser, ["-Q", "-K", profilePath], {
      encoding: "utf8",
    })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })
})

describe("deb maintainer scripts", () => {
  let root: string

  afterEach(() => {
    rmSync(root, { force: true, recursive: true })
  })

  function setup(options: {
    apparmor: boolean
    // "rejects" fails the -Q parse check; "fails" fails only the -r load.
    parser: "ok" | "rejects" | "fails" | "absent"
  }) {
    root = mkdtempSync(join(tmpdir(), "dataconnect-deb-apparmor-"))
    const bin = join(root, "bin")
    const sysfs = join(root, "apparmor")
    const source = join(root, "source-dataconnect-chromium")
    const profile = join(root, "dataconnect-chromium")
    const calls = join(root, "calls")
    mkdirSync(bin)
    writeFileSync(source, profileText)
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    stub("update-desktop-database", "exit 0")
    if (options.parser !== "absent") {
      stub(
        "apparmor_parser",
        [
          `echo "$@" >> "${calls}"`,
          options.parser === "rejects" ? `[ "$1" = -Q ] && exit 1` : "",
          options.parser === "fails" ? `[ "$1" = -r ] && exit 1` : "",
          "exit 0",
        ].join("\n")
      )
    }
    if (options.apparmor) {
      mkdirSync(sysfs)
      writeFileSync(
        join(sysfs, "profiles"),
        "dataconnect-chromium (unconfined)\nchrome (unconfined)\n"
      )
      writeFileSync(join(sysfs, ".remove"), "")
    }
    const run = (script: string, ...args: string[]) =>
      spawnSync("/bin/sh", [script, ...args], {
        encoding: "utf8",
        env: {
          DATACONNECT_APPARMOR_PROFILE: profile,
          DATACONNECT_APPARMOR_SOURCE: source,
          DATACONNECT_APPARMOR_SYSFS: sysfs,
          // No /usr/sbin: the only apparmor_parser is the stub, if any.
          PATH: `${bin}:/usr/bin:/bin`,
        },
      })
    const parserCalls = () =>
      existsSync(calls) ? readFileSync(calls, "utf8") : ""
    return { parserCalls, profile, run, source, sysfs }
  }

  it("post-install does nothing when AppArmor is not in use", () => {
    const { parserCalls, run } = setup({ apparmor: false, parser: "ok" })
    const result = run(postInstall, "configure")
    expect(result.status).toBe(0)
    expect(parserCalls()).toBe("")
  })

  it("post-install succeeds when apparmor_parser is absent", () => {
    const { run } = setup({ apparmor: true, parser: "absent" })
    expect(run(postInstall, "configure").status).toBe(0)
  })

  it("post-install copies the profile and loads it with apparmor_parser -r", () => {
    const { parserCalls, profile, run, source } = setup({
      apparmor: true,
      parser: "ok",
    })
    expect(run(postInstall, "configure").status).toBe(0)
    expect(readFileSync(profile, "utf8")).toBe(profileText)
    expect(parserCalls()).toBe(`-Q -K ${source}\n-r ${profile}\n`)
  })

  it("post-install does not install the profile when apparmor_parser -Q rejects it", () => {
    const { parserCalls, profile, run, source } = setup({
      apparmor: true,
      parser: "rejects",
    })
    expect(run(postInstall, "configure").status).toBe(0)
    expect(existsSync(profile)).toBe(false)
    expect(parserCalls()).toBe(`-Q -K ${source}\n`)
  })

  it("post-install does not fail the install when loading fails", () => {
    const { parserCalls, profile, run } = setup({ apparmor: true, parser: "fails" })
    expect(run(postInstall, "configure").status).toBe(0)
    expect(parserCalls()).toContain(`-r ${profile}`)
  })

  it("post-remove unloads and removes the profile on remove", () => {
    const { profile, run, sysfs } = setup({ apparmor: true, parser: "ok" })
    writeFileSync(profile, profileText)
    expect(run(postRemove, "remove").status).toBe(0)
    expect(readFileSync(join(sysfs, ".remove"), "utf8")).toBe(
      "dataconnect-chromium"
    )
    expect(existsSync(profile)).toBe(false)
  })

  it("post-remove keeps the profile on upgrade", () => {
    const { profile, run, sysfs } = setup({ apparmor: true, parser: "ok" })
    writeFileSync(profile, profileText)
    expect(run(postRemove, "upgrade", "0.7.60").status).toBe(0)
    expect(readFileSync(join(sysfs, ".remove"), "utf8")).toBe("")
    expect(existsSync(profile)).toBe(true)
  })

  it("post-remove succeeds without AppArmor", () => {
    const { run } = setup({ apparmor: false, parser: "absent" })
    expect(run(postRemove, "purge").status).toBe(0)
  })
})
