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
