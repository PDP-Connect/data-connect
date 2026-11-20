// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The desktop app arms PR_SET_PDEATHSIG(SIGKILL) on the launch.mjs process it
// supervises, and only on that process: the kernel clears the signal for a
// forked child. A launcher that forks the server therefore leaves the server
// running when the app is SIGKILLed. SIGKILL on the launcher pid is exactly
// what the kernel does on parent death, so killing it here must leave no live
// server behind.

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
import { launchScript } from "./ensure-reference-stack.js"

const SERVER_SOURCE = `
require("node:fs").writeFileSync(process.env.TEST_PID_FILE, String(process.pid))
setInterval(() => {}, 1000)
`

const canExec =
  process.platform === "linux" && typeof process.execve === "function"

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
  } catch {
    return false
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
  writeFileSync(join(root, "launch.mjs"), launchScript(), { mode: 0o755 })
}

function stageConsoleLauncher(root) {
  mkdirSync(join(root, "apps", "console"), { recursive: true })
  writeFileSync(join(root, "apps", "console", "server.js"), SERVER_SOURCE)
  writeLauncher(root, "apps/console/server.js")
}

describe.skipIf(!canExec)("launch.mjs and parent death", () => {
  for (const [name, stage] of [
    ["reference implementation", stageReferenceLauncher],
    ["console", stageConsoleLauncher],
  ]) {
    it(`leaves no live ${name} server after the launcher is SIGKILLed`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pdpp-launcher-death-"))
      const pidFile = join(root, "server.pid")
      let launcher
      let serverPid
      try {
        stage(root)
        launcher = spawn(process.execPath, [join(root, "launch.mjs")], {
          cwd: root,
          env: {
            ...process.env,
            PDPP_DATA_DIR: join(root, "data"),
            TEST_PID_FILE: pidFile,
          },
          stdio: "ignore",
        })
        expect(
          await waitFor(
            () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
            15_000
          )
        ).toBe(true)
        serverPid = Number(readFileSync(pidFile, "utf8"))
        expect(isLive(serverPid)).toBe(true)

        launcher.kill("SIGKILL")

        expect(await waitFor(() => !isLive(serverPid), 5_000)).toBe(true)
      } finally {
        if (launcher && launcher.exitCode === null) launcher.kill("SIGKILL")
        if (serverPid && isLive(serverPid)) process.kill(serverPid, "SIGKILL")
        rmSync(root, { force: true, recursive: true })
      }
    })
  }
})
