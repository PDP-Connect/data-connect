import { completeFixture } from "./journey-support.mjs";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPreparedFixture } from "./prepared-fixture.mjs";

test("fresh owner review discloses the observed positive paid rate without starting a route", {
	timeout: 30000,
}, async () => {
	const fixture = await createPreparedFixture(undefined, { runtimeObservations: true });
	try {
		const starts = await fixture.startCount();
		await fixture.registry.setRuntimeCost("paid", 125);
		const fresh = await fixture.api.call(`/drafts/${fixture.draftId}/review`, { usage: "attached" });
		assert.deepEqual(fresh.candidate.consent.disclosures.cost, {
			kind: "paid",
			summary: "Fixture paid rate",
			amount: 125,
			currency: "USD",
			period: "month",
		});
		assert.equal(await fixture.startCount(), starts, "Review must not start the synthetic route");
	} finally {
		await fixture.close();
	}
});

test("a runtime cost that turns paid after a free review refuses the stale approval and starts the fresh paid review's route", {
	timeout: 60000,
}, async () => {
	const fixture = await createPreparedFixture(undefined, { runtimeObservations: true });
	const settle = async (operationId) => {
		const deadline = Date.now() + 20000;
		let state;
		do {
			state = await fixture.api.call(`/operations/${operationId}`);
			if (state.stage !== "applying") return state;
			await new Promise(resolve => setTimeout(resolve, 20));
		} while (Date.now() < deadline);
		return state;
	};
	try {
		const free = await fixture.api.call(`/drafts/${fixture.draftId}/review`, { usage: "attached" });
		assert.deepEqual(free.candidate.consent.disclosures.cost, { kind: "free", summary: "Fixture free rate" });
		const starts = await fixture.startCount();
		await fixture.registry.setRuntimeCost("paid", 125);
		const stale = await fixture.api.call("/operations", {
			reviewId: free.id,
			kind: "route",
			consentFactsDigest: free.candidate.consentFactsDigest,
			acknowledgeDisconnect: true,
		});
		const refused = await settle(stale.operationId);
		assert.equal(refused.failureCode, "consent_mismatch");
		assert.notEqual(refused.stage, "settled");
		assert.equal(await fixture.startCount(), starts, "An approval from the free review must not start a route");
		const fresh = await fixture.api.call(`/drafts/${fixture.draftId}/review`, { usage: "attached" });
		assert.deepEqual(fresh.candidate.consent.disclosures.cost, {
			kind: "paid",
			summary: "Fixture paid rate",
			amount: 125,
			currency: "USD",
			period: "month",
		});
		const paid = await fixture.api.call("/operations", {
			reviewId: fresh.id,
			kind: "route",
			consentFactsDigest: fresh.candidate.consentFactsDigest,
			acknowledgeDisconnect: true,
		});
		const settled = await settle(paid.operationId);
		assert.equal(settled.stage, "settled");
		assert.equal(settled.failureCode, null);
		assert.equal(await fixture.startCount(), starts + 1, "The fresh paid review must start exactly one route");
	} finally {
		await fixture.close();
	}
});

