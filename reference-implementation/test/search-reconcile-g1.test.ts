// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import {
	__setLexicalBackfillPhaseHookForTest,
	lexicalIndexBackfillForManifest,
} from "../server/search.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
	configureSemanticBackend,
	resetVectorIndexForTests,
} from "../server/search-semantic.ts";
import {
	isSearchIndexScopeDirty,
	listDirtySearchIndexScopes,
	markSearchIndexDirtySqlite,
} from "../server/stores/search-index-dirty-store.ts";

function manifest(connectorId: string, semantic = false) {
	return {
		capabilities: { human_interaction: [] },
		connector_id: connectorId,
		display_name: connectorId,
		manifest_uri: `https://sources.example/${connectorId}`,
		protocol_version: "0.1.0",
		version: "0.1.0",
		streams: [
			{
				name: "items",
				primary_key: ["id"],
				query: {
					search: semantic
						? { lexical_fields: ["subject"], semantic_fields: ["subject"] }
						: { lexical_fields: ["subject"] },
				},
				schema: {
					type: "object",
					properties: { id: { type: "string" }, subject: { type: "string" } },
					required: ["id", "subject"],
				},
				selection: { fields: true, resources: true },
				semantics: "mutable_state",
			},
		],
	};
}

async function seed(connectorId: string, instance: string, key = "k1") {
	const outcome = await ingestRecord(
		{ connector_id: connectorId, connector_instance_id: instance },
		{
			stream: "items",
			key,
			emitted_at: "2026-07-16T00:00:00.000Z",
			data: { id: key, subject: `canonical ${key}` },
		},
		{ deferIndexes: true },
	);
	assert.equal(outcome.accepted, true);
}

function mark(connectorId: string, instance: string) {
	markSearchIndexDirtySqlite(
		{ connectorId, connectorInstanceId: instance, stream: "items" },
		"2026-07-16T00:00:00.000Z",
	);
}

async function scope(instance: string) {
	const result = (await listDirtySearchIndexScopes(100)).find(
		(s) => s.connectorInstanceId === instance && s.stream === "items",
	);
	assert.ok(result, "fixture must have an eligible dirty scope");
	return result;
}

function lexicalRows(instance: string) {
	return getDb()
		.prepare(
			"SELECT rowid, record_key, field, text FROM lexical_search_index " +
				"WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key, field, rowid",
		)
		.all(instance, "items");
}

function reset() {
	__setLexicalBackfillPhaseHookForTest(null);
	configureSemanticBackend(null);
	resetVectorIndexForTests();
	closeDb();
}

test("G1: lexical index-only cleanup debt is removed before dirty completion", {
	concurrency: false,
	timeout: 15000,
}, async (t) => {
	for (const removed of [false, true]) {
		await t.test(
			removed ? "removed stream" : "retained stream without lexical fields",
			async () => {
				initDb(":memory:");
				configureSemanticBackend(null);
				const connectorId = "gap-lex-meta";
				const instance = "cin_gap_lex_meta";
				const sibling = "cin_gap_lex_meta_sibling";
				const m = manifest(connectorId);
				try {
					await registerConnector(m);
					await seed(connectorId, instance);
					await seed(connectorId, sibling);
					for (const id of [instance, sibling]) {
						await lexicalIndexBackfillForManifest({
							manifest: {
								...m,
								storage_binding: { connector_instance_id: id },
							},
						});
					}
					assert.equal(
						lexicalRows(instance).length,
						1,
						"real index row must exist",
					);
					const siblingBefore = lexicalRows(sibling);
					getDb()
						.prepare(
							"DELETE FROM lexical_search_meta WHERE connector_instance_id = ? AND stream = ?",
						)
						.run(instance, "items");
					const original = m.streams[0]!;
					const changed = {
						...m,
						streams: [
							{
								...original,
								name: removed ? "other" : "items",
								query: { search: {} },
							},
						],
					};
					await registerConnector(changed, { backfillRetrievalIndexes: false });
					mark(connectorId, instance);
					const result = await reconcileSearchIndexDirtyScope(
						await scope(instance),
					);
					assert.deepEqual(
						lexicalRows(instance),
						[],
						"meta absence must not hide physical cleanup debt",
					);
					assert.equal(result.outcome, "converged");
					assert.equal(
						await isSearchIndexScopeDirty({
							connectorInstanceId: instance,
							stream: "items",
						}),
						false,
					);
					assert.deepEqual(
						lexicalRows(sibling),
						siblingBefore,
						"repair remains exact-instance scoped",
					);
				} finally {
					reset();
				}
			},
		);
	}
});
