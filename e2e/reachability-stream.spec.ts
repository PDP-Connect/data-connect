// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	ownedReachabilityPlan,
	prepareReachability,
} from "./reachability-fixture.ts";

test("pending initial stream proof cannot publish through concurrent status/watch or the screen", async ({
	page,
	request,
}) => {
	const { plan } = await ownedReachabilityPlan();
	expect(plan.mode).toBe("stream");
	const canary = randomBytes(32).toString("hex");
	const surface = await prepareReachability(page, canary);
	const review = surface.getByRole("region", {
		name: "Route consent",
		exact: true,
	});
	await surface.evaluate((element) => {
		Reflect.set(window, "reachabilityVerifiedDuringPendingProof", false);
		const observer = new MutationObserver(() => {
			if (
				[...element.querySelectorAll("h1,h2,h3,h4,h5,h6")].some(
					(heading) => heading.textContent?.trim().toLowerCase() === "verified",
				)
			)
				Reflect.set(window, "reachabilityVerifiedDuringPendingProof", true);
		});
		observer.observe(element, {
			subtree: true,
			childList: true,
			characterData: true,
		});
		Reflect.set(window, "reachabilityPendingProofObserver", observer);
	});
	await review.getByRole("checkbox").check();
	await review.getByRole("button", { name: "Apply reachability" }).click();
	// This private test control invokes the PUBLIC Gozar status/watch methods in
	// the fixture host while its real gate-backed stream response is buffered.
	const response = await request.get(
		`${plan.controlOrigin}/concurrent-observations`,
		{ headers: { authorization: `Bearer ${plan.controlToken}` } },
	);
	expect(response.ok()).toBeTruthy();
	const observations = await response.json();
	expect(observations.initialStreamSeen).toBe(true);
	expect(observations.observations.length).toBeGreaterThan(0);
	for (const row of observations.observations)
		for (const view of [row.status, row.watch]) {
			if (view.pending) continue; // A waiting read has not made a publication claim.
			expect(view.published).toBeNull();
			expect(view.verification.status).not.toBe("verified");
		}
	await expect(
		surface.getByRole("heading", { name: /^verified$/i }),
	).toHaveCount(0);
	await expect(
		surface.getByText("Unknown, possibly live", { exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "reachabilityVerifiedDuringPendingProof"),
		),
	).toBe(false);
	await page.evaluate(() =>
		Reflect.get(window, "reachabilityPendingProofObserver")?.disconnect(),
	);
	expect(await response.text()).not.toContain(canary);
	expect(await surface.textContent()).not.toContain(canary);
});