test("runtime consent drift withdraws publication, and initial-only proof offers only stop", {
	timeout: 60000,
}, async () => {
	const fixture = await createPreparedFixture(undefined, {
		runtimeObservations: true,
	});
	const abort = new AbortController();
	try {
		const review = await fixture.api.call(`/drafts/${fixture.draftId}/review`, { usage: "attached" });
		const operation = await fixture.api.call("/operations", {
			reviewId: review.id,
			kind: "route",
			consentFactsDigest: review.candidate.consentFactsDigest,
			acknowledgeDisconnect: true,
		});
		const deadline = Date.now() + 20000;
		let state;
		do {
			state = await fixture.api.call(`/operations/${operation.operationId}`);
			if (state.stage !== "applying") break;
			await new Promise(resolve => setTimeout(resolve, 20));
		} while (Date.now() < deadline);
		assert.equal(state.stage, "settled");
		// Keep the real host intent/handle path, then establish proof explicitly
		// through the idempotent public call and current status, not enumeration.
		assert.equal(fixture.request.wait, "verified");
		const exposed = await fixture.gozar.expose({ ...fixture.request, operationId: operation.operationId });
		assert.equal(exposed.verification.status, "verified", "Drift needs verified initial expose proof");
		assert.equal(exposed.published, exposed.origin);
		const route = await fixture.gozar.routeStatus({ home: fixture.home, handle: exposed.handle });
		assert.equal(route.verification.status, "verified", "Drift needs current initial status proof");
		assert.equal(route.published, exposed.origin);
		const watch = fixture.gozar.watchRoutes({
			home: fixture.home,
			handle: route.handle,
			signal: abort.signal,
		});
		const changed = (async () => {
			for await (const event of watch)
				if (event.type === "consent_changed") return event;
			throw new Error("No runtime consent change event");
		})();
		changed.catch(() => {});
		await fixture.registry.setRuntimeCost("paid");
		let current;
		try {
			current = await fixture.gozar.routeStatus({
				home: fixture.home,
				handle: route.handle,
			});
		} catch (error) {
			assert.equal(error.code, "consent_changed");
			current = error.route;
		}
		assert.ok(current);
		assert.equal(current.published, null);
		assert.notEqual(current.verification.status, "verified");
		const event = await Promise.race([
			changed,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Consent watch timed out")), 8000),
			),
		]);
		assert.equal(event.route.published, null);
		const refused = await fixture.api.request(
			`/routes/${encodeURIComponent(route.handle.id)}/review`,
			{ generation: route.handle.generation },
		);
		assert.equal(refused.error?.code, "proof_refresh_unsupported");
		const host = await fixture.api.call("/state");
		const safe = host.routes.find((item) => item.handle.id === route.handle.id);
		assert.equal(safe.published, null);
		assert.deepEqual(safe.actions, ["stop"]);
		assert.equal(host.reasons[route.handle.id], "proof_refresh_unsupported");
	} finally {
		abort.abort();
		await fixture.close();
	}
});

test("owned enumeration projects current verified publication and proof without renewing evidence", {
	timeout: 30000,
}, async () => {
	const fixture = await createPreparedFixture(undefined, { fixture: "unknown" });
	let failure;
	try {
		const exposed = await fixture.gozar.expose(fixture.request);
		assert.equal(exposed.verification.status, "verified");
		const current = await fixture.gozar.routeStatus({ home: fixture.home, handle: exposed.handle });
		assert.equal(current.verification.status, "verified");
		assert.equal(current.published, current.origin);
		assert.ok(current.published);
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const events = join(fixture.registry.root, "providers", fixture.request.providerId, "events.jsonl");
		const before = await readFile(events, "utf8");
		const listed = (await fixture.gozar.listRoutes({ home: fixture.home, owner: fixture.owner })).routes
			.filter(route => route.operationId === exposed.operationId);
		assert.equal(listed.length, 1, "Known operation must remain enumerable");
		assert.equal(await readFile(events, "utf8"), before, "Enumeration must not run provider proof or lifecycle effects");
		assert.deepEqual(listed[0].handle, current.handle);
		assert.equal(listed[0].published, current.published, "Enumeration must retain known current publication, not bare null");
		assert.deepEqual(listed[0].verification, current.verification, "Enumeration must retain current proof metadata without fabricating evidence");
	} catch (error) {
		failure = error;
	} finally {
		await completeFixture(fixture, failure);
	}
});

