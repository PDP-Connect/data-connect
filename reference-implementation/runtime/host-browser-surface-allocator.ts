// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	BrowserSurface,
	BrowserSurfaceAllocator,
	EnsureBrowserSurfaceRequest,
	StopBrowserSurfaceRequest,
} from "@opendatalabs/remote-surface/leases";

const DEFAULT_HOST_REQUEST_TIMEOUT_MS = 5_000;

export interface HostBrowserSurfaceLeaseBinding {
	readonly runId: string;
	readonly surfaceId: string;
}

export interface HostBrowserSurfaceAllocatorOptions {
	readonly endpoint: string;
	readonly fetchImpl?: typeof fetch;
	readonly headless: boolean;
	readonly now?: () => Date;
	readonly requestTimeoutMs?: number;
	readonly token: string;
}

export interface HostBrowserSurfaceAllocator extends BrowserSurfaceAllocator {
	readonly bindRunToSurface: (binding: HostBrowserSurfaceLeaseBinding) => void;
	readonly releaseRun: (runId: string) => Promise<void>;
}

export class HostBrowserSurfaceAllocatorError extends Error {
	readonly code:
		| "host_browser_surface_http_error"
		| "host_browser_surface_invalid_config"
		| "host_browser_surface_malformed_response"
		| "host_browser_surface_missing_lease_context"
		| "host_browser_surface_timeout"
		| "host_browser_surface_unreachable";

	constructor(
		code: HostBrowserSurfaceAllocatorError["code"],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HostBrowserSurfaceAllocatorError";
		this.code = code;
	}
}

interface HostLeaseRecord {
	readonly hostSurfaceId: string;
	readonly runId: string;
	readonly surface: BrowserSurface;
}

interface HostSurfaceLeaseResponse {
	readonly cdp_url: string;
	readonly surface_id: string;
}

interface FetchResponseLike {
	readonly json: () => Promise<unknown>;
	readonly ok: boolean;
	readonly status: number;
}

type FetchImpl = (
	input: string,
	init: RequestInit,
) => Promise<FetchResponseLike>;

export function createHostBrowserSurfaceAllocator(
	options: HostBrowserSurfaceAllocatorOptions,
): HostBrowserSurfaceAllocator {
	return new HostBrowserSurfaceAllocatorImpl(options);
}

class HostBrowserSurfaceAllocatorImpl implements HostBrowserSurfaceAllocator {
	readonly #endpoint: string;
	readonly #fetch: FetchImpl;
	readonly #headless: boolean;
	readonly #now: () => Date;
	readonly #requestTimeoutMs: number;
	readonly #token: string;
	readonly #leasesBySurfaceId = new Map<string, HostLeaseRecord>();
	readonly #pendingRunIdsBySurfaceId = new Map<string, string>();
	readonly #surfaceIdsByRunId = new Map<string, string>();

