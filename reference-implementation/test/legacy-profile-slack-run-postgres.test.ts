// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The compiled Slack profile scenarios (legacy-profile-slack-run.test.ts) on Postgres, where the
 * storage is the point: instances, per-instance state, grants, versions and client-token reads.
 *
 * Gated on the dedicated loopback test database (PDPP_TEST_POSTGRES_URL); when it is absent each
 * case registers as skipped.
 */

import test from "node:test";

import { closeDb } from "../server/db.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import {
	assertCompiledSlackOffline,
	assertCompiledSlackUpgrade,
} from "./helpers/legacy-profile-slack-scenario.ts";
import { postgresBackend } from "./helpers/legacy-upgrade.ts";

const DATABASE_URL = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
const OWNER_TABLES =
	"TRUNCATE connectors, connector_instances, grants, records, connector_state CASCADE";
const SKIP = DATABASE_URL ? false : "dedicated PDPP_TEST_POSTGRES_URL unset";

async function withFreshPostgres(body: (databaseUrl: string) => Promise<void>) {
	const databaseUrl = DATABASE_URL as string;
	await initPostgresStorage({ backend: "postgres", databaseUrl });
	try {
		// The per-file database is dedicated to this file; start each case from empty owner tables.
		await postgresQuery(OWNER_TABLES);
		await body(databaseUrl);
	} finally {
		// The test-database guard refuses a database that still holds records at admission.
		await postgresQuery(OWNER_TABLES).catch(() => undefined);
		await closePostgresStorage();
		closeDb();
	}
}

test(
	"Postgres: compiled slack 0.6.0 -> 0.7.1 local sources: streams, state, fetched_at and grant reads across the upgrade",
	{
		skip: SKIP,
		timeout: 240_000,
	},
	() =>
		withFreshPostgres((databaseUrl) =>
			assertCompiledSlackUpgrade(postgresBackend, databaseUrl),
		),
);

test(
	"Postgres: compiled slack 0.7.1 with the network closed: archive streams run, Web API streams are skipped",
	{
		skip: SKIP,
		timeout: 120_000,
	},
	() =>
		withFreshPostgres((databaseUrl) =>
			assertCompiledSlackOffline(postgresBackend, databaseUrl),
		),
);
