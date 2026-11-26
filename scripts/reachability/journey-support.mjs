// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";

const fixtureData = JSON.parse(
	readFileSync(
		new URL(
			"../../reference-implementation/test/fixtures/reachability/effects.json",
			import.meta.url,
		),
		"utf8",
	),
);

async function freeLocalPort() {
	const listener = net.createServer();
	listener.listen(0, "localhost");
	await once(listener, "listening");
	const value = String(listener.address().port);
	listener.close();
	await once(listener, "close");
	return value;
}
// The address the fixture host reports for its one non-internal unicast interface.
function observedInterfaceAddress() {
	const rows = Object.values(
		fixtureData["recipe/probe"].interfaces.interfaces,
	).flat();
	const external = rows.filter((row) => row.internal === false);
	assert.equal(
		external.length,
		1,
		"The fixture inventory must hold exactly one non-internal interface",
	);
	return external[0].address;
}
const inputSources = {
	"observed-interface-address": async () => observedInterfaceAddress(),
	"free-local-port": freeLocalPort,
};
// A free-text input is answered only from a declared mapping keyed by its
// public id; an unmapped input is a fixture gap, never a guess.
async function textInputValue(field, action) {
	const id = field?.id ?? action.id;
	const mapping = fixtureData["owner-inputs"]?.[id];
	assert.ok(mapping, `No fixture mapping for required text input "${id}"`);
	const source = inputSources[mapping.from];
	assert.ok(
		source,
		`Fixture input "${id}" names unknown source "${mapping.from}"`,
	);
	return source();
}
export function setupApproval(action) {
	assert.equal(action.consent?.scope.kind, "setup");
	assert.ok(
		action.consent.facts && action.consent.disclosures,
		"Setup needs the exact visible snapshot",
	);
	return {
		kind: "setup",
		digest: action.digest,
		disclosureRevision: action.disclosure.revision,
		consentFactsDigest: action.consent.consentFactsDigest,
	};
}
export function mutationCount(events, backend) {
	return (
		events.filter((event) =>
			["open", "close", "run", "request"].includes(event.operation),
		).length +
		backend.trace.filter((event) => ["put", "delete"].includes(event)).length
	);
}
export async function prepareDraft(api, provider, canary, events, backend) {
	let draft = await api.call("/drafts", {
		providerId: provider.providerId,
		expectedRevision: provider.configuration.revision,
	});
	const initial = draft.configuration.revision;
	const reload = await api.call(
		`/drafts/${draft.draftId}?providerId=${encodeURIComponent(provider.providerId)}`,
	);
	assert.equal(reload.configuration.revision, initial);
	const attempted = new Set();
	for (;;) {
		const config = draft.configuration;
		const action = config.actions.find(
			(action) =>
				!attempted.has(action.id) &&
				!action.step && // This fixture drives the legacy draft endpoint.
				[
					"provide-secret",
					"provide-value",
					"install-artifact",
					"gozar-runs",
				].includes(action.kind),
		);
		if (!action) break;
		attempted.add(action.id);
		const field = config.inputRequirements.find(
			(field) => field.actionId === action.id,
		);
		const writes = mutationCount(events, backend);
		const stale = await api.request(
			`/drafts/${draft.draftId}/actions/${encodeURIComponent(action.id)}`,
			{ expectedRevision: "stale-revision", approval: setupApproval(action) },
		);
		assert.equal(stale.error?.code, "configuration_stale");
		assert.equal(mutationCount(events, backend), writes);
		const wrongKind = await api.request(
			`/drafts/${draft.draftId}/actions/${encodeURIComponent(action.id)}`,
			{
				expectedRevision: config.revision,
				approval: { kind: "route", candidateToken: "wrong-kind" },
			},
		);
		assert.equal(wrongKind.error?.code, "consent_kind_mismatch");
		assert.equal(mutationCount(events, backend), writes);
		const value =
			action.kind !== "provide-value"
				? undefined
				: field?.kind === "domain"
					? "fixture.invalid"
					: field?.kind === "https-origin"
						? "https://fixture.invalid"
						: await textInputValue(field, action);
		const configuration = await api.call(
			`/drafts/${draft.draftId}/actions/${encodeURIComponent(action.id)}`,
			{
				expectedRevision: config.revision,
				approval: setupApproval(action),
				...(action.kind === "provide-secret"
					? { secret: canary }
					: action.kind === "provide-value"
						? { value }
						: {}),
			},
		);
		// The HTTP projection and a fresh public read must describe the same scope.
		const fresh = await api.call(
			`/drafts/${draft.draftId}?providerId=${encodeURIComponent(provider.providerId)}`,
		);
		assert.equal(configuration.revision, fresh.configuration.revision);
		assert.equal(configuration.scopeId, fresh.configuration.scopeId);
		draft = { ...draft, configuration };
	}
	return draft;
}

export async function closeOwnedCase(gozar, home, owner) {
	let confirmed = true;
	for (const route of (await gozar.listRoutes({ home, owner })).routes) {
		if (route.ownership !== "gozar-owned") continue;
		let closed = await gozar.closeRoute({
			home,
			handle: route.handle,
			mode: "remove",
		});
		if (closed.cleanup.state !== "confirmed")
			closed = await gozar.closeRoute({
				home,
				handle: route.handle,
				mode: "remove",
			});
		if (closed.cleanup.state !== "confirmed") confirmed = false;
	}
	return confirmed;
}

export async function completeFixture(fixture, failure) {
	try {
		await fixture.close();
	} catch (cleanup) {
		if (failure)
			throw new AggregateError(
				[failure, cleanup],
				"Journey assertion and cleanup both failed",
			);
		throw cleanup;
	}
	if (failure) throw failure;
}
