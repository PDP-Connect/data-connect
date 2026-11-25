// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { doctor, seedConnector, BASE_URL } from "./capture-support.ts"

interface Action {
  type: "click"
  role: "button" | "link"
  name: string
  withinTestId?: string
}

interface JourneyStep {
  id: string
  open?: string
  desktopAction?: Action
  desktopActions?: Action[]
  phoneAction?: Action
  readyText: string
  desktopReadyHeading?: string
  phoneReadyHeading?: string
  readyPathIncludes?: string
  phonePathIncludes?: string
  assertText?: string
  minMainListItems?: number
}

interface Journey {
  id: string
  name: string
  seed?: string[]
  steps: JourneyStep[]
}

const journeyDir = fileURLToPath(new URL("./journeys/", import.meta.url))
const harnessRoot = process.env.E2E_HARNESS_ROOT
if (!harnessRoot)
  throw new Error("E2E_HARNESS_ROOT is missing; use e2e/harness.mjs")
const evidenceRoot = join(dirname(dirname(harnessRoot)), "evidence")
const desktop = { width: 1440, height: 1000 }
const phone = { width: 390, height: 844 }

async function readJourneys(): Promise<Journey[]> {
  const files = (await readdir(journeyDir))
    .filter(file => file.endsWith(".json"))
    .sort()
  return Promise.all(
    files.map(
      async file =>
        JSON.parse(await readFile(join(journeyDir, file), "utf8")) as Journey
    )
  )
}

async function applyAction(page: Page, action?: Action): Promise<void> {
  if (!action) return
  if (action.type === "click") {
    const scope = action.withinTestId
      ? page.getByTestId(action.withinTestId)
      : page
    await scope.getByRole(action.role, { name: action.name }).first().click()
    return
  }
  throw new Error(`Unsupported journey action: ${JSON.stringify(action)}`)
}

