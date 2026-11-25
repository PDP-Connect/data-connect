// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test"
import { readFile, readdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { assertHarnessOwnership } from "./harness-safety.mjs"

export const BASE_URL = process.env.E2E_BASE_URL!

export async function loginAsOwner(page: Page): Promise<void> {
  const password = process.env.E2E_OWNER_PASSWORD
  if (!password)
    throw new Error("E2E_OWNER_PASSWORD is missing; use e2e/harness.mjs")
  await page.goto(`${BASE_URL}/owner/login?return_to=%2F`)
  await page.getByLabel("Owner password").fill(password)
  const [response] = await Promise.all([
    page.waitForResponse(
      res =>
        res.url().includes("/owner/login") && res.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  expect(response.status(), "owner sign-in must succeed").toBeLessThan(400)
  await page.waitForLoadState("networkidle")
}

/** Read-only readiness check against this harness's own disposable stack. */
export async function doctor(page: Page): Promise<void> {
  await assertHarnessOwnership()
  await assertOwnedServices()
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/sources`, { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible()
  const visible = await page.locator("main").innerText()
  expect(visible.trim(), "the Sources page must render owner content").not.toBe(
    ""
  )
  expect(visible, "the reference services must be reachable").not.toContain(
    "Service unavailable"
  )
}

async function assertOwnedServices(): Promise<void> {
  const consolePort = new URL(BASE_URL).port
  let consoleProcess = false
  let referenceProcess = false
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const args = (await readFile(`/proc/${entry.name}/cmdline`, "utf8"))
        .split("\0")
        .filter(Boolean)
      if (args.includes("server/index.ts")) referenceProcess = true
      if (
        args.some(arg => arg.endsWith("node_modules/next/dist/bin/next")) &&
        args.includes("start") &&
        args.includes(consolePort)
      ) {
        consoleProcess = true
      }
      if (args.some(arg => arg.startsWith("next-server ("))) {
        const environment = await readFile(
          `/proc/${entry.name}/environ`,
          "utf8"
        )
        if (
          environment.split("\0").includes(`PDPP_REFERENCE_ORIGIN=${BASE_URL}`)
        )
          consoleProcess = true
      }
    } catch {
      // The short-lived browser/helper process may exit between listing and read.
    }
  }
  expect(
    referenceProcess,
    "the harness PID namespace must contain its reference server"
  ).toBeTruthy()
  expect(
    consoleProcess,
    `the console port ${consolePort} must belong to this harness's next start process`
  ).toBeTruthy()
}

async function referenceEndpoints(): Promise<{ asUrl: string; rsUrl: string }> {
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const args = await readFile(`/proc/${entry.name}/cmdline`, "utf8")
      if (!args.includes("server/index.ts")) continue
      const environment = Object.fromEntries(
        (await readFile(`/proc/${entry.name}/environ`, "utf8"))
          .split("\0")
          .filter(Boolean)
          .map(value => {
            const separator = value.indexOf("=")
            return [value.slice(0, separator), value.slice(separator + 1)]
          })
      )
      const asUrl = environment.PDPP_AS_URL
      const rsUrl = environment.PDPP_RS_URL
      if (!asUrl || !rsUrl) continue
      for (const value of [asUrl, rsUrl]) {
        const url = new URL(value)
        if (url.hostname !== "127.0.0.1") {
          throw new Error(
            `Harness reference endpoint is not loopback: ${url.hostname}`
          )
        }
      }
      return { asUrl, rsUrl }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Harness reference endpoint")
      )
        throw error
    }
  }
  throw new Error(
    "Could not find the disposable reference server inside the harness PID namespace"
  )
}

/** Approve the real device flow in the owner browser, then run the seed connector. */
export async function seedConnector(
  page: Page,
  connector: string
): Promise<void> {
  const deviceResponse = await page.request.post(
    `${BASE_URL}/oauth/device_authorization`,
    {
      form: { client_id: "dataconnect-console" },
    }
  )
  expect(
    deviceResponse.ok(),
    "owner device authorization request must succeed"
  ).toBeTruthy()
  const device = await deviceResponse.json()
  await page.goto(
    `${BASE_URL}/device?user_code=${encodeURIComponent(device.user_code)}`
  )
  await page
    .getByRole("button", { name: "Approve and issue owner token" })
    .click()
  await expect(page.getByText("CLI access approved")).toBeVisible()

  const tokenResponse = await page.request.post(`${BASE_URL}/oauth/token`, {
    form: {
      client_id: "dataconnect-console",
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  })
  expect(
    tokenResponse.ok(),
    "approved owner device flow must issue a token"
  ).toBeTruthy()
  const { access_token: ownerToken } = await tokenResponse.json()
  const { asUrl, rsUrl } = await referenceEndpoints()
  const dataDir = process.env.E2E_DATA_DIR
  if (!dataDir) throw new Error("E2E_DATA_DIR is missing; use e2e/harness.mjs")

  const helper = new URL("./seed-fixture.mjs", import.meta.url)
  const child = spawn(
    process.execPath,
    ["--import", "tsx", helper.pathname, connector],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        PDPP_AS_URL: asUrl,
        PDPP_RS_URL: rsUrl,
        PDPP_DB_PATH: join(dataDir, "e2e.sqlite"),
        PDPP_OWNER_TOKEN: ownerToken,
        PDPP_RUNTIME_QUIET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", chunk => {
    stderr += chunk
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  expect(exitCode, `seed connector failed: ${stderr.trim()}`).toBe(0)
  expect(stdout, "seed connector must report real fixture records").toMatch(
    /Seeded .+: [1-9]\d* records/
  )
  console.log(`[capture] ${stdout.trim()}`)
}
