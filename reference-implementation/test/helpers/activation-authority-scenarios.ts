// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend-neutral scenarios for the connector activation authority
 * (server/connector-install/activation-authority.ts), run once on SQLite and
 * once on PostgreSQL by test/connector-install-activation-authority.test.ts.
 *
 * The module's public functions are the contract: publish the registry
 * manifest, generation advance, executable tuple and pending repair in one
 * transaction; fence repair completion and error by attempt id; fail closed
 * on registry drift and corrupt rows; import legacy installs once and keep
 * `repair_required` rows out of the runnable list.
 *
 * Scenarios touch the module only through its exported API plus plain SQL to
 * seed and inspect rows.
 */

import assert from "node:assert/strict";
import type { it } from "node:test";
import { registerConnector } from "../../server/auth.ts";
import {
	canonicalActivationManifestRevision,
	completeConnectorActivation,
	getConnectorActivation,
	listRepairRequiredConnectorActivations,
	listRunnableConnectorActivations,
	markConnectorActivationRepairRequired,
	publishConnectorActivation,
} from "../../server/connector-install/activation-authority.ts";
import type { ConnectorInstallRecord } from "../../server/connector-install/index.ts";
import {
	installedGmail,
	shippedGmail,
} from "./connector-install-gmail-fixture.ts";
import { killChildAt, spawnCrashChild } from "./crash-harness.ts";

export interface ActivationBackend {
	readonly name: "postgres" | "sqlite";
	/** Run a statement; `?` placeholders. */
	exec: (sql: string, ...params: unknown[]) => Promise<void>;
	/** Make every INSERT or UPDATE on `table` fail with "injected failure" until the returned function runs. */
	failWrites: (table: string) => Promise<() => Promise<void>>;
	/** Run a query; `?` placeholders. */
	query: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
	/** Empty every table the scenarios touch. */
	reset: () => Promise<void>;
	/** Replace the stored registry manifest of gmail with this JSON, bypassing registration. */
	setRegistry: (manifestJson: string) => Promise<void>;
}

const INSTANCE = "cin_activation_authority";
const REPAIR_PENDING = "Derived manifest repair pending";
const LEGACY_DISAGREE = "Legacy registry and installed artifact disagree";
const RE_CHANGED_BEFORE_COMPLETE = /changed before repair completed/;
const RE_CHANGED_BEFORE_ERROR = /changed before repair state could be recorded/;
const RE_STREAM_SHAPE =
	/Registry stream shape changed during activation repair/;
const RE_REVISION =
	/Registry manifest revision changed during activation repair/;
const RE_DISAPPEARED = /Registry manifest disappeared during activation repair/;
const RE_CORRUPT = /Connector activation authority is corrupt for gmail/;
const RE_IDENTITY = /Connector activation manifest identity mismatch/;
const RE_INJECTED = /injected failure/;

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, entry]) => [key, sortKeys(entry)]),
		);
	}
	return value;
}

function canonical(value: unknown): string {
	return JSON.stringify(
		sortKeys(typeof value === "string" ? JSON.parse(value) : value),
	);
}

export function installRecord(
	manifest: Record<string, unknown> = installedGmail,
	overrides: Partial<ConnectorInstallRecord> = {},
): ConnectorInstallRecord {
	return {
		activatedAt: "2026-10-18T00:00:00.000Z",
		bindings: {},
		configDigest: `sha256:${"b".repeat(64)}`,
		connectorId: "gmail",
		digest: `sha256:${"a".repeat(64)}`,
		entrypointPath: "dist/collection-profile.mjs",
		entrypointSha256: `sha256:${"1".repeat(64)}`,
		manifest,
		manifestPath: "profile/collection-profile.json",
		manifestSha256: `sha256:${"2".repeat(64)}`,
		provenancePath: "provenance.json",
		provenanceSha256: `sha256:${"3".repeat(64)}`,
		registry: "ghcr.io",
		repository: "pdp-connect/connector/gmail",
		root: "/data/connectors/gmail/a",
		tier: "preview",
		version: String(manifest.version),
		...overrides,
	};
}

/** A different connector's manifest, for the mixed legacy import. */
function slackManifest(): Record<string, unknown> {
	return {
		...installedGmail,
		connector_id: "https://registry.pdpp.dev/connectors/slack",
		connector_key: "slack",
		display_name: "Slack",
		manifest_uri: "https://registry.pdpp.dev/connectors/slack",
	};
}

