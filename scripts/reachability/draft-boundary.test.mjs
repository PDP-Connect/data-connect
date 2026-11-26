import { completeFixture } from "./journey-support.mjs";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createGozar } from "@tnunamak/gozar";
import { fakeRegistry } from "@tnunamak/gozar/testing";
import { setupApproval } from "./journey-support.mjs";
import { createPreparedFixture } from "./prepared-fixture.mjs";

async function fresh(fixture, draft) {
	return fixture.gozar.readConfigurationDraft({
		home: fixture.home,
		owner: fixture.owner,
		providerId: fixture.request.providerId,
		draftId: draft.draftId,
	});
}
function fieldAction(draft, kind) {
	const action = draft.configuration.actions.find(
		(action) => action.kind === kind,
	);
	assert.ok(action, `Required fixture action missing: ${kind}`);
	return action;
}
async function clear(fixture, draft) {
	const action = fieldAction(draft, "clear-input");
	const configuration = await fixture.gozar.clearConfigurationInput({
		home: fixture.home,
		owner: fixture.owner,
		providerId: fixture.request.providerId,
		draftId: draft.draftId,
		inputId: action.inputId,
		expectedConfigurationRevision: draft.configuration.revision,
		approval: setupApproval(action),
	});
	return { ...draft, configuration };
}
async function bind(fixture, draft, value) {
	const action = fieldAction(draft, "provide-secret");
	const input = draft.configuration.inputRequirements.find(
		(field) => field.actionId === action.id && field.secret,
	);
	assert.ok(input);
	const stored = await fixture.gozar.storeSecret({
		home: fixture.home,
		owner: fixture.owner,
		providerId: fixture.request.providerId,
		draftId: draft.draftId,
		inputId: input.id,
		scopeId: draft.scopeId,
		expectedConfigurationRevision: draft.configuration.revision,
		bytes: new TextEncoder().encode(value),
	});
	assert.equal(stored.configurationRevision, draft.configuration.revision);
	assert.equal(stored.scopeId, draft.scopeId);
	const result = await fixture.gozar.runSetupAction({
		home: fixture.home,
		owner: fixture.owner,
		providerId: fixture.request.providerId,
		draftId: draft.draftId,
		actionId: action.id,
		expectedConfigurationRevision: draft.configuration.revision,
		approval: setupApproval(action),
		secretHandle: stored.handle,
	});
	assert.equal(result.configurationRevision, result.configuration.revision);
	assert.equal(result.scopeId, result.configuration.scopeId);
	return {
		draft: { ...draft, configuration: result.configuration },
		handle: stored.handle,
	};
}

test("draft rotation preserves the old credential, guards live commit, and promotes only after close", {
	timeout: 60000,
}, async () => {
	const fixture = await createPreparedFixture();
	try {
		const catalog = await fixture.gozar.catalogRoutes(fixture.request),
			applied = catalog.candidates[0].configuration;
		let draft = await fixture.gozar.beginConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: fixture.request.providerId,
			expectedConfigurationRevision: applied.revision,
		});
		const oldHandles = fixture.backend.handles();
		assert.ok(oldHandles.length);
		const route = await fixture.gozar.expose(fixture.request);
		draft = await clear(fixture, draft);
		const staged = await bind(fixture, draft, `${fixture.canary}-replacement`);
		draft = staged.draft;
		const oldStillPresent = await fixture.backend.withSecret(
			{ scopeId: applied.scopeId, handle: oldHandles[0] },
			async (bytes) => new TextDecoder().decode(bytes) === fixture.canary,
		);
		assert.ok(
			oldStillPresent,
			"Rotation erased the old credential before close and commit",
		);
		await assert.rejects(
			fixture.gozar.discardSecret({
				home: fixture.home,
				owner: fixture.owner,
				handle: oldHandles[0],
			}),
			{ code: "secret_in_use" },
		);
		await assert.rejects(
			fixture.gozar.commitConfigurationDraft({
				home: fixture.home,
				owner: fixture.owner,
				providerId: fixture.request.providerId,
				draftId: draft.draftId,
				expectedConfigurationRevision: draft.configuration.revision,
			}),
			{ code: "configuration_in_use" },
		);
		const revision = draft.configuration.revision,
			writes = fixture.backend.trace.filter((item) =>
				["put", "delete"].includes(item),
			).length;
		const action = fieldAction(draft, "provide-secret");
		await assert.rejects(
			fixture.gozar.runSetupAction({
				home: fixture.home,
				owner: fixture.owner,
				providerId: fixture.request.providerId,
				draftId: draft.draftId,
				actionId: action.id,
				expectedConfigurationRevision: "stale-revision",
				approval: setupApproval(action),
				secretHandle: staged.handle,
			}),
			{ code: "configuration_stale" },
		);
		assert.equal(
			(await fresh(fixture, draft)).configuration.revision,
			revision,
		);
		assert.equal(
			fixture.backend.trace.filter((item) => ["put", "delete"].includes(item))
				.length,
			writes,
		);
		const closed = await fixture.gozar.closeRoute({
			home: fixture.home,
			owner: fixture.owner,
			handle: route.handle,
			mode: "remove",
		});
		assert.equal(closed.cleanup.state, "confirmed");
		const committed = await fixture.gozar.commitConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: fixture.request.providerId,
			draftId: draft.draftId,
			expectedConfigurationRevision: draft.configuration.revision,
		});
		assert.equal(committed.scopeId, applied.scopeId);
		assert.ok(
			fixture.backend.trace.includes("use"),
			"The real controller never resolved the host backend",
		);
	} finally {
		await fixture.close();
	}
});

