// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The desktop app keeps the write end of a stdin pipe open for each sidecar.
// The kernel closes it when the app dies, so EOF on the sidecar's stdin is the
// death signal on every OS. This starts each staged launcher the way the
// supervisor does (stdin pipe plus the lifeline flag), closes the pipe, and
// requires the server process to be gone.

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { writeLauncher } from "./ensure-console-stack.js"
import { writeLaunchScript } from "./ensure-reference-stack.js"

const SERVER_SOURCE = `
require("node:fs").writeFileSync(process.env.TEST_PID_FILE, String(process.pid))
require("node:fs").writeFileSync(process.env.TEST_PID_FILE + ".launcher", process.env.PDPP_LAUNCHER_PID ?? "")
setInterval(() => {}, 1000)
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isLive(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
  } catch (error) {
    // No /proc (macOS, Windows): the signal-0 probe above is the answer.
    return error?.code !== "ENOENT" || process.platform !== "linux"
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

function stageReferenceLauncher(root) {
  mkdirSync(join(root, "reference-implementation", "server"), { recursive: true })
  writeFileSync(
    join(root, "reference-implementation", "server", "index.ts"),
    SERVER_SOURCE
  )
  // `--import tsx` only needs to resolve; the stub server is plain JavaScript.
  mkdirSync(join(root, "node_modules", "tsx"), { recursive: true })
  writeFileSync(
    join(root, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", version: "0.0.0", main: "index.js" })
  )
  writeFileSync(join(root, "node_modules", "tsx", "index.js"), "")
  writeLaunchScript(root)
}

function stageConsoleLauncher(root) {
  mkdirSync(join(root, "apps", "console"), { recursive: true })
  writeFileSync(join(root, "apps", "console", "server.js"), SERVER_SOURCE)
  writeLauncher(root, "apps/console/server.js")
}

async function withRunningServer(stage, lifelineEnv, body) {
  const root = mkdtempSync(join(tmpdir(), "pdpp-launcher-lifeline-"))
  const pidFile = join(root, "server.pid")
  let launcher
  let serverPid
  try {
    stage(root)
    launcher = spawn(process.execPath, [join(root, "launch.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        ...lifelineEnv,
        PDPP_DATA_DIR: join(root, "data"),
        TEST_PID_FILE: pidFile,
      },
      // A pipe the test never writes to, as the supervisor provides.
      stdio: ["pipe", "ignore", "ignore"],
    })
    expect(
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
        15_000
      )
    ).toBe(true)
    serverPid = Number(readFileSync(pidFile, "utf8"))
    expect(isLive(serverPid)).toBe(true)
    await body({ launcher, serverPid })
  } finally {
    if (launcher && launcher.exitCode === null) launcher.kill("SIGKILL")
    if (serverPid && isLive(serverPid)) process.kill(serverPid, "SIGKILL")
    rmSync(root, { force: true, recursive: true })
  }
}

const launchers = [
  ["reference implementation", stageReferenceLauncher],
  ["console", stageConsoleLauncher],
]

describe("launch.mjs and the parent lifeline", () => {
  for (const [name, stage] of launchers) {
    it(`stops the ${name} server when its stdin pipe closes`, () =>
      withRunningServer(
        stage,
        { PDPP_PARENT_LIFELINE: "stdin" },
        async ({ launcher, serverPid }) => {
          // Holding the pipe open must not stop the server.
          await sleep(500)
          expect(isLive(serverPid)).toBe(true)

          launcher.stdin.destroy()

          expect(await waitFor(() => !isLive(serverPid), 10_000)).toBe(true)
        }
      ), 30_000)

    // A lease names the launcher's pid. On Linux the launcher execs into the
    // server, so the server is not the launcher's child and cannot assume it.
    it(`tells the ${name} server the pid its lease names`, () =>
      withRunningServer(
        stage,
        { PDPP_PARENT_LIFELINE: "stdin" },
        async ({ launcher, serverPid }) => {
          const recorded = readFileSync(join(launcher.spawnargs[1], "..", "server.pid.launcher"), "utf8")
          expect(recorded).toBe(String(launcher.pid))
          if (process.platform === "linux") expect(serverPid).toBe(launcher.pid)
        }
      ), 30_000)

    it(`leaves the ${name} server running on a closed stdin when the flag is absent`, () =>
      withRunningServer(
        stage,
        { PDPP_PARENT_LIFELINE: "" },
        async ({ launcher, serverPid }) => {
          launcher.stdin.destroy()
          await sleep(1_000)
          expect(isLive(serverPid)).toBe(true)
        }
      ), 30_000)
  }
})
