// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  collectOldGenerations,
  findProcessesUsingDirectory,
  parseArgs,
  stageConsoleStack,
} from "./ensure-console-stack.js"

function createConsoleBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), "pdpp-console-stack-"))
  const standalone = join(
    root,
    "apps",
    "console",
    ".next",
    "standalone",
    "apps",
    "console"
  )
  mkdirSync(join(standalone, ".next"), { recursive: true })
  mkdirSync(join(root, "apps", "console", ".next", "static"), {
    recursive: true,
  })
  mkdirSync(join(root, "apps", "console", "public"), { recursive: true })
  writeFileSync(join(standalone, "server.js"), "generated server")
  writeFileSync(join(standalone, "package.json"), "{}\n")
  writeFileSync(
    join(root, "apps", "console", ".next", "static", "app.js"),
    "static"
  )
  writeFileSync(
    join(root, "apps", "console", "public", "favicon.svg"),
    "public"
  )
  const manifestsDirectory = join(
    root,
    "node_modules",
    "@pdpp",
    "polyfill-connectors",
    "manifests"
  )
  mkdirSync(manifestsDirectory, { recursive: true })
  writeFileSync(join(manifestsDirectory, "ynab.json"), "{}")
  writeFileSync(
    join(root, "node_modules", "@pdpp", "polyfill-connectors", "package.json"),
    "{}\n"
  )
  return root
}

