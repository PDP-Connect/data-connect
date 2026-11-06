// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-completion sign-in proof writer is fenced on run identity and
 * captures terminal failure evidence for the watchdog and rejection paths.
 */

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { recordSignInProofAfterRun } from "../runtime/browser-surface/sign-in-proof-recorder.ts";
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
	readonly isCurrent: (() => boolean) | undefined;
	readonly activeRunIdAtCall: string | null;
	readonly runId: string;
	readonly status: string | null | undefined;
}

function makeController(
	calls: RecorderCall[],
	impl: () => Promise<RuntimeRunConnectorResult>,
	maxRunWallClockMs: number,
	store: SchedulerStore,
	hold?: () => Promise<void>,
) {
	const controller = createController({
		admitRunConnection: admit(),
		connectorPathResolver: () => "/tmp/connector.js",
		logger: { error: () => undefined, warn: () => undefined },
		maxRunWallClockMs,
		recordSignInProof: async (_deps, input) => {
			calls.push({
				isCurrent: input.isCurrent,
				activeRunIdAtCall:
					controller.getActiveRun(CONNECTOR_ID, {
						connectorInstanceId: INSTANCE_ID,
					})?.run_id ?? null,
				runId: input.runId,
				status: input.status,
			});
			await hold?.();
			return "none";
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
	assert.deepEqual(
		calls.map(({ activeRunIdAtCall, runId, status }) => ({
			activeRunIdAtCall,
			runId,
			status,
		})),
		[{ activeRunIdAtCall: "run_wd", runId: "run_wd", status: "failed" }],
	);
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
	assert.deepEqual(
		calls.map(({ activeRunIdAtCall, runId, status }) => ({
			activeRunIdAtCall,
			runId,
			status,
		})),
		[{ activeRunIdAtCall: "run_rej", runId: "run_rej", status: "failed" }],
	);
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

	assert.equal(
		calls.length,
		0,
		"the reclaimed run must not reach the recorder",
	);
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

test("a run reaching two terminal paths records evidence once, and a held capture sees itself superseded", async (t) => {
	await freshDb(t);
	const store = schedulerStore();
	const calls: RecorderCall[] = [];
	let openGate: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	let rejectRun: (err: Error) => void = () => undefined;
	const first = makeController(
		calls,
		() =>
			new Promise<RuntimeRunConnectorResult>((_resolve, reject) => {
				rejectRun = reject;
			}),
		20,
		store,
		() => gate,
	);
	await first.runNow(CONNECTOR_ID, runOptions("run_a"));
	// The watchdog fires and its capture is held open; the run promise then
	// rejects, reaching a second terminal path for the same run.
	await new Promise((resolve) => setTimeout(resolve, 200).unref());
	rejectRun(new Error("late rejection"));
	await new Promise((resolve) => setTimeout(resolve, 100).unref());
	assert.equal(calls.length, 1, "only one terminal path may capture per run");
	openGate();
	await first.drainActiveRuns(1000);
	await new Promise((resolve) => setTimeout(resolve, 100).unref());
	const isCurrent = calls[0]?.isCurrent;
	assert.ok(isCurrent, "the recorder is given a post-await currency check");
	assert.equal(isCurrent(), false, "a released run is no longer current");
});

test("a watchdog on a run that already completed does not record failure evidence", async (t) => {
	await freshDb(t);
	const calls: RecorderCall[] = [];
	const controller = makeController(
		calls,
		async () => {
			await emitSpineEvent({
				actor_id: CONNECTOR_ID,
				actor_type: "runtime",
				data: { connector_instance_id: INSTANCE_ID },
				event_type: "run.completed",
				object_id: "run_done",
				object_type: "run",
				run_id: "run_done",
				status: "completed",
			});
			return new Promise<RuntimeRunConnectorResult>(() => undefined);
		},
		20,
		schedulerStore(),
	);
	await controller.runNow(CONNECTOR_ID, runOptions("run_done"));
	await new Promise((resolve) => setTimeout(resolve, 300).unref());
	assert.equal(
		calls.filter((call) => call.status === "failed").length,
		0,
		"no failure evidence for a run that already succeeded",
	);
});

async function persistedProofSurvivesCompetingTerminalPath(
	t: TestContext,
	first: "watchdog" | "result",
): Promise<void> {
	await freshDb(t);
	let openGate: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	// The real recorder, with only its DevTools read held open and answering
	// with a page that matches the manifest's sign-in pattern.
	const fetchImpl = (async () => {
		await gate;
		return new Response(
			JSON.stringify([
				{ type: "page", url: "https://accounts.example.test/signin?next=1" },
			]),
		);
	}) as unknown as typeof fetch;
	let rejectRun: (err: Error) => void = () => undefined;
	let resolveRun: (result: RuntimeRunConnectorResult) => void = () => undefined;
	const controller = createController({
		admitRunConnection: admit(),
		connectorPathResolver: () => "/tmp/connector.js",
		logger: { error: () => undefined, warn: () => undefined },
		maxRunWallClockMs: 20,
		recordSignInProof: (deps, input) =>
			recordSignInProofAfterRun(
				{ ...deps, fetchImpl },
				{ ...input, cdpUrl: "http://127.0.0.1:1" },
			),
		runConnectorImpl: () =>
			new Promise<RuntimeRunConnectorResult>((resolve, reject) => {
				resolveRun = resolve;
				rejectRun = reject;
			}),
		schedulerStore: schedulerStore(),
	});
	await controller.runNow(CONNECTOR_ID, runOptions("run_race"));
	if (first === "watchdog") {
		await new Promise((resolve) => setTimeout(resolve, 200).unref());
		rejectRun(new Error("late rejection"));
	} else {
		resolveRun({ records_emitted: 0, status: "failed" });
		await new Promise((resolve) => setTimeout(resolve, 200).unref());
	}
	await new Promise((resolve) => setTimeout(resolve, 100).unref());
	// Release the DevTools read only now, after the competing path ran.
	openGate();
	await controller.drainActiveRuns(2000);
	await new Promise((resolve) => setTimeout(resolve, 100).unref());
	const loaded =
		await getDefaultProviderInvalidationProofStore().load(INSTANCE_ID);
	assert.equal(
		loaded.proof?.evidence_id,
		"run_race",
		"the claimed capture finished before the lease was released, so its proof is durable",
	);
}

test("a held capture still persists its proof when the run's rejection races the watchdog", async (t) => {
	await persistedProofSurvivesCompetingTerminalPath(t, "watchdog");
});

test("a held capture still persists its proof when the watchdog races a failed result", async (t) => {
	await persistedProofSurvivesCompetingTerminalPath(t, "result");
});
