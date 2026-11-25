// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Photograph the shared look: every baseline route at desktop and phone width,
// light and dark, plus the opened phone drawer, jump dialog and a popover.
// Each picture also gets an in-page audit (contrast, capitals, monospace,
// square bordered boxes, clipped text, sideways scroll) in look-audit.json.
//
//   node e2e/harness.mjs look.spec.ts --harness-minutes=40 --output <dir>  (production build)
//   node e2e/harness.mjs look.spec.ts --console-dev --output <dir>          (?demo= routes need next dev)
import { test, type Page } from "@playwright/test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BASE_URL,
  doctor,
  resolveBaselineRoutes,
  seedConnector,
} from "./capture-support.ts"
import { auditLook } from "./look-audit.ts"

const harnessRoot = process.env.E2E_HARNESS_ROOT
if (!harnessRoot)
  throw new Error("E2E_HARNESS_ROOT is missing; use e2e/harness.mjs")
const evidenceRoot = join(dirname(dirname(harnessRoot)), "evidence")
const viewports = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
} as const
const themes = ["light", "dark"] as const
type Theme = (typeof themes)[number]
type Label = keyof typeof viewports

interface Route {
  id: string
  path: string
  readyText?: string
  skipReason?: string
}

async function paint(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })
  await page
    .waitForFunction(
      t => document.documentElement.getAttribute("data-theme") === t,
      theme,
      { timeout: 3_000 }
    )
    .catch(() => {})
  await page.waitForTimeout(150)
}

class Album {
  readonly audits: unknown[] = []
  readonly notes: string[] = []
  constructor(readonly target: string) {}

  async shoot(
    page: Page,
    name: string,
    fullPage: boolean,
    meta: Record<string, unknown> = {}
  ) {
    const file = `${name}.png`
    await page
      .screenshot({ path: join(this.target, file), fullPage, timeout: 20_000 })
      .catch(error => this.notes.push(`${file}: screenshot failed ${error}`))
    const audit = await page
      .evaluate(auditLook)
      .catch(error => ({ error: String(error) }))
    this.audits.push({ file, ...meta, ...audit })
  }

  async save() {
    await writeFile(
      join(this.target, "look-audit.json"),
      `${JSON.stringify({ notes: this.notes, audits: this.audits }, null, 2)}\n`,
      { mode: 0o600 }
    )
  }
}