/** The shipped gmail manifest is in the registry, one connection exists, and its evidence is fresh. */
export async function seedRegistry(backend: ActivationBackend): Promise<void> {
	await registerConnector(shippedGmail, { backfillRetrievalIndexes: false });
	const now = new Date().toISOString();
	await backend.exec(
		`INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name,
       source_kind, source_binding_key, created_at, updated_at)
     VALUES(?, 'owner', 'gmail', 'Gmail', 'account', ?, ?, ?)`,
		INSTANCE,
		INSTANCE,
		now,
		now,
	);
	await backend.exec(
		"INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, dirty, state) VALUES(?, 'gmail', 0, 'fresh')",
		INSTANCE,
	);
}

export interface Snapshot {
	readonly activation: readonly Record<string, unknown>[];
	readonly dirty: readonly Record<string, unknown>[];
	readonly generation: readonly Record<string, unknown>[];
	readonly install: readonly Record<string, unknown>[];
	readonly registry: string | null;
}

/** Every durable fact publication touches, in a comparable form. */
export async function snapshot(backend: ActivationBackend): Promise<Snapshot> {
	const registry = await backend.query<{ manifest: unknown }>(
		"SELECT manifest FROM connectors WHERE connector_id = 'gmail'",
	);
	return {
		activation: await backend.query(
			"SELECT state, attempt_id, activation_id, manifest_revision, repair_reason, repair_error_json FROM connector_activations ORDER BY connector_id",
		),
		dirty: await backend.query(
			"SELECT dirty, state FROM connector_summary_evidence ORDER BY connector_instance_id",
		),
		generation: await backend.query(
			"SELECT CAST(manifest_generation AS TEXT) AS manifest_generation FROM connector_instances ORDER BY connector_instance_id",
		),
		install: await backend.query(
			"SELECT record_json FROM connector_installs ORDER BY connector_id",
		),
		registry: registry[0] ? canonical(registry[0].manifest) : null,
	};
}

async function activationRows(
	backend: ActivationBackend,
): Promise<Record<string, unknown>[]> {
	return await backend.query(
		"SELECT * FROM connector_activations ORDER BY connector_id",
	);
}

/** Publish, then let the repair finish: the connector is active and runnable. */
export async function publishAndComplete(record: ConnectorInstallRecord) {
	const published = await publishConnectorActivation(record);
	await completeConnectorActivation(record.connectorId, published.attemptId);
	return published;
}

/**
 * A legacy install: only `connector_installs` holds it, as an older build
 * wrote it. Plain SQL on purpose, so the seed does not depend on the install
 * store's write path.
 */
export async function writeLegacyInstall(
	backend: ActivationBackend,
	record: ConnectorInstallRecord,
): Promise<void> {
	await backend.exec(
		`INSERT INTO connector_installs(connector_id, record_json, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(connector_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`,
		record.connectorId,
		JSON.stringify(record),
		new Date().toISOString(),
	);
}

