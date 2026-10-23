// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID } from "../server/postgres-migration-ledger.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const { Pool } = pg;
const POSTGRES_URL = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
const CONNECTOR_ID = "claude-code";
const NOW = "2026-10-22T12:00:00.000Z";
const MIGRATION_HARNESS_TIMEOUT_MS = 25_000;
const PAGE_HARNESS_TIMEOUT_MS = 12_000;

let tempDbCounter = 0;

function nextDatabaseName(prefix: string): string {
	tempDbCounter += 1;
	return `pdpp_test_rh_${prefix}_${process.pid}_${tempDbCounter}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type BootstrapOutcome =
	| { readonly kind: "returned" }
	| { readonly kind: "rejected"; readonly error: unknown };

async function observeBootstrapWithinHarness(
	attempt: Promise<unknown>,
	timeoutMs: number,
	releaseBlocker: () => Promise<void>,
	migration: string,
): Promise<BootstrapOutcome> {
	const settled = attempt.then(
		(): BootstrapOutcome => ({ kind: "returned" }),
		(error: unknown): BootstrapOutcome => ({ kind: "rejected", error }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
		timer = setTimeout(() => {
			void releaseBlocker().then(
				() => resolve({ kind: "deadline" }),
				() => resolve({ kind: "deadline" }),
			);
		}, timeoutMs);
	});
	const outcome = await Promise.race([settled, deadline]);
	if (timer) {
		clearTimeout(timer);
	}
	if (outcome.kind === "deadline") {
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const settledAfterRelease = await Promise.race([
			settled.then(() => true),
			new Promise<boolean>((resolve) => {
				settleTimer = setTimeout(() => resolve(false), 5_000);
			}),
		]);
		if (settleTimer) {
			clearTimeout(settleTimer);
		}
		assert.fail(
			`${migration} exceeded the ${timeoutMs}ms test harness deadline; bootstrap ${settledAfterRelease ? "settled" : "remained pending"} after the test released its lock.`,
		);
	}
	return outcome;
}

test("PostgreSQL: a run_history default lock timeout fails boot clearly and the next boot repairs it", {
	skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
	timeout: 60_000,
}, async () => {
	assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
	await withTemporaryPostgresDatabase(
		{
			closeConnections: closePostgresStorage,
			connectionString: POSTGRES_URL,
			databaseName: nextDatabaseName("default_lock"),
		},
		async (url) => {
			await initPostgresStorage({ backend: "postgres", databaseUrl: url });
			await postgresQuery(
				"ALTER TABLE run_history ALTER COLUMN scheduler_managed SET DEFAULT true",
			);
			await closePostgresStorage();

			const blockerPool = new Pool({ connectionString: url });
			const blocker = await blockerPool.connect();
			let blockerHeld = false;
			const releaseBlocker = async () => {
				if (!blockerHeld) {
					return;
				}
				blockerHeld = false;
				await blocker.query("ROLLBACK");
			};

			try {
				await blocker.query("BEGIN");
				blockerHeld = true;
				await blocker.query("SELECT 1 FROM run_history LIMIT 1");

				const attempt = initPostgresStorage({
					backend: "postgres",
					databaseUrl: url,
				});
				const outcome = await observeBootstrapWithinHarness(
					attempt,
					MIGRATION_HARNESS_TIMEOUT_MS,
					releaseBlocker,
					"scheduler_managed default repair",
				);
				if (outcome.kind !== "rejected") {
					assert.fail(
						"bootstrap returned even though the legacy run_history default was not repaired",
					);
				}
				const message = errorMessage(outcome.error);
				assert.match(
					message,
					/run_history scheduler_managed default repair timed out after 3 attempts/i,
				);
				assert.match(message, /inspect pg_stat_activity\/pg_locks/i);
				assert.equal(
					(
						await postgresQuery<{ column_default: string | null }>(
							`SELECT column_default FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'scheduler_managed'`,
						)
					).rows[0]?.column_default,
					"true",
					"a timed-out ALTER leaves the committed default unchanged",
				);

				await releaseBlocker();
				await closePostgresStorage();
				await initPostgresStorage({ backend: "postgres", databaseUrl: url });
				assert.equal(
					(
						await postgresQuery<{ column_default: string | null }>(
							`SELECT column_default FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'scheduler_managed'`,
						)
					).rows[0]?.column_default,
					"false",
					"a later boot repairs the default once the lock is released",
				);
			} finally {
				await releaseBlocker();
				blocker.release();
				await blockerPool.end();
				await closePostgresStorage();
			}
		},
	);
});

test("PostgreSQL: a locked provenance page keeps its cursor and a later boot resumes it", {
	skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
	timeout: 45_000,
}, async () => {
	assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
	await withTemporaryPostgresDatabase(
		{
			closeConnections: closePostgresStorage,
			connectionString: POSTGRES_URL,
			databaseName: nextDatabaseName("page_lock"),
		},
		async (url) => {
			await initPostgresStorage({ backend: "postgres", databaseUrl: url });
			await postgresQuery(
				"DELETE FROM storage_migration_ledger WHERE migration_id = $1",
				[RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID],
			);
			await postgresQuery(
				`INSERT INTO run_history(
             connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id, scheduler_managed
           )
           SELECT 'cin_page_fill', $1, '{}'::jsonb, 'succeeded', $2, $2, 'run-page-fill-' || n, false
             FROM generate_series(1, 2000) AS n`,
				[CONNECTOR_ID, NOW],
			);
			await postgresQuery(
				`INSERT INTO run_history(
             connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id, scheduler_managed
           ) VALUES ('cin_page_locked', $1, '{}'::jsonb, 'succeeded', $2, $2, 'run-page-locked', true)`,
				[CONNECTOR_ID, NOW],
			);
			await postgresQuery(
				`INSERT INTO spine_events(
             event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id,
             object_type, object_id, status, run_id, data_json, version, connector_instance_id
           ) VALUES ($1, 'run.completed', $2, $2, 'scenario', 'trace', 'local_device', 'actor', 'run',
             'run-page-locked', 'succeeded', 'run-page-locked', $3::jsonb, '1', 'cin_page_locked')`,
				[
					`evt_page_locked_${process.pid}`,
					NOW,
					JSON.stringify({ connector_instance_id: "cin_page_locked" }),
				],
			);
			await closePostgresStorage();

			const blockerPool = new Pool({ connectionString: url });
			const blocker = await blockerPool.connect();
			let blockerHeld = false;
			const releaseBlocker = async () => {
				if (!blockerHeld) {
					return;
				}
				blockerHeld = false;
				await blocker.query("ROLLBACK");
			};

			try {
				await blocker.query("BEGIN");
				blockerHeld = true;
				await blocker.query(
					"SELECT id FROM run_history WHERE run_id = 'run-page-locked' FOR UPDATE",
				);

				const attempt = initPostgresStorage({
					backend: "postgres",
					databaseUrl: url,
				});
				const outcome = await observeBootstrapWithinHarness(
					attempt,
					PAGE_HARNESS_TIMEOUT_MS,
					releaseBlocker,
					"run_history device-run provenance page after id 2000",
				);
				if (outcome.kind !== "rejected") {
					assert.fail(
						"bootstrap returned without resolving the locked provenance page",
					);
				}
				const message = errorMessage(outcome.error);
				assert.match(
					message,
					/run_history device-run provenance page after id 2000 timed out after 3 attempts/i,
				);

				const blocked = await postgresQuery<{
					changed_rows: string;
					cursor: string | null;
					status: string;
				}>(
					`SELECT status, cursor, changed_rows::text AS changed_rows FROM storage_migration_ledger
              WHERE migration_id = $1`,
					[RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID],
				);
				assert.deepEqual(blocked.rows[0], {
					changed_rows: "0",
					cursor: "2000",
					status: "blocked",
				});
				assert.equal(
					(
						await postgresQuery<{ scheduler_managed: boolean }>(
							"SELECT scheduler_managed FROM run_history WHERE run_id = 'run-page-locked'",
						)
					).rows[0]?.scheduler_managed,
					true,
					"the failed page does not partially update its locked row",
				);

				await releaseBlocker();
				await closePostgresStorage();
				await initPostgresStorage({ backend: "postgres", databaseUrl: url });
				const completed = await postgresQuery<{
					changed_rows: string;
					cursor: string | null;
					status: string;
				}>(
					`SELECT status, cursor, changed_rows::text AS changed_rows FROM storage_migration_ledger
              WHERE migration_id = $1`,
					[RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID],
				);
				assert.deepEqual(completed.rows[0], {
					changed_rows: "1",
					cursor: "2001",
					status: "complete",
				});
				assert.equal(
					(
						await postgresQuery<{ scheduler_managed: boolean }>(
							"SELECT scheduler_managed FROM run_history WHERE run_id = 'run-page-locked'",
						)
					).rows[0]?.scheduler_managed,
					false,
					"the later boot resumes at the blocked row and repairs it",
				);
			} finally {
				await releaseBlocker();
				blocker.release();
				await blockerPool.end();
				await closePostgresStorage();
			}
		},
	);
});
