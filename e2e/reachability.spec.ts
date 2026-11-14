// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	ownedReachabilityPlan,
	prepareReachability,
} from "./reachability-fixture.ts";

test("unknown registry data drives the actual setup, review, apply and stop screen", async ({
	page,
}) => {
	const canary = randomBytes(32).toString("hex");
	const { data, plan } = await ownedReachabilityPlan();
	expect(plan.mode).toBe("unknown");
	const spec = JSON.parse(
		await readFile(
			new URL(
				"../reference-implementation/test/fixtures/reachability/unknown-provider.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	let surface = await prepareReachability(page, canary);
	const control = async (path, method = "GET") => {
		const response = await fetch(`${plan.controlOrigin}${path}`, { method, headers: { authorization: `Bearer ${plan.controlToken}` } });
		expect(response.ok).toBe(true);
		return response.json();
	};
	const before = await control("/fixture-state");
	const review = surface.getByRole("region", {
		name: "Route consent",
		exact: true,
	});
	await expect(
		review.getByText(spec.facts[0].label, { exact: true }),
	).toBeVisible();
	// Change only trusted registry DATA while the previous consent is on screen.
	const path = join(
		data,
		"reachability-registry",
		"providers",
		spec.id,
		"definition.json",
	);
	const definition = JSON.parse(await readFile(path, "utf8"));
	definition.adapter.facts.push(spec.addedFact);
	await writeFile(path, JSON.stringify(definition));
	await review.getByRole("checkbox").check();
	await review.getByRole("button", { name: "Apply reachability" }).click();
	await expect(
		surface.getByText("artifact_integrity_failed", { exact: true }),
	).toBeVisible();
	expect((await control("/fixture-state")).starts).toBe(before.starts);
	await control("/reload-registry", "POST");
	await page.evaluate(() => sessionStorage.clear());
	surface = await prepareReachability(page, canary, false);
	const fresh = surface.getByRole("region", {
		name: "Route consent",
		exact: true,
	});
	await expect(
		fresh.getByText(spec.addedFact.label, { exact: true }),
	).toBeVisible();
	await expect(
		fresh.getByText(spec.addedFact.value, { exact: true }),
	).toBeVisible();
	await fresh.getByRole("checkbox").check();
	await fresh.getByRole("button", { name: "Apply reachability" }).click();
	await expect(
		surface.getByRole("heading", { name: /^verified$/i }),
	).toBeVisible();
	await expect(surface.getByText(/^Synthetic fixture proof: verified/)).toBeVisible();
	expect(await surface.textContent()).not.toContain(canary);
	await surface.getByLabel(/remote change may disconnect/).check();
	await surface
		.getByRole("button", { name: "Stop reachability", exact: true })
		.click();
	await expect(
		surface.getByText(/(?:^|· )Cleanup: confirmed$/),
	).toBeVisible();
});