for (const usage of ["attached", "session", "durable"]) {
	test(`${usage}: fresh same-generation consent rechecks the current route`, {
		timeout: 30000,
	}, async () => {
		const fixture = await createPreparedFixture(undefined, {
			fixture: "unknown",
			usage,
			runtimeObservations: true,
		});
		try {
			const route = await fixture.start();
			assert.equal(route.verification.status, "verified");
			assert.equal(route.published, route.origin);
			const initial = await fixture.gozar.routeStatus({ home: fixture.home, handle: route.handle });
			assert.equal(initial.verification.status, "verified", "Re-consent needs a current initial proof");
			assert.equal(initial.published, route.origin);
			await fixture.registry.setRuntimeCost("paid");
			const changed = await fixture.gozar
				.routeStatus({ home: fixture.home, handle: route.handle })
				.catch((error) => error.route);
			assert.equal(changed.published, null);
			const review = await fixture.gozar.reviewRouteConsent({
				home: fixture.home,
				handle: route.handle,
			});
			assert.equal(review.scope.kind, "route");
			assert.ok(review.facts);
			assert.ok(review.disclosures);
			const refreshed = await fixture.gozar.approveRouteConsent({
				home: fixture.home,
				handle: route.handle,
				approvalToken: review.approvalToken,
				consentFactsDigest: review.consentFactsDigest,
			});
			assert.deepEqual(refreshed.handle, route.handle);
			assert.equal(refreshed.verification.status, "verified");
			assert.equal(refreshed.published, refreshed.origin);
		} finally {
			await fixture.close();
		}
	});
}

test("a data-only consent row invalidates the earlier route approval", {
	timeout: 30000,
}, async () => {
	const fixture = await createPreparedFixture(undefined, {
		fixture: "unknown",
	});
	let failure, freshFixture;
	try {
		const { readFile, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const path = join(
			fixture.registry.root,
			fixture.registry.manifest.providers[0].definition,
		);
		const definition = JSON.parse(await readFile(path, "utf8"));
		definition.adapter.facts.push(fixture.registry.addedFact);
		await writeFile(path, JSON.stringify(definition));
		const starts = await fixture.startCount();
		await assert.rejects(fixture.start(), { code: "artifact_integrity_failed" });
		assert.equal(await fixture.startCount(), starts, "An old registry approval causes zero provider starts");
		freshFixture = await createPreparedFixture(undefined, { fixture: "unknown", addedFacts: [fixture.registry.addedFact] });
		const freshFactory = freshFixture.gozar;
		const fresh = (await freshFactory.catalogRoutes(freshFixture.request)).candidates[0];
		assert.equal(await readFile(join(fixture.registry.root, "providers", fixture.request.providerId, "index.mjs"), "utf8"), await readFile(join(freshFixture.registry.root, "providers", freshFixture.request.providerId, "index.mjs"), "utf8"), "Only declared data changes between registry deployments");
		assert.notEqual(
			fresh.consentFactsDigest,
			fixture.request.approval.consentFactsDigest,
		);
		assert.ok(
			fresh.consent.facts.some(
				(fact) =>
					fact.id === fixture.registry.addedFact.id &&
					fact.value === fixture.registry.addedFact.value,
			),
		);
		await assert.rejects(freshFactory.expose({
			...freshFixture.request, operationId: randomUUID(),
			approval: { ...freshFixture.request.approval, candidateToken: fresh.candidateToken, disclosureRevision: fresh.disclosure.revision, consentFactsDigest: fixture.request.approval.consentFactsDigest },
		}), { code: "consent_mismatch" });
		assert.equal(await freshFixture.startCount(), 0, "A fresh token does not authorize the previous digest");
		const latest = (await freshFactory.catalogRoutes(freshFixture.request)).candidates[0];
		const route = await freshFactory.expose({
			...freshFixture.request, operationId: randomUUID(),
			approval: { kind: "route", candidateToken: latest.candidateToken, disclosureRevision: latest.disclosure.revision, consentFactsDigest: latest.consentFactsDigest },
		});
		assert.equal(route.verification.status, "verified");
		assert.equal(route.published, route.origin);
		const closed = await freshFactory.closeRoute({ home: freshFixture.home, handle: route.handle, mode: "remove" });
		assert.equal(closed.cleanup.state, "confirmed");
	} catch (error) {
		failure = error;
	} finally {
		if (freshFixture) {
			try { await freshFixture.close(); } catch (error) { failure = failure ? new AggregateError([failure, error], "New-fact assertions and fresh cleanup failed") : error; }
		}
		await completeFixture(fixture, failure);
	}
});