	constructor(options: HostBrowserSurfaceAllocatorOptions) {
		this.#endpoint = normalizeEndpoint(options.endpoint);
		this.#fetch = (options.fetchImpl ?? fetch) as FetchImpl;
		this.#headless = options.headless;
		this.#now = options.now ?? (() => new Date());
		this.#requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_HOST_REQUEST_TIMEOUT_MS;
		this.#token = options.token.trim();
		if (!this.#token) {
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_invalid_config",
				"PDPP_BROWSER_SURFACE_HOST_TOKEN must not be empty",
			);
		}
	}

	bindRunToSurface(binding: HostBrowserSurfaceLeaseBinding): void {
		this.#pendingRunIdsBySurfaceId.set(binding.surfaceId, binding.runId);
	}

	async ensureSurface(
		request: EnsureBrowserSurfaceRequest,
	): Promise<BrowserSurface> {
		const existing = this.#leasesBySurfaceId.get(request.surfaceId);
		if (existing) {
			return existing.surface;
		}
		const runId = this.#pendingRunIdsBySurfaceId.get(request.surfaceId);
		if (!runId) {
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_missing_lease_context",
				`no run_id was bound for browser surface ${request.surfaceId}`,
			);
		}
		const response = await this.#requestJson("POST", this.#leasesUrl(), {
			run_id: runId,
			connector_id: request.connectorId,
			headless: this.#headless,
		});
		const hostLease = parseHostSurfaceLeaseResponse(response);
		const now = this.#now().toISOString();
		const surface: BrowserSurface = {
			allocator_metadata: { host_surface_id: hostLease.surface_id },
			backend: "neko",
			cdp_url: hostLease.cdp_url,
			connector_id: request.connectorId,
			created_at: now,
			health: "ready",
			last_used_at: now,
			profile_key: request.profileKey,
			// The host contract supplies CDP only. The legacy field is required by
			// the lease type, but an empty value prevents callers from mistaking CDP
			// for a browser-stream endpoint.
			stream_base_url: "",
			surface_id: request.surfaceId,
		};
		const record = { hostSurfaceId: hostLease.surface_id, runId, surface };
		this.#leasesBySurfaceId.set(request.surfaceId, record);
		this.#surfaceIdsByRunId.set(runId, request.surfaceId);
		this.#pendingRunIdsBySurfaceId.delete(request.surfaceId);
		return surface;
	}

	async getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null> {
		return this.#leasesBySurfaceId.get(surfaceId)?.surface ?? null;
	}

	async listSurfaces(): Promise<BrowserSurface[]> {
		return [...this.#leasesBySurfaceId.values()].map(
			(record) => record.surface,
		);
	}

	async releaseRun(runId: string): Promise<void> {
		const surfaceId = this.#surfaceIdsByRunId.get(runId);
		const pendingSurfaceId = [...this.#pendingRunIdsBySurfaceId].find(
			([, pendingRunId]) => pendingRunId === runId,
		)?.[0];
		await this.#requestNoContent("DELETE", this.#runUrl(runId));
		if (surfaceId) {
			this.#leasesBySurfaceId.delete(surfaceId);
			this.#surfaceIdsByRunId.delete(runId);
		}
		if (pendingSurfaceId) {
			this.#pendingRunIdsBySurfaceId.delete(pendingSurfaceId);
		}
	}

	async stopSurface(
		request: StopBrowserSurfaceRequest,
	): Promise<BrowserSurface | null> {
		const record = this.#leasesBySurfaceId.get(request.surfaceId);
		if (!record) {
			return null;
		}
		await this.#requestNoContent(
			"DELETE",
			this.#leaseUrl(record.hostSurfaceId),
		);
		this.#leasesBySurfaceId.delete(request.surfaceId);
		this.#surfaceIdsByRunId.delete(record.runId);
		return { ...record.surface, health: "stopping" };
	}

	#leaseUrl(hostSurfaceId: string): string {
		return `${this.#leasesUrl()}/${encodeURIComponent(hostSurfaceId)}`;
	}

	#runUrl(runId: string): string {
		return `${this.#endpoint}/browser-surface/runs/${encodeURIComponent(runId)}`;
	}

	#leasesUrl(): string {
		return `${this.#endpoint}/browser-surface/leases`;
	}

	async #requestJson(
		method: "POST",
		url: string,
		body: Record<string, unknown>,
	): Promise<unknown> {
		const response = await this.#request(method, url, JSON.stringify(body));
		try {
			return await response.json();
		} catch (error) {
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_malformed_response",
				`host browser surface ${method} ${url} returned invalid JSON`,
				{ cause: error },
			);
		}
	}

	async #requestNoContent(method: "DELETE", url: string): Promise<void> {
		await this.#request(method, url);
	}

	async #request(
		method: "DELETE" | "POST",
		url: string,
		body?: string,
	): Promise<FetchResponseLike> {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.#requestTimeoutMs,
		);
		try {
			const response = await this.#fetch(url, {
				headers: {
					Authorization: `Bearer ${this.#token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body } : {}),
				method,
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new HostBrowserSurfaceAllocatorError(
					"host_browser_surface_http_error",
					`host browser surface ${method} ${url} returned HTTP ${response.status}`,
				);
			}
			return response;
		} catch (error) {
			if (error instanceof HostBrowserSurfaceAllocatorError) {
				throw error;
			}
			if (controller.signal.aborted) {
				throw new HostBrowserSurfaceAllocatorError(
					"host_browser_surface_timeout",
					`host browser surface ${method} ${url} timed out after ${this.#requestTimeoutMs}ms`,
					{ cause: error },
				);
			}
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_unreachable",
				`host browser surface ${method} ${url} is unreachable`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}

function normalizeEndpoint(endpoint: string): string {
	const trimmed = endpoint.trim();
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
		return parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
	} catch (error) {
		throw new HostBrowserSurfaceAllocatorError(
			"host_browser_surface_invalid_config",
			"host browser surface endpoint must be a valid http(s) URL",
			{ cause: error },
		);
	}
}

function parseHostSurfaceLeaseResponse(
	value: unknown,
): HostSurfaceLeaseResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HostBrowserSurfaceAllocatorError(
			"host_browser_surface_malformed_response",
			"host browser surface lease response must be an object",
		);
	}
	const response = value as Record<string, unknown>;
	const surfaceId = response.surface_id;
	const cdpUrl = response.cdp_url;
	const normalizedSurfaceId =
		typeof surfaceId === "string" ? surfaceId.trim() : "";
	const normalizedCdpUrl = typeof cdpUrl === "string" ? cdpUrl.trim() : "";
	if (!normalizedSurfaceId) {
		throw new HostBrowserSurfaceAllocatorError(
			"host_browser_surface_malformed_response",
			"host browser surface lease response must include surface_id",
		);
	}
	if (!isHttpUrl(normalizedCdpUrl)) {
		throw new HostBrowserSurfaceAllocatorError(
			"host_browser_surface_malformed_response",
			"host browser surface lease response must include an http(s) cdp_url",
		);
	}
	return { cdp_url: normalizedCdpUrl, surface_id: normalizedSurfaceId };
}

function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
