// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"
import { MARKER } from "./harness-safety.mjs"

export async function ownedReachabilityPlan() {
  const data = process.env.E2E_DATA_DIR,
    nonce = process.env.E2E_HARNESS_NONCE
  if (!data || !nonce)
    throw new Error("Use the disposable reachability e2e harness")
  expect(await readFile(join(data, MARKER), "utf8")).toBe(nonce)
  return {
    data,
    plan: JSON.parse(
      await readFile(join(data, "reachability-browser-plan.json"), "utf8")
    ),
  }
}

export async function signIn(page: Page) {
  await page.goto("/owner/login?return_to=%2Fsettings")
  await page
    .getByLabel("Owner password")
    .fill(process.env.E2E_OWNER_PASSWORD ?? "")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL("**/settings")
}

export function remoteAccess(page: Page): Locator {
  return page.getByRole("region", { name: "Remote access", exact: true })
}

/** The card with the facts the owner approves and the one button that approves them. */
export function turnOnCard(surface: Locator): Locator {
  return surface.getByRole("region", { name: "Turn on", exact: true })
}

export function turnOnButton(surface: Locator): Locator {
  return turnOnCard(surface).getByRole("button", {
    name: "Turn on remote access",
    exact: true,
  })
}

/** The card for a route that is on. */
export function onCard(surface: Locator): Locator {
  return surface.getByRole("region", { name: "On", exact: true })
}

/**
 * Remote access shown as off: the status line when nothing was ever started, or
 * the Off heading on a route entry the host confirmed closed.
 */
export function offState(surface: Locator): Locator {
  return surface
    .getByText("Off · Only this computer can open DataConnect.", {
      exact: true,
    })
    .or(
      surface
        .getByRole("region", { name: "Your address", exact: true })
        .getByRole("heading", { name: "Off", exact: true })
    )
}

export async function openDetails(card: Locator) {
  const details = card.locator("details").first()
  if ((await details.getAttribute("open")) === null)
    // The summary is the toggle; its wording names the service and may change.
    await details.locator("summary").click()
  return details
}

/** Gives every input the recommended way asks for, one Allow card at a time. */
export async function giveInputs(
  surface: Locator,
  plan: { inputs: { label: string; secret: boolean; kind: string }[] },
  canary: string
) {
  for (const input of plan.inputs) {
    const card = surface.getByRole("region", {
      name: "Allow this step",
      exact: true,
    })
    await card
      .getByLabel(new RegExp(input.label))
      .fill(
        input.secret
          ? canary
          : input.kind === "domain"
            ? "fixture.invalid"
            : input.kind === "https-origin"
              ? "https://fixture.invalid"
              : "fixture.invalid:8443"
      )
    await card.getByRole("button", { name: "Allow", exact: true }).click()
  }
}

/** Picks the way the plan names: the recommended one when it is that way, else one under Other ways. */
export async function chooseWay(surface: Locator, providerId: string) {
  const way = surface.locator(`input[name="way"][value="${providerId}"]`)
  await expect(
    surface.getByRole("region", { name: "Recommended way", exact: true })
  ).toBeVisible()
  if ((await way.count()) === 0) {
    await surface
      .getByRole("button", { name: "Other ways", exact: true })
      .click()
    for (const summary of await surface
      .locator("fieldset details:not([open]) > summary")
      .all())
      await summary.click()
  }
  await way.check()
}

/**
 * Signs in (unless told not to), opens Settings and walks the recommended way
 * to its Turn on card. Nothing is turned on.
 */
export async function prepareReachability(
  page: Page,
  canary: string,
  login = true
) {
  const { plan } = await ownedReachabilityPlan()
  if (login) await signIn(page)
  await page.goto("/settings")
  const surface = remoteAccess(page)
  await expect(
    surface.getByRole("region", { name: "Recommended way", exact: true })
  ).toBeVisible()
  await chooseWay(surface, plan.providerId)
  await giveInputs(surface, plan, canary)
  await expect(turnOnButton(surface)).toBeEnabled()
  return surface
}
