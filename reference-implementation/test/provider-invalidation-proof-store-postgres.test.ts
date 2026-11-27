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

const ORDER_CONNECTOR_ID = "provider_invalidation_pg_order_connector";
const ORDER_INSTANCE_ID = "cin_test_provider_invalidation_pg_order";

// Run order, not wall-clock time, decides which proof is current: a repair
// supersedes only the proofs recorded before it.
const FAILURE_REPAIR_FAILURE_CASES = [
	{ name: "equal timestamps", a: "run_a", aAt: NOW, b: "run_z", bAt: NOW },
	{
		name: "equal timestamps, later id sorts before",
		a: "run_z",
		aAt: NOW,
		b: "run_a",
		bAt: NOW,
	},
	{
		name: "clock moved backwards",
		a: "run_a",
		aAt: "2026-05-20T12:00:05.000Z",
		b: "run_z",
		bAt: "2026-05-20T12:00:01.000Z",
	},
	{
		name: "clock moved backwards, later id sorts before",
		a: "run_z",
		aAt: "2026-05-20T12:00:05.000Z",
		b: "run_a",
		bAt: "2026-05-20T12:00:01.000Z",
	},
] as const;

test("dedicated PostgreSQL: failure, repair, failure keeps the later failure current", {
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
			[ORDER_CONNECTOR_ID],
		);
		await createPostgresConnectorInstanceStore().upsert({
			connectorId: ORDER_CONNECTOR_ID,
			connectorInstanceId: ORDER_INSTANCE_ID,
			createdAt: NOW,
			displayName: "Browser connection",
			ownerSubjectId: "owner_local",
			sourceBinding: { kind: "account" },
			sourceBindingKey: "account-browser-order",
			sourceKind: "account",
			status: "active",
			updatedAt: NOW,
		});
		const store = getDefaultProviderInvalidationProofStore();
		const proofFor = (runId: string, observedAt: string) => ({
			connection_id: ORDER_INSTANCE_ID,
			evidence_id: runId,
			kind: "provider_invalidation_proof" as const,
			observed_at: observedAt,
			provider: ORDER_CONNECTOR_ID,
			verified: true as const,
		});
		for (const scenario of FAILURE_REPAIR_FAILURE_CASES) {
			await postgresQuery(
				"DELETE FROM provider_invalidation_proofs WHERE connection_id = $1",
				[ORDER_INSTANCE_ID],
			);
			await store.record(proofFor(scenario.a, scenario.aAt));
			await store.markRepaired(ORDER_INSTANCE_ID, scenario.aAt);
			await store.record(proofFor(scenario.b, scenario.bAt));
			const loaded = await store.load(ORDER_INSTANCE_ID);
			assert.equal(loaded.proof?.evidence_id, scenario.b, scenario.name);
			assert.deepEqual(
				loaded.repairedProofKeys,
				[`${ORDER_INSTANCE_ID}\n${ORDER_CONNECTOR_ID}\n${scenario.a}`],
				scenario.name,
			);
		}
		// A replay of an earlier run keeps that run's original place in run order.
		await postgresQuery(
			"DELETE FROM provider_invalidation_proofs WHERE connection_id = $1",
			[ORDER_INSTANCE_ID],
		);
		await store.record(proofFor("run_a", NOW));
		await store.record(proofFor("run_z", NOW));
		await store.record(proofFor("run_a", NOW));
		assert.equal(
			(await store.load(ORDER_INSTANCE_ID)).proof?.evidence_id,
			"run_z",
		);
	} finally {
		await postgresQuery(
			"DELETE FROM connector_instances WHERE connector_instance_id = $1",
			[ORDER_INSTANCE_ID],
		);
		await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [
			ORDER_CONNECTOR_ID,
		]);
		await closePostgresStorage();
	}
});
