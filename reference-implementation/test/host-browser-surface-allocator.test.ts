// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
	BrowserSurfaceLeaseManager,
	DEFAULT_NEKO_PRIORITY_RANKS,
	type EnsureBrowserSurfaceRequest,
	type StopBrowserSurfaceRequest,
} from "@opendatalabs/remote-surface/leases";
import { parseNekoBrowserSurfaceRuntimeConfig } from "../runtime/browser-surface-leases.ts";
import {
	createHostBrowserSurfaceAllocator,
	type HostBrowserSurfaceAllocator,
} from "../runtime/host-browser-surface-allocator.ts";
import { createBrowserProfilePurger } from "../server/browser-profile-purge.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";

interface MockResponse {
	readonly json: () => Promise<unknown>;
	readonly ok: boolean;
	readonly status: number;
}

interface MockRequest {
	readonly body?: string;
	readonly headers?: Record<string, string>;
	readonly method?: string;
	readonly url: string;
}

function createMockHostEndpoint(response: MockResponse): {
	readonly calls: MockRequest[];
	readonly fetchImpl: typeof fetch;
} {
	const calls: MockRequest[] = [];
	const fetchImpl = (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<MockResponse> => {
		calls.push({
			...(init?.body === undefined ? {} : { body: String(init.body) }),
			...(init?.headers === undefined
				? {}
				: { headers: init.headers as Record<string, string> }),
			...(init?.method === undefined ? {} : { method: init.method }),
			url: String(input),
		});
		return Promise.resolve(response);
	};
	return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function dynamicManager(): BrowserSurfaceLeaseManager {
	return new BrowserSurfaceLeaseManager({
		config: {
			defaultPriorityClass: "background",
			idleTtlMs: 300_000,
			leaseWaitTimeoutMs: 60_000,
			managedConnectors: new Set(["chase"]),
			priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
			surfaceCap: 1,
			surfaceMode: "dynamic",
		},
		makeLeaseId: () => "lease_1",
		makeSurfaceId: () => "surface_1",
		nextFencingToken: () => 1,
		now: () => new Date("2026-09-16T16:00:00.000Z"),
	});
}

function hostAllocator(fetchImpl: typeof fetch): HostBrowserSurfaceAllocator {
	return createHostBrowserSurfaceAllocator({
		endpoint: "http://127.0.0.1:9916/agent",
		fetchImpl,
		headless: false,
		now: () => new Date("2026-09-16T16:00:00.000Z"),
		token: "shared-secret",
	});
}

test("host mode refuses to boot without its bearer token", () => {
	assert.throws(
		() =>
			parseNekoBrowserSurfaceRuntimeConfig({
				PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9916/agent",
				PDPP_BROWSER_SURFACE_MODE: "host",
			}),
		/PDPP_BROWSER_SURFACE_HOST_TOKEN is required when PDPP_BROWSER_SURFACE_MODE=host/,
	);
});

test("host mode manages connectors by manifest browser binding with a safe dynamic cap", () => {
	const config = parseNekoBrowserSurfaceRuntimeConfig({
		PDPP_BROWSER_HEADLESS: "1",
		PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9916/agent",
		PDPP_BROWSER_SURFACE_HOST_TOKEN: "shared-secret",
		PDPP_BROWSER_SURFACE_MODE: "host",
	});

	assert.equal(config.host?.headless, true);
	assert.equal(config.leaseConfig.surfaceMode, "dynamic");
	assert.equal(config.leaseConfig.surfaceCap, 2);
	assert.equal(config.leaseConfig.managedConnectors, config.manifestManagedConnectors);
	assert.equal(config.leaseConfig.managedConnectors.has("chase"), false);
	config.manifestManagedConnectors?.observe("chase", {
		runtime_requirements: { bindings: { browser: { required: true } } },
	});
	assert.equal(config.leaseConfig.managedConnectors.has("chase"), true);
	config.manifestManagedConnectors?.observe("chase", {
		runtime_requirements: { bindings: { network: { required: true } } },
	});
	assert.equal(config.leaseConfig.managedConnectors.has("chase"), false);
});

test("host lease POST returns the host CDP URL and release DELETE targets host surface_id", async () => {
	const mock = createMockHostEndpoint({
		json: async () => ({
			cdp_url: "http://127.0.0.1:9222/host-cdp",
			surface_id: "host-surface-7",
		}),
		ok: true,
		status: 200,
	});
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-7", surfaceId: "surface_1" });

	const request: EnsureBrowserSurfaceRequest = {
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		surfaceId: "surface_1",
	};
	const surface = await allocator.ensureSurface(request);

	assert.equal(surface.cdp_url, "http://127.0.0.1:9222/host-cdp");
	assert.equal(surface.stream_base_url, "");
	assert.deepEqual(JSON.parse(mock.calls[0]?.body ?? "{}"), {
		connection_id: "cin_chase",
		connector_id: "chase",
		headless: false,
		migrate_connector_profile: false,
		run_id: "run-7",
	});
	assert.equal(mock.calls[0]?.headers?.Authorization, "Bearer shared-secret");

	const stopRequest: StopBrowserSurfaceRequest = {
		reason: "operator",
		surfaceId: "surface_1",
	};
	await allocator.stopSurface(stopRequest);
	assert.equal(mock.calls[1]?.method, "DELETE");
	assert.equal(
		mock.calls[1]?.url,
		"http://127.0.0.1:9916/agent/browser-surface/leases/host-surface-7",
	);
});

async function leasedHostAllocator(deleteStatus: number) {
	const calls: MockRequest[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			...(init?.method === undefined ? {} : { method: init.method }),
			url: String(input),
		});
		if (init?.method === "POST") {
			return {
				json: async () => ({
					cdp_url: "http://127.0.0.1:9222/host-cdp",
					surface_id: "host-surface-9",
				}),
				ok: true,
				status: 200,
			} as Response;
		}
		return {
			json: async () => ({}),
			ok: deleteStatus >= 200 && deleteStatus < 300,
			status: deleteStatus,
		} as Response;
	}) as typeof fetch;
	const allocator = hostAllocator(fetchImpl);
	allocator.bindRunToSurface({ runId: "run-9", surfaceId: "surface_9" });
	await allocator.ensureSurface({
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		surfaceId: "surface_9",
	});
	return { allocator, calls };
}

