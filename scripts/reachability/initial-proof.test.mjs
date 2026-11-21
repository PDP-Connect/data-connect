// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { createEffectFixtures } from "./effect-fixtures.ts";
import { prepareDraft } from "./journey-support.mjs";
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs";
import { createEffectFixtureHost } from "./testing-effects.mjs";

test("pending initial stream proof cannot publish through concurrent status or watch", {
	timeout: 30000,
}, async () => {
	const parent = join(homedir(), ".tmp", "ra");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const root = await mkdtemp(join(parent, "proof-")),
		home = join(root, "g");
	const backend = new FixtureSecretBackend(),
		canary = randomBytes(32).toString("hex");
	const identity = { instanceId: randomUUID(), bootId: randomUUID() };
	const hostCapabilities = Object.fromEntries(
		[
			"installer.execute",
			"runtime.attached",
			"runtime.durable",
			"secrets.backend",
		].map((id) => [id, { known: true, value: true }]),
	);
	const effects = createEffectFixtures({
		streamDelayMs: 2500,
		failInitialStream: true,
	});
	const harness = await createEffectFixtureHost(
		{ secretBackend: backend, hostCapabilities, identity },
		effects.effects,
	);
	const app = http.createServer((_req, res) => res.end("fixture application"));
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	let api, route;
	const abort = new AbortController();
	try {
		const inventory = await harness.gozar.listProviders({
			home,
			owner: "fixture-owner",
			refresh: true,
		});
		const provider = inventory.providers.find(
			(p) =>
				p.transport === "https" &&
				p.availability.attached.state === "action-required" &&
				p.configuration.inputRequirements.length === 2 &&
				p.configuration.inputRequirements.some(
					(field) => field.kind === "domain",
				),
		);
		assert.ok(
			provider,
			"No admitted HTTPS fixture with declared domain and credential inputs",
		);
		const query = {
			schemaVersion: 1,
			home,
			owner: "fixture-owner",
			target: `127.0.0.1:${app.address().port}`,
			providerId: provider.providerId,
			usage: { kind: "attached" },
			requirements: {
				reach: provider.reach,
				transport: "https",
				payloadAccess: "allow-provider",
				address: "any",
				setup: "allow",
				protocols: ["sse"],
			},
		};
		api = await createOwnerHttpFixture(
			harness.gozar,
			query,
			root,
			canary,
			identity,
			hostCapabilities,
		);
		const draft = await prepareDraft(
			api,
			provider,
			canary,
			harness.events,
			backend,
		);
		await api.call(`/drafts/${draft.draftId}/commit`, {
			expectedRevision: draft.configuration.revision,
		});
		const candidate = (await harness.gozar.catalogRoutes(query)).candidates[0];
		assert.ok(candidate.candidateToken);
		const initial = harness.gozar.expose({
			...query,
			operationId: randomUUID(),
			wait: "verified",
			approval: {
				kind: "route",
				candidateToken: candidate.candidateToken,
				disclosureRevision: candidate.disclosure.revision,
				consentFactsDigest: candidate.consentFactsDigest,
			},
		});
		initial.catch(() => {});
		const deadline = Date.now() + 8000;
		while (!effects.initialStreamSeen && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(
			effects.initialStreamSeen,
			"Initial stream must reach the actual owned gate",
		);
		const listed = await harness.gozar.listRoutes({
			home,
			owner: "fixture-owner",
		});
		route = listed.routes[0];
		assert.ok(route);
		const iterator = harness.gozar
			.watchRoutes({ home, handle: route.handle, signal: abort.signal })
			[Symbol.asyncIterator]();
		const pending = Symbol("pending");
		const observe = (promise) =>
			Promise.race([
				promise,
				new Promise((resolve) => setTimeout(() => resolve(pending), 100)),
			]);
		const values = await Promise.all([
			observe(harness.gozar.routeStatus({ home, handle: route.handle })),
			observe(iterator.next().then((event) => event.value?.route)),
		]);
		for (const value of values)
			if (value && value !== pending) {
				assert.equal(value.published, null);
				assert.notEqual(value.verification.status, "verified");
			}
		const result = await initial.catch((error) => error.route);
		assert.ok(result);
		assert.equal(result.published, null);
		assert.notEqual(result.verification.status, "verified");
		const status = await harness.gozar.routeStatus({
			home,
			handle: route.handle,
		});
		assert.equal(status.published, null);
		assert.notEqual(status.verification.status, "verified");
		assert.ok(
			!JSON.stringify({
				events: harness.events,
				responses: api.responses,
				logs: api.logs,
			}).includes(canary),
		);
	} finally {
		abort.abort();
		if (route)
			await harness.gozar.closeRoute({
				home,
				handle: route.handle,
				mode: "remove",
			});
		await api?.close();
		await harness.close();
		await effects.close();
		app.closeAllConnections();
		app.close();
		await once(app, "close");
		await rm(root, { recursive: true, force: true });
	}
});
