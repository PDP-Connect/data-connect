// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import {
  offState,
  onCard,
  ownedReachabilityPlan,
  remoteAccess,
  signIn,
  turnOnButton,
} from "./reachability-fixture.ts"

// The host settles setup state asynchronously; allow it time before failing.
const eventually = expect.configure({ timeout: 30_000 })

test("setup finishes, stays unturned-on until permitted, then turns on and off", async ({
  page,
}) => {
  const { plan } = await ownedReachabilityPlan()
  expect(plan.mode).toBe("setup")
  const control = (path: string, method = "GET") =>
    fetch(`${plan.controlOrigin}${path}`, {
      method,
      headers: { authorization: `Bearer ${plan.controlToken}` },
    })
  const reset = await control("/reset-setup", "POST")
  expect([reset.status, await reset.text()]).toEqual([204, ""])
  const world = async () => (await control("/setup-world")).json()
  const { handoff } = await world()
  await page.route(
    url => url.href === handoff,
    route => route.fulfill({ body: "Enrollment returned without verification" })
  )
  await signIn(page)
  await page.goto("/settings")
  const surface = remoteAccess(page)
  const signInCard = surface.getByRole("region", {
    name: `Sign in to ${plan.label}`,
    exact: true,
  })
  await signInCard
    .getByRole("button", { name: `Sign in to ${plan.label}`, exact: true })
    .click()
  await eventually(
    page.getByText("Enrollment returned without verification")
  ).toBeVisible()
  await page.goBack()
  // The enrollment came back without a verification: nothing was done on the host.
  await eventually(signInCard).toBeVisible()
  await eventually(signInCard).not.toContainText(handoff)
  await eventually(signInCard).not.toContainText("Fixture inventory note")
  expect((await world()).effects).toEqual([])

  const writer = surface
  // The owner finishes the sign-in on the provider's side.
  expect((await control("/verify-setup", "POST")).ok).toBe(true)
  const details = writer.getByRole("region", { name: /^Details for / })
  await eventually(details.getByRole("combobox")).toBeVisible({
    timeout: 30_000,
  })
  await eventually(details.getByRole("button", { name: "Save" })).toBeDisabled()
  await details.getByRole("combobox").selectOption({ label: "Workshop" })
  await details.getByRole("button", { name: "Save" }).click()
  const secret = randomUUID()
  await details.getByLabel("Enrollment secret").fill(secret)
  await details.getByRole("button", { name: "Save token" }).click()
  const setup = writer.getByRole("region", {
    name: `Setup for ${plan.label}`,
    exact: true,
  })
  await eventually(setup).toBeVisible()
  await eventually(writer.getByLabel("Enrollment secret")).toHaveCount(0)
  expect((await world()).effects).toEqual(["account", "key"])

  {
    // An administrator has not confirmed the permission: the setup waits and nothing can be turned on.
    expect((await control("/setup-permission", "POST")).ok).toBe(true)
    await setup
      .getByRole("button", { name: "Check setup status" })
      .first()
      .click()
    await eventually(
      setup
        .getByText(
          "An administrator must confirm the exact workshop permission."
        )
        .first()
    ).toBeVisible()
    await eventually(turnOnButton(writer)).toHaveCount(0)
    expect((await control("/setup-permission", "POST")).ok).toBe(true)
    await setup
      .getByRole("button", { name: "Check setup status" })
      .first()
      .click()
  }
  const allocate = setup.getByRole("button", {
    name: "Allocate the reviewed resource",
    exact: true,
  })
  await eventually(allocate).toBeDisabled()
  await setup.getByRole("checkbox").check()
  await allocate.click()
  await eventually(setup.getByRole("status")).toHaveText("Ready to turn on")
  // This browser did not act: it reaches the same place from the host's state.
  const observer = surface.getByRole("region", {
    name: `Setup for ${plan.label}`,
    exact: true,
  })
  await eventually(observer.getByRole("status")).toHaveText("Ready to turn on")
  await eventually(
    observer
      .getByText("The completed setup is ready for a separate route review.")
      .first()
  ).toBeVisible()
  await page.reload()
  await eventually(turnOnButton(surface)).toBeEnabled()
  await turnOnButton(surface).click()
  await eventually(onCard(surface)).toBeVisible()
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage })
  )
  expect(stored).not.toContain(secret)
  expect(stored).not.toContain(handoff)
  expect(await surface.textContent()).not.toContain(secret)

  // Turning off ends the route; the page shows it as off and not on.
  await onCard(surface)
    .getByRole("button", { name: "Turn off", exact: true })
    .click()
  await eventually(offState(surface)).toBeVisible()
  await eventually(onCard(surface)).toHaveCount(0)
})