test("lease DELETE answered 404 counts as released, so idle cleanup does not retry it forever", async () => {
	const { allocator, calls } = await leasedHostAllocator(404);

	const stopped = await allocator.stopSurface({ reason: "idle_ttl", surfaceId: "surface_9" });

	assert.equal(stopped?.health, "stopping");
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
	// The lease is forgotten: a second stop has nothing to release.
	assert.equal(await allocator.stopSurface({ reason: "idle_ttl", surfaceId: "surface_9" }), null);
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("lease DELETE answered 500 still fails and keeps the lease for a later retry", async () => {
	const { allocator, calls } = await leasedHostAllocator(500);

	await assert.rejects(
		allocator.stopSurface({ reason: "idle_ttl", surfaceId: "surface_9" }),
		/HTTP 500/,
	);
	await assert.rejects(
		allocator.stopSurface({ reason: "idle_ttl", surfaceId: "surface_9" }),
		/HTTP 500/,
	);
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 2);
});

/**
 * A host that keeps the lease protocol's contract: one start per run_id, which
 * a repeated POST joins, and a released run whose late start is torn down and
 * refused. Its start completes only when the test calls finishStart.
 */
function createSlowStartHost(): {
	readonly calls: MockRequest[];
	readonly fetchImpl: typeof fetch;
	readonly finishStart: () => Promise<void>;
	readonly heldRunIds: ReadonlySet<string>;
	readonly startedRunIds: readonly string[];
} {
	const calls: MockRequest[] = [];
	const heldRunIds = new Set<string>();
	const releasedRunIds = new Set<string>();
	const startedRunIds: string[] = [];
	const starts = new Map<string, Promise<void>>();
	let finish: () => void = () => undefined;
	const startFinished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const refused = {
		json: async () => ({
			error: "surface_start_failed",
			message: "Run id has already been released",
		}),
		ok: false,
		status: 500,
	} as Response;
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		calls.push({
			...(init?.body === undefined ? {} : { body: String(init.body) }),
			...(init?.method === undefined ? {} : { method: init.method }),
			url,
		});
		if (init?.method === "DELETE") {
			const runId = decodeURIComponent(
				url.split("/browser-surface/runs/")[1] ?? "",
			);
			releasedRunIds.add(runId);
			heldRunIds.delete(runId);
			return { json: async () => ({}), ok: true, status: 204 } as Response;
		}
		const { run_id: runId } = JSON.parse(String(init?.body)) as {
			run_id: string;
		};
		if (releasedRunIds.has(runId)) {
			return refused;
		}
		let start = starts.get(runId);
		if (!start) {
			startedRunIds.push(runId);
			start = startFinished.then(() => {
				if (!releasedRunIds.has(runId)) {
					heldRunIds.add(runId);
				}
			});
			starts.set(runId, start);
		}
		const joined = start;
		await new Promise<void>((resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new Error("aborted")),
			);
			joined.then(resolve, reject);
		});
		if (releasedRunIds.has(runId)) {
			return refused;
		}
		return {
			json: async () => ({
				cdp_url: "http://127.0.0.1:9222/host-cdp",
				surface_id: `host-surface-${runId}`,
			}),
			ok: true,
			status: 200,
		} as Response;
	}) as typeof fetch;
	return {
		calls,
		fetchImpl,
		finishStart: async () => {
			finish();
			await Promise.all(starts.values());
		},
		heldRunIds,
		startedRunIds,
	};
}

