// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultProviderInvalidationProofStore } from "../server/stores/provider-invalidation-proof-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
const CONNECTOR_ID = "provider_invalidation_pg_connector";
const INSTANCE_ID = "cin_test_provider_invalidation_pg";
const NOW = "2026-05-20T12:00:00.000Z";

test("dedicated PostgreSQL: deleting a connection removes its provider invalidation proofs", {
	skip: POSTGRES_URL
		? false
		: "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
	assert.ok(
		POSTGRES_URL,
		"dedicated PostgreSQL URL is configured when this test runs",
	);
	await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
	try {
		await postgresQuery(
			"INSERT INTO connectors(connector_id, manifest) VALUES ($1, '{}'::jsonb) ON CONFLICT DO NOTHING",
			[CONNECTOR_ID],
		);
		await createPostgresConnectorInstanceStore().upsert({
			connectorId: CONNECTOR_ID,
			connectorInstanceId: INSTANCE_ID,
			createdAt: NOW,
			displayName: "Browser connection",
			ownerSubjectId: "owner_local",
			sourceBinding: { kind: "account" },
			sourceBindingKey: "account-browser",
			sourceKind: "account",
			status: "active",
			updatedAt: NOW,
		});
		const store = getDefaultProviderInvalidationProofStore();
		await store.record({
			connection_id: INSTANCE_ID,
			evidence_id: "run_pg_1",
			kind: "provider_invalidation_proof",
			observed_at: NOW,
			provider: CONNECTOR_ID,
			verified: true,
		});
		assert.ok((await store.load(INSTANCE_ID)).proof);
		await postgresQuery(
			"DELETE FROM connector_instances WHERE connector_instance_id = $1",
			[INSTANCE_ID],
		);
		assert.equal((await store.load(INSTANCE_ID)).proof, null);
	} finally {
		await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [
			CONNECTOR_ID,
		]);
		await closePostgresStorage();
	}
});