describe("ensure console stack", () => {
  it("parses and validates a Tauri profile", () => {
    expect(parseArgs(["--profile", "debug"], {})).toEqual({ profile: "debug" })
    expect(() => parseArgs(["--profile", "../release"], {})).toThrow(
      /invalid Tauri profile/
    )
  })

  it("builds the console through its workspace script and stages the complete runtime tree", () => {
    const root = createConsoleBuildFixture()
    const calls = []
    try {
      const result = stageConsoleStack({
        build: true,
        env: { CI: "1" },
        profile: "release",
        projectRoot: root,
        spawn: (...args) => {
          calls.push(args)
          return { status: 0 }
        },
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual([
        "npm",
        ["run", "build", "--workspace=apps/console"],
        expect.objectContaining({
          cwd: root,
          env: { CI: "1", NODE_ENV: "production" },
          shell: false,
          stdio: "inherit",
        }),
      ])
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/server.js"),
          "utf8"
        )
      ).toBe("generated server")
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/.next/static/app.js"),
          "utf8"
        )
      ).toBe("static")
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/public/favicon.svg"),
          "utf8"
        )
      ).toBe("public")
      expect(
        readFileSync(join(result.stageDirectory, "launch.mjs"), "utf8")
      ).toContain('resolve(stageDirectory, "apps/console/server.js")')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("stages the connector manifests package so the packaged console is self-contained", () => {
    const root = createConsoleBuildFixture()
    try {
      const result = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const stagedManifestsDirectory = join(
        result.stageDirectory,
        "apps",
        "console",
        "node_modules",
        "@pdpp",
        "polyfill-connectors",
        "manifests"
      )
      expect(
        readFileSync(join(stagedManifestsDirectory, "ynab.json"), "utf8")
      ).toBe("{}")
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("stages the simple-icons package when installed, for the layer-2 vendored icon lookup", () => {
    const root = createConsoleBuildFixture()
    try {
      const simpleIconsDirectory = join(root, "node_modules", "simple-icons")
      mkdirSync(join(simpleIconsDirectory, "icons"), { recursive: true })
      mkdirSync(join(simpleIconsDirectory, "data"), { recursive: true })
      writeFileSync(join(simpleIconsDirectory, "package.json"), "{}\n")
      writeFileSync(
        join(simpleIconsDirectory, "data", "simple-icons.json"),
        '[{"title":"GitHub","slug":"github"}]'
      )
      writeFileSync(
        join(simpleIconsDirectory, "icons", "github.svg"),
        "<svg><title>GitHub</title></svg>"
      )
      const result = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const stagedSimpleIconsDirectory = join(
        result.stageDirectory,
        "apps",
        "console",
        "node_modules",
        "simple-icons"
      )
      expect(
        readFileSync(join(stagedSimpleIconsDirectory, "icons", "github.svg"), "utf8")
      ).toBe("<svg><title>GitHub</title></svg>")
      expect(
        readFileSync(
          join(stagedSimpleIconsDirectory, "data", "simple-icons.json"),
          "utf8"
        )
      ).toContain("github")
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("degrades quietly (no throw) when simple-icons is not installed", () => {
    const root = createConsoleBuildFixture()
    try {
      expect(() =>
        stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      ).not.toThrow()
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("fails fast if the connector manifests package is not installed", () => {
    const root = createConsoleBuildFixture()
    try {
      rmSync(join(root, "node_modules", "@pdpp", "polyfill-connectors"), {
        force: true,
        recursive: true,
      })
      expect(() =>
        stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      ).toThrow(/connector manifests package/)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("replaces stale output and records deterministic sha256 hashes", () => {
    const root = createConsoleBuildFixture()
    try {
      const first = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      writeFileSync(join(first.stageDirectory, "stale.txt"), "must be removed")
      const second = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const manifest = JSON.parse(readFileSync(second.manifestPath, "utf8"))

      expect(manifest.profile).toBe("release")
      expect(manifest.server).toBe("apps/console/server.js")
      expect(manifest.hashes["apps/console/server.js"]).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      expect(manifest.hashes["apps/console/server.js"]).toBe(
        `sha256:${createHash("sha256")
          .update(
            readFileSync(join(second.stageDirectory, "apps/console/server.js"))
          )
          .digest("hex")}`
      )
      expect(manifest.hashes["launch.mjs"]).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(manifest.hashes["manifest.json"]).toBeUndefined()
      expect(manifest.hashes["stale.txt"]).toBeUndefined()
      expect(manifest.runtimeEnv).toContain("PDPP_AS_URL")
      expect(manifest.runtimeEnv).toContain("PDPP_RS_URL")
      assert.deepEqual(
        Object.keys(manifest.hashes),
        [...Object.keys(manifest.hashes)].sort()
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  describe.skipIf(process.platform !== "linux")(
    "stale staged-process detection (Linux only, matching findProcessesUsingDirectory's own platform gate)",
    () => {
      it("finds a live process whose cwd is inside the target directory, and stops finding it once stopped", async () => {
        // Confirmed live, 2026-09-19: a next-server process kept running
        // against a directory ensure-console-stack.js had just replaced,
        // serving stale HTML while every static asset 404'd. This proves the
        // detection this fix adds actually sees a real running process by
        // its /proc/<pid>/cwd, not a mock -- the exact mechanism the
        // original bug depended on going undetected.
        const directory = mkdtempSync(join(tmpdir(), "pdpp-stale-process-"))
        try {
          const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
            cwd: directory,
            stdio: "ignore",
          })
          try {
            await new Promise(resolve => setTimeout(resolve, 100))
            expect(findProcessesUsingDirectory(directory)).toContain(child.pid)

            child.kill("SIGTERM")
            await new Promise(resolve => {
              child.once("exit", resolve)
            })
            await new Promise(resolve => setTimeout(resolve, 50))
            expect(findProcessesUsingDirectory(directory)).not.toContain(
              child.pid
            )
          } finally {
            if (!child.killed) child.kill("SIGKILL")
          }
        } finally {
          rmSync(directory, { force: true, recursive: true })
        }
      })

      it("does not match a process whose cwd is merely a sibling with a shared prefix", () => {
        // /a/b-other must not match target /a/b -- a naive string-prefix
        // check without the trailing separator would false-positive here.
        const directory = mkdtempSync(join(tmpdir(), "pdpp-stale-process-"))
        const sibling = `${directory}-other`
        mkdirSync(sibling, { recursive: true })
        try {
          const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
            cwd: sibling,
            stdio: "ignore",
          })
          try {
            expect(findProcessesUsingDirectory(directory)).not.toContain(
              child.pid
            )
          } finally {
            child.kill("SIGKILL")
          }
        } finally {
          rmSync(directory, { force: true, recursive: true })
          rmSync(sibling, { force: true, recursive: true })
        }
      })
    }
  )

  it("fails loudly instead of staging a console with an empty connector manifest catalog", () => {
    const root = createConsoleBuildFixture()
    try {
      const manifestsDirectory = join(
        root,
        "node_modules",
        "@pdpp",
        "polyfill-connectors",
        "manifests"
      )
      rmSync(join(manifestsDirectory, "ynab.json"))
      expect(() =>
        stageConsoleStack({
          build: false,
          profile: "release",
          projectRoot: root,
        })
      ).toThrow(/staged connector manifests directory is empty/)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
  it("keeps a running server's build directory intact across a restage", async () => {
    // Scope correction (2026-09-21): this proves a generation directory is
    // never unlinked by a later restage, which is what makes a build
    // durable on disk. It does NOT prove the shipped app's running server
    // keeps serving coherently, because that server's cwd is the STABLE
    // path, not a generation -- `resolve_staged_root` in unified.rs hands
    // `reference-stack/<sidecar>` to `console_process_spec`'s
    // `cwd: Some(root.to_path_buf())`. Measured for the stable-path case:
    // a relative read after a restage gives ENOENT and an absolute read
    // transparently returns the NEW content, so neither is "the old build,
    // coherently". See the stable-path test below for what is actually
    // guaranteed there.
    const root = createConsoleBuildFixture()
    const stageParent = join(root, "src-tauri", "target", "release", "reference-stack")
    let child
    try {
      stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      const first = readdirSync(stageParent)
        .filter((entry) => entry.startsWith("console-"))
        .map((entry) => join(stageParent, entry))
      expect(first).toHaveLength(1)
      const runningGeneration = first[0]

      // A real process whose cwd is inside that generation, exactly like a
      // staged next-server.
      child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        cwd: runningGeneration,
        stdio: "ignore",
      })
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))

      // Restage with different content, which produces a new generation.
      writeFileSync(
        join(root, "apps", "console", ".next", "static", "app.js"),
        "static-v2"
      )
      stageConsoleStack({ build: false, profile: "release", projectRoot: root })

      expect(
        existsSync(join(runningGeneration, "launch.mjs")),
        "the generation a live server is running from must survive a restage"
      ).toBe(true)
      expect(
        findProcessesUsingDirectory(runningGeneration).includes(child.pid)
      ).toBe(true)
    } finally {
      child?.kill("SIGKILL")
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("preserves a live server at the stable path while publishing a new stable stage", async () => {
    // IMPORTANT SCOPE NOTE, found during independent review, fixed in this
    // same pass: the test above ("keeps a running server's build directory
    // intact...") exercises a process whose cwd is inside a GENERATION
    // directory -- but that is never what actually happens in the shipped
    // app. unified.rs's resolve_staged_root resolves the fixed
    // `reference-stack/<sidecar>` path (this test's `result.stageDirectory`,
    // i.e. the STABLE path), and the Rust supervisor spawns launch.mjs with
    // THAT exact path as its `cwd` (`cwd: Some(root.to_path_buf())` in
    // console_process_spec/ri_process_spec). No real process's cwd is ever
    // `console-<hash>`.
    //
    // Measured directly (2026-09-21, isolated Node repro): a fixed
    // sleep-then-swap did NOT reliably protect a live process at the STABLE
    // path -- a relative-path read from inside such a process fails with
    // ENOENT after an unguarded restage (recursive rmSync unlinks every
    // file, not just the top directory entry), and an absolute-path read
    // instead silently serves the NEW content. Neither is "the old build,
    // coherently." Traced to three real incidents against the actual
    // console, most recently within the hour of this fix --
    // `InvariantError: client reference manifest for route "/connect" does
    // not exist`, a 500 that blocked testing.
    //
    // Publication must preserve the old tree and leave process ownership to
    // the supervisor. A cwd scan cannot prove that the staging command owns
    // the process, so it must never signal it.
    const root = createConsoleBuildFixture()
    let child
    try {
      const first = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const stablePath = first.stageDirectory

      child = spawn(
        process.execPath,
        [
          "-e",
          "setTimeout(() => {}, 30000)",
        ],
        { cwd: stablePath, stdio: "ignore" }
      )
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      expect(findProcessesUsingDirectory(stablePath)).toContain(child.pid)

      writeFileSync(
        join(root, "apps", "console", ".next", "static", "app.js"),
        "static-v2-stable-path-case"
      )
      const second = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })

      const previous = readdirSync(dirname(stablePath)).find((entry) => entry.startsWith("console.previous-"))
      expect(previous).toBeDefined()
      expect(findProcessesUsingDirectory(join(dirname(stablePath), previous))).toContain(child.pid)
      expect(readFileSync(join(dirname(stablePath), previous, "apps/console/.next/static/app.js"), "utf8")).toBe("static")
      expect(
        readFileSync(
          join(second.stageDirectory, "apps/console/.next/static/app.js"),
          "utf8"
        )
      ).toBe("static-v2-stable-path-case")
    } finally {
      child?.kill("SIGKILL")
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("publishes the stable path as a real directory, never a symlink", () => {
    // build-prod.js and finalize-linux-appimage.js copy this exact path into
    // the packaged app with cpSync, which PRESERVES symlinks rather than
    // following them -- a symlinked `console` would ship a dangling link
    // inside the bundle. Verified 2026-09-21.
    const root = createConsoleBuildFixture()
    try {
      const result = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      expect(lstatSync(result.stageDirectory).isSymbolicLink()).toBe(false)
      expect(lstatSync(result.stageDirectory).isDirectory()).toBe(true)
      expect(existsSync(join(result.stageDirectory, "launch.mjs"))).toBe(true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("reuses an unchanged generation without removing a process's directory", async () => {
    const root = createConsoleBuildFixture()
    const stageParent = join(root, "src-tauri", "target", "release", "reference-stack")
    const generations = () =>
      readdirSync(stageParent).filter((entry) => entry.startsWith("console-"))
    let child
    try {
      stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      const afterFirst = generations()
      const generationPath = join(stageParent, afterFirst[0])
      const proofPath = join(root, "live-generation-proof.txt")
      child = spawn(
        process.execPath,
        [
          "-e",
          "setTimeout(() => { const fs = require('node:fs'); fs.writeFileSync(process.env.PROOF, fs.existsSync('manifest.json') ? 'preserved' : 'missing') }, 100)",
        ],
        { cwd: generationPath, env: { ...process.env, PROOF: proofPath }, stdio: "ignore" },
      )
      // Identical content restages onto the same generation id rather than
      // replacing the directory an existing process is using.
      stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      await new Promise((resolveWait, rejectWait) => {
        child.once("error", rejectWait)
        child.once("close", resolveWait)
      })
      expect(generations()).toEqual(afterFirst)
      expect(readFileSync(proofPath, "utf8")).toBe("preserved")

      // Keep all generations because the pruner cannot prove that an old
      // generation is unused on every supported platform.
      for (const value of ["v2", "v3", "v4"]) {
        writeFileSync(
          join(root, "apps", "console", ".next", "static", "app.js"),
          value
        )
        stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      }
      expect(generations().length).toBe(4)
    } finally {
      child?.kill("SIGKILL")
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("never prunes a generation a live process is running from", async () => {
    const root = createConsoleBuildFixture()
    const stageParent = join(root, "src-tauri", "target", "release", "reference-stack")
    let child
    try {
      stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      const held = join(
        stageParent,
        readdirSync(stageParent).find((entry) => entry.startsWith("console-"))
      )
      child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        cwd: held,
        stdio: "ignore",
      })
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))

      // keep=0 asks the pruner to remove everything; the held generation
      // must still be refused.
      const removed = collectOldGenerations(stageParent, 0)
      expect(removed).not.toContain(held)
      expect(existsSync(held)).toBe(true)
    } finally {
      child?.kill("SIGKILL")
      rmSync(root, { force: true, recursive: true })
    }
  })
  it("stages from cold with no prior target directory", () => {
    // Lane unifydefault-0921 makes the unified stack the default, so a
    // first launch on a clean machine reaches staging with no
    // reference-stack directory at all. The generation scheme must not
    // assume a previous generation or a pre-existing stable path.
    const root = createConsoleBuildFixture()
    const stageParent = join(root, "src-tauri", "target", "release", "reference-stack")
    try {
      expect(existsSync(stageParent)).toBe(false)
      const result = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      expect(existsSync(join(result.stageDirectory, "launch.mjs"))).toBe(true)
      expect(
        readdirSync(stageParent).filter((entry) => entry.startsWith("console-"))
      ).toHaveLength(1)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
