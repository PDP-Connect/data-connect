// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-completion sign-in proof writer is fenced on run identity and
 * captures terminal failure evidence for the watchdog and rejection paths.
 */

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";

import {
	__resetControllerInteractionStateForTests,
	createController,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultProviderInvalidationProofStore } from "../server/stores/provider-invalidation-proof-store.ts";
import type {
	ActiveRunRecord,
	SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID =
	"https://registry.pdpp.dev/connectors/sign-in-proof-fence-test";
const NOW = "2026-05-20T12:00:00.000Z";
const INSTANCE_ID = "cin_sign_in_proof_fence";
const UNREACHABLE_BUDGET_MS = 600_000;
const MANIFEST = {
	connector_id: CONNECTOR_ID,
	name: "Sign-in proof fence test",
	runtime_requirements: {
		bindings: {
			browser: {
				required: true,
				sign_in_url_pattern: "https://accounts.example.test/signin*",
			},
		},
	},
	streams: [],
	version: "1.0.0",
};

function unimplemented(name: string): never {
	throw new Error(`test fake: ${name} is not implemented`);
}

function admit() {
	return ({
		connectorId,
		connectorInstanceId,
		ownerSubjectId,
	}: {
		connectorId: string;
		connectorInstanceId: string | null;
		ownerSubjectId: string | null;
	}) =>
		Promise.resolve({
			connectorId,
			connectorInstanceId: connectorInstanceId ?? INSTANCE_ID,
			ownerSubjectId: ownerSubjectId || "owner_local",
		});
}

function schedulerStore(): SchedulerStore {
	const active = new Map<string, ActiveRunRecord>();
	return {
		appendRunHistory: () => undefined,
		createSchedule: () => unimplemented("createSchedule"),
		deleteActiveRun: (instanceId: string, runId: string) => {
			if (active.get(instanceId)?.run_id === runId) {
				active.delete(instanceId);
			}
		},
		deleteSchedule: () => unimplemented("deleteSchedule"),
		getActiveRun: (instanceId: string) => active.get(instanceId) ?? null,
		getLatestRunHistoryForConnection: () =>
			unimplemented("getLatestRunHistoryForConnection"),
		getSchedule: () => null,
		listActiveRuns: () => [...active.values()],
		listLastRunTimes: () => [],
		listRunHistory: () => [],
		listSchedules: () => [],
		setScheduleEnabled: () => unimplemented("setScheduleEnabled"),
		updateSchedule: () => unimplemented("updateSchedule"),
		upsertActiveRun: (record: ActiveRunRecord) => {
			active.set(record.connector_instance_id ?? record.connector_id, record);
			return true;
		},
		upsertLastRunTime: () => undefined,
	};
}

async function freshDb(t: TestContext): Promise<void> {
	closeDb();
	initDb(makeTemporaryDbPath("pdpp-sign-in-fence-"));
	__resetControllerInteractionStateForTests();
	getDb()
		.prepare(
			"INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)",
		)
		.run(CONNECTOR_ID, JSON.stringify(MANIFEST), NOW);
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: CONNECTOR_ID,
		connectorInstanceId: INSTANCE_ID,
		createdAt: NOW,
		displayName: "Fence",
		ownerSubjectId: "owner_local",
		sourceBinding: { kind: "account" },
		sourceBindingKey: "k",
		sourceKind: "account",
		status: "active",
		updatedAt: NOW,
	});
	const keepAlive = setInterval(() => undefined, 10);
	t.after(() => {
		clearInterval(keepAlive);
		__resetControllerInteractionStateForTests();
		closeDb();
	});
}

interface RecorderCall {
	readonly activeRunIdAtCall: string | null;
	readonly runId: string;
	readonly status: string | null | undefined;
}

function makeController(
	calls: RecorderCall[],
	impl: () => Promise<RuntimeRunConnectorResult>,
	maxRunWallClockMs: number,
	store: SchedulerStore,
) {
	const controller = createController({
		admitRunConnection: admit(),
		connectorPathResolver: () => "/tmp/connector.js",
		logger: { error: () => undefined, warn: () => undefined },
		maxRunWallClockMs,
		recordSignInProof: (_deps, input) => {
			calls.push({
				activeRunIdAtCall:
					controller.getActiveRun(CONNECTOR_ID, {
						connectorInstanceId: INSTANCE_ID,
					})?.run_id ?? null,
				runId: input.runId,
				status: input.status,
			});
			return Promise.resolve("none");
		},
		runConnectorImpl: impl,
		schedulerStore: store,
	});
	return controller;
}

const runOptions = (runId: string) => ({
	connectorInstanceId: INSTANCE_ID,
	manifest: MANIFEST,
	ownerToken: "owner-token",
	runId,
});

test("the watchdog captures failure evidence while the run still owns its slot", async (t) => {
	await freshDb(t);
	const calls: RecorderCall[] = [];
	const controller = makeController(
		calls,
		() => new Promise(() => undefined),
		20,
		schedulerStore(),
	);
	await controller.runNow(CONNECTOR_ID, runOptions("run_wd"));
	await new Promise((resolve) => setTimeout(resolve, 300).unref());
	assert.deepEqual(calls, [
		{ activeRunIdAtCall: "run_wd", runId: "run_wd", status: "failed" },
	]);
});

test("a rejected run captures failure evidence while the run still owns its slot", async (t) => {
	await freshDb(t);
	const calls: RecorderCall[] = [];
	const controller = makeController(
		calls,
		() => Promise.reject(new Error("launch failed")),
		UNREACHABLE_BUDGET_MS,
		schedulerStore(),
	);
	await controller.runNow(CONNECTOR_ID, runOptions("run_rej"));
	await controller.drainActiveRuns(1000);
	assert.deepEqual(calls, [
		{ activeRunIdAtCall: "run_rej", runId: "run_rej", status: "failed" },
	]);
});

test("a late succeeded result from a reclaimed run cannot clear a newer run's proof", async (t) => {
	await freshDb(t);
	const store = schedulerStore();
	const calls: RecorderCall[] = [];
	const releases: ((result: RuntimeRunConnectorResult) => void)[] = [];
	const hanging = () =>
		new Promise<RuntimeRunConnectorResult>((resolve) => {
			releases.push(resolve);
		});
	const first = makeController(calls, hanging, 20, store);
	const second = makeController(calls, hanging, UNREACHABLE_BUDGET_MS, store);
	await first.runNow(CONNECTOR_ID, runOptions("run_old"));
	await new Promise((resolve) => setTimeout(resolve, 300).unref());
	await second.runNow(CONNECTOR_ID, runOptions("run_new"));

	// A valid, unrepaired proof for the newer run's failure.
	await getDefaultProviderInvalidationProofStore().record({
		connection_id: INSTANCE_ID,
		evidence_id: "run_new_proof",
		kind: "provider_invalidation_proof",
		observed_at: "2026-05-20T12:00:00.000Z",
		provider: CONNECTOR_ID,
		verified: true,
	});
	calls.length = 0;

	releases[0]?.({ records_emitted: 0, status: "succeeded" });
	await new Promise((resolve) => setTimeout(resolve, 50).unref());

	assert.equal(calls.length, 0, "the reclaimed run must not reach the recorder");
	assert.deepEqual(
		(await getDefaultProviderInvalidationProofStore().load(INSTANCE_ID))
			.repairedProofKeys,
		[],
	);

	releases[1]?.({ records_emitted: 0, status: "succeeded" });
	await second.drainActiveRuns(1000);
	assert.deepEqual(
		calls.map((call) => [call.runId, call.status]),
		[["run_new", "succeeded"]],
		"the current run still records its own result",
	);
});
