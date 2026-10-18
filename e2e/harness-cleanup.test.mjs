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
import { test } from "node:test"

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

for (const mode of ["normal", "failure", "SIGTERM", "SIGINT", "timeout"]) {
  test(
    `owned process groups and scratch are removed after ${mode}`,
    { timeout: 20_000 },
    async t => {
      const directory = await mkdtemp(join(tmpdir(), "e2e-cleanup-test-"))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const fixture = join(directory, "fixture.mjs")
      await writeFile(
        fixture,
        `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOwnedHarness, runInNamespace, receiveSignals } from ${JSON.stringify(harness)};
import { assertLoopbackOnly } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("harness-safety.mjs", import.meta.url))).href)};
// Same decision as harness.mjs main(): under test-sandbox --net none a nested
// namespace is refused, so the fixture runs the inner path directly.
const reexeced = process.argv.includes("--isolated");
let isolated = reexeced;
if (!reexeced) { try { assertLoopbackOnly(); isolated = true } catch {} }
if (!isolated) {
  process.exitCode = await runInNamespace([process.argv[1], "--isolated"]);
} else {
assertLoopbackOnly();
const stopReceiving = reexeced ? receiveSignals() : () => {};
const mode = ${JSON.stringify(mode)};
try {
  const code = await runOwnedHarness(async ({ root, launch }) => {
    launch(["-e", ${JSON.stringify(`
      process.on("SIGTERM", () => {});
      const {spawn} = require("node:child_process");
      const stat = require("node:fs").readFileSync("/proc/self/stat", "utf8");
      console.log(JSON.stringify({pgid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])}));
      spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({grandchild:true})); setInterval(() => {}, 1000)'], {stdio: ["ignore", "inherit", "inherit"]});
      setInterval(() => {}, 1000);
    `)}], { output: true });
    // Give both generations time to install their TERM-resistant handlers.
    await new Promise(r => setTimeout(r, 300));
    console.log(JSON.stringify({ ready: true }));
    if (mode === "normal") return 0;
    if (mode === "failure") {
      const spec = join(root, "failure.spec.mjs");
      const config = join(root, "playwright.config.mjs");
      await writeFile(spec, ${JSON.stringify(`import { test, expect } from ${JSON.stringify(new URL("node_modules/@playwright/test/index.mjs", import.meta.url).href)}; test("seeded assertion failure", () => { expect(true).toBe(false) });`)});
      await writeFile(config, 'export default { testMatch: "failure.spec.mjs", workers: 1, reporter: "line" }');
      return launch([${JSON.stringify(fileURLToPath(new URL("node_modules/@playwright/test/cli.js", import.meta.url)))}, "test", "--config", config], { cwd: root }).completion;
    }
    return new Promise(() => {});
  }, { timeoutMs: mode === "timeout" ? 800 : 10000, onState: value => console.log(JSON.stringify(value)) });
  process.exitCode = code;
} catch (error) { console.error(error.message); process.exitCode = /SIGINT/.test(error.message) ? 130 : /SIGTERM/.test(error.message) ? 143 : 1; } finally { console.log(JSON.stringify({ innerTeardown: true })); stopReceiving(); }
}
`
      )
      const child = spawn(process.execPath, [fixture], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TEST_TMPDIR: directory },
      })
      const states = []
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
      assert.equal(
        code,
        { normal: 0, failure: 1, SIGTERM: 143, SIGINT: 130, timeout: 1 }[mode],
        stderr
      )
      assert.ok(
        states.some(state => state.innerTeardown),
        "inner finally completed before namespace exit"
      )
      const root = states.find(state => state.root)?.root
      assert.ok(root, "scratch root was recorded")
      await assert.rejects(access(root), { code: "ENOENT" })
      assert.ok(
        states.some(state => state.grandchild),
        "grandchild started"
      )
      const pids = states.filter(state => state.pgid).map(state => state.pgid)
      assert.ok(pids.length)
      for (const pgid of pids) {
        let remaining = await processesInGroup(pgid)
        for (let retry = 0; remaining.length && retry < 40; retry++) {
          await delay(50)
          remaining = await processesInGroup(pgid)
        }
        assert.deepEqual(remaining, [], `remaining processes in PGID ${pgid}`)
      }
      console.log(
        JSON.stringify({
          mode,
          code,
          rootRemoved: true,
          pgids: pids,
          remaining: [],
        })
      )
    }
  )
}
