// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { ownedReachabilityPlan } from "./reachability-fixture.ts"

test("setup uses the unknown provider’s choices and current approval across browser return and reload", async ({
  page,
}) => {
  const { plan } = await ownedReachabilityPlan()
  expect(plan.mode).toBe("setup")
  const control = (path: string, method = "GET") =>
    fetch(`${plan.controlOrigin}${path}`, {
      method,
      headers: { authorization: `Bearer ${plan.controlToken}` },
    })
  const world = async () => (await control("/setup-world")).json()
  const { handoff, foreign } = await world()
  await page.route(url => url.href === handoff, route =>
    route.fulfill({ body: "Enrollment returned without verification" })
  )
  await page.goto("/owner/login?return_to=%2Fsettings")
  await page
    .getByLabel("Owner password")
    .fill(process.env.E2E_OWNER_PASSWORD ?? "")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.goto("/settings")
  const surface = page.getByRole("region", {
    name: "Remote access",
    exact: true,
  })
  await surface.getByRole("radio", { name: new RegExp(plan.label) }).check()
  await surface.getByRole("radio", { name: "attached", exact: true }).check()
  await surface
    .getByRole("button", { name: "Continue setup", exact: true })
    .click()
  await surface.getByRole("button", { name: "Start provider setup" }).click()

  const setup = surface.getByRole("region", {
    name: `Provider setup for ${plan.label}`,
  })
  const approval = setup.getByRole("region", { name: "Setup approval" })
  const approve = async (label: string) => {
    await expect(
      approval.getByRole("button", { name: label, exact: true })
    ).toBeDisabled()
    await approval.getByRole("checkbox").check()
    await approval.getByRole("button", { name: label, exact: true }).click()
  }
  await expect(setup.getByRole("status")).toHaveText("Waiting for verification")
  await expect(approval).not.toContainText(handoff)
  await expect(approval).not.toContainText("Fixture inventory note")
  await approve("Approve and open in browser")
  await expect(
    page.getByText("Enrollment returned without verification")
  ).toBeVisible()
  await page.goBack()
  await expect(setup.getByRole("status")).toHaveText("Waiting for verification")
  expect((await world()).effects).toEqual([])

  expect((await control("/verify-setup", "POST")).ok).toBe(true)
  await setup.getByRole("button", { name: "Check setup status" }).click()
  await approval.getByRole("combobox").selectOption({ label: "Workshop" })
  await approve("Select an account")
  const secret = randomUUID()
  await approval.getByLabel("Enrollment secret").fill(secret)
  await approve("Store enrollment secret")
  await expect(approval.getByLabel("Enrollment secret")).toHaveCount(0)
  expect((await world()).effects).toEqual(["account", "key"])
  await page.reload()
  await approve("Allocate the reviewed resource")
  await expect(setup.getByRole("status")).toHaveText("Setup complete")
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage })
    )
  ).not.toContain(secret)
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage })
    )
  ).not.toContain(handoff)

  await setup.getByRole("button", { name: "Prepare removal" }).click()
  await expect(setup.getByRole("status")).toHaveText("Setup cancelled")
  await approve("Remove the reviewed resource")
  await expect(setup.getByText(/Removal confirmed/)).toBeVisible()
  expect(await world()).toMatchObject({
    foreign,
    effects: ["account", "key", "create", "remove"],
  })
})