async function waitUntilReady(
  page: Page,
  text: string,
  heading?: string
): Promise<void> {
  if (heading) {
    await page
      .getByRole("heading", { name: heading, exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
    return
  }
  await page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
}

async function saveViewport(
  page: Page,
  stepId: string,
  label: string,
  size: typeof desktop,
  target: string
): Promise<string> {
  await page.setViewportSize(size)
  await page.screenshot({
    path: join(target, `${stepId}--${label}.png`),
    fullPage: true,
  })
  const visibleText = (await page.locator("body").innerText()).trim()
  return `## ${stepId} · ${label} (${size.width}×${size.height})\nURL: ${page.url()}\n\n${visibleText}`
}

async function captureJourney(page: Page, journey: Journey): Promise<void> {
  await doctor(page)
  for (const connector of journey.seed ?? [])
    await seedConnector(page, connector)
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace(/\d{3}Z$/, "Z")}-${randomBytes(3).toString("hex")}`
  const target = join(evidenceRoot, journey.id, runId)
  await mkdir(target, { recursive: true, mode: 0o700 })
  console.log(`[capture] evidence: ${target}`)
  const transcript: string[] = [
    `Journey: ${journey.name}`,
    `Evidence: ${target}`,
    `Captured: ${new Date().toISOString()}`,
    "Visible text is taken from the rendered page body in DOM reading order.",
  ]

  for (const step of journey.steps) {
    await page.setViewportSize(desktop)
    if (step.open)
      await page.goto(
        `${BASE_URL}${await resolveJourneyPath(page, step.open)}`,
        {
          waitUntil: "domcontentloaded",
        }
      )
    await applyAction(page, step.desktopAction)
    for (const action of step.desktopActions ?? [])
      await applyAction(page, action)
    await waitUntilReady(page, step.readyText, step.desktopReadyHeading)
    if (step.readyPathIncludes)
      expect(page.url(), `${step.id} must reach its setup route`).toContain(
        step.readyPathIncludes
      )
    const desktopText = await saveViewport(
      page,
      step.id,
      "desktop",
      desktop,
      target
    )

    await page.setViewportSize(phone)
    if (step.open)
      await page.goto(
        `${BASE_URL}${await resolveJourneyPath(page, step.open)}`,
        {
          waitUntil: "domcontentloaded",
        }
      )
    await applyAction(page, step.phoneAction)
    await waitUntilReady(page, step.readyText, step.phoneReadyHeading)
    if (step.phonePathIncludes)
      expect(
        page.url(),
        `${step.id} must navigate to its detail route`
      ).toContain(step.phonePathIncludes)
    const phoneText = await saveViewport(page, step.id, "phone", phone, target)
    transcript.push(desktopText, phoneText)
    await writeFile(
      join(target, "visible-text.txt"),
      `${transcript.join("\n\n---\n\n")}\n`,
      { mode: 0o600 }
    )

    if (step.minMainListItems !== undefined) {
      const count = await page.locator("main li").count()
      expect(
        count,
        `${step.id} needs at least ${step.minMainListItems} catalog items`
      ).toBeGreaterThanOrEqual(step.minMainListItems)
    }
    if (step.assertText) {
      const visible = `${desktopText}\n${phoneText}`
      expect(
        visible,
        `${step.id} must show ${JSON.stringify(step.assertText)}`
      ).toContain(step.assertText)
    }
  }

  await writeFile(
    join(target, "capture.json"),
    `${JSON.stringify({ journey: journey.id, runId, baseOrigin: new URL(BASE_URL).origin, viewport: { desktop, phone }, files: [...(await readdir(target)), "capture.json"] }, null, 2)}\n`,
    { mode: 0o600 }
  )
}

async function resolveJourneyPath(page: Page, path: string): Promise<string> {
  const sourceMarker = "/sources/[seed-source:spotify]"
  const connectionMarker = "[seed-connection:spotify]"
  const runMarker = "[seed-run:spotify]"
  if (
    !path.includes(sourceMarker) &&
    !path.includes(connectionMarker) &&
    !path.includes(runMarker)
  )
    return path
  await page.goto(`${BASE_URL}/sources`, { waitUntil: "domcontentloaded" })
  const sourceHref = await page
    .locator('a[href^="/sources/cin_"]')
    .filter({ hasText: /spotify/i })
    .first()
    .getAttribute("href")
  expect(
    sourceHref,
    "seeded Spotify source must have a visible detail link"
  ).toBeTruthy()
  let resolved = path.replace(sourceMarker, sourceHref!)
  const connectionId = sourceHref!.match(/^\/sources\/([^/]+)/)?.[1]
  expect(
    connectionId,
    "seeded Spotify source must expose a connection ID"
  ).toBeTruthy()
  resolved = resolved.replace(connectionMarker, connectionId!)

  if (path.includes(runMarker)) {
    await page.goto(`${BASE_URL}${sourceHref}`, {
      waitUntil: "domcontentloaded",
    })
    const runHref = await page
      .locator('a[href^="/syncs/run_"]')
      .first()
      .getAttribute("href")
    expect(
      runHref,
      "seeded Spotify source must expose a sync detail link"
    ).toBeTruthy()
    resolved = resolved.replace(
      runMarker,
      runHref!.slice("/syncs/".length).split("/")[0]
    )
  }
  return resolved
}

async function captureBaseline(page: Page): Promise<void> {
  const routes = JSON.parse(
    await readFile(
      fileURLToPath(new URL("./baseline-routes.json", import.meta.url)),
      "utf8"
    )
  ) as {
    id: string
    path: string
    title: string
    readyText?: string
    skipReason?: string
  }[]
  routes.push({
    id: "owner-login",
    path: "/owner/login",
    title: "Server-rendered owner sign-in",
  })
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const target = join(evidenceRoot, `baseline-${date}`)
  await mkdir(target, { recursive: true, mode: 0o700 })
  const transcripts = [
    `DataConnect route baseline · ${date}`,
    "Screenshots and visible body text are captured after navigation. Routes without seeded identifiers are listed as skipped; no identifier is invented.",
  ]
  const results: {
    id: string
    path: string
    title: string
    finalUrl: string | null
    status: number | null
    opened?: boolean
    heading?: string
    error?: string
    skipReason?: string
  }[] = []

  // Capture the server-rendered owner sign-in before authenticating the console.
  const login = routes.find(route => route.path === "/owner/login")
  if (login)
    await captureBaselineRoute(page, login, target, transcripts, results)
  await doctor(page)
  for (const connector of ["spotify", "github", "reddit"])
    await seedConnector(page, connector)

  await page.goto(`${BASE_URL}/sources`, { waitUntil: "domcontentloaded" })
  const sourceHref = await page
    .locator('a[href^="/sources/cin_"]')
    .filter({ hasText: /spotify/i })
    .first()
    .getAttribute("href")
  const connectionId = sourceHref?.match(/^\/sources\/([^/]+)/)?.[1]
  let recordHref: string | undefined
  let runHref: string | undefined
  if (sourceHref) {
    await page.goto(`${BASE_URL}${sourceHref}/top_artists`, {
      waitUntil: "domcontentloaded",
    })
    const recordLinks = await page
      .locator(`a[href^="${sourceHref}/top_artists/"]`)
      .evaluateAll(elements =>
        elements.map(element => element.getAttribute("href"))
      )
    recordHref =
      recordLinks.find(href => href && !href.endsWith("/health")) ?? undefined
    runHref =
      (await page
        .locator('a[href^="/syncs/run_"]')
        .first()
        .getAttribute("href")) ?? undefined
  }
  await page.goto(`${BASE_URL}/audit`, { waitUntil: "domcontentloaded" })
  const traceLinks = page.locator('a[href^="/audit/"]')
  const traceHref =
    (await traceLinks.count()) > 0
      ? ((await traceLinks.first().getAttribute("href")) ?? undefined)
      : undefined
  const resolvedRoutes = routes.map(route => {
    let path = route.path
    if (connectionId) {
      path = path.replaceAll("/sources/spotify", `/sources/${connectionId}`)
      path = path.replaceAll("baseline-missing-connection", connectionId)
    }
    if (recordHref)
      path = path.replace(
        "/baseline-missing-record",
        recordHref.slice(recordHref.lastIndexOf("/"))
      )
    if (runHref)
      path = path.replaceAll(
        "baseline-missing-run",
        runHref.slice("/syncs/".length).split("/")[0]
      )
    if (traceHref)
      path = path.replace(
        "baseline-missing-trace",
        traceHref.slice("/audit/".length)
      )
    return { ...route, path }
  })

  for (const route of resolvedRoutes) {
    if (route.path === "/owner/login") continue
    if (route.skipReason) {
      results.push({
        id: route.id,
        path: route.path,
        title: route.title,
        finalUrl: null,
        status: null,
        opened: false,
        skipReason: route.skipReason,
      })
      transcripts.push(`## ${route.path} · skipped\n\n${route.skipReason}`)
      console.log(`[baseline] skipped ${route.path}: ${route.skipReason}`)
      continue
    }
    await captureBaselineRoute(page, route, target, transcripts, results)
  }
  await writeFile(
    join(target, "visible-text.txt"),
    `${transcripts.join("\n\n---\n\n")}\n`,
    { mode: 0o600 }
  )
  await writeFile(
    join(target, "capture.json"),
    `${JSON.stringify({ date, consoleRouteCount: 44, additionalServerPageCount: 1, routes: results }, null, 2)}\n`,
    { mode: 0o600 }
  )
  const skippedCount = results.filter(route => route.skipReason).length
  console.log(
    `[baseline] listed ${results.length} routes; navigated ${results.length - skippedCount}; skipped ${skippedCount}; evidence: ${target}`
  )
}

