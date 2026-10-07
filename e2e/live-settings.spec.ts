// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live settings across tabs and devices, against a running console and
 * reference server.
 *
 *   E2E_BASE_URL=http://127.0.0.1:PORT \
 *   E2E_OWNER_PASSWORD=... \
 *   E2E_DATA_DIR=<the reference server's PDPP_DATA_DIR> \
 *   [E2E_REMOTE_BASE_URL=https://<tunnel to the same console>] \
 *   [E2E_BUFFERING_BASE_URL=https://<a proxy that buffers SSE>] \
 *   npm run test:e2e -- live-settings.spec.ts
 *
 * This file plays the desktop app's autostart watcher
 * (`src-tauri/src/unified.rs::spawn_autostart_watcher`): it rewrites
 * `autostart.json` every 250 ms (the real one: every 3 s, so this also
 * checks that identical rewrites do not look like changes) and applies a
 * request 2 s after it appears (the real one: within 3 s). Do not point
 * it at a data directory a real desktop app is also watching.
 *
 * With E2E_REMOTE_BASE_URL, tab B is a separate browser context on the
 * tunnel origin: a second device, not a second tab of the same browser.
 */
import { readFile, writeFile } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const REMOTE_BASE_URL = process.env.E2E_REMOTE_BASE_URL ?? ""
const BUFFERING_BASE_URL = process.env.E2E_BUFFERING_BASE_URL ?? ""
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""
const DATA_DIR = process.env.E2E_DATA_DIR ?? ""

const WATCHER_TICK_MS = 250
const WATCHER_APPLY_AFTER_MS = 2000

interface AutostartFile {
  appliedRequestId: number
  desiredEnabled: boolean
  enabled: boolean
  error: string | null
  requestId: number
}

/** Stand-in for the Tauri autostart watcher. Returns a stop function. */
function startFakeAutostartWatcher(dataDir: string): () => void {
  const path = join(dataDir, "autostart.json")
  const firstSeen = new Map<number, number>()
  const tick = async () => {
    let state: AutostartFile
    try {
      state = JSON.parse(await readFile(path, "utf8")) as AutostartFile
    } catch {
      state = { appliedRequestId: 0, desiredEnabled: false, enabled: false, error: null, requestId: 0 }
    }
    if (state.requestId > state.appliedRequestId) {
      const seen = firstSeen.get(state.requestId) ?? Date.now()
      firstSeen.set(state.requestId, seen)
      if (Date.now() - seen >= WATCHER_APPLY_AFTER_MS) {
        state = { ...state, appliedRequestId: state.requestId, enabled: state.desiredEnabled }
      }
    }
    // The real watcher rewrites the file on every tick, changed or not.
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }
  void tick()
  const timer = setInterval(() => void tick(), WATCHER_TICK_MS)
  return () => clearInterval(timer)
}

/**
 * A TCP relay in front of the console, so a test can cut every open
 * connection the way a network drop or server restart does.
 */
async function startRelay(target: URL): Promise<{ close: () => void; dropAll: () => void; origin: string }> {
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
    close: () => {
      dropAll()
      server.close()
    },
    dropAll,
    origin: `http://127.0.0.1:${port}`,
  }
}

async function newOwnerContext(browser: Browser, baseUrl: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: baseUrl,
    // ngrok's free edge shows an interstitial to browsers without this header.
    extraHTTPHeaders: { "ngrok-skip-browser-warning": "1" },
  })
  const page = await context.newPage()
  await page.goto(`${baseUrl}/owner/login?return_to=%2Fsettings`)
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD)
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/owner/login")), page.getByRole("button", { name: "Sign in" }).click()])
  await page.close()
  return context
}