export function defineActivationAuthorityScenarios(
	register: typeof it,
	backend: ActivationBackend,
	options: { readonly skip?: string | false } = {},
): void {
	const scenario = (name: string, body: () => Promise<void>): void => {
		register(
			`activation authority (${backend.name}): ${name}`,
			{ skip: options.skip ?? false },
			async () => {
				await backend.reset();
				await body();
			},
		);
	};

	// -------------------------------------------------------------------------
	// DCR-45: publication is one atomic step
	// -------------------------------------------------------------------------

	scenario(
		"publish writes the registry manifest, generation, evidence mark, pointer and pending repair together",
		async () => {
			await seedRegistry(backend);
			const activation = await publishConnectorActivation(installRecord());

			const after = await snapshot(backend);
			assert.equal(
				after.registry,
				canonical(await expectedStored()),
				"registry holds the published manifest",
			);
			assert.deepEqual(
				after.generation,
				[{ manifest_generation: "1" }],
				"the connection's manifest generation advanced once",
			);
			assert.deepEqual(
				after.dirty,
				[{ dirty: 1, state: "stale" }],
				"summary evidence is marked stale",
			);
			assert.equal(after.activation.length, 1);
			assert.deepEqual(after.activation[0], {
				activation_id: activation.activationId,
				attempt_id: activation.attemptId,
				manifest_revision: canonicalActivationManifestRevision(installedGmail),
				repair_error_json: null,
				repair_reason: REPAIR_PENDING,
				state: "repair_required",
			});
			assert.equal(after.install.length, 1);
			assert.equal(
				canonical(after.install[0]?.record_json),
				canonical(installRecord()),
				"the executable tuple is the install record",
			);
			assert.equal(activation.state, "repair_required");
			assert.deepEqual(
				await listRunnableConnectorActivations(),
				[],
				"an unrepaired publication is not runnable",
			);
			assert.equal(
				(await getConnectorActivation("gmail"))?.attemptId,
				activation.attemptId,
			);
		},
	);

	scenario(
		"publishing an unchanged manifest opens a new attempt without advancing the generation",
		async () => {
			await seedRegistry(backend);
			const first = await publishAndComplete(installRecord());
			const generation = (await snapshot(backend)).generation;

			const second = await publishConnectorActivation(installRecord());

			assert.notEqual(second.attemptId, first.attemptId);
			assert.deepEqual(
				(await snapshot(backend)).generation,
				generation,
				"same manifest, same generation",
			);
			assert.equal(
				(await getConnectorActivation("gmail"))?.state,
				"repair_required",
				"the new attempt needs its own repair",
			);
		},
	);

	// Not "connectors" or "connector_instances": source-revision triggers make the
	// very first statement touch connector_instances, so a failure there writes
	// nothing under any fault. The later writes are the ones that can be torn.
	for (const failing of [
		"connector_activations",
		"connector_installs",
	] as const) {
		scenario(
			`a write that fails mid-publication (${failing}) leaves the previous activation untouched`,
			async () => {
				await seedRegistry(backend);
				await publishAndComplete(installRecord());
				const before = await snapshot(backend);
				const next = { ...installedGmail, version: "9.1.0" };
				const release = await backend.failWrites(failing);
				try {
					await assert.rejects(
						publishConnectorActivation(
							installRecord(next, { digest: `sha256:${"c".repeat(64)}` }),
						),
						RE_INJECTED,
					);
				} finally {
					await release();
				}

				assert.deepEqual(
					await snapshot(backend),
					before,
					"registry, generation, evidence, pointer and install are all unchanged",
				);
				assert.equal(
					(await listRunnableConnectorActivations()).length,
					1,
					"the previous activation stays runnable",
				);
			},
		);
	}

	// -------------------------------------------------------------------------
	// DCR-46: repair outcomes are fenced by attempt id; drift fails closed
	// -------------------------------------------------------------------------

	scenario(
		"a completion from an older attempt cannot activate a newer publication",
		async () => {
			await seedRegistry(backend);
			const older = await publishConnectorActivation(installRecord());
			const newer = await publishConnectorActivation(installRecord());

			await assert.rejects(
				completeConnectorActivation("gmail", older.attemptId),
				RE_CHANGED_BEFORE_COMPLETE,
			);
			assert.equal(
				(await getConnectorActivation("gmail"))?.state,
				"repair_required",
			);
			assert.deepEqual(await listRunnableConnectorActivations(), []);

			await completeConnectorActivation("gmail", newer.attemptId);
			const done = await getConnectorActivation("gmail");
			assert.equal(done?.state, "active");
			assert.equal(done?.attemptId, newer.attemptId);
			assert.equal(done?.repairReason, null);
			assert.equal((await listRunnableConnectorActivations()).length, 1);
		},
	);

	scenario(
		"a repair error from an older attempt cannot overwrite a newer publication",
		async () => {
			await seedRegistry(backend);
			const older = await publishConnectorActivation(installRecord());
			const newer = await publishConnectorActivation(installRecord());
			const before = (await getConnectorActivation("gmail"))?.repairError;

			await assert.rejects(
				markConnectorActivationRepairRequired(
					"gmail",
					older.attemptId,
					"stale reason",
					new Error("stale boom"),
				),
				RE_CHANGED_BEFORE_ERROR,
			);
			const unchanged = await getConnectorActivation("gmail");
			assert.equal(unchanged?.repairReason, REPAIR_PENDING);
			assert.equal(unchanged?.repairError, before);

			await markConnectorActivationRepairRequired(
				"gmail",
				newer.attemptId,
				"current reason",
				new Error("current boom"),
			);
			const recorded = await getConnectorActivation("gmail");
			assert.equal(recorded?.state, "repair_required");
			assert.equal(recorded?.repairReason, "current reason");
			assert.deepEqual(JSON.parse(String(recorded?.repairError)), {
				message: "current boom",
			});
		},
	);

	scenario(
		"registry drift between publication and completion fails closed",
		async () => {
			const drifts: readonly {
				readonly name: string;
				readonly expected: RegExp;
				readonly apply: () => Promise<void>;
			}[] = [
				{
					apply: async () => {
						const streams = (
							installedGmail as unknown as {
								streams: Record<string, unknown>[];
							}
						).streams.slice(1);
						await backend.setRegistry(
							JSON.stringify(await storedWith({ streams })),
						);
					},
					expected: RE_STREAM_SHAPE,
					name: "a stream removed",
				},
				{
					apply: async () => {
						await backend.setRegistry(
							JSON.stringify(
								await storedWith({ display_name: "Edited behind the install" }),
							),
						);
					},
					expected: RE_REVISION,
					name: "same streams, another revision",
				},
				{
					apply: async () => {
						await backend.exec("DELETE FROM connector_summary_evidence");
						await backend.exec("DELETE FROM connector_instances");
						await backend.exec(
							"DELETE FROM connectors WHERE connector_id = 'gmail'",
						);
					},
					expected: RE_DISAPPEARED,
					name: "registry row deleted",
				},
			];
			for (const drift of drifts) {
				await backend.reset();
				await seedRegistry(backend);
				const published = await publishConnectorActivation(installRecord());
				await drift.apply();

				await assert.rejects(
					completeConnectorActivation("gmail", published.attemptId),
					drift.expected,
					drift.name,
				);

				const row = await getConnectorActivation("gmail");
				assert.equal(
					row?.state,
					"repair_required",
					`${drift.name}: stays repair_required`,
				);
				assert.deepEqual(
					await listRunnableConnectorActivations(),
					[],
					`${drift.name}: never runnable`,
				);
			}
		},
	);

	scenario(
		"a corrupt activation row fails closed on read and on the runnable list",
		async () => {
			const corruptions: readonly {
				readonly name: string;
				readonly sql: string;
				readonly params?: unknown[];
			}[] = [
				{
					name: "activation id",
					sql: "UPDATE connector_activations SET activation_id = 'sha256:forged'",
				},
				{
					name: "manifest revision",
					sql: "UPDATE connector_activations SET manifest_revision = 'sha256:forged'",
				},
				{
					name: "canonical manifest",
					params: [
						JSON.stringify({
							...(await storedWith({})),
							display_name: "forged",
						}),
					],
					sql: "UPDATE connector_activations SET canonical_manifest_json = ?",
				},
				{
					name: "executable tuple",
					params: [
						JSON.stringify(
							installRecord(installedGmail, {
								entrypointSha256: `sha256:${"9".repeat(64)}`,
							}),
						),
					],
					sql: "UPDATE connector_activations SET record_json = ?",
				},
			];
			for (const corruption of corruptions) {
				await backend.reset();
				await seedRegistry(backend);
				await publishAndComplete(installRecord());
				assert.equal(
					(await listRunnableConnectorActivations()).length,
					1,
					"healthy before the corruption",
				);

				await backend.exec(corruption.sql, ...(corruption.params ?? []));

				await assert.rejects(
					getConnectorActivation("gmail"),
					RE_CORRUPT,
					corruption.name,
				);
				await assert.rejects(
					listRunnableConnectorActivations(),
					RE_CORRUPT,
					`${corruption.name}: runnable list`,
				);
			}
			await backend.reset();
			await seedRegistry(backend);
			await publishAndComplete(installRecord());
			await backend.exec(
				"UPDATE connector_activations SET record_json = '{not json'",
			);
			await assert.rejects(
				getConnectorActivation("gmail"),
				SyntaxError,
				"an unparsable tuple is not silently skipped",
			);
		},
	);

	// -------------------------------------------------------------------------
	// DCR-47: legacy activation import
	// -------------------------------------------------------------------------

	scenario(
		"a legacy install whose registry matches imports as active and runnable",
		async () => {
			await registerConnector(installedGmail, {
				backfillRetrievalIndexes: false,
			});
			await writeLegacyInstall(backend, installRecord());

			const activation = await getConnectorActivation("gmail");

			assert.equal(activation?.state, "active");
			assert.equal(activation?.repairReason, null);
			assert.equal(
				activation?.manifestRevision,
				canonicalActivationManifestRevision(installedGmail),
			);
			assert.deepEqual(
				(await listRunnableConnectorActivations()).map(
					(row) => row.record.connectorId,
				),
				["gmail"],
			);
			assert.deepEqual(await listRepairRequiredConnectorActivations(), []);
		},
	);

	for (const registry of ["another manifest", "no manifest"] as const) {
		scenario(
			`a legacy install with ${registry} in the registry imports as repair_required and is not runnable`,
			async () => {
				if (registry === "another manifest") {
					await registerConnector(shippedGmail, {
						backfillRetrievalIndexes: false,
					});
				}
				await writeLegacyInstall(backend, installRecord());

				const activation = await getConnectorActivation("gmail");

				assert.equal(activation?.state, "repair_required");
				assert.equal(activation?.repairReason, LEGACY_DISAGREE);
				assert.deepEqual(
					await listRunnableConnectorActivations(),
					[],
					"a repair_required row is not runnable",
				);
				assert.deepEqual(
					(await listRepairRequiredConnectorActivations()).map(
						(row) => row.record.connectorId,
					),
					["gmail"],
				);
			},
		);
	}

	scenario(
		"importing the legacy list splits runnable and repair_required connectors",
		async () => {
			await registerConnector(installedGmail, {
				backfillRetrievalIndexes: false,
			});
			await writeLegacyInstall(backend, installRecord());
			await writeLegacyInstall(
				backend,
				installRecord(slackManifest(), {
					connectorId: "slack",
					repository: "pdp-connect/connector/slack",
				}),
			);

			const runnable = (await listRunnableConnectorActivations()).map(
				(row) => row.record.connectorId,
			);
			const repair = (await listRepairRequiredConnectorActivations()).map(
				(row) => row.record.connectorId,
			);

			assert.deepEqual(runnable, ["gmail"]);
			assert.deepEqual(repair, ["slack"], "slack has no registry manifest");
			assert.equal((await activationRows(backend)).length, 2);
		},
	);

	scenario(
		"a legacy install with a manifest of another identity is refused and writes nothing",
		async () => {
			await registerConnector(installedGmail, {
				backfillRetrievalIndexes: false,
			});
			await writeLegacyInstall(
				backend,
				installRecord(slackManifest(), { connectorId: "gmail" }),
			);

			await assert.rejects(getConnectorActivation("gmail"), RE_IDENTITY);
			await assert.rejects(
				listRunnableConnectorActivations(),
				RE_IDENTITY,
				"the runnable list fails closed too",
			);
			assert.deepEqual(
				await activationRows(backend),
				[],
				"no activation row for a refused import",
			);
		},
	);

	scenario(
		"a failed legacy import leaves no row, and the retry imports the connector once",
		async () => {
			await registerConnector(installedGmail, {
				backfillRetrievalIndexes: false,
			});
			await writeLegacyInstall(backend, installRecord());
			const release = await backend.failWrites("connector_activations");
			try {
				await assert.rejects(getConnectorActivation("gmail"), RE_INJECTED);
			} finally {
				await release();
			}
			assert.deepEqual(
				await activationRows(backend),
				[],
				"the failed import left nothing behind",
			);

			const imported = await getConnectorActivation("gmail");
			const again = await getConnectorActivation("gmail");

			assert.equal(imported?.state, "active");
			assert.equal(
				again?.attemptId,
				imported?.attemptId,
				"the second read does not import again",
			);
			assert.equal((await activationRows(backend)).length, 1);
		},
	);

	scenario(
		"an existing activation is never replaced by a legacy install row",
		async () => {
			await seedRegistry(backend);
			const published = await publishAndComplete(installRecord());
			const older = installRecord(
				{ ...installedGmail, version: "8.0.0" },
				{ digest: `sha256:${"d".repeat(64)}` },
			);
			await writeLegacyInstall(backend, older);

			const activation = await getConnectorActivation("gmail");

			assert.equal(activation?.attemptId, published.attemptId);
			assert.equal(activation?.state, "active");
			assert.equal(activation?.record.digest, installRecord().digest);
		},
	);
}