function slowStartAllocator(
	fetchImpl: typeof fetch,
): HostBrowserSurfaceAllocator {
	return createHostBrowserSurfaceAllocator({
		endpoint: "http://127.0.0.1:9916/agent",
		fetchImpl,
		headless: false,
		now: () => new Date("2026-09-16T16:00:00.000Z"),
		requestTimeoutMs: 1,
		token: "shared-secret",
	});
}

test("an unanswered lease POST leaves the surface starting, and asking again adopts the host's one start", async () => {
	const host = createSlowStartHost();
	const allocator = slowStartAllocator(host.fetchImpl);
	const manager = dynamicManager();
	const acquired = manager.acquire({
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		runId: "run-slow",
	});
	allocator.bindRunToSurface({ runId: "run-slow", surfaceId: "surface_1" });

	// Two POSTs time out while the host is still starting the browser.
	for (const _attempt of [1, 2]) {
		const waiting = await manager.ensureStartingSurfaceReady({
			allocator,
			leaseId: acquired.lease.lease_id,
		});
		assert.equal(waiting.lease.status, "starting_surface");
		assert.equal(waiting.surface?.health, "starting");
	}
	await host.finishStart();
	const ready = await manager.ensureStartingSurfaceReady({
		allocator,
		leaseId: acquired.lease.lease_id,
	});

	assert.equal(ready.lease.status, "leased");
	assert.equal(ready.surface?.cdp_url, "http://127.0.0.1:9222/host-cdp");
	assert.deepEqual(host.startedRunIds, ["run-slow"]);
	assert.equal(allocator.lastStartFailure("run-slow"), undefined);
	const postedRunIds = host.calls.map(
		(call) => (JSON.parse(call.body ?? "{}") as { run_id?: string }).run_id,
	);
	assert.deepEqual(postedRunIds, ["run-slow", "run-slow", "run-slow"]);
});