test("a locked backend reads unknown and approved clear/discard deletes only draft-owned staged bytes", {
	timeout: 60000,
}, async () => {
	const fixture = await createPreparedFixture();
	try {
		const applied = (await fixture.gozar.catalogRoutes(fixture.request))
			.candidates[0].configuration;
		let draft = await fixture.gozar.beginConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: fixture.request.providerId,
			expectedConfigurationRevision: applied.revision,
		});
		draft = await clear(fixture, draft);
		const staged = await bind(fixture, draft, `${fixture.canary}-discard`);
		draft = staged.draft;
		fixture.backend.locked = true;
		const locked = await fresh(fixture, draft),
			presences = Object.values(locked.configuration.credentials);
		assert.ok(presences.length);
		for (const presence of presences) {
			assert.equal(presence.known, false);
			assert.equal(presence.reason, "secret_backend_locked");
		}
		fixture.backend.locked = false;
		draft = await clear(fixture, await fresh(fixture, draft));
		await fixture.gozar.discardConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: fixture.request.providerId,
			draftId: draft.draftId,
		});
		await fixture.gozar.discardSecret({
			home: fixture.home,
			owner: fixture.owner,
			handle: staged.handle,
		});
		assert.deepEqual(
			await fixture.backend.presence({
				scopeId: draft.scopeId,
				handle: staged.handle,
			}),
			{ known: true, value: false },
		);
	} finally {
		fixture.backend.locked = false;
		await fixture.close();
	}
});

test("unknown and cross-provider draft/secret references fail explicitly with zero binding effects", {
	timeout: 60000,
}, async () => {
	const fixture = await createPreparedFixture();
	let other;
	try {
		await assert.rejects(
			fixture.gozar.readConfigurationDraft({
				home: fixture.home,
				owner: fixture.owner,
				providerId: fixture.request.providerId,
				draftId: "unknown-draft",
			}),
		);
		const spec = fixture.registry.specification;
		assert.ok(spec.secondId);
		other = await fakeRegistry({
			...spec,
			id: spec.secondId,
			dir: fixture.registry.root,
		});
		const gozar = createGozar({
			...fixture.factoryOptions,
			manifest: {
				providers: [
					...fixture.registry.manifest.providers,
					...other.manifest.providers,
				],
			},
		});
		const inventory = await gozar.listProviders({
			home: fixture.home,
			owner: fixture.owner,
			owner: fixture.owner,
		});
		const target = inventory.providers.find(
			(provider) => provider.providerId === spec.secondId,
		);
		assert.ok(target);
		const draft = await gozar.beginConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: target.providerId,
			expectedConfigurationRevision: target.configuration.revision,
		});
		const action = fieldAction(draft, "provide-secret"),
			writes = fixture.backend.trace.filter((item) =>
				["put", "delete"].includes(item),
			).length;
		await assert.rejects(
			gozar.runSetupAction({
				home: fixture.home,
				owner: fixture.owner,
				providerId: target.providerId,
				draftId: draft.draftId,
				actionId: action.id,
				expectedConfigurationRevision: draft.configuration.revision,
				approval: setupApproval(action),
				secretHandle: fixture.backend.handles()[0],
			}),
		);
		assert.equal(
			(
				await gozar.readConfigurationDraft({
					home: fixture.home,
					owner: fixture.owner,
					providerId: target.providerId,
					draftId: draft.draftId,
				})
			).configuration.revision,
			draft.configuration.revision,
		);
		assert.equal(
			fixture.backend.trace.filter((item) => ["put", "delete"].includes(item))
				.length,
			writes,
		);
	} finally {
		await other?.cleanup();
		await fixture.close();
	}
});

test("public library approval-kind mismatches cause zero setup or route effects", {
	timeout: 30000,
}, async () => {
	const fixture = await createPreparedFixture();
	let failure;
	try {
		const provider = fixture.request.providerId;
		const applied = (await fixture.gozar.catalogRoutes(fixture.request))
			.candidates[0].configuration;
		const draft = await fixture.gozar.beginConfigurationDraft({
			home: fixture.home,
			owner: fixture.owner,
			providerId: provider,
			expectedConfigurationRevision: applied.revision,
		});
		const action = fieldAction(draft, "provide-secret");
		const writes = fixture.backend.trace.filter((event) =>
			["put", "delete"].includes(event),
		).length;
		const starts = await fixture.startCount();
		await assert.rejects(
			fixture.gozar.runSetupAction({
				home: fixture.home,
				owner: fixture.owner,
				providerId: provider,
				draftId: draft.draftId,
				expectedConfigurationRevision: draft.configuration.revision,
				actionId: action.id,
				approval: fixture.request.approval,
			}),
		);
		await assert.rejects(
			fixture.gozar.expose({
				...fixture.request,
				approval: setupApproval(action),
			}),
		);
		assert.equal(
			fixture.backend.trace.filter((event) => ["put", "delete"].includes(event))
				.length,
			writes,
		);
		assert.equal(await fixture.startCount(), starts);
	} catch (error) {
		failure = error;
	} finally {
		await completeFixture(fixture, failure);
	}
});
