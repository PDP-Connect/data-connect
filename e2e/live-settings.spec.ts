// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Live settings on a disposable console. Run npm run test:e2e.
 * The harness owns the data directory, servers, and network namespace.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test as base,
} from "@playwright/test"

import { assertHarnessOwnership, startWatcher } from "./harness-safety.mjs"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const REMOTE_BASE_URL = process.env.E2E_REMOTE_BASE_URL ?? ""
const BUFFERING_BASE_URL = process.env.E2E_BUFFERING_BASE_URL ?? ""
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""
const DATA_DIR = process.env.E2E_DATA_DIR ?? ""

const WATCHER_TICK_MS = 250
const WATCHER_APPLY_AFTER_MS = 2000

interface AutostartCommand {
  commandId: string
  kind: "set_autostart_enabled"
  desiredEnabled: boolean
  createdAt: string
}

async function writeJson(path: string, value: object): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8")
  await rename(temporary, path)
}

/** Stand-in for the desktop's command/result autostart watcher. */
function startFakeAutostartWatcher(dataDir: string): () => Promise<void> {
  const firstSeen = new Map<string, number>()
  return startWatcher(async () => {
    const directory = join(dataDir, "autostart-commands")
    const commands: AutostartCommand[] = []
    for (const name of await readdir(directory)) {
      if (/^ast_[A-Za-z0-9_-]{22}\.json$/.test(name)) {
        commands.push(JSON.parse(await readFile(join(directory, name), "utf8")))
      }
    }
    commands.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const command of commands) {
      const resultPath = join(
        dataDir,
        "autostart-results",
        `${command.commandId}.json`
      )
      try {
        await readFile(resultPath)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const seen = firstSeen.get(command.commandId) ?? Date.now()
      firstSeen.set(command.commandId, seen)
      if (Date.now() - seen < WATCHER_APPLY_AFTER_MS) continue
      await setAutostartDirect(dataDir, command.desiredEnabled)
      await writeJson(resultPath, {
        ...command,
        status: "succeeded",
        enabled: command.desiredEnabled,
        error: null,
      })
    }
    // Identical rewrites must not be published as a setting change.
    const path = join(dataDir, "autostart-state.json")
    await writeJson(path, JSON.parse(await readFile(path, "utf8")))
  }, WATCHER_TICK_MS)
}

/**
 * A TCP relay in front of the console, so a test can cut every open
 * connection the way a network drop or server restart does.
 */
async function startRelay(target: URL): Promise<{
  close: () => Promise<void>
  dropAll: () => void
  origin: string
}> {
  const sockets = new Set<Socket>()
  const server = createServer(client => {
    const upstream = connect(Number(target.port), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => socket.destroy())
    }
    client.pipe(upstream).pipe(client)
    client.on("close", () => upstream.destroy())
    upstream.on("close", () => client.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const dropAll = () => {
    for (const socket of sockets) socket.destroy()
  }
  return {
    close: async () => {
      dropAll()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
    dropAll,
    origin: `http://127.0.0.1:${port}`,
  }
}

async function newOwnerContext(
  browser: Browser,
  baseUrl: string,
  track: (context: BrowserContext) => void
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: baseUrl,
    // ngrok's free edge shows an interstitial to browsers without this header.
    extraHTTPHeaders: { "ngrok-skip-browser-warning": "1" },
  })
  track(context)
  const page = await context.newPage()
  await page.goto(`${baseUrl}/owner/login?return_to=%2Fsettings`)
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD)
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith("/owner/login")),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  await page.close()
  return context
}