const CHASE_SURFACE_REQUEST: EnsureBrowserSurfaceRequest = {
	connectorId: "chase",
	profileKey: "chase:cin_chase",
	surfaceSubjectId: "cin_chase",
	surfaceId: "surface_1",
};

test("a lease answer whose body stalls after its headers counts as an unanswered start", async () => {
	const mock = createMockHostEndpoint({
		json: () => new Promise<unknown>(() => undefined),
		ok: true,
		status: 200,
	});
	const allocator = slowStartAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-stalled", surfaceId: "surface_1" });

	const surface = await allocator.ensureSurface(CHASE_SURFACE_REQUEST);

	assert.equal(surface.health, "starting");
	assert.equal(
		allocator.lastStartFailure("run-stalled")?.code,
		"host_browser_surface_timeout",
	);
});

test("overlapping ensures of one surface share one host request, so a ready lease is never downgraded", async () => {
	let answer: () => void = () => undefined;
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		calls.push(String(input));
		await answered;
		return {
			json: async () => ({
				cdp_url: "http://127.0.0.1:9222/host-cdp",
				surface_id: "host-surface-shared",
			}),
			ok: true,
			status: 200,
		} as Response;
	}) as typeof fetch;
	const allocator = hostAllocator(fetchImpl);
	allocator.bindRunToSurface({ runId: "run-shared", surfaceId: "surface_1" });

	const first = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	const second = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	answer();
	const [a, b] = await Promise.all([first, second]);

	assert.equal(calls.length, 1);
	assert.equal(a.health, "ready");
	assert.deepEqual(b, a);
	// The binding is consumed once; a later ensure reuses the ready lease.
	assert.deepEqual(await allocator.ensureSurface(CHASE_SURFACE_REQUEST), a);
	assert.equal(calls.length, 1);
	assert.equal((await allocator.getSurfaceStatus("surface_1"))?.health, "ready");
});

/** A host whose lease answers wait until the test answers each run by id. */
function createGatedHost(): {
	readonly answer: (runId: string) => void;
	readonly postedRunIds: string[];
	readonly fetchImpl: typeof fetch;
} {
	const gates = new Map<string, () => void>();
	const postedRunIds: string[] = [];
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		const runId = (JSON.parse(String(init?.body ?? "{}")) as { run_id: string }).run_id;
		postedRunIds.push(runId);
		await new Promise<void>((resolve) => {
			gates.set(runId, resolve);
		});
		return {
			json: async () => ({
				cdp_url: `http://127.0.0.1:9222/${runId}`,
				surface_id: `host-surface-${runId}`,
			}),
			ok: true,
			status: 200,
		} as Response;
	}) as typeof fetch;
	const answer = (runId: string) => {
		const open = gates.get(runId);
		assert.ok(open, `no start is waiting for ${runId}`);
		open();
	};
	return { answer, fetchImpl, postedRunIds };
}

/** Let queued promise callbacks run, so a fake fetch reaches its gate. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A host whose DELETE waits until the test completes it; starts answer at once. */
function createDeleteGatedHost() {
	let started!: () => void;
	let complete!: () => void;
	const deleteStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const deleteCompleted = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		if (init?.method === "DELETE") {
			started();
			await deleteCompleted;
			return new Response(null, { status: 204 });
		}
		const { run_id } = JSON.parse(String(init?.body));
		return Response.json({ cdp_url: `http://127.0.0.1:9222/${run_id}`, surface_id: `host-${run_id}` });
	}) as typeof fetch;
	return { deleteStarted, complete, fetchImpl };
}