/** The stored (normalized) form of the installed gmail manifest, as the registry holds it. */
async function expectedStored(): Promise<Record<string, unknown>> {
	return await storedWith({});
}

async function storedWith(
	overrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { normalizeConnectorManifestForStorage } = await import(
		"../../server/auth.ts"
	);
	return {
		...normalizeConnectorManifestForStorage(installedGmail).storedManifest,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Real processes: contention on the legacy import, and a kill mid-publication
// ---------------------------------------------------------------------------

export interface ProcessSupport {
	/** Environment that points a child at the same database as this process. */
	childEnv: () => Promise<Record<string, string>>;
	/** Switch this process to a database the children can open. */
	enter: () => Promise<void>;
	/** Undo `enter`. */
	leave: () => Promise<void>;
}

const CHILD = new URL(
	"../fixtures/crash/activation-authority-child.ts",
	import.meta.url,
).pathname;
const BEFORE_IMPORT = "activation-authority:before-legacy-import";
const IN_IMPORT = "activation-authority:in-legacy-import";
const IN_PUBLISH = "activation-authority:in-publish";

export function defineActivationAuthorityProcessScenarios(
	register: typeof it,
	backend: ActivationBackend,
	support: ProcessSupport,
	options: { readonly skip?: string | false } = {},
): void {
	const scenario = (name: string, body: () => Promise<void>): void => {
		register(
			`activation authority (${backend.name}): ${name}`,
			{ skip: options.skip ?? false },
			async () => {
				await support.enter();
				try {
					await backend.reset();
					await body();
				} finally {
					await support.leave();
				}
			},
		);
	};

	scenario(
		"two processes importing the same legacy install produce one activation",
		async () => {
			await registerConnector(installedGmail, {
				backfillRetrievalIndexes: false,
			});
			await writeLegacyInstall(backend, installRecord());
			const points = [BEFORE_IMPORT, IN_IMPORT];
			const first = spawnCrashChild(CHILD, {
				args: ["import"],
				env: await support.childEnv(),
				points,
			});
			const second = spawnCrashChild(CHILD, {
				args: ["import"],
				env: await support.childEnv(),
				points,
			});
			try {
				await first.parked(BEFORE_IMPORT);
				await second.parked(BEFORE_IMPORT);
				// The first importer is inside its transaction, before the insert.
				first.resume();
				await first.parked(IN_IMPORT);
				// The second must wait for the first. Entering the transaction now would
				// be the race: both would import.
				second.resume();
				let secondEntered = false;
				const entered = second.parked(IN_IMPORT).then(
					() => {
						secondEntered = true;
					},
					() => undefined,
				);
				await Promise.race([
					entered,
					new Promise((settle) => setTimeout(settle, 1500)),
				]);
				assert.equal(
					secondEntered,
					false,
					"the second importer entered the import transaction while the first was inside it",
				);
				first.resume();
				// A second importer that enters late (the exists check missing) is let
				// through, so it fails on its own instead of hanging the test.
				void entered.then(() => {
					if (secondEntered) second.resume();
				});
				const [firstExit, secondExit] = await Promise.all([
					first.exited,
					second.exited,
				]);
				assert.equal(firstExit.code, 0, firstExit.stderr);
				assert.equal(secondExit.code, 0, secondExit.stderr);
				const results = [firstExit, secondExit].map(
					(exit) =>
						JSON.parse(exit.stdout.trim()) as {
							attemptId: string;
							state: string;
						},
				);
				assert.equal(
					results[0]?.attemptId,
					results[1]?.attemptId,
					"both processes saw the same imported attempt",
				);
				assert.equal(results[0]?.state, "active");
				assert.equal((await activationRows(backend)).length, 1);
			} finally {
				await first.kill();
				await second.kill();
			}
		},
	);

	scenario(
		"a process killed inside publication leaves the previous activation exactly as it was",
		async () => {
			await seedRegistry(backend);
			await publishAndComplete(installRecord());
			const before = await snapshot(backend);

			await killChildAt(CHILD, IN_PUBLISH, {
				args: ["publish"],
				env: await support.childEnv(),
			});

			assert.deepEqual(
				await snapshot(backend),
				before,
				"the kill rolled back registry, generation, evidence, pointer and install",
			);
			assert.equal(
				(await listRunnableConnectorActivations()).length,
				1,
				"the previous activation is still runnable",
			);
			// The next publication works: nothing is left locked or half-written.
			const retry = await publishConnectorActivation(
				installRecord(
					{ ...installedGmail, version: "9.1.0" },
					{ digest: `sha256:${"c".repeat(64)}` },
				),
			);
			assert.equal(retry.state, "repair_required");
		},
	);
}
