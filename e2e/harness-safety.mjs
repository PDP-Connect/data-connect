// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile, realpath } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { isAbsolute, join, relative } from "node:path"

export const MARKER = ".e2e-harness-owner"
export const TARGET_VARIABLES = [
  "E2E_BASE_URL",
  "E2E_DATA_DIR",
  "E2E_OWNER_PASSWORD",
  "E2E_REMOTE_BASE_URL",
  "E2E_BUFFERING_BASE_URL",
]

export function refuseExternalTargets(env) {
  const supplied = TARGET_VARIABLES.filter(name => env[name] !== undefined)
  if (supplied.length)
    throw new Error(
      `Refusing externally supplied ${supplied.join(", ")}. Unset these variables and run npm run test:e2e.`
    )
}

export function assertLoopbackOnly(interfaces = networkInterfaces()) {
  const entries = Object.entries(interfaces)
  if (
    !entries.length ||
    entries.some(
      ([name, addresses]) =>
        name !== "lo" ||
        !addresses?.length ||
        addresses.some(address => !address.internal)
    )
  ) {
    throw new Error(
      "E2E requires a private loopback-only network namespace; run npm run test:e2e."
    )
  }
}

export async function assertHarnessOwnership(
  env = process.env,
  interfaces = networkInterfaces()
) {
  assertLoopbackOnly(interfaces)
  if (
    [env.E2E_BASE_URL, env.E2E_REMOTE_BASE_URL, env.E2E_BUFFERING_BASE_URL]
      .filter(value => value !== undefined && value !== "")
      .some(
        value => !["127.0.0.1", "localhost"].includes(new URL(value).hostname)
      )
  ) {
    throw new Error("E2E_BASE_URL must be loopback")
  }
  if (
    !env.E2E_BASE_URL ||
    !env.E2E_HARNESS_ROOT ||
    !env.E2E_DATA_DIR ||
    !env.E2E_HARNESS_NONCE ||
    !env.E2E_OWNER_PASSWORD
  ) {
    throw new Error(
      "Missing disposable harness ownership; run npm run test:e2e"
    )
  }
  const root = await realpath(env.E2E_HARNESS_ROOT)
  const data = await realpath(env.E2E_DATA_DIR)
  const inside = relative(root, data)
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith("../") ||
    isAbsolute(inside)
  ) {
    throw new Error("E2E_DATA_DIR must resolve inside E2E_HARNESS_ROOT")
  }
  if ((await readFile(join(data, MARKER), "utf8")) !== env.E2E_HARNESS_NONCE) {
    throw new Error("E2E data directory ownership nonce does not match")
  }
}

/** Serialize ticks; stopping waits for the last write and prevents another tick. */
export function startWatcher(tick, intervalMs) {
  let stopped = false
  let timer
  let failure
  let pending
  const run = () => {
    pending = Promise.resolve()
      .then(tick)
      .catch(error => {
        failure = error
      })
      .finally(() => {
        if (!stopped && !failure) timer = setTimeout(run, intervalMs)
      })
  }
  run()
  return async () => {
    stopped = true
    clearTimeout(timer)
    await pending
    if (failure) throw failure
  }
}
