// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import {
  assertLoopbackOnly,
  MARKER,
  refuseExternalTargets,
} from "./harness-safety.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..")
const require = createRequire(import.meta.url)

export function cleanEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      [
        "PATH",
        "LANG",
        "LC_ALL",
        "TEST_TMPDIR",
        "PLAYWRIGHT_BROWSERS_PATH",
      ].includes(name)
    )
  )
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const { port } = server.address()
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

export async function stopProcess(child) {
  if (!child.pid) return
  const kill = signal => {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  kill("SIGTERM")
  const deadline = Date.now() + 3000
  while (groupExists(child.pid) && Date.now() < deadline) await delay(50)
  if (groupExists(child.pid)) kill("SIGKILL")
  await child.completion
  const killedDeadline = Date.now() + 3000
  while (groupExists(child.pid) && Date.now() < killedDeadline) await delay(50)
  if (groupExists(child.pid))
    throw new Error(`E2E process group ${child.pid} did not exit`)
}

/** Own all mutable state and process groups, including partial startup failures. */
export async function runOwnedHarness(
  start,
  { timeoutMs = 600_000, onState = () => {} } = {}
) {
  const controller = new AbortController()
  const owned = []
  let root
  let failure
  let work
  let exitCode = 1
  const interrupt = signal => {
    exitCode = signal === "SIGINT" ? 130 : 143
    controller.abort(new Error(`E2E interrupted by ${signal}`))
  }
  const sigint = () => interrupt("SIGINT")
  const sigterm = () => interrupt("SIGTERM")
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)
  const timeout = setTimeout(
    () => controller.abort(new Error("E2E harness timed out")),
    timeoutMs
  )
  const aborted = new Promise((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true }
    )
  )
  try {
    root = await mkdtemp(
      join(process.env.TEST_TMPDIR || tmpdir(), "dataconnect-e2e-")
    )
    const env = {
      ...cleanEnvironment(),
      HOME: root,
      TMPDIR: root,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        join(homedir(), ".cache/ms-playwright"),
    }
    const launch = (
      args,
      { cwd = repo, extraEnv = {}, output = false } = {}
    ) => {
      controller.signal.throwIfAborted()
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...env, ...extraEnv },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.completion = new Promise((resolveExit, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) =>
          resolveExit(
            code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
          )
        )
      })
      // Keep rejection observed even if a later startup step fails first.
      child.completion.catch(() => {})
      let tail = ""
      const secrets = [
        extraEnv.PDPP_OWNER_PASSWORD,
        extraEnv.E2E_OWNER_PASSWORD,
      ].filter(Boolean)
      const redact = line => {
        for (const secret of secrets)
          line = line.replaceAll(secret, "[redacted]")
        return /cookie|authorization/i.test(line)
          ? "[redacted authentication log]"
          : line
      }
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", chunk => {
          tail = (tail + chunk).slice(-16_384)
        })
        if (output)
          createInterface({ input: stream, crlfDelay: Infinity }).on(
            "line",
            line => console.log(redact(line))
          )
      }
      child.diagnostic = () =>
        tail.split("\n").map(redact).slice(-12).join("\n")
      owned.push(child)
      onState({ root, pid: child.pid })
      return child
    }
    onState({ root })
    work = Promise.resolve(
      start({ root, launch, signal: controller.signal, env })
    )
    exitCode = await Promise.race([work, aborted])
  } catch (error) {
    failure = error
  } finally {
    controller.abort(new Error("E2E teardown"))
    clearTimeout(timeout)
    const results = await Promise.allSettled(owned.reverse().map(stopProcess))
    // Readiness observes abort; a test process completes once its group exits.
    if (work) await Promise.race([work.catch(() => {}), delay(1000)])
    const cleanupErrors = results
      .filter(result => result.status === "rejected")
      .map(result => result.reason)
    try {
      if (root)
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
    } catch (error) {
      cleanupErrors.push(error)
    }
    for (const error of cleanupErrors)
      console.error(`E2E cleanup failed: ${error.message}`)
    if (cleanupErrors.length && exitCode === 0) exitCode = 1
    process.off("SIGINT", sigint)
    process.off("SIGTERM", sigterm)
  }
  if (failure) throw failure
  return exitCode
}