async function open(page: Page, route: Route, album: Album): Promise<boolean> {
  await paint(page, "light")
  await page.setViewportSize(viewports.desktop)
  try {
    await page.goto(`${BASE_URL}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
  } catch (error) {
    album.notes.push(`${route.id}: navigation failed ${error}`)
  }
  if (route.readyText)
    await page
      .getByText(route.readyText, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => album.notes.push(`${route.id}: readyText not seen`))
  // Record whether the page settles; the baseline showed loading bars on some pages.
  return page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .then(() => true)
    .catch(() => false)
}

// The frame pins itself to the viewport and scrolls `.rr-content`, so a
// full-page screenshot would stop at the first screen. Let the document grow
// for the picture only; the audit runs on the same unpinned layout.
const UNPIN_FRAME = `
html:has(.rr-app) { overflow: visible !important; }
.rr-app { height: auto !important; min-height: 100dvh; overflow: visible !important; }
.rr-content { overflow-y: visible !important; }
`

async function shootRoute(page: Page, route: Route, album: Album) {
  const settled = await open(page, route, album)
  await page.addStyleTag({ content: UNPIN_FRAME }).catch(() => {})
  for (const theme of themes) {
    await paint(page, theme)
    for (const label of Object.keys(viewports) as Label[]) {
      await page.setViewportSize(viewports[label])
      await page.waitForTimeout(250)
      await album.shoot(page, `${route.id}--${label}--${theme}`, true, {
        route: route.path,
        networkIdle: settled,
      })
    }
  }
}

async function shootOverlay(
  page: Page,
  name: string,
  path: string,
  label: Label,
  openOverlay: () => Promise<void>,
  album: Album
) {
  for (const theme of themes) {
    await paint(page, theme)
    await page.setViewportSize(viewports[label])
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
    try {
      await openOverlay()
      await page.waitForTimeout(450)
      await album.shoot(page, `${name}--${label}--${theme}`, false, {
        overlay: name,
        route: path,
      })
    } catch (error) {
      album.notes.push(`${name}--${label}--${theme}: could not open ${error}`)
    }
  }
}

async function openJump(page: Page, label: Label) {
  if (label === "phone") {
    await page.getByRole("button", { name: "Open navigation" }).click({ timeout: 5_000 })
    await page
      .getByRole("dialog", { name: "Primary navigation" })
      .getByRole("button", { name: "Search or jump to commands" })
      .click({ timeout: 5_000 })
  } else {
    await page
      .getByRole("button", { name: "Search or jump to commands" })
      .first()
      .click({ timeout: 5_000 })
  }
  await page
    .locator('[role="dialog"] input')
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
}

const consoleMode = process.env.E2E_CONSOLE_MODE

test("look: every baseline route in both themes", async ({ page }) => {
  test.skip(consoleMode === "dev", "routes are photographed on the production build")
  test.setTimeout(40 * 60 * 1000)
  const album = new Album(join(evidenceRoot, "after-look"))
  await mkdir(album.target, { recursive: true, mode: 0o700 })
  const routes = JSON.parse(
    await readFile(
      fileURLToPath(new URL("./baseline-routes.json", import.meta.url)),
      "utf8"
    )
  ) as Route[]

  await shootRoute(page, { id: "owner-login", path: "/owner/login" }, album)
  await doctor(page)
  for (const connector of ["spotify", "github", "reddit"])
    await seedConnector(page, connector)
  for (const path of ["/sources", "/connect/static-secret/spotify", "/connect", "/settings"]) {
    const slug = path.split("/").filter(Boolean).join("-")
    await shootOverlay(page, `overlay-drawer-${slug}`, path, "phone", async () => {
      await page.getByRole("button", { name: "Open navigation" }).click({ timeout: 5_000 })
      await page
        .getByRole("dialog", { name: "Primary navigation" })
        .waitFor({ state: "visible", timeout: 5_000 })
    }, album)
  }
  for (const label of Object.keys(viewports) as Label[])
    await shootOverlay(page, "overlay-jump", "/", label, () => openJump(page, label), album)

  await page.goto(`${BASE_URL}/sources`, { waitUntil: "domcontentloaded" })
  const sourceHref = await page
    .locator('a[href^="/sources/cin_"]')
    .filter({ hasText: /spotify/i })
    .first()
    .getAttribute("href")
  for (const label of Object.keys(viewports) as Label[])
    await shootOverlay(page, "overlay-columns-popover", `${sourceHref}/top_artists`, label, async () => {
      await page.getByRole("button", { name: /^Columns/ }).first().click({ timeout: 5_000 })
      await page
        .getByText("Displayed columns")
        .waitFor({ state: "visible", timeout: 5_000 })
    }, album)
  await album.save()
  for (const route of await resolveBaselineRoutes(page, routes)) {
    if (route.skipReason) continue
    console.log(`[look] ${route.path}`)
    await shootRoute(page, route, album)
    await album.save()
  }

  await album.save()
  console.log(`[look] evidence: ${album.target}`)
})

test("look: demo routes (needs --console-dev)", async ({ page }) => {
  test.skip(consoleMode !== "dev", "?demo= routes render only under next dev")
  test.setTimeout(15 * 60 * 1000)
  const album = new Album(join(evidenceRoot, "after-look-demo"))
  await mkdir(album.target, { recursive: true, mode: 0o700 })
  await doctor(page)
  const demos: Route[] = [
    { id: "home-demo-calm", path: "/?demo=calm" },
    { id: "home-demo-alarm", path: "/?demo=alarm" },
    { id: "home-demo-decide", path: "/?demo=decide" },
    { id: "sources-demo-mixed", path: "/sources?demo=mixed" },
    { id: "sources-demo-healthy", path: "/sources?demo=healthy" },
    { id: "sources-demo-attention", path: "/sources?demo=attention" },
  ]
  for (const route of demos) {
    console.log(`[look] ${route.path}`)
    await shootRoute(page, route, album)
    await album.save()
  }
})
