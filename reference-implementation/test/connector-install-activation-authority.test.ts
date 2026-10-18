// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The connector activation authority on SQLite and PostgreSQL.
 *
 * NOTE: on this base, production calls only `removeConnectorActivation`
 * (server/index.ts). The installer still writes the install pointer and the
 * registry manifest in two separate steps. These tests pin the module's own
 * contract, the one PR #276 ("publish one coherent activation") makes the
 * installer use. See the PR body.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { QueryResultRow } from "pg";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import {
	type ActivationBackend,
	defineActivationAuthorityProcessScenarios,
	defineActivationAuthorityScenarios,
	type ProcessSupport,
} from "./helpers/activation-authority-scenarios.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const TABLES = [
	"connector_activations",
	"connector_installs",
	"connector_summary_evidence",
	"connector_instances",
	"connectors",
];

const sqliteBackend: ActivationBackend = {
	exec: async (sql, ...params) => {
		getDb()
			.prepare(sql)
			.run(...params);
	},
	failWrites: async (table) => {
		const name = `fail_${table}`;
		for (const event of ["INSERT", "UPDATE"]) {
			getDb()
				.prepare(
					`CREATE TRIGGER ${name}_${event} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
				)
				.run();
		}
		return async () => {
			for (const event of ["INSERT", "UPDATE"]) {
				getDb().prepare(`DROP TRIGGER ${name}_${event}`).run();
			}
		};
	},
	name: "sqlite",
	query: async <T>(sql: string, ...params: unknown[]) =>
		getDb()
			.prepare(sql)
			.all<T>(...params),
	reset: async () => {
		for (const table of TABLES) {
			getDb().prepare(`DELETE FROM ${table}`).run();
		}
	},
	setRegistry: async (manifestJson) => {
		getDb()
			.prepare(
				"UPDATE connectors SET manifest = ? WHERE connector_id = 'gmail'",
			)
			.run(manifestJson);
	},
};

function numbered(sql: string): string {
	let index = 0;
	return sql.replace(/\?/g, () => {
		index += 1;
		return `$${String(index)}`;
	});
}

const postgresBackend: ActivationBackend = {
	exec: async (sql, ...params) => {
		await postgresQuery(numbered(sql), params);
	},
	failWrites: async (table) => {
		const name = `fail_${table}`;
		await postgresQuery(
			`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
		);
		await postgresQuery(
			`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
		);
		return async () => {
			await postgresQuery(`DROP TRIGGER ${name} ON ${table}`);
			await postgresQuery(`DROP FUNCTION ${name}()`);
		};
	},
	name: "postgres",
	query: async <T>(sql: string, ...params: unknown[]) =>
		(await postgresQuery<T & QueryResultRow>(numbered(sql), params)).rows,
	reset: async () => {
		for (const table of TABLES) {
			await postgresQuery(`DELETE FROM ${table}`);
		}
	},
	setRegistry: async (manifestJson) => {
		await postgresQuery(
			"UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = 'gmail'",
			[manifestJson],
		);
	},
};

/** Children open the same SQLite file, so this process leaves its :memory: database for the test. */
function sqliteProcessSupport(): ProcessSupport {
	let dir = "";
	return {
		childEnv: async () => ({
			PDPP_ACTIVATION_CHILD_DB: join(dir, "pdpp.sqlite"),
		}),
		enter: async () => {
			dir = mkdtempSync(join(tmpdir(), "pdpp-activation-authority-"));
			closeDb();
			initDb(join(dir, "pdpp.sqlite"));
		},
		leave: async () => {
			closeDb();
			initDb(":memory:");
			rmSync(dir, { force: true, recursive: true });
		},
	};
}

describe("activation authority on SQLite", () => {
	before(() => {
		initDb(":memory:");
	});
	after(() => {
		closeDb();
	});
	defineActivationAuthorityScenarios(it, sqliteBackend);
	defineActivationAuthorityProcessScenarios(
		it,
		sqliteBackend,
		sqliteProcessSupport(),
	);
});

// PostgreSQL: one disposable database for the whole group.
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
describe("activation authority on PostgreSQL", {
	skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, () => {
	let databaseUrl = "";
	let release: (() => void) | undefined;
	let finished: Promise<unknown> | undefined;
	before(async () => {
		assert.ok(POSTGRES_URL);
		initDb(":memory:");
		const ready = new Promise<void>((resolve, reject) => {
			finished = withTemporaryPostgresDatabase(
				{
					closeConnections: closePostgresStorage,
					connectionString: POSTGRES_URL,
					databaseName: `pdpp_test_activation_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
					templateName: null,
				},
				async (url) => {
					try {
						databaseUrl = url;
						await initPostgresStorage({
							backend: "postgres",
							databaseUrl: url,
						});
						resolve();
						await new Promise<void>((done) => {
							release = done;
						});
					} catch (error) {
						reject(error);
					} finally {
						await closePostgresStorage();
					}
				},
			);
		});
		await ready;
	});
	after(async () => {
		release?.();
		await finished;
		closeDb();
	});
	defineActivationAuthorityScenarios(it, postgresBackend);
	defineActivationAuthorityProcessScenarios(it, postgresBackend, {
		// Each child claims its own single-use attachment to the scratch database.
		childEnv: async () => ({
			PDPP_ACTIVATION_CHILD_ATTACHMENT:
				await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl),
			PDPP_ACTIVATION_CHILD_DATABASE_URL: databaseUrl,
		}),
		enter: async () => undefined,
		leave: async () => undefined,
	});
});