async function waitReady(url, child, signal) {
  const started = performance.now()
  for (;;) {
    signal.throwIfAborted()
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited during startup\n${child.diagnostic()}`)
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 400)
        return ((performance.now() - started) / 1000).toFixed(2)
    } catch (error) {
      if (signal.aborted) throw error
    }
    if (performance.now() - started > 120_000)
      throw new Error(`Server readiness timed out\n${child.diagnostic()}`)
    await delay(200, undefined, { signal })
  }
}

async function startStack({ root, launch, signal }, args) {
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
  ]) {
    if (existsSync(join(repo, "apps/console", name))) {
      throw new Error(
        `Refusing console environment file apps/console/${name}; use a clean checkout for npm run test:e2e.`
      )
    }
  }
  const data = join(root, "data")
  await mkdir(data)
  const nonce = randomBytes(24).toString("hex")
  const password = randomBytes(32).toString("hex")
  await writeFile(join(data, MARKER), nonce, { mode: 0o600 })
  const ports = new Set()
  while (ports.size < 3) ports.add(await freePort())
  const [asPort, rsPort, consolePort] = [...ports]
  const origin = `http://127.0.0.1:${consolePort}`
  const shared = {
    PDPP_DATA_DIR: data,
    PDPP_MANAGED_DESKTOP_HOST: "1",
    PDPP_DB_PATH: join(data, "e2e.sqlite"),
    PDPP_OWNER_PASSWORD: password,
    PDPP_REFERENCE_MODE: "composed",
    PDPP_REFERENCE_ORIGIN: origin,
    PDPP_AS_URL: `http://127.0.0.1:${asPort}`,
    PDPP_RS_URL: `http://127.0.0.1:${rsPort}`,
    PDPP_BIND_HOST: "127.0.0.1",
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
    PDPP_SEMANTIC_EMBEDDING_BACKEND: "stub",
    AS_PORT: String(asPort),
    RS_PORT: String(rsPort),
  }
  const reference = launch(["--import", "tsx", "server/index.ts"], {
    cwd: join(repo, "reference-implementation"),
    extraEnv: shared,
  })
  console.log(
    `Reference startup: ${await waitReady(`${shared.PDPP_AS_URL}/.well-known/oauth-authorization-server`, reference, signal)}s`
  )
  const web = launch(
    [
      join(repo, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(consolePort),
    ],
    {
      cwd: join(repo, "apps/console"),
      extraEnv: {
        ...shared,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "development",
      },
    }
  )
  console.log(
    `Console startup (next dev --webpack): ${await waitReady(`${origin}/owner/login`, web, signal)}s`
  )
  const browser = launch(
    [require.resolve("@playwright/test/cli"), "test", ...args],
    {
      cwd: here,
      output: true,
      extraEnv: {
        E2E_BASE_URL: origin,
        E2E_DATA_DIR: data,
        E2E_OWNER_PASSWORD: password,
        E2E_HARNESS_ROOT: root,
        E2E_HARNESS_NONCE: nonce,
      },
    }
  )
  const code = await browser.completion
  if (code !== 0) {
    console.error(`Console diagnostics:\n${web.diagnostic()}`)
    console.error(`Reference diagnostics:\n${reference.diagnostic()}`)
  }
  return code
}

// Use the pipe so bwrap stays alive while the inner finally removes scratch.
export function receiveSignals() {
  let buffer = ""
  const receive = chunk => {
    buffer += chunk
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n")
      const signal = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal)
    }
  }
  process.stdin.on("data", receive)
  return () => {
    process.stdin.off("data", receive)
    process.stdin.pause()
  }
}

export async function runInNamespace(args) {
  // Detached browser helpers can outlive the process group that launched them.
  // Remove their state after the PID namespace has reaped every descendant.
  const namespaceRoot = await mkdtemp(
    join(process.env.TEST_TMPDIR || tmpdir(), "dataconnect-e2e-namespace-")
  )
  const sandbox = join(repo, "scripts/test-sandbox/test-sandbox")
  const command = existsSync(sandbox) ? sandbox : "bwrap"
  const prefix = existsSync(sandbox)
    ? ["--net", "none", "--"]
    : [
        "--dev-bind",
        "/",
        "/",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--tmpfs",
        "/tmp",
        "--",
      ]
  const child = spawn(command, [...prefix, process.execPath, ...args], {
    detached: true,
    env: { ...process.env, TEST_TMPDIR: namespaceRoot },
    stdio: ["pipe", "inherit", "inherit"],
  })
  child.stdin.on("error", () => {})
  let signalDeadline
  let requestedSignal
  const forward = signal => {
    requestedSignal ||= signal
    child.stdin.write(`${signal}\n`)
    signalDeadline ||= setTimeout(() => child.kill("SIGKILL"), 20_000)
  }
  const forwardInt = () => forward("SIGINT")
  const forwardTerm = () => forward("SIGTERM")
  process.on("SIGINT", forwardInt)
  process.on("SIGTERM", forwardTerm)
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", () =>
        reject(
          new Error(
            "Cannot create private E2E namespace: install bwrap or scripts/test-sandbox/test-sandbox. No servers started."
          )
        )
      )
      child.once("close", (code, signal) =>
        resolveExit(
          requestedSignal === "SIGINT"
            ? 130
            : requestedSignal === "SIGTERM"
              ? 143
              : (code ??
                (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1))
        )
      )
    })
  } finally {
    clearTimeout(signalDeadline)
    process.off("SIGINT", forwardInt)
    process.off("SIGTERM", forwardTerm)
    await rm(namespaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
}

async function main() {
  // Refuse targets before namespace setup, process launch, or filesystem writes.
  refuseExternalTargets(process.env)
  const args = process.argv.slice(2)
  if (args[0] === "--isolated") {
    assertLoopbackOnly()
    const stopReceiving = receiveSignals()
    try {
      return await runOwnedHarness(state => startStack(state, args.slice(1)))
    } finally {
      stopReceiving()
    }
  }
  return runInNamespace([fileURLToPath(import.meta.url), "--isolated", ...args])
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then(code => {
      process.exitCode = code
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = /SIGINT/.test(error.message)
        ? 130
        : /SIGTERM/.test(error.message)
          ? 143
          : 1
    })
}
