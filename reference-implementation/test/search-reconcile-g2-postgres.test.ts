// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
	withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
	configureSemanticBackend,
	makeStubBackend,
	semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";
import {
	isSearchIndexScopeDirty,
	listDirtySearchIndexScopes,
	markSearchIndexDirtyPostgres,
} from "../server/stores/search-index-dirty-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function manifest(connectorId: string, semantic: boolean) {
	return {
		capabilities: { human_interaction: [] },
		connector_id: connectorId,
		display_name: connectorId,
		manifest_uri: `https://sources.example/${connectorId}`,
		protocol_version: "0.1.0",
		streams: [
			{
				name: "items",
				primary_key: ["id"],
				query: {
					search: semantic
						? { lexical_fields: ["subject"], semantic_fields: ["subject"] }
						: {},
				},
				schema: {
					properties: { id: { type: "string" }, subject: { type: "string" } },
					required: ["id", "subject"],
					type: "object",
				},
				selection: { fields: true, resources: true },
				semantics: "mutable_state",
			},
		],
		version: "0.1.0",
	};
}

async function getScope(instance: string) {
	const scope = (await listDirtySearchIndexScopes(100)).find(
		(candidate) =>
			candidate.connectorInstanceId === instance &&
			candidate.stream === "items",
	);
	assert.ok(scope);
	return scope;
}

test("G2 PostgreSQL: backend-unavailable vector-only debt retains dirty until physical cleanup", {
	skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
	timeout: 60_000,
}, async () => {
	assert.ok(POSTGRES_URL);
	await withTemporaryPostgresDatabase(
		{
			closeConnections: closePostgresStorage,
			connectionString: POSTGRES_URL,
			databaseName: `pdpp_search_reconcile_g2_${process.pid}_${Date.now().toString(36)}`,
		},
		async (databaseUrl) => {
			initDb(":memory:");
			await initPostgresStorage({ backend: "postgres", databaseUrl });
			const connectorId = "gap-g2-postgres";
			const instance = "gap-g2-postgres-instance";
			const backend = makeStubBackend({ dimensions: 8 });
			const semanticManifest = manifest(connectorId, true);
			try {
				configureSemanticBackend(backend);
				await registerConnector(semanticManifest, {
					backfillRetrievalIndexes: false,
				});
				const ingested = await ingestRecord(
					{ connector_id: connectorId, connector_instance_id: instance },
					{
						data: { id: "k1", subject: "canonical" },
						emitted_at: "2026-07-16T00:00:00.000Z",
						key: "k1",
						stream: "items",
					},
					{ deferIndexes: true },
				);
				assert.equal(ingested.accepted, true);
				await semanticIndexBackfillForManifest({
					manifest: {
						...semanticManifest,
						storage_binding: { connector_instance_id: instance },
					},
					orphanStreamCleanup: false,
				});
				const vectors = () =>
					postgresQuery(
						"SELECT record_key FROM semantic_search_blob WHERE connector_instance_id = $1 ORDER BY record_key",
						[instance],
					);
				assert.equal(
					(await vectors()).rows.length,
					1,
					"must exercise persisted PostgreSQL vector debt",
				);
				await postgresQuery(
					"DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = 'items'",
					[instance],
				);
				await postgresQuery(
					"DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = 'items'",
					[instance],
				);
				await registerConnector(manifest(connectorId, false), {
					backfillRetrievalIndexes: false,
				});
				configureSemanticBackend(null);
				await withPostgresTransaction(async (client) => {
					await markSearchIndexDirtyPostgres(
						client,
						{ connectorId, connectorInstanceId: instance, stream: "items" },
						"2026-07-16T00:00:00.000Z",
					);
				});
				const observed = await getScope(instance);
				const unavailable = await reconcileSearchIndexDirtyScope(observed);
				assert.equal(
					unavailable.outcome,
					"failed",
					"cleanup remains unproven without a backend",
				);
				assert.equal(
					await isSearchIndexScopeDirty({
						connectorInstanceId: instance,
						stream: "items",
					}),
					true,
				);
				assert.equal(
					(await vectors()).rows.length,
					1,
					"the unavailable pass must not claim absent vectors",
				);
				configureSemanticBackend(backend);
				assert.equal(
					(await reconcileSearchIndexDirtyScope(observed)).outcome,
					"converged",
				);
				assert.deepEqual((await vectors()).rows, []);
				assert.equal(
					await isSearchIndexScopeDirty({
						connectorInstanceId: instance,
						stream: "items",
					}),
					false,
				);
			} finally {
				configureSemanticBackend(null);
				await closePostgresStorage();
				closeDb();
			}
		},
	);
});
