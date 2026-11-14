// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	statfs,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGozar } from "@tnunamak/gozar";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { createEffectFixtures } from "./effect-fixtures.ts";
import {
	closeOwnedCase,
	mutationCount,
	prepareDraft,
	setupApproval,
} from "./journey-support.mjs";
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs";
import { createEffectFixtureHost } from "./testing-effects.mjs";
import { createUnknownRegistry } from "./unknown-registry.mjs";

const matrix = [];
const output = process.env.GOZAR_COVERAGE_MATRIX;
const capabilities = Object.fromEntries(
	[
		"installer.execute",
		"privilege.elevate",
		"secrets.backend",
		"runtime.attached",
		"runtime.durable",
	].map((id) => [id, { known: true, value: id !== "privilege.elevate" }]),
);
const safeError = (error) =>
	typeof error?.code === "string" ? error.code : "unclassified_failure";
async function requireBudget() {
	const disk = await statfs(process.cwd());
	if (disk.bavail * disk.bsize < 105_000_000_000)
		throw Object.assign(new Error("NOT RUN (disk): need 105 GB free"), {
			code: "disk_floor",
		});
	assert.ok(output, "Set GOZAR_COVERAGE_MATRIX to an external evidence path");
}
async function persist() {
	if (!output) return;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		`${JSON.stringify({ source: process.env.GOZAR_SOURCE_SHA, sha256: process.env.GOZAR_TARBALL_SHA256, matrix }, null, 2)}\n`,
	);
}
async function assertNoCanary(root, canary) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) await assertNoCanary(path, canary);
		else if (entry.isFile())
			assert.ok(
				!(await readFile(path)).includes(Buffer.from(canary)),
				"Credential canary reached a Gozar file",
			);
	}
}
async function application() {
	const app = http.createServer((_request, response) =>
		response.end("fixture application"),
	);
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	return {
		target: `127.0.0.1:${app.address().port}`,
		close: async () => {
			app.closeAllConnections();
			app.close();
			await once(app, "close");
		},
	};
}
async function scratch() {
	const parent = join(homedir(), ".tmp", "ra");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	return mkdtemp(join(parent, "case-"));
}
async function bounded(promise, ms = 10000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							Object.assign(new Error("Public cleanup did not settle"), {
								code: "cleanup_timeout",
							}),
						),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function settle(api, operationId) {
	const deadline = Date.now() + 20000;
	for (;;) {
		const operation = await api.call(`/operations/${operationId}`);
		if (operation.stage !== "applying") return operation;
		if (Date.now() >= deadline)
			throw Object.assign(new Error("Host operation timed out"), {
				code: "operation_timeout",
			});
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
async function commonJourney(
	gozar,
	provider,
	usage,
	root,
	events,
	backend,
	canary,
	identity,
) {
	const app = await application();
	const query = {
		schemaVersion: 1,
		home: join(root, "gozar"),
		owner: "fixture-owner",
		target: app.target,
		requirements: {
			reach: provider.reach,
			transport: provider.transport === "http" ? "any" : provider.transport,
			payloadAccess: "allow-provider",
			address: "any",
			setup: "allow",
			protocols: [],
		},
	};
	const api = await createOwnerHttpFixture(
		gozar,
		query,
		root,
		canary,
		identity,
		capabilities,
	);
	let route;
	const violations = [];
	try {
		assert.ok(
			(await api.request("/catalog", undefined, { anonymous: true })).status >=
				400,
			"Anonymous inventory must be refused",
		);
		assert.ok(
			(
				await api.request(
					"/drafts",
					{
						providerId: provider.providerId,
						expectedRevision: provider.configuration.revision,
					},
					{ noCsrf: true },
				)
			).status >= 400,
			"Cookie mutation requires CSRF",
		);
		assert.ok(
			(
				await api.request(
					"/drafts",
					{
						providerId: provider.providerId,
						expectedRevision: provider.configuration.revision,
					},
					{ noCsrf: true, invalidBearer: true },
				)
			).status >= 400,
			"An unvalidated Authorization header cannot bypass cookie CSRF",
		);
		const currentCatalog = await api.call("/catalog");
		provider = currentCatalog.providers.find(
			(item) => item.providerId === provider.providerId,
		);
		assert.ok(provider);
		const draft = await prepareDraft(api, provider, canary, events, backend);
		await api.call(`/drafts/${draft.draftId}/commit`, {
			expectedRevision: draft.configuration.revision,
		});
		const review = await api.call(`/drafts/${draft.draftId}/review`, { usage });
		assert.equal(
			review.candidate.consent.consentFactsDigest,
			review.candidate.consentFactsDigest,
		);
		const writes = mutationCount(events, backend);
		assert.equal(
			(
				await api.request("/operations", {
					reviewId: review.id,
					kind: "setup",
					consentFactsDigest: review.candidate.consentFactsDigest,
				})
			).error?.code,
			"consent_kind_mismatch",
		);
		assert.equal(mutationCount(events, backend), writes);
		const operation = await api.call("/operations", {
			reviewId: review.id,
			kind: "route",
			consentFactsDigest: review.candidate.consentFactsDigest,
			acknowledgeDisconnect: true,
		});
		const outcome = await settle(api, operation.operationId);
		if (outcome.stage !== "settled")
			throw Object.assign(new Error("Start did not settle"), {
				code: outcome.failureCode,
				diagnostics: api.diagnostics,
				step: "apply",
			});
		const live = await api.call("/state");
		route = live.routes.find(
			(item) => item.operationId === operation.operationId,
		);
		assert.ok(route, "Owner state must expose the applied operation");
		assert.equal(route.verification.status, "verified");
		assert.equal(route.published, route.origin);
		assert.equal(route.verification.subject.instanceId, identity.instanceId);
		if (route.verification.subject.bootId !== identity.bootId)
			violations.push("proof_boot_identity_mismatch");
		assert.equal(route.verification.subject.target, query.target);
		assert.equal(
			route.verification.subject.handleGeneration,
			route.handle.generation,
		);
		backend.locked = true;
		const locked = await api.call("/catalog");
		const lockedProvider = locked.providers.find(
			(item) => item.providerId === provider.providerId,
		);
		for (const presence of Object.values(
			lockedProvider.configuration.credentials,
		)) {
			assert.equal(
				presence.known,
				false,
				"Locked backend must never report an absent credential",
			);
		}
		backend.locked = false;
		const watched = await api.call("/events");
		assert.ok(
			watched.routes.some((item) => item.handle.id === route.handle.id),
		);
		await api.call(`/routes/${route.handle.id}/check`, {
			generation: route.handle.generation,
		});
		const currentInventory = await api.call("/catalog");
		const current = currentInventory.providers.find(
			(item) => item.providerId === provider.providerId,
		);
		const edit = await api.call("/drafts", {
			providerId: provider.providerId,
			expectedRevision: current.configuration.revision,
		});
		const inUse = await api.request(`/drafts/${edit.draftId}/commit`, {
			expectedRevision: edit.configuration.revision,
		});
		assert.equal(inUse.error?.code, "configuration_in_use");
		// A rotation clears only the draft binding. Live credentials remain bound.
		const clear = edit.configuration.actions.find(
			(action) => action.kind === "clear-input",
		);
		if (clear) {
			const next = await api.call(
				`/drafts/${edit.draftId}/clear/${encodeURIComponent(clear.id)}`,
				{
					expectedRevision: edit.configuration.revision,
					approval: setupApproval(clear),
				},
			);
			edit.configuration = next;
			assert.equal(
				(
					await api.call(`/routes/${route.handle.id}/check`, {
						generation: route.handle.generation,
					})
				).handle.id,
				route.handle.id,
			);
		}
		const stopping = await api.call(`/routes/${route.handle.id}/stop`, {
			generation: route.handle.generation,
			acknowledgeDisconnect: true,
		});
		const stopOutcome = await settle(api, stopping.operationId);
		assert.equal(stopOutcome.stage, "settled");
		const first = (await api.call("/state")).routes.find(
			(item) => item.handle.id === route.handle.id,
		);
		if (first.cleanup.state === "unconfirmed") {
			assert.ok(
				first.cleanup.nextAction,
				"Cleanup debt must retain its retry action",
			);
			const retry = await api.call(`/routes/${route.handle.id}/stop`, {
				generation: route.handle.generation,
				acknowledgeDisconnect: true,
			});
			await settle(api, retry.operationId);
			const second = (await api.call("/state")).routes.find(
				(item) => item.handle.id === route.handle.id,
			);
			assert.equal(second.cleanup.state, "confirmed");
		} else assert.equal(first.cleanup.state, "confirmed");
		await api.call(`/drafts/${edit.draftId}/commit`, {
			expectedRevision: edit.configuration.revision,
		});
		await api.call(`/drafts/${edit.draftId}/discard`, {});
		const lastInventory = await api.call("/catalog");
		const last = lastInventory.providers.find(
			(item) => item.providerId === provider.providerId,
		);
		const abandoned = await api.call("/drafts", {
			providerId: provider.providerId,
			expectedRevision: last.configuration.revision,
		});
		await api.call(`/drafts/${abandoned.draftId}/discard`, {});
		assert.ok(
			!JSON.stringify({ events, responses: api.responses }).includes(canary),
		);
		for (const handle of backend.issuedHandles())
			assert.ok(
				!JSON.stringify({ events, responses: api.responses }).includes(handle),
				"Secret reference reached a browser response or event",
			);
		await assertNoCanary(query.home, canary);
		if (violations.length)
			throw Object.assign(new Error(violations.join(",")), {
				code: violations[0],
				expectedIdentity: identity,
				actualSubject: route.verification.subject,
			});
	} finally {
		backend.locked = false;
		if (route)
			await bounded(
				gozar.closeRoute({
					home: query.home,
					handle: route.handle,
					mode: "remove",
				}),
			).catch(() => {});
		await api.close();
		await app.close();
	}
}

test("every inventory provider/usage pair is accounted for through the owner HTTP journey", {
	timeout: 240000,
}, async () => {
	await requireBudget();
	const root = await scratch(),
		backend = new FixtureSecretBackend();
	const effects = createEffectFixtures({ uncertainCloseOnce: true });
	const identity = { instanceId: randomUUID(), bootId: randomUUID() };
	const harness = await createEffectFixtureHost(
		{ secretBackend: backend, hostCapabilities: capabilities, identity },
		effects.effects,
	);
	let retainEvidence = false;
	try {
		const inventory = await harness.gozar.listProviders({
			home: join(root, "discovery"),
			owner: "fixture-owner",
		});
		assert.ok(inventory.providers.length);
		const packageRoot = dirname(
			fileURLToPath(import.meta.resolve("@tnunamak/gozar/package.json")),
		);
		const manifest = JSON.parse(
			await readFile(join(packageRoot, "adapters/manifest.json"), "utf8"),
		);
		const declared = [];
		for (const entry of manifest.providers) {
			const data = JSON.parse(
				await readFile(join(packageRoot, "adapters", entry.definition), "utf8"),
			);
			for (const usage of (data.adapter ?? data).supportedKinds)
				declared.push({ providerId: entry.id, usage });
		}
		matrix.push(
			...declared.map((pair) => ({
				...pair,
				result: "blocked",
				reason: "journey-not-completed",
			})),
		);
		await persist();
		for (const pair of declared) {
			const provider = inventory.providers.find(
				(provider) => provider.providerId === pair.providerId,
			);
			assert.ok(provider, "Inventory silently omitted a registered provider");
			const usage = pair.usage,
				availability = provider.availability[usage];
			assert.ok(availability, "Inventory silently omitted a declared usage");
			const row = matrix.find(
				(row) => row.providerId === pair.providerId && row.usage === usage,
			);
			row.reason = null;
			if (!["http", "https"].includes(provider.transport)) {
				row.result = "detect-only (0.4 scope)";
				row.reason = availability.reason;
				row.admissionDataValid = availability.state === "detect-only";
				// This assertion intentionally blocks artifacts whose old data still
				// admits the real raw-stream adapters. The host UI does not hide them.
				if (!row.admissionDataValid)
					row.reason = "artifact-admission-data-not-yet-updated";
				else {
					const app = await application();
					try {
						const query = {
							schemaVersion: 1,
							home: join(root, "detect-only"),
							owner: "fixture-owner",
							providerId: provider.providerId,
							target: app.target,
							usage: { kind: usage },
							requirements: {
								reach: provider.reach,
								transport: provider.transport,
								payloadAccess: "allow-provider",
								address: "any",
								setup: "allow",
								protocols: [],
							},
						};
						const catalog = await harness.gozar.catalogRoutes(query);
						assert.equal(catalog.candidates[0].candidateToken, null);
						const before = mutationCount(harness.events, backend);
						try {
							await assert.rejects(
								harness.gozar.expose({
									...query,
									operationId: randomUUID(),
									wait: "verified",
									approval: {
										kind: "route",
										candidateToken: "not-authority",
										disclosureRevision: "none",
										consentFactsDigest: "none",
									},
								}),
								{ code: "unsupported" },
							);
						} catch (error) {
							row.redemption = {
								result: "fail",
								expected: "unsupported",
								actual: error.actual?.code ?? safeError(error),
							};
						}
						assert.equal(mutationCount(harness.events, backend), before);
					} finally {
						await app.close();
					}
				}
				continue;
			}
			if (
				availability.state === "detect-only" ||
				availability.state === "unsupported"
			) {
				row.result = "blocked";
				row.reason = availability.reason || "admitted-http-kind-not-executable";
				continue;
			}
			const caseRoot = join(root, randomUUID().slice(0, 8));
			await mkdir(caseRoot, { mode: 0o700 });
			const caseBackend = new FixtureSecretBackend(),
				caseIdentity = { instanceId: randomUUID(), bootId: randomUUID() };
			const caseEffects = createEffectFixtures({ uncertainCloseOnce: true });
			const caseHarness = await createEffectFixtureHost(
				{
					secretBackend: caseBackend,
					hostCapabilities: capabilities,
					identity: caseIdentity,
				},
				caseEffects.effects,
			);
			try {
				await commonJourney(
					caseHarness.gozar,
					provider,
					usage,
					caseRoot,
					caseHarness.events,
					caseBackend,
					randomBytes(32).toString("hex"),
					caseIdentity,
				);
				row.result = "pass";
			} catch (error) {
				row.result = safeError(error) === "unsupported" ? "blocked" : "fail";
				row.reason = safeError(error);
				row.step = error.step ?? null;
				row.diagnostics = error.diagnostics ?? null;
				row.expectedIdentity = error.expectedIdentity;
				row.actualSubject = error.actualSubject;
				row.detail = error.code === "ERR_ASSERTION" ? error.message : null;
			} finally {
				try {
					if (
						!(await bounded(
							closeOwnedCase(
								caseHarness.gozar,
								join(caseRoot, "gozar"),
								"fixture-owner",
							),
						))
					) {
						retainEvidence = true;
						row.cleanup = "unconfirmed";
						row.evidenceRoot = caseRoot;
					}
				} catch {
					retainEvidence = true;
					row.cleanup = "unconfirmed";
					row.evidenceRoot = caseRoot;
				}
				try {
					await bounded(caseHarness.close());
				} catch (error) {
					row.harnessClose = safeError(error);
					retainEvidence = true;
				}
				await caseEffects.close();
			}
			await persist();
		}
		assert.ok(
			matrix.every(
				(row) =>
					row.result === "pass" ||
					(row.result === "detect-only (0.4 scope)" &&
						row.admissionDataValid &&
						!row.redemption),
			),
			"Release blocked: see provider/usage matrix",
		);
	} finally {
		await persist();
		try {
			await bounded(harness.close());
		} catch (error) {
			matrix.push({
				result: "fail",
				stage: "harness-close",
				reason: safeError(error),
			});
		}
		await effects.close();
		if (!retainEvidence) await rm(root, { recursive: true, force: true });
	}
});

test("unknown provider uses the same owner HTTP path and current draft snapshots", {
	timeout: 60000,
}, async () => {
	await requireBudget();
	const root = await scratch(),
		registry = await createUnknownRegistry(join(root, "registry"));
	const backend = new FixtureSecretBackend(),
		identity = { instanceId: randomUUID(), bootId: randomUUID() };
	const row = {
		providerId: registry.specification.id,
		usage: "attached",
		registry: "fixture",
		result: "blocked",
		reason: "journey-not-completed",
	};
	matrix.push(row);
	const gozar = createGozar({
		manifest: registry.manifest,
		root: registry.root,
		secretBackend: backend,
		hostCapabilities: capabilities,
		identity,
	});
	try {
		const inventory = await gozar.listProviders({
			home: join(root, "discovery"),
		});
		assert.equal(inventory.providers.length, 1);
		await commonJourney(
			gozar,
			inventory.providers[0],
			"attached",
			root,
			[],
			backend,
			randomBytes(32).toString("hex"),
			identity,
		);
		row.result = "pass";
		row.reason = null;
	} catch (error) {
		row.result = "fail";
		row.reason = safeError(error);
		throw error;
	} finally {
		await persist();
		await registry.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("generic non-HTTP extension remains executable independently of real-adapter admission scope", {
	timeout: 60000,
}, async () => {
	await requireBudget();
	const root = await scratch(),
		registry = await createUnknownRegistry(join(root, "registry"), {
			fixture: "non-http",
		});
	const backend = new FixtureSecretBackend(),
		identity = { instanceId: randomUUID(), bootId: randomUUID() };
	const row = {
		providerId: registry.specification.id,
		usage: "attached",
		registry: "fixture",
		result: "blocked",
		reason: "journey-not-completed",
	};
	matrix.push(row);
	const gozar = createGozar({
		manifest: registry.manifest,
		root: registry.root,
		secretBackend: backend,
		hostCapabilities: capabilities,
		identity,
	});
	try {
		const inventory = await gozar.listProviders({
			home: join(root, "discovery"),
		});
		assert.equal(inventory.providers.length, 1);
		await commonJourney(
			gozar,
			inventory.providers[0],
			"attached",
			root,
			[],
			backend,
			randomBytes(32).toString("hex"),
			identity,
		);
		row.result = "pass";
		row.reason = null;
	} catch (error) {
		row.result = "fail";
		row.reason = safeError(error);
		throw error;
	} finally {
		await persist();
		await registry.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});