test("a late run release does not erase the next run's pending binding", async () => {
	const host = createDeleteGatedHost();
	const allocator = hostAllocator(host.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-old", surfaceId: "surface_1" });
	const release = allocator.releaseRun("run-old");
	await host.deleteStarted;
	allocator.bindRunToSurface({ runId: "run-next", surfaceId: "surface_1" });
	host.complete();
	await release;
	assert.equal((await allocator.ensureSurface(CHASE_SURFACE_REQUEST)).cdp_url, "http://127.0.0.1:9222/run-next");
	assert.equal((await allocator.getSurfaceStatus("surface_1"))?.cdp_url, "http://127.0.0.1:9222/run-next");
});

test("a late surface stop does not erase the next run's ready lease", async () => {
	const host = createDeleteGatedHost();
	const allocator = hostAllocator(host.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-old", surfaceId: "surface_1" });
	await allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	const stopping = allocator.stopSurface({ reason: "surface_failed", surfaceId: "surface_1" });
	await host.deleteStarted;
	allocator.bindRunToSurface({ runId: "run-next", surfaceId: "surface_1" });
	const next = await allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	host.complete();
	await stopping;
	assert.equal(next.cdp_url, "http://127.0.0.1:9222/run-next");
	assert.equal((await allocator.getSurfaceStatus("surface_1"))?.cdp_url, next.cdp_url);
});

test("a surface rebound to the next run starts for that run, and the older run's late answer is not recorded", async () => {
	const host = createGatedHost();
	const allocator = hostAllocator(host.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-old", surfaceId: "surface_1" });
	const older = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	allocator.bindRunToSurface({ runId: "run-next", surfaceId: "surface_1" });
	const next = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();

	assert.deepEqual(host.postedRunIds, ["run-old", "run-next"]);
	host.answer("run-next");
	assert.equal((await next).cdp_url, "http://127.0.0.1:9222/run-next");
	host.answer("run-old");
	await older;
	assert.equal(
		(await allocator.getSurfaceStatus("surface_1"))?.cdp_url,
		"http://127.0.0.1:9222/run-next",
	);
});

test("an older run's answer that lands after the next run is bound leaves that binding in place", async () => {
	const host = createGatedHost();
	const allocator = hostAllocator(host.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-old", surfaceId: "surface_1" });
	const older = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	allocator.bindRunToSurface({ runId: "run-next", surfaceId: "surface_1" });
	host.answer("run-old");
	await older;

	assert.equal(await allocator.getSurfaceStatus("surface_1"), null);
	const next = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	host.answer("run-next");
	assert.equal((await next).cdp_url, "http://127.0.0.1:9222/run-next");
	assert.deepEqual(host.postedRunIds, ["run-old", "run-next"]);
});

/**
 * A host whose every request waits until the test answers it by method and
 * run id, oldest first. A request that is never answered fails when the
 * allocator aborts it, as a real fetch does.
 */
function createRequestGatedHost() {
	const waiting: { key: string; open: () => void }[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const method = init?.method ?? "GET";
		const runId =
			method === "POST"
				? (JSON.parse(String(init?.body)) as { run_id: string }).run_id
				: decodeURIComponent(
						String(input).split("/browser-surface/runs/")[1] ?? "",
					);
		await new Promise<void>((resolve, reject) => {
			const entry = { key: `${method} ${runId}`, open: resolve };
			waiting.push(entry);
			init?.signal?.addEventListener("abort", () => {
				const index = waiting.indexOf(entry);
				if (index >= 0) waiting.splice(index, 1);
				reject(init.signal?.reason);
			});
		});
		return method === "POST"
			? Response.json({
					cdp_url: `http://127.0.0.1:9222/${runId}`,
					surface_id: `host-${runId}`,
				})
			: new Response(null, { status: 204 });
	}) as typeof fetch;
	const answer = async (key: string) => {
		const index = waiting.findIndex((entry) => entry.key === key);
		assert.ok(index >= 0, `no request is waiting for ${key}`);
		waiting.splice(index, 1)[0]?.open();
		await settle();
	};
	return { answer, fetchImpl };
}

test("a start answered while its run is being released is not kept after the release", async () => {
	const host = createRequestGatedHost();
	const allocator = hostAllocator(host.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-a", surfaceId: "surface_1" });
	const started = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	const release = allocator.releaseRun("run-a");
	await settle();

	await host.answer("POST run-a");
	assert.equal((await started).health, "ready");
	await host.answer("DELETE run-a");
	await release;

	assert.equal(await allocator.getSurfaceStatus("surface_1"), null);
	assert.deepEqual(await allocator.listSurfaces(), []);
});

test("a start answered while its unanswered surface is being stopped is not kept after the stop", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const host = createRequestGatedHost();
	const allocator = createHostBrowserSurfaceAllocator({
		endpoint: "http://127.0.0.1:9916/agent",
		fetchImpl: host.fetchImpl,
		headless: false,
		now: () => new Date("2026-09-16T16:00:00.000Z"),
		requestTimeoutMs: 1_000,
		token: "shared-secret",
	});
	allocator.bindRunToSurface({ runId: "run-a", surfaceId: "surface_1" });
	const unanswered = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	t.mock.timers.tick(1_000);
	assert.equal((await unanswered).health, "starting");
	const retried = allocator.ensureSurface(CHASE_SURFACE_REQUEST);
	await settle();
	const stopping = allocator.stopSurface({
		reason: "surface_failed",
		surfaceId: "surface_1",
	});
	await settle();

	await host.answer("POST run-a");
	assert.equal((await retried).health, "ready");
	await host.answer("DELETE run-a");
	await stopping;

	assert.equal(await allocator.getSurfaceStatus("surface_1"), null);
	assert.deepEqual(await allocator.listSurfaces(), []);
});

test("stopping an unanswered start releases its run, so the host drops the browser when the start completes", async () => {
	const host = createSlowStartHost();
	const allocator = slowStartAllocator(host.fetchImpl);
	const manager = dynamicManager();
	const acquired = manager.acquire({
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		runId: "run-abandoned",
	});
	allocator.bindRunToSurface({
		runId: "run-abandoned",
		surfaceId: "surface_1",
	});
	const waiting = await manager.ensureStartingSurfaceReady({
		allocator,
		leaseId: acquired.lease.lease_id,
	});
	assert.equal(waiting.surface?.health, "starting");

	const stopped = await allocator.stopSurface({
		reason: "surface_failed",
		surfaceId: "surface_1",
	});
	await host.finishStart();

	assert.equal(stopped?.health, "stopping");
	assert.equal(
		host.calls.at(-1)?.url,
		"http://127.0.0.1:9916/agent/browser-surface/runs/run-abandoned",
	);
	assert.equal(host.heldRunIds.size, 0);
	assert.equal(await allocator.getSurfaceStatus("surface_1"), null);
	assert.deepEqual(await allocator.listSurfaces(), []);
	// A late retry of the released run is refused, never leased.
	allocator.bindRunToSurface({
		runId: "run-abandoned",
		surfaceId: "surface_1",
	});
	const retried = await manager.ensureStartingSurfaceReady({
		allocator,
		leaseId: acquired.lease.lease_id,
	});
	assert.equal(retried.lease.status, "surface_failed");
	assert.equal(host.heldRunIds.size, 0);
	assert.deepEqual(host.startedRunIds, ["run-abandoned"]);
});

test("release after a lost acquire response targets the stable run id", async () => {
	const calls: MockRequest[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			...(init?.body === undefined ? {} : { body: String(init.body) }),
			...(init?.method === undefined ? {} : { method: init.method }),
			url: String(input),
		});
		if (init?.method === "POST") {
			throw new Error("response was lost after host acquisition");
		}
		return { json: async () => ({}), ok: true, status: 204 } as Response;
	}) as typeof fetch;
	const allocator = hostAllocator(fetchImpl);
	allocator.bindRunToSurface({ runId: "run-lost-response", surfaceId: "surface_1" });
	const request: EnsureBrowserSurfaceRequest = {
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		surfaceId: "surface_1",
	};

	await assert.rejects(allocator.ensureSurface(request), /unreachable/);
	await allocator.releaseRun("run-lost-response");

	assert.equal(calls[0]?.method, "POST");
	assert.equal(calls[1]?.method, "DELETE");
	assert.equal(
		calls[1]?.url,
		"http://127.0.0.1:9916/agent/browser-surface/runs/run-lost-response",
	);
});

