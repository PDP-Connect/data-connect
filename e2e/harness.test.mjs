// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import {
  assertHarnessOwnership,
  MARKER,
  refuseConsoleEnvFiles,
  startWatcher,
  TARGET_VARIABLES,
} from "./harness-safety.mjs"
import { cleanEnvironment, main, runOwnedHarness } from "./harness.mjs"

const loopback = { lo: [{ internal: true }] }
const harness = fileURLToPath(new URL("harness.mjs", import.meta.url))

async function snapshot(path) {
  const info = await stat(path)
  return {
    hash: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    mtime: info.mtimeMs,
    size: info.size,
  }
}

test("external targets are refused before process creation or filesystem writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "e2e-refusal-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sentinel = join(root, "autostart.json")
  await writeFile(sentinel, '{"enabled":true}\n')
  const before = await snapshot(sentinel)
  // A preload fails the test if the harness tries to spawn even namespace setup.
  const preload = join(root, "no-spawn.cjs")
  await writeFile(
    preload,
    `const cp = require("node:child_process"); for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"]) cp[key] = () => { console.error("CHILD_STARTED"); process.exit(99) }; require("node:module").syncBuiltinESMExports();`
  )
  const contents = await readdir(root)
  const directoryBefore = await stat(root)
  for (const name of TARGET_VARIABLES) {
    for (const value of [
      name.endsWith("DATA_DIR") ? root : "https://pdpp.example.com",
      "",
    ]) {
      const env = { ...process.env, TEST_TMPDIR: root }
      for (const key of TARGET_VARIABLES) delete env[key]
      env[name] = value
      const result = spawnSync(
        process.execPath,
        ["--require", preload, harness],
        { env, encoding: "utf8" }
      )
      assert.equal(result.status, 1, result.stderr)
      assert.match(
        result.stderr,
        new RegExp(`Refusing externally supplied ${name}`)
      )
      assert.doesNotMatch(result.stderr, /CHILD_STARTED/)
      assert.deepEqual(await snapshot(sentinel), before)
      assert.deepEqual(await readdir(root), contents)
      assert.equal((await stat(root)).mtimeMs, directoryBefore.mtimeMs)
    }
  }
})

test("every console env file except *.example is refused before any spawn", async t => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-env-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, ".env.example"), "")
  refuseConsoleEnvFiles(dir)
  // A missing wrapper would be the next error, so a refusal message proves order.
  const env = { PATH: process.env.PATH }
  const wrapper = [join(dir, "no-such-wrapper")]
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.production.local",
    ".env.test.local",
  ]) {
    await writeFile(join(dir, name), "AS_PUBLIC_URL=https://example.com\n")
    await assert.rejects(
      main({ args: [], env, consoleDir: dir, wrapper }),
      new RegExp(`Refusing console environment file apps/console/${name}`)
    )
    await rm(join(dir, name))
  }
})

