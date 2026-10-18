// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { describe, test } from "node:test"

const harness = pathToFileURL(
  fileURLToPath(new URL("harness.mjs", import.meta.url))
).href

async function processesInGroup(pgid) {
  const found = []
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8")
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
      if (Number(fields[2]) === pgid)
        found.push({ pid: Number(pid), state: fields[0] })
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error
    }
  }
  return found
}

// "host" runs the outer wrapper path through a stub that mimics test-sandbox
// (`cmd & wait`: stdin is /dev/null, fd 3 is inherited), so it runs even inside
// a sandbox; "in-place" runs the inner path directly, as under test-sandbox.
const WRAPPER = `#!/usr/bin/env bash\n"$@" &\nwait $!\n`
const EXPECTED = {
  normal: 0,
  failure: 1,
  SIGTERM: 143,
  SIGINT: 130,
  timeout: 1,
  escape: 0,
}

function killGroup(pid, signal = "SIGKILL") {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

// Concurrent: each case spends seconds waiting out TERM-resistant processes.
describe("process cleanup", { concurrency: 4 }, () => {
  for (const path of ["host", "in-place"]) {
    for (const mode of Object.keys(EXPECTED)) {
      test(
        `${path}: owned process groups and scratch are removed after ${mode}`,
        { timeout: 20_000 },
        async t => {
          const directory = await mkdtemp(join(tmpdir(), "e2e-cleanup-test-"))
          const states = []
          let child
          t.after(async () => {
            // A seeded fault must fail fast: kill the fixture, every recorded
            // group and the escaped descendant instead of hanging the runner.
            if (child?.pid) killGroup(child.pid)
            for (const { pgid } of states) if (pgid) killGroup(pgid)
            for (const { escaped } of states)
              if (escaped) {
                try {
                  process.kill(escaped, "SIGKILL")
                } catch {}
              }
            await rm(directory, { recursive: true, force: true })
          })
          const wrapper = join(directory, "wrapper.sh")
          await writeFile(wrapper, WRAPPER, { mode: 0o755 })
          const fixture = join(directory, "fixture.mjs")
          await writeFile(fixture, fixtureSource(mode, wrapper))
          child = spawn(process.execPath, [fixture, path], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, TEST_TMPDIR: directory },
          })
          let stderr = ""
          child.stderr.on("data", chunk => {
            stderr += chunk
          })
          child.stdout.setEncoding("utf8")
          let buffer = ""
          child.stdout.on("data", chunk => {
            buffer += chunk
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n")
              const state = JSON.parse(buffer.slice(0, end))
              states.push(state)
              buffer = buffer.slice(end + 1)
              if (state.ready && mode.startsWith("SIG")) child.kill(mode)
            }
          })
          const code = await new Promise((resolve, reject) => {
            child.once("error", reject)
            child.once("exit", resolve)
          })
          assert.equal(code, EXPECTED[mode], stderr)
          if (mode.startsWith("SIG"))
            assert.match(
              stderr,
              new RegExp(`E2E interrupted by ${mode}`),
              "the inner process saw the signal"
            )
          assert.ok(
            states.some(state => state.innerTeardown),
            "inner finally completed before the wrapper exited"
          )
          const root = states.find(state => state.root)?.root
          assert.ok(root, "scratch root was recorded")
          await assert.rejects(access(root), { code: "ENOENT" })
          assert.ok(
            states.some(state => state.grandchild),
            "grandchild started"
          )
          const pids = states
            .filter(state => state.pgid)
            .map(state => state.pgid)
          assert.ok(pids.length)
          for (const pgid of pids) {
            let remaining = await processesInGroup(pgid)
            for (let retry = 0; remaining.length && retry < 40; retry++) {
              await delay(50)
              remaining = await processesInGroup(pgid)
            }
            assert.deepEqual(
              remaining,
              [],
              `remaining processes in PGID ${pgid}`
            )
          }
          console.log(
            JSON.stringify({ path, mode, code, rootRemoved: true, pgids: pids })
          )
        }
      )
    }
  }
})

// The fixture's timeout (30 s) sits above the test's (20 s): a signal that never
// reaches the inner process fails the test instead of passing via the timeout.
function fixtureSource(mode, wrapper) {
  const child = `
    process.on("SIGTERM", () => {});
    const {spawn} = require("node:child_process");
    const stat = require("node:fs").readFileSync("/proc/self/stat", "utf8");
    console.log(JSON.stringify({pgid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])}));
    spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({grandchild:true})); setInterval(() => {}, 1000)'], {stdio: ["ignore", "inherit", "inherit"]});
    if (${JSON.stringify(mode)} === "escape") {
      // setsid descendant that ignores TERM and holds our stdout and stderr.
      const escaped = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {detached: true, stdio: ["ignore", "inherit", "inherit"]});
      console.log(JSON.stringify({escaped: escaped.pid}));
      process.on("SIGTERM", () => process.exit(0));
    }
    setInterval(() => {}, 1000);
  `
  const failing = `import { test, expect } from ${JSON.stringify(new URL("node_modules/@playwright/test/index.mjs", import.meta.url).href)}; test("seeded assertion failure", () => { expect(true).toBe(false) });`
  return `
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOwnedHarness, runInSandbox, receiveSignals, signalExitCode } from ${JSON.stringify(harness)};
const mode = ${JSON.stringify(mode)};
const inner = process.argv.includes("--isolated");
if (!inner && process.argv[2] === "host") {
  process.exitCode = await runInSandbox([process.argv[1], process.argv[2], "--isolated"], [${JSON.stringify(wrapper)}]);
} else {
const stopReceiving = inner ? receiveSignals() : () => {};
const stat = readFileSync("/proc/self/stat", "utf8");
console.log(JSON.stringify({ pgid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) }));
try {
  const code = await runOwnedHarness(async ({ root, launch }) => {
    launch(["-e", ${JSON.stringify(child)}], { output: true });
    // Give both generations time to install their TERM-resistant handlers.
    await new Promise(r => setTimeout(r, 300));
    console.log(JSON.stringify({ ready: true }));
    if (mode === "normal" || mode === "escape") return 0;
    if (mode === "failure") {
      const spec = join(root, "failure.spec.mjs");
      const config = join(root, "playwright.config.mjs");
      await writeFile(spec, ${JSON.stringify(failing)});
      await writeFile(config, 'export default { testMatch: "failure.spec.mjs", workers: 1, reporter: "line" }');
      return launch([${JSON.stringify(fileURLToPath(new URL("node_modules/@playwright/test/cli.js", import.meta.url)))}, "test", "--config", config], { cwd: root }).completion;
    }
    return new Promise(() => {});
  }, { timeoutMs: mode === "timeout" ? 800 : 30000, onState: value => console.log(JSON.stringify(value)) });
  process.exitCode = code;
} catch (error) { console.error(error.message); process.exitCode = signalExitCode(error.signal); } finally { console.log(JSON.stringify({ innerTeardown: true })); stopReceiving(); }
}
`
}