async function openSettings(context: BrowserContext, baseUrl: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${baseUrl}/settings`)
  await expect(page.locator("#autostart-enabled")).toBeEnabled({ timeout: 20_000 })
  return page
}

function liveState(page: Page) {
  return page.locator("html")
}

async function setAutostartDirect(dataDir: string, enabled: boolean): Promise<void> {
  const state: AutostartFile = { appliedRequestId: 1, desiredEnabled: enabled, enabled, error: null, requestId: 1 }
  await writeFile(join(dataDir, "autostart.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

test.describe("live settings", () => {
  test.skip(!(OWNER_PASSWORD && DATA_DIR), "needs E2E_OWNER_PASSWORD and E2E_DATA_DIR")
  test.setTimeout(90_000)

  let stopWatcher: () => void = () => undefined
  test.beforeEach(async () => {
    await setAutostartDirect(DATA_DIR, false)
    stopWatcher = startFakeAutostartWatcher(DATA_DIR)
  })
  test.afterEach(() => stopWatcher())

  test("tab A toggles launch at login; tab B shows Applying… and then the applied value, without a reload", async ({
    browser,
  }) => {
    const contextA = await newOwnerContext(browser, BASE_URL)
    const remote = REMOTE_BASE_URL && REMOTE_BASE_URL !== BASE_URL
    const contextB = remote ? await newOwnerContext(browser, REMOTE_BASE_URL) : contextA
    const tabA = await openSettings(contextA, BASE_URL)
    const tabB = await openSettings(contextB, remote ? REMOTE_BASE_URL : BASE_URL)
    await expect(liveState(tabA)).toHaveAttribute("data-live-state", "live", { timeout: 15_000 })
    await expect(liveState(tabB)).toHaveAttribute("data-live-state", "live", { timeout: 15_000 })
    await expect(tabB.locator("#autostart-enabled")).not.toBeChecked()
    await tabB.evaluate(() => {
      ;(window as unknown as { __notReloaded: boolean }).__notReloaded = true
    })

    const clickedAt = Date.now()
    await tabA.locator("#autostart-enabled").click()

    await expect(tabB.getByTestId("autostart-applying")).toBeVisible({ timeout: 1500 })
    const applyingAt = Date.now()
    await expect(tabB.locator("#autostart-enabled")).toBeChecked({ timeout: 6000 })
    await expect(tabB.getByTestId("autostart-applying")).toBeHidden()
    const appliedAt = Date.now()
    await expect(tabA.locator("#autostart-enabled")).toBeChecked()
    expect(await tabB.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true)
    await expect(tabB.getByTestId("live-status-strip")).toHaveCount(0)

    test.info().annotations.push({
      description: `tab B (${remote ? "remote over tunnel" : "same browser"}): Applying… after ${applyingAt - clickedAt} ms, applied after ${appliedAt - clickedAt} ms`,
      type: "timing",
    })
    await contextA.close()
    if (remote) await contextB.close()
  })

  test("when the channel drops, the page says it is not live and refreshes on focus instead", async ({ browser }) => {
    test.skip(!new URL(BASE_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/), "the relay needs a loopback console")
    const relay = await startRelay(new URL(BASE_URL))
    const context = await newOwnerContext(browser, relay.origin)
    const tab = await openSettings(context, relay.origin)
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "live", { timeout: 15_000 })
    await expect(tab.getByTestId("live-status-strip")).toHaveCount(0)
    await expect(tab.getByTestId("live-read-at")).toHaveCount(0)

    // Cut the open stream, and make every reattach fail until unrouted.
    await tab.route("**/_ref/owner-live/**", route => route.abort())
    relay.dropAll()
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "paused", { timeout: 2000 })

    const strip = tab.getByTestId("live-status-strip")
    await expect(strip).toBeVisible()
    await expect(strip).toHaveText(
      /^Live updates paused\. Settings on this page were last read at .+\. Reconnecting…$/
    )
    await expect(tab.getByTestId("live-read-at").first()).toHaveText(/^Read at .+/)

    // A change elsewhere does not arrive while paused, and the page does not
    // pretend otherwise: the value stays as read, the strip stays up.
    await setAutostartDirect(DATA_DIR, true)
    await tab.waitForTimeout(2500)
    await expect(tab.locator("#autostart-enabled")).not.toBeChecked()
    await expect(strip).toBeVisible()

    // Returning to the tab refetches (TanStack refetch-on-focus).
    await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })))
    await expect(tab.locator("#autostart-enabled")).toBeChecked({ timeout: 5000 })
    await expect(strip).toBeVisible()

    // Once the channel can attach again, the page is live and the strip goes.
    await tab.unroute("**/_ref/owner-live/**")
    await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })))
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "live", { timeout: 10_000 })
    await expect(strip).toHaveCount(0)
    await context.close()
    relay.close()
  })

  test("over a proxy that buffers the stream, the page says live updates are not supported", async ({ browser }) => {
    test.skip(!BUFFERING_BASE_URL, "needs E2E_BUFFERING_BASE_URL, e.g. a Cloudflare Quick Tunnel")
    const context = await newOwnerContext(browser, BUFFERING_BASE_URL)
    const tab = await openSettings(context, BUFFERING_BASE_URL)
    const strip = tab.getByTestId("live-status-strip")
    await expect(strip).toHaveText(
      "This connection does not support live updates. Values refresh when you return to this tab.",
      { timeout: 20_000 }
    )
    await expect(liveState(tab)).toHaveAttribute("data-live-state", "unsupported")
    await context.close()
  })
})
