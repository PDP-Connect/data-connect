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

test("host mode defaults to generated browser-bound connectors and a safe dynamic cap", () => {
	const config = parseNekoBrowserSurfaceRuntimeConfig({
		PDPP_BROWSER_HEADLESS: "1",
		PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9916/agent",
		PDPP_BROWSER_SURFACE_HOST_TOKEN: "shared-secret",
		PDPP_BROWSER_SURFACE_MODE: "host",
	});

	assert.equal(config.host?.headless, true);
	assert.equal(config.leaseConfig.surfaceMode, "dynamic");
	assert.equal(config.leaseConfig.managedConnectors.has("chase"), true);
	assert.equal(config.leaseConfig.surfaceCap, 2);
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
		profileKey: "chase",
		surfaceId: "surface_1",
	};
	const surface = await allocator.ensureSurface(request);

	assert.equal(surface.cdp_url, "http://127.0.0.1:9222/host-cdp");
	assert.equal(surface.stream_base_url, "");
	assert.deepEqual(JSON.parse(mock.calls[0]?.body ?? "{}"), {
		connector_id: "chase",
		headless: false,
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
		profileKey: "chase",
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
		profileKey: "chase",
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
