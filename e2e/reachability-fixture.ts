// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { MARKER } from "./harness-safety.mjs";

export async function ownedReachabilityPlan() {
	const data = process.env.E2E_DATA_DIR,
		nonce = process.env.E2E_HARNESS_NONCE;
	if (!data || !nonce)
		throw new Error("Use the disposable reachability e2e harness");
	expect(await readFile(join(data, MARKER), "utf8")).toBe(nonce);
	return {
		data,
		plan: JSON.parse(
			await readFile(join(data, "reachability-browser-plan.json"), "utf8"),
		),
	};
}
export async function prepareReachability(page: Page, canary: string, login = true) {
	const { plan } = await ownedReachabilityPlan();
	if (login) {
	await page.goto("/owner/login?return_to=%2Fsettings");
	await page
		.getByLabel("Owner password")
		.fill(process.env.E2E_OWNER_PASSWORD ?? "");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	}
	await page.goto("/settings");
	const surface = page.getByRole("region", {
		name: "Remote access",
		exact: true,
	});
	await expect(surface.getByRole("radio", { checked: true })).toHaveCount(0);
	await surface.getByRole("radio", { name: new RegExp(plan.label) }).check();
	await surface.getByRole("radio", { name: "attached", exact: true }).check();
	await surface
		.getByRole("button", { name: "Continue setup", exact: true })
		.click();
	for (const input of plan.inputs) {
		const field = surface.getByLabel(new RegExp(input.label));
		const card = surface
			.getByRole("region", { name: "Setup approval", exact: true })
			.filter({ has: page.getByLabel(new RegExp(input.label)) });
		await field.fill(
			input.secret
				? canary
				: input.kind === "domain"
					? "fixture.invalid"
					: input.kind === "https-origin"
						? "https://fixture.invalid"
						: "fixture.invalid:8443",
		);
		await card.getByRole("checkbox").check();
		await card
			.getByRole("button", { name: "Approve setup action", exact: true })
			.click();
		await expect(
			surface.getByRole("button", {
				name: "Commit and review route",
				exact: true,
			}),
		).toBeEnabled();
		await expect(surface.getByRole("alert")).toHaveCount(0);
	}
	await surface
		.getByRole("button", { name: "Commit and review route", exact: true })
		.click();
	await expect(
		surface.getByRole("region", { name: "Route consent", exact: true }),
	).toBeVisible();
	return surface;
}
