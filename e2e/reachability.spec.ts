// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  offState,
  onCard,
  openDetails,
  ownedReachabilityPlan,
  prepareReachability,
  turnOnButton,
  turnOnCard,
} from "./reachability-fixture.ts"

test("unknown registry data drives Turn on: stale facts are refused, fresh facts turn it on, Turn off confirms cleanup", async ({
  page,
}) => {
  const canary = randomBytes(32).toString("hex")
  const { data, plan } = await ownedReachabilityPlan()
  expect(plan.mode).toBe("unknown")
  const spec = JSON.parse(
    await readFile(
      new URL(
        "../reference-implementation/test/fixtures/reachability/unknown-provider.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  let surface = await prepareReachability(page, canary)
  const control = async (path, method = "GET") => {
    const response = await fetch(`${plan.controlOrigin}${path}`, {
      method,
      headers: { authorization: `Bearer ${plan.controlToken}` },
    })
    expect(response.ok).toBe(true)
    return response.json()
  }
  const before = await control("/fixture-state")
  const card = turnOnCard(surface)
  await openDetails(card)
  await expect(
    card.getByText(spec.facts[0].label, { exact: true })
  ).toBeVisible()
  // Change only trusted registry DATA while the previous consent is on screen.
  const path = join(
    data,
    "reachability-registry",
    "providers",
    spec.id,
    "definition.json"
  )
  const definition = JSON.parse(await readFile(path, "utf8"))
  definition.adapter.facts.push(spec.addedFact)
  await writeFile(path, JSON.stringify(definition))
  await turnOnButton(surface).click()
  // The host refuses the approval: the data under the review changed. Nothing
  // starts and the page never shows remote access as on.
  await expect(
    surface
      .getByText("A required download didn't pass its safety check. Try again.")
      .first()
  ).toBeVisible()
  await expect(onCard(surface)).toHaveCount(0)
  await expect(offState(surface)).toHaveCount(0)
  expect((await control("/fixture-state")).starts).toBe(before.starts)
  // The refused attempt leaves a step that asks the owner to turn it off.
  await surface
    .getByRole("region", { name: "Needs your action", exact: true })
    .getByRole("button", { name: "Turn off", exact: true })
    .click()
  // The refused attempt also left an address entry that has no route behind it.
  await surface
    .getByRole("region", { name: "Your address", exact: true })
    .getByRole("button", { name: "Turn off", exact: true })
    .click()
  await expect(offState(surface)).toBeVisible()
  await control("/reload-registry", "POST")
  await page.evaluate(() => sessionStorage.clear())
  surface = await prepareReachability(page, canary, false)
  const fresh = turnOnCard(surface)
  await openDetails(fresh)
  await expect(
    fresh.getByText(spec.addedFact.label, { exact: true })
  ).toBeVisible()
  await expect(
    fresh.getByText(spec.addedFact.value, { exact: true })
  ).toBeVisible()
  await turnOnButton(surface).click()
  const on = onCard(surface)
  await expect(on).toBeVisible()
  await expect(on.getByText(/^Test data: Works on this computer/)).toBeVisible()
  expect(await surface.textContent()).not.toContain(canary)
  await on.getByRole("button", { name: "Turn off", exact: true }).click()
  // Off shows only once the host confirms the route is closed.
  await expect(offState(surface)).toBeVisible()
  await expect(onCard(surface)).toHaveCount(0)
  await expect(
    surface.getByText("Couldn't confirm the service closed your address.")
  ).toHaveCount(0)
  // The host side agrees: the route was started once and its cleanup is confirmed.
  const after = await control("/fixture-state")
  expect(after.starts).toBe(before.starts + 1)
  expect(after.cleanup.map(route => route.state)).toEqual(["confirmed"])
  expect(await surface.textContent()).not.toContain(canary)
})