test("a missing or failing test-sandbox is fatal and no other isolation is tried", async t => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-wrapper-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = { PATH: process.env.PATH }
  await assert.rejects(
    main({ args: [], env, consoleDir: dir, wrapper: [join(dir, "missing")] }),
    /missing, and the E2E harness supports no other isolation/
  )
  // A wrapper that fails never runs the command: its exit status is ours.
  const failing = join(dir, "failing.sh")
  const record = join(dir, "args")
  await writeFile(
    failing,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 3\n`,
    { mode: 0o755 }
  )
  assert.equal(
    await main({
      args: ["a.spec.ts"],
      env,
      consoleDir: dir,
      wrapper: [failing],
    }),
    3
  )
  assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
    process.execPath,
    harness,
    "--isolated",
    "a.spec.ts",
  ])
})

test("inside a sandbox, a network that is not loopback-only is refused before servers start", async t => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-ownership-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const interfaces of [{ ...loopback, eth0: [{ internal: false }] }, {}])
    await assert.rejects(
      main({
        args: [],
        env: { PATH: process.env.PATH, TEST_SANDBOX_ACTIVE: "1" },
        consoleDir: dir,
        interfaces,
      }),
      /loopback-only/
    )
})

test("ownership guard refuses each unsafe condition before a write", async t => {
  const root = await mkdtemp(join(tmpdir(), "e2e-guard-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, "data")
  const outside = join(root, "outside")
  await mkdir(data)
  await mkdir(outside)
  await writeFile(join(data, MARKER), "nonce")
  await writeFile(join(outside, MARKER), "nonce")
  const sentinel = join(data, "autostart.json")
  await writeFile(sentinel, "original")
  const before = await snapshot(sentinel)
  const env = {
    E2E_BASE_URL: "http://127.0.0.1:1234",
    E2E_HARNESS_ROOT: data,
    E2E_DATA_DIR: data,
    E2E_HARNESS_NONCE: "nonce",
    E2E_OWNER_PASSWORD: "test-only",
  }
  const valid = { ...env, E2E_HARNESS_ROOT: root }
  await assertHarnessOwnership(valid, loopback)
  await symlink(outside, join(data, "escape"))
  const cases = [
    [{ ...valid, E2E_BASE_URL: "" }, loopback, /Missing disposable/],
    [valid, { ...loopback, eth0: [{ internal: false }] }, /loopback-only/],
    [
      { ...valid, E2E_BASE_URL: "https://pdpp.example.com" },
      loopback,
      /must be loopback/,
    ],
    [{ ...env, E2E_DATA_DIR: outside }, loopback, /resolve inside/],
    [
      { ...env, E2E_DATA_DIR: join(data, "escape") },
      loopback,
      /resolve inside/,
    ],
    [
      { ...valid, E2E_HARNESS_NONCE: "wrong" },
      loopback,
      /nonce does not match/,
    ],
    [{ ...valid, E2E_HARNESS_NONCE: "" }, loopback, /Missing disposable/],
  ]
  for (const name of ["E2E_REMOTE_BASE_URL", "E2E_BUFFERING_BASE_URL"]) {
    cases.push([
      { ...valid, [name]: "https://pdpp.example.com" },
      loopback,
      /must be loopback/,
    ])
  }
  for (const [candidate, interfaces, message] of cases) {
    await assert.rejects(async () => {
      await assertHarnessOwnership(candidate, interfaces)
      await writeFile(sentinel, "unsafe write")
    }, message)
    assert.deepEqual(await snapshot(sentinel), before)
  }
})

test("watcher stop waits for an in-flight write and prevents subsequent ticks", async () => {
  let release
  let started
  const inFlight = new Promise(resolve => {
    started = resolve
  })
  const blocked = new Promise(resolve => {
    release = resolve
  })
  let writes = 0
  const stop = startWatcher(async () => {
    started()
    await blocked
    writes++
  }, 1)
  await inFlight
  let stopped = false
  const stopping = stop().then(() => {
    stopped = true
  })
  await delay(10)
  assert.equal(stopped, false, "stop must await the write already in flight")
  release()
  await stopping
  assert.equal(writes, 1)
  await delay(20)
  assert.equal(writes, 1, "no write may start after awaited stop")
})

test("child environment excludes ambient backend, credential, and loader configuration", () => {
  assert.deepEqual(
    cleanEnvironment({
      PATH: "/bin",
      PDPP_DB_PATH: "shared",
      E2E_BASE_URL: "live",
      NODE_OPTIONS: "--require evil",
      DATABASE_URL: "postgres://host",
      HTTP_PROXY: "live",
    }),
    { PATH: "/bin" }
  )
})

test("streamed diagnostics redact a password split between chunks and authentication headers", async () => {
  const lines = []
  const log = console.log
  console.log = line => lines.push(line)
  try {
    assert.equal(
      await runOwnedHarness(async ({ launch }) => {
        const child = launch(
          [
            "-e",
            'process.stdout.write("secret-"); setTimeout(() => { console.log("value"); console.log("Cookie: session-token"); console.error("Authorization: bearer-token") }, 10)',
          ],
          {
            extraEnv: { E2E_OWNER_PASSWORD: "secret-value" },
            output: true,
          }
        )
        return child.completion
      }),
      0
    )
  } finally {
    console.log = log
  }
  assert.ok(lines.includes("[redacted]"))
  assert.doesNotMatch(
    lines.join("\n"),
    /secret-value|session-token|bearer-token/
  )
})
