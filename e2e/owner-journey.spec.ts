// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-journey smoke check for a running DataConnect console.
 *
 * Exercises the exact regressions the owner found by manual clicking that CI
 * and lane self-reports missed: an empty connector catalog, connector rows
 * with no brand marks, a false "provider cannot read your data" claim on the
 * public-URL remote-access posture, and a blocked-IPC error banner leaking
 * onto Settings. It asserts on the rendered page, not on component internals.
 *
 * Target a running console with:
 *   E2E_BASE_URL=http://127.0.0.1:PORT E2E_OWNER_PASSWORD=... npm run test:e2e
 *
 * See e2e/README.md for how to find the port and password for a given
 * console instance.
 */
import { expect, test } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""

const CONNECTOR_ROW_FLOOR = 20
const MIN_SVG_ROW_PROPORTION = 0.5

async function loginAsOwner(
  page: import("@playwright/test").Page
): Promise<void> {
  if (!OWNER_PASSWORD) {
    throw new Error(
      "E2E_OWNER_PASSWORD is not set. Pass the console's actual owner password " +
        "(not necessarily the contents of ~/.tmp/unified-owner-password - that file can be stale for a " +
        "given running instance; read PDPP_OWNER_PASSWORD from the target process's environment if unsure)."
    )
  }
  await page.goto(`${BASE_URL}/owner/login?return_to=%2F`)
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD)
  const [response] = await Promise.all([
    page.waitForResponse(
      res =>
        res.url().includes("/owner/login") && res.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  expect(
    response.status(),
    `owner login POST returned ${response.status()}; expected a redirect (2xx/3xx) after a correct password`
  ).toBeLessThan(400)
  await page.waitForLoadState("networkidle")
}

test("sources/add renders many connectors, not the empty-catalog regression", async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/sources/add`, { waitUntil: "networkidle" })

  const bodyText = await page.locator("body").innerText()
  expect(
    bodyText,
    'expected the connector catalog to render rows, but found the empty-state text "No connector matched"'
  ).not.toContain("No connector matched")

  const rows = page.locator("main li")
  const rowCount = await rows.count()
  expect(
    rowCount,
    `expected >= ${CONNECTOR_ROW_FLOOR} distinct connector rows on /sources/add, found ${rowCount}. ` +
      "This is the exact empty-catalog regression the owner hit twice."
  ).toBeGreaterThanOrEqual(CONNECTOR_ROW_FLOOR)

  let rowsWithSvg = 0
  for (let i = 0; i < rowCount; i++) {
    const svgCount = await rows.nth(i).locator("svg").count()
    if (svgCount > 0) {
      rowsWithSvg += 1
    }
  }
  const svgProportion = rowsWithSvg / rowCount
  expect(
    svgProportion,
    `expected at least ${Math.round(MIN_SVG_ROW_PROPORTION * 100)}% of connector rows to render a brand-mark <svg>, ` +
      `found ${rowsWithSvg}/${rowCount} (${Math.round(svgProportion * 100)}%). ` +
      "This will start passing once lane logos-0918's resolver fix lands; until then it documents the monogram-only regression."
  ).toBeGreaterThanOrEqual(MIN_SVG_ROW_PROPORTION)
})

test("settings renders Remote access with three honest, non-empty postures", async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  await expect(page).toHaveTitle("Settings")

  const remoteAccessHeading = page.getByRole("heading", {
    name: "Remote access",
    level: 2,
  })
  await expect(
    remoteAccessHeading,
    "expected a 'Remote access' section heading on Settings"
  ).toBeVisible()

  const postureGroup = page.getByRole("radiogroup", {
    name: "Remote access posture",
  })
  await expect(
    postureGroup,
    "expected a 'Remote access posture' radiogroup on Settings"
  ).toBeVisible()

  const expectedPostures = ["Off", "My devices only", "Public URL"]
  for (const postureName of expectedPostures) {
    const postureRow = postureGroup.locator("label").filter({
      has: page.getByRole("radio", { name: postureName }),
    })
    await expect(
      postureRow,
      `expected exactly one '${postureName}' posture row inside the Remote access radiogroup`
    ).toHaveCount(1)

    const badgeText = (
      await postureRow.locator(".rounded-full").first().innerText()
    ).trim()
    expect(
      badgeText.length,
      `expected a non-empty privacy badge on the '${postureName}' posture row, found an empty string`
    ).toBeGreaterThan(0)

    if (postureName === "Public URL") {
      expect(
        badgeText,
        "the Public URL (user-supplied-proxy) posture badge must not claim " +
          '"Provider cannot read your data" - a proxy the owner does not control can read traffic ' +
          "in transit unless it terminates TLS correctly. This was a false safety claim the owner caught."
      ).not.toContain("Provider cannot read your data")
    }
  }
})

test("settings renders the About section", async ({ page }) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const aboutHeading = page.getByRole("heading", { name: "About", level: 2 })
  await expect(
    aboutHeading,
    "expected an 'About' section heading on Settings"
  ).toBeVisible()
})

test("settings shows no blocked-IPC error banner text", async ({ page }) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const bodyText = await page.locator("body").innerText()
  expect(
    bodyText.toLowerCase(),
    'expected Settings to render without a "not allowed" error banner (Tauri IPC command blocked)'
  ).not.toContain("not allowed")
  expect(
    bodyText,
    'expected Settings to render without a "Plugin not found" error banner (Tauri IPC plugin missing)'
  ).not.toContain("Plugin not found")
})

test("settings does not hang on 'Reading the current remote access state', with no console errors or 404'd chunks", async ({
  page,
}) => {
  // Confirmed live, 2026-09-19: a stale next-server process (running from a
  // staged build directory a live rebuild had already replaced under it,
  // fixed in scripts/ensure-console-stack.js) served this exact page stuck
  // forever on "Reading the current remote access state…" because its own
  // JS chunk 404'd -- a browser resource-loading failure the prior
  // owner-journey assertions above did not catch, since they only check for
  // server-rendered headings/labels that appear before the failing client
  // fetch ever runs. This test asserts the property those did not: the page
  // must actually finish reading remote-access state, not just render its
  // static shell.
  const consoleErrors: string[] = []
  const failed404s: string[] = []
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })
  page.on("response", res => {
    if (res.status() === 404) failed404s.push(res.url())
  })

  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const readingState = page.getByText(
    "Reading the current remote access state…"
  )
  await expect(
    readingState,
    "expected the loading placeholder to disappear once the client's own remote-access fetch resolves, " +
      "not remain stuck forever"
  ).toBeHidden({ timeout: 10_000 })

  expect(
    failed404s,
    `expected no 404'd requests while loading Settings, found: ${JSON.stringify(failed404s)}`
  ).toEqual([])
  expect(
    consoleErrors,
    `expected no browser console errors while loading Settings, found: ${JSON.stringify(consoleErrors)}`
  ).toEqual([])
})