async function captureBaselineRoute(
  page: Page,
  route: { id: string; path: string; title: string; readyText?: string },
  target: string,
  transcripts: string[],
  results: {
    id: string
    path: string
    title: string
    finalUrl: string | null
    status: number | null
    opened?: boolean
    heading?: string
    error?: string
    skipReason?: string
  }[]
): Promise<void> {
  let status: number | null = null
  let error: string | undefined
  try {
    const response = await page.goto(`${BASE_URL}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    })
    status = response?.status() ?? null
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  if (route.readyText) {
    await page
      .getByText(route.readyText, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {})
  }
  const finalUrl = page.url()
  const heading = await page
    .locator("h1")
    .first()
    .innerText({ timeout: 500 })
    .catch(() => "")
  await page.setViewportSize(desktop)
  const desktopBody = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "")
  const opened = Boolean(
    status &&
    status >= 200 &&
    status < 400 &&
    !/^404$/i.test(heading.trim()) &&
    !/not found|reference server unreachable|service unavailable|internal server error|Loading Sources…/i.test(
      `${heading}\n${desktopBody}`
    )
  )
  results.push({
    id: route.id,
    path: route.path,
    title: route.title,
    finalUrl,
    status,
    opened,
    ...(heading ? { heading } : {}),
    ...(error ? { error } : {}),
  })
  console.log(
    `[baseline] ${status ?? "error"} ${route.path} → ${finalUrl}${error ? ` (${error})` : ""}`
  )
  for (const [label, size] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    await page.setViewportSize(size)
    const body = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "")
    const filename = `${route.id}--${label}.png`
    await page
      .screenshot({
        path: join(target, filename),
        fullPage: true,
        timeout: 20_000,
      })
      .catch(() => {})
    transcripts.push(
      `## ${route.path} · ${label} · HTTP ${status ?? "unknown"}\nURL: ${finalUrl}\n\n${body.trim()}${error ? `\nNavigation error: ${error}` : ""}`
    )
    await writeFile(
      join(target, "visible-text.txt"),
      `${transcripts.join("\n\n---\n\n")}\n`,
      { mode: 0o600 }
    )
  }
}

for (const journey of await readJourneys()) {
  test(`journey: ${journey.id}`, async ({ page }) =>
    captureJourney(page, journey))
}

test("baseline: all console routes", async ({ page }) => {
  test.setTimeout(8 * 60 * 1000)
  await captureBaseline(page)
})