async function openSettings(
  context: BrowserContext,
  baseUrl: string
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${baseUrl}/settings`)
  await expect(page.locator("#autostart-enabled")).toBeEnabled({
    timeout: 20_000,
  })
  return page
}

function liveState(page: Page) {
  return page.locator("html")
}

async function setAutostartDirect(
  dataDir: string,
  enabled: boolean
): Promise<void> {
  await writeJson(join(dataDir, "autostart-state.json"), {
    enabled,
    error: null,
    observedAt: new Date().toISOString(),
    revision: randomUUID(),
  })
}

const test = base.extend<{
  ownerContext: (baseUrl: string) => Promise<BrowserContext>
  relay: Awaited<ReturnType<typeof startRelay>>
}>({
  ownerContext: async ({ browser }, provide) => {
    const contexts: BrowserContext[] = []
    try {
      await provide(baseUrl =>
        newOwnerContext(browser, baseUrl, context => contexts.push(context))
      )
    } finally {
      await Promise.all(contexts.map(context => context.close()))
    }
  },
  relay: async ({ baseURL }, provide) => {
    const relay = await startRelay(new URL(baseURL ?? BASE_URL))
    try {
      await provide(relay)
    } finally {
      await relay.close()
    }
  },
})

test.describe("live settings", () => {
  test.skip(
    process.env.E2E_OWNER_PASSWORD === undefined &&
      process.env.E2E_DATA_DIR === undefined,
    "Run npm run test:e2e for a disposable console"
  )
  test.beforeAll(async () => {
    await assertHarnessOwnership()
  })
  test.setTimeout(90_000)

  let stopWatcher: () => Promise<void> = async () => undefined
  test.beforeEach(async () => {
    await assertHarnessOwnership()
    for (const directory of ["autostart-commands", "autostart-results"]) {
      await mkdir(join(DATA_DIR, directory), { recursive: true })
    }
    await setAutostartDirect(DATA_DIR, false)
    stopWatcher = startFakeAutostartWatcher(DATA_DIR)
  })
  test.afterEach(async () => {
    try {
      await stopWatcher()
    } finally {
      stopWatcher = async () => undefined
    }
  })

  test("tab A toggles launch at login; tab B shows Applying… and then the applied value, without a reload", async ({
    ownerContext,
  }) => {
    const contextA = await ownerContext(BASE_URL)
    const remote = REMOTE_BASE_URL && REMOTE_BASE_URL !== BASE_URL
    const contextB = remote ? await ownerContext(REMOTE_BASE_URL) : contextA
    const tabA = await openSettings(contextA, BASE_URL)
    const tabB = await openSettings(
      contextB,
      remote ? REMOTE_BASE_URL : BASE_URL
    )
    await expect(liveState(tabA)).toHaveAttribute("data-live-state", "live", {
      timeout: 15_000,
    })
    await expect(liveState(tabB)).toHaveAttribute("data-live-state", "live", {
      timeout: 15_000,
    })
    await expect(tabB.locator("#autostart-enabled")).not.toBeChecked()
    await tabB.evaluate(() => {
      ;(window as unknown as { __notReloaded: boolean }).__notReloaded = true
    })

    const clickedAt = Date.now()
    await tabA.locator("#autostart-enabled").click()

    await expect(tabB.getByTestId("autostart-applying")).toBeVisible({
      timeout: 1500,
    })
    const applyingAt = Date.now()
    await expect(tabB.locator("#autostart-enabled")).toBeChecked({
      timeout: 6000,
    })
    await expect(tabB.getByTestId("autostart-applying")).toBeHidden()
    const appliedAt = Date.now()
    await expect(tabA.locator("#autostart-enabled")).toBeChecked()
    expect(
      await tabB.evaluate(
        () => (window as unknown as { __notReloaded?: boolean }).__notReloaded
      )
    ).toBe(true)
    await expect(tabB.getByTestId("live-status-strip")).toHaveCount(0)

    test.info().annotations.push({
      description: `tab B (${remote ? "remote over tunnel" : "same browser"}): Applying… after ${applyingAt - clickedAt} ms, applied after ${appliedAt - clickedAt} ms`,
      type: "timing",
    })
  })

  test("when the channel drops, the page says it is not live and refreshes on focus instead", async ({
    ownerContext,
    relay,
  }) => {
    test.skip(
      !new URL(BASE_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/),
      "the relay needs a loopback console"
    )
    const context = await ownerContext(relay.origin)
    const tab = await openSettings(context, relay.origin)
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "live", {
      timeout: 15_000,
    })
    await expect(tab.getByTestId("live-status-strip")).toHaveCount(0)
    await expect(tab.getByTestId("live-read-at")).toHaveCount(0)

    // Cut the open stream, and make every reattach fail until unrouted.
    await tab.route("**/_ref/owner-live/**", route => route.abort())
    relay.dropAll()
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "paused", {
      timeout: 2000,
    })

    const strip = tab.getByTestId("live-status-strip")
    await expect(strip).toBeVisible()
    await expect(strip).toHaveText(
      /^Live updates paused\. Settings on this page were last read at .+\. Reconnecting…$/
    )
    await expect(tab.getByTestId("live-read-at").first()).toHaveText(
      /^Read at .+/
    )

    // A change elsewhere does not arrive while paused, and the page does not
    // pretend otherwise: the value stays as read, the strip stays up.
    // Drain the stand-in before changing its observation from outside the watcher.
    await stopWatcher()
    await setAutostartDirect(DATA_DIR, true)
    stopWatcher = startFakeAutostartWatcher(DATA_DIR)
    await tab.waitForTimeout(2500)
    await expect(tab.locator("#autostart-enabled")).not.toBeChecked()
    await expect(strip).toBeVisible()

    // Returning to the tab refetches (TanStack refetch-on-focus).
    await tab.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    )
    await expect(tab.locator("#autostart-enabled")).toBeChecked({
      timeout: 5000,
    })
    await expect(strip).toBeVisible()

    // Once the channel can attach again, the page is live and the strip goes.
    await tab.unroute("**/_ref/owner-live/**")
    await tab.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    )
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "live", {
      timeout: 10_000,
    })
    await expect(strip).toHaveCount(0)
  })

  test("over a proxy that buffers the stream, the page says live updates are not supported", async ({
    ownerContext,
  }) => {
    test.skip(
      !BUFFERING_BASE_URL,
      "needs E2E_BUFFERING_BASE_URL, e.g. a Cloudflare Quick Tunnel"
    )
    const context = await ownerContext(BUFFERING_BASE_URL)
    const tab = await openSettings(context, BUFFERING_BASE_URL)
    const strip = tab.getByTestId("live-status-strip")
    await expect(strip).toHaveText(
      "This connection does not support live updates. Values refresh when you return to this tab.",
      { timeout: 20_000 }
    )
    await expect(liveState(tab)).toHaveAttribute(
      "data-live-state",
      "unsupported"
    )
  })
})
