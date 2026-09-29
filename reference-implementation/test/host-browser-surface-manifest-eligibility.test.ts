// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Host browser mode (the desktop) without PDPP_NEKO_MANAGED_CONNECTORS decides
// which connectors get a managed browser surface from each connector's
// manifest. A catalog-installed browser connector that no bundled key list
// names must get a surface and complete a run; a connector without a browser
// binding must not get one.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BrowserSurfaceReadinessProbe } from "../runtime/browser-surface-readiness.ts";
import {
	__resetControllerInteractionStateForTests,
	createController,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { resolveNekoBrowserSurfaceControllerOptions as resolveUntyped } from "../server/index.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import type {
	ActiveRunRecord,
	SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const HOST_ENV = {
	PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9916/agent",
	PDPP_BROWSER_SURFACE_HOST_TOKEN: "shared-secret",
	PDPP_BROWSER_SURFACE_MODE: "host",
};

// A catalog-installed connector: not bundled, so no generated key list names it.
const ACME_SHOP_MANIFEST = {
	capabilities: { browser_surface: { profile_key: "acme-shop" } },
	connector_id: "acme-shop",
	name: "Acme Shop",
	runtime_requirements: { bindings: { browser: { required: true } } },
	streams: [],
	version: "1.0.0",
};

const ACME_API_MANIFEST = {
	connector_id: "acme-api",
	name: "Acme API",
	runtime_requirements: { bindings: { network: { required: true } } },
	streams: [],
	version: "1.0.0",
};

const ACME_SHOP_CONNECTION_ID = "cin_acme_shop";

interface KnownManifest {
	connectorId: string;
	manifest: unknown;
}

function createSchedulerStore(): SchedulerStore {
	const activeRuns = new Map<string, ActiveRunRecord>();
	return {
		appendRunHistory: () => undefined,
		createSchedule: () => undefined,
		deleteActiveRun: (_connectorId, runId) => {
			activeRuns.delete(runId);
		},
		deleteSchedule: () => undefined,
		getActiveRun: (connectorInstanceId) =>
			activeRuns.get(connectorInstanceId) ?? null,
		getLatestRunHistoryForConnection: () => null,
		getSchedule: () => null,
		listActiveRuns: () => [...activeRuns.values()],
		listLastRunTimes: () => [],
		listRunHistory: () => [],
		listSchedules: () => [],
		setScheduleEnabled: () => undefined,
		updateSchedule: () => undefined,
		upsertActiveRun: (record) => {
			activeRuns.set(record.run_id, record);
			return true;
		},
		upsertLastRunTime: () => undefined,
	};
}

// Stands in for the desktop host agent: it hands out one browser surface per
// lease and releases it by run id.
function stubHostAgent(t: TestContext): {
	acquireBodies: Record<string, unknown>[];
	requests: string[];
} {
	const requests: string[] = [];
	const acquireBodies: Record<string, unknown>[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const method = init?.method ?? "GET";
		requests.push(`${method} ${String(input)}`);
		if (method === "POST") {
			const body =
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {};
			acquireBodies.push(body);
			if (typeof body.connection_id !== "string" || !body.connection_id) {
				return {
					json: async () => ({ error: "connection_id_required" }),
					ok: false,
					status: 400,
				} as Response;
			}
			return {
				json: async () => ({
					cdp_url: "http://127.0.0.1:9222/host-cdp",
					surface_id: "host-surface-1",
				}),
				ok: true,
				status: 200,
			} as Response;
		}
		return { json: async () => ({}), ok: true, status: 204 } as Response;
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	return { acquireBodies, requests };
}

const READY_PROBE: BrowserSurfaceReadinessProbe = {
	probe: async () => ({ ok: true, pageTargetCount: 1 }),
};

async function setup(
	t: TestContext,
	knownManifests: readonly KnownManifest[],
	env: Record<string, string> = HOST_ENV,
) {
	closeDb();
	initDb(makeTemporaryDbPath("pdpp-host-manifest-surface-"));
	__resetControllerInteractionStateForTests();
	const keepAlive = setInterval(() => {}, 10);
	t.after(() => {
		clearInterval(keepAlive);
		__resetControllerInteractionStateForTests();
		closeDb();
	});
	const hostAgent = stubHostAgent(t);
	const resolve = resolveUntyped as (
		args: unknown,
	) => Promise<Record<string, unknown>>;
	const browserSurfaceOptions = await resolve({
		env,
		getBrowserSurfaceLeaseStore: () => createSqliteBrowserSurfaceLeaseStore(),
		listKnownConnectorManifests: async () => knownManifests,
	});
	const spawned: RuntimeRunConnectorOptions[] = [];
	const controller = createController({
		...browserSurfaceOptions,
		admitRunConnection: ({ connectorId, connectorInstanceId }) =>
			Promise.resolve({
				connectorId,
				// Default-account admission resolves to a concrete connection row.
				connectorInstanceId:
					connectorInstanceId ?? `cin_${connectorId.replaceAll("-", "_")}`,
				ownerSubjectId: "owner_local",
			}),
		browserSurfaceReadinessProbe: READY_PROBE,
		connectorPathResolver: () => "/tmp/connector.js",
		logger: { error: () => undefined, warn: () => undefined },
		runConnectorImpl: async (opts) => {
			spawned.push(opts);
			return {
				checkpoint_summary: null,
				records_emitted: 0,
				state: null,
				status: "succeeded",
			};
		},
		schedulerStore: createSchedulerStore(),
	} as Parameters<typeof createController>[0]);
	return { controller, hostAgent, spawned };
}

test("a catalog-installed browser connector known at boot gets a host surface and completes its run", async (t) => {
	const { controller, hostAgent, spawned } = await setup(t, [
		{ connectorId: "acme-shop", manifest: ACME_SHOP_MANIFEST },
	]);

	const result = await controller.runNow("acme-shop", {
		manifest: ACME_SHOP_MANIFEST,
		ownerToken: "owner-token",
		runId: "run_acme_boot",
	});
	await controller.drainActiveRuns(1000);

	assert.equal(result.status, "started");
	assert.equal(spawned.length, 1);
	assert.equal(
		spawned[0]?.browserSurfaceEnv?.PDPP_BROWSER_SURFACE_REQUIRED,
		"neko",
	);
	assert.equal(
		spawned[0]?.browserSurfaceEnv?.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
		"http://127.0.0.1:9222/host-cdp",
	);
	assert.deepEqual(hostAgent.requests, [
		"POST http://127.0.0.1:9916/agent/browser-surface/leases",
		"DELETE http://127.0.0.1:9916/agent/browser-surface/runs/run_acme_boot",
	]);
	assert.equal(
		hostAgent.acquireBodies[0]?.connection_id,
		ACME_SHOP_CONNECTION_ID,
	);
});

test("a browser connector installed after boot gets a host surface on its first run", async (t) => {
	const { controller, hostAgent, spawned } = await setup(t, []);

	const result = await controller.runNow("acme-shop", {
		manifest: ACME_SHOP_MANIFEST,
		ownerToken: "owner-token",
		runId: "run_acme_late",
	});
	await controller.drainActiveRuns(1000);

	assert.equal(result.status, "started");
	assert.equal(
		hostAgent.acquireBodies[0]?.connection_id,
		ACME_SHOP_CONNECTION_ID,
	);
	assert.equal(
		spawned[0]?.browserSurfaceEnv?.PDPP_BROWSER_SURFACE_REQUIRED,
		"neko",
	);
});

test("a connector without a browser binding gets no host surface", async (t) => {
	const { controller, hostAgent, spawned } = await setup(t, [
		{ connectorId: "acme-api", manifest: ACME_API_MANIFEST },
	]);

	const result = await controller.runNow("acme-api", {
		manifest: ACME_API_MANIFEST,
		ownerToken: "owner-token",
		runId: "run_acme_api",
	});
	await controller.drainActiveRuns(1000);

	assert.equal(result.status, "started");
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]?.browserSurfaceEnv ?? null, null);
	assert.deepEqual(hostAgent.requests, []);
});

test("PDPP_NEKO_MANAGED_CONNECTORS still limits host surfaces to the listed connectors", async (t) => {
	const { controller, hostAgent, spawned } = await setup(
		t,
		[{ connectorId: "acme-shop", manifest: ACME_SHOP_MANIFEST }],
		{
			...HOST_ENV,
			PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
			PDPP_NEKO_SURFACE_CAP: "2",
		},
	);

	await controller.runNow("acme-shop", {
		manifest: ACME_SHOP_MANIFEST,
		ownerToken: "owner-token",
		runId: "run_acme_override",
	});
	await controller.drainActiveRuns(1000);

	assert.equal(spawned[0]?.browserSurfaceEnv ?? null, null);
	assert.deepEqual(hostAgent.requests, []);
});