test("host endpoint failure terminalizes admission before a connector can start", async () => {
	const mock = createMockHostEndpoint({
		json: async () => ({}),
		ok: false,
		status: 503,
	});
	const allocator = hostAllocator(mock.fetchImpl);
	const manager = dynamicManager();
	const acquired = manager.acquire({
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		runId: "run-down",
	});
	assert.equal(acquired.lease.status, "starting_surface");
	assert.equal(acquired.lease.surface_id, "surface_1");

	allocator.bindRunToSurface({ runId: "run-down", surfaceId: "surface_1" });
	const ready = await manager.ensureStartingSurfaceReady({
		allocator,
		leaseId: acquired.lease.lease_id,
	});

	assert.equal(ready.lease.status, "surface_failed");
	assert.equal(ready.lease.wait_reason, "surface_start_failed");
	assert.equal(mock.calls.length, 1);
});

test("host endpoint 500 with a structured sandbox-unavailable body surfaces the host reason on the allocator error and lastStartFailure", async () => {
	const mock = createMockHostEndpoint({
		json: async () => ({
			error: "browser_sandbox_unavailable",
			message:
				"This Linux distribution blocks the bundled browser's sandbox. Install Google Chrome or Chromium from a .deb package.",
		}),
		ok: false,
		status: 500,
	});
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-sandbox", surfaceId: "surface_1" });

	const request: EnsureBrowserSurfaceRequest = {
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		surfaceId: "surface_1",
	};

	let caught: unknown;
	try {
		await allocator.ensureSurface(request);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error);
	const err = caught as Error & { hostError?: string; hostMessage?: string };
	assert.equal(err.hostError, "browser_sandbox_unavailable");
	assert.match(
		err.hostMessage ?? "",
		/This Linux distribution blocks the bundled browser's sandbox/,
	);
	assert.match(err.message, /browser_sandbox_unavailable/);
	assert.match(err.message, /This Linux distribution blocks/);

	const failure = allocator.lastStartFailure("run-sandbox");
	assert.equal(failure?.code, "browser_sandbox_unavailable");
	assert.match(
		failure?.message ?? "",
		/This Linux distribution blocks the bundled browser's sandbox/,
	);
});

