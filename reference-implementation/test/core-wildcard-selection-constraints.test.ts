// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Core §5/§6 wildcard note: a wildcard request's fields, resources, view and
 * time_range apply to every expanded stream and are validated per stream, as
 * for a concrete request. They must never be silently dropped.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import { resolveCoreSelection } from "../server/core-source-authorization.ts";
import { sourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/chatgpt";
const entry = readPolyfillManifests().find(
	(candidate) => candidate.file === "chatgpt.json",
);
assert.ok(entry, "expected the shipped ChatGPT manifest");

function declaration() {
	return structuredClone(
		sourceDeclarationFromLegacyConnectorManifest(entry?.manifest as never, {
			connectorImplementationId: CONNECTOR_ID,
			declarationVersion: "1",
			publisherId: "https://registry.pdpp.dev",
			sourceId: CONNECTOR_ID,
		}),
	) as any;
}

const SINCE = "2026-03-01T00:00:00.000Z";

test("wildcard fields keep the projection on every expanded stream", () => {
	const decl = declaration();
	decl.streams = decl.streams.filter((s: any) => s.selection.fields);
	const resolved = resolveCoreSelection(
		{ streams: [{ fields: ["id"], name: "*" }] },
		decl,
	);
	assert.equal(resolved.length, decl.streams.length);
	for (const stream of resolved) {
		const declared = decl.streams.find((s: any) => s.name === stream.name);
		const expected = [...new Set(["id", ...(declared.schema.required ?? [])])];
		assert.deepEqual(stream.fields, expected, stream.name);
	}
	assert.ok(resolved.some((s) => (s.fields?.length ?? 0) < 5));
});

test("wildcard resources keep the resource constraint on every expanded stream", () => {
	const decl = declaration();
	decl.streams = decl.streams.filter(
		(s: any) => s.selection.resources && s.primary_key.length === 1,
	);
	assert.ok(decl.streams.length > 0);
	const resolved = resolveCoreSelection(
		{ streams: [{ name: "*", resources: ["only-this"] }] },
		decl,
	);
	assert.equal(resolved.length, decl.streams.length);
	for (const stream of resolved) {
		assert.deepEqual(stream.resources, ["only-this"], stream.name);
	}
});

test("wildcard resources reject when an expanded stream does not support them", () => {
	const decl = declaration();
	decl.streams[0].selection.resources = false;
	assert.throws(
		() =>
			resolveCoreSelection(
				{ streams: [{ name: "*", resources: ["x"] }] },
				decl,
			),
		new RegExp(`Stream '${decl.streams[0].name}'`),
	);
});

test("wildcard time_range is kept when every expanded stream has consent_time_field", () => {
	const decl = declaration();
	decl.streams = decl.streams.filter((s: any) => s.consent_time_field);
	assert.ok(decl.streams.length > 0);
	const resolved = resolveCoreSelection(
		{ streams: [{ name: "*", time_range: { since: SINCE } }] },
		decl,
	);
	assert.equal(resolved.length, decl.streams.length);
	for (const stream of resolved) {
		const declared = decl.streams.find((s: any) => s.name === stream.name);
		assert.deepEqual(stream.time_constraint, {
			field: declared.consent_time_field,
			since: SINCE,
		});
	}
});

test("wildcard time_range rejects, naming a stream without consent_time_field", () => {
	const decl = declaration();
	const target = decl.streams[0];
	delete target.consent_time_field;
	assert.throws(
		() =>
			resolveCoreSelection(
				{ streams: [{ name: "*", time_range: { since: SINCE } }] },
				decl,
			),
		new RegExp(`Stream '${target.name}' does not support time_range`),
	);
});

test("wildcard view that is not declared on an expanded stream rejects", () => {
	assert.throws(
		() =>
			resolveCoreSelection(
				{ streams: [{ name: "*", view: "no-such-view" }] },
				declaration(),
			),
		/Unknown view 'no-such-view'/,
	);
});

test("wildcard with no extra parameters expands to every stream with full fields", () => {
	const decl = declaration();
	const resolved = resolveCoreSelection({ streams: [{ name: "*" }] }, decl);
	assert.equal(resolved.length, decl.streams.length);
	for (const stream of resolved) {
		assert.equal(stream.resources, undefined);
		assert.equal(stream.time_constraint, undefined);
	}
});

test("concrete stream constraints are unchanged", () => {
	const resolved = resolveCoreSelection(
		{
			streams: [
				{
					fields: ["id"],
					name: "messages",
					resources: ["r1"],
					time_range: { since: SINCE },
				},
			],
		},
		declaration(),
	);
	assert.equal(resolved.length, 1);
	assert.deepEqual(resolved[0]?.resources, ["r1"]);
	assert.equal(resolved[0]?.time_constraint?.since, SINCE);
	assert.ok(resolved[0]?.fields?.includes("id"));
});