test("browser_profile_in_use reaches lastStartFailure after ensureStartingSurfaceReady swallows the host error", async () => {
	const mock = createMockHostEndpoint({
		json: async () => ({
			error: "browser_profile_in_use",
			message:
				"A DataConnect browser window for this account is still open. Close it and try again.",
		}),
		ok: false,
		status: 500,
	});
	const allocator = hostAllocator(mock.fetchImpl);
	const manager = dynamicManager();
	const acquired = manager.acquire({
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		runId: "run-profile-in-use",
	});
	allocator.bindRunToSurface({
		runId: "run-profile-in-use",
		surfaceId: "surface_1",
	});

	const ready = await manager.ensureStartingSurfaceReady({
		allocator,
		leaseId: acquired.lease.lease_id,
	});

	assert.equal(ready.lease.status, "surface_failed");
	assert.equal(ready.lease.wait_reason, "surface_start_failed");

	const failure = allocator.lastStartFailure("run-profile-in-use");
	assert.equal(failure?.code, "browser_profile_in_use");
	assert.match(
		failure?.message ?? "",
		/A DataConnect browser window for this account is still open/,
	);
});

test("host endpoint 500 with a non-JSON body keeps today's plain HTTP-status message and records no structured failure", async () => {
	const mock = createMockHostEndpoint({
		json: async () => {
			throw new SyntaxError("Unexpected token in JSON");
		},
		ok: false,
		status: 500,
	});
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-nonjson", surfaceId: "surface_1" });

	const request: EnsureBrowserSurfaceRequest = {
		connectorId: "chase",
		profileKey: "chase:cin_chase",
		surfaceSubjectId: "cin_chase",
		surfaceId: "surface_1",
	};

	await assert.rejects(
		allocator.ensureSurface(request),
		/returned HTTP 500$/,
	);

	const failure = allocator.lastStartFailure("run-nonjson");
	assert.equal(failure?.code, "host_browser_surface_http_error");
});

function okHostEndpoint() {
	return createMockHostEndpoint({
		json: async () => ({
			cdp_url: "http://127.0.0.1:9222/host-cdp",
			surface_id: "host-surface-1",
		}),
		ok: true,
		status: 200,
	});
}

test("host lease POST refuses a lease without a connection instead of sharing a connector profile", async () => {
	const mock = okHostEndpoint();
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-1", surfaceId: "surface_1" });

	await assert.rejects(
		allocator.ensureSurface({
			connectorId: "chase",
			profileKey: "chase",
			surfaceId: "surface_1",
		}),
		/no connection id was bound/,
	);
	assert.equal(mock.calls.length, 0, "the host is never asked for a shared profile");
});

test("host lease POST carries the migration flag bound for the run", async () => {
	const mock = okHostEndpoint();
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({
		migrateConnectorProfile: true,
		runId: "run-1",
		surfaceId: "surface_1",
	});

	await allocator.ensureSurface({
		connectorId: "chase",
		profileKey: "chase:cin_only",
		surfaceId: "surface_1",
		surfaceSubjectId: "cin_only",
	});

	const body = JSON.parse(mock.calls[0]?.body ?? "{}");
	assert.equal(body.connection_id, "cin_only");
	assert.equal(body.migrate_connector_profile, true);
});

test("a URL-form connector id leases and purges the same host profile key", async () => {
	const mock = okHostEndpoint();
	const allocator = hostAllocator(mock.fetchImpl);
	allocator.bindRunToSurface({ runId: "run-1", surfaceId: "surface_1" });
	await allocator.ensureSurface({
		connectorId: "https://registry.pdpp.dev/connectors/github",
		profileKey: "https://registry.pdpp.dev/connectors/github:cin_gh",
		surfaceId: "surface_1",
		surfaceSubjectId: "cin_gh",
	});
	const lease = JSON.parse(mock.calls[0]?.body ?? "{}");

	// The desktop host stores one profile per (connector_id, connection_id);
	// model it and let the RI purge address it.
	const hostProfiles = new Set([`${lease.connector_id}/${lease.connection_id}`]);
	const purgeCalls: string[] = [];
	const purge = createBrowserProfilePurger({
		env: {
			PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9916/agent",
			PDPP_BROWSER_SURFACE_HOST_TOKEN: "shared-secret",
			PDPP_BROWSER_SURFACE_MODE: "host",
		},
		fetchImpl: (async (url: string) => {
			purgeCalls.push(url);
			const key = decodeURIComponent(
				new URL(url).pathname.replace("/agent/browser-surface/profiles/", ""),
			);
			return new Response(null, { status: hostProfiles.delete(key) ? 204 : 404 });
		}) as typeof fetch,
		logger: null,
	});
	const result = await purge({
		connectorInstanceId: "cin_gh",
		connectorKey:
			canonicalConnectorKey("https://registry.pdpp.dev/connectors/github") ?? "",
	});

	assert.equal(lease.connector_id, "github");
	assert.deepEqual(result, { removed: 1, status: "purged", target: "host" });
	assert.equal(hostProfiles.size, 0, "the leased profile is the one purged");
});
