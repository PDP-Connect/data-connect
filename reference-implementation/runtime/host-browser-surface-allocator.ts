// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	BrowserSurface,
	BrowserSurfaceAllocator,
	EnsureBrowserSurfaceRequest,
	StopBrowserSurfaceRequest,
} from "@opendatalabs/remote-surface/leases";
import { canonicalConnectorKey } from "../server/connector-key.ts";

const DEFAULT_HOST_REQUEST_TIMEOUT_MS = 5_000;

export interface HostBrowserSurfaceLeaseBinding {
	/**
	 * True only when the owner has exactly one connection of this connector,
	 * so the host may move its old per-connector profile to this connection.
	 */
	readonly migrateConnectorProfile?: boolean;
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

export interface HostBrowserSurfaceStartFailure {
	readonly code: string;
	readonly message: string;
}

export interface HostBrowserSurfaceAllocator extends BrowserSurfaceAllocator {
	readonly bindRunToSurface: (binding: HostBrowserSurfaceLeaseBinding) => void;
	/** Last host-reported start failure recorded for this runId's lease POST, if any. */
	readonly lastStartFailure: (
		runId: string,
	) => HostBrowserSurfaceStartFailure | undefined;
	readonly releaseRun: (runId: string) => Promise<void>;
}

// Bound so a hostile/misbehaving host cannot use the error body to exhaust memory.
const MAX_HOST_ERROR_FIELD_LENGTH = 1_000;

export class HostBrowserSurfaceAllocatorError extends Error {
	readonly code:
		| "host_browser_surface_http_error"
		| "host_browser_surface_invalid_config"
		| "host_browser_surface_malformed_response"
		| "host_browser_surface_missing_lease_context"
		| "host_browser_surface_timeout"
		| "host_browser_surface_unreachable";
	/** The host's `error` field, when the HTTP error body parsed as JSON with one. */
	readonly hostError?: string;
	/** The host's `message` field, when the HTTP error body parsed as JSON with one. */
	readonly hostMessage?: string;

	constructor(
		code: HostBrowserSurfaceAllocatorError["code"],
		message: string,
		options?: ErrorOptions & {
			readonly hostError?: string;
			readonly hostMessage?: string;
		},
	) {
		super(message, options);
		this.name = "HostBrowserSurfaceAllocatorError";
		this.code = code;
		if (options?.hostError !== undefined) {
			this.hostError = options.hostError;
		}
		if (options?.hostMessage !== undefined) {
			this.hostMessage = options.hostMessage;
		}
	}
}

interface HostLeaseRecord {
	/** Null while a lease POST for the run has had no answer. */
	readonly hostSurfaceId: string | null;
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

/** Settle with `work`, or reject as soon as `signal` aborts. */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		work.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() =>
			signal.removeEventListener("abort", onAbort),
		);
	});
}

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
	readonly #migrateProfileBySurfaceId = new Map<string, boolean>();
	readonly #surfaceIdsByRunId = new Map<string, string>();
	readonly #ensuresInFlightBySurfaceId = new Map<
		string,
		{ readonly ensure: Promise<BrowserSurface>; readonly runId: string | undefined }
	>();
	readonly #lastStartFailureByRunId = new Map<
		string,
		HostBrowserSurfaceStartFailure
	>();

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
		this.#migrateProfileBySurfaceId.set(
			binding.surfaceId,
			binding.migrateConnectorProfile === true,
		);
	}

	lastStartFailure(runId: string): HostBrowserSurfaceStartFailure | undefined {
		return this.#lastStartFailureByRunId.get(runId);
	}

	/**
	 * One host request per surface and run at a time. A second caller for the
	 * same run joins the first one's request: two requests could finish in
	 * either order, and a timed-out one finishing last would record the
	 * surface as starting over the ready lease the other one got. A surface
	 * is reused by the next run once its lease is released, so a caller for a
	 * newly bound run never joins an older run's request.
	 */
	ensureSurface(request: EnsureBrowserSurfaceRequest): Promise<BrowserSurface> {
		const runId = this.#pendingRunIdsBySurfaceId.get(request.surfaceId);
		const inFlight = this.#ensuresInFlightBySurfaceId.get(request.surfaceId);
		if (inFlight && inFlight.runId === runId) {
			return inFlight.ensure;
		}
		const ensure: Promise<BrowserSurface> = this.#ensureSurfaceOnce(
			request,
			runId,
		).finally(() => {
			if (this.#ensuresInFlightBySurfaceId.get(request.surfaceId)?.ensure === ensure) {
				this.#ensuresInFlightBySurfaceId.delete(request.surfaceId);
			}
		});
		this.#ensuresInFlightBySurfaceId.set(request.surfaceId, { ensure, runId });
		return ensure;
	}

	async #ensureSurfaceOnce(
		request: EnsureBrowserSurfaceRequest,
		runId: string | undefined,
	): Promise<BrowserSurface> {
		const existing = this.#leasesBySurfaceId.get(request.surfaceId);
		// The binding is consumed when a start succeeds, so an unbound surface
		// with a ready lease is that run's surface. A newly bound run never
		// reuses another run's lease.
		if (existing?.hostSurfaceId && (runId === undefined || existing.runId === runId)) {
			return existing.surface;
		}
		if (!runId) {
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_missing_lease_context",
				`no run_id was bound for browser surface ${request.surfaceId}`,
			);
		}
		// The host keeps one browser profile per connection. A lease without a
		// connection would fall back to a profile shared by every account of
		// the connector, so it is refused instead.
		const connectionId = request.surfaceSubjectId?.trim();
		if (!connectionId) {
			throw new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_missing_lease_context",
				`no connection id was bound for browser surface ${request.surfaceId}`,
			);
		}
		let response: unknown;
		try {
			response = await this.#requestJson("POST", this.#leasesUrl(), {
				run_id: runId,
				// Canonical, so the host profile key matches the one the RI's
				// post-delete purge sends (server/browser-profile-purge.ts).
				connector_id:
					canonicalConnectorKey(request.connectorId) ?? request.connectorId,
				connection_id: connectionId,
				migrate_connector_profile:
					this.#migrateProfileBySurfaceId.get(request.surfaceId) === true,
				headless: this.#headless,
			});
		} catch (error) {
			if (error instanceof HostBrowserSurfaceAllocatorError) {
				this.#lastStartFailureByRunId.set(runId, {
					code: error.hostError ?? error.code,
					message: error.hostMessage ?? error.message,
				});
				if (error.code === "host_browser_surface_timeout") {
					// No answer does not mean no browser: the host can still be
					// starting one for this run. Report the surface as starting. The
					// lease manager asks again within its readiness budget, and the
					// host answers a repeated run_id with the start it already has.
					return this.#recordSurfaceIfStillBound(request, runId, null);
				}
			}
			throw error;
		}
		this.#lastStartFailureByRunId.delete(runId);
		const surface = this.#recordSurfaceIfStillBound(
			request,
			runId,
			parseHostSurfaceLeaseResponse(response),
		);
		this.#forgetBinding(request.surfaceId, runId);
		return surface;
	}

	#isBound(surfaceId: string, runId: string): boolean {
		return this.#pendingRunIdsBySurfaceId.get(surfaceId) === runId;
	}

	// The two helpers below run after an awaited host request. While it ran,
	// the surface may have been bound to, or started for, another run, so each
	// removes only state that still belongs to `runId`.

	/** Drop `runId`'s pending binding of `surfaceId`. */
	#forgetBinding(surfaceId: string, runId: string): void {
		if (this.#isBound(surfaceId, runId)) {
			this.#pendingRunIdsBySurfaceId.delete(surfaceId);
			this.#migrateProfileBySurfaceId.delete(surfaceId);
		}
	}

	/** Drop `record`, the lease `runId` held on `surfaceId`, and the run's index entry. */
	#forgetLease(
		surfaceId: string,
		runId: string,
		record: HostLeaseRecord | undefined,
	): void {
		if (
			record?.runId === runId &&
			this.#leasesBySurfaceId.get(surfaceId) === record
		) {
			this.#leasesBySurfaceId.delete(surfaceId);
		}
		if (
			this.#surfaceIdsByRunId.get(runId) === surfaceId &&
			this.#leasesBySurfaceId.get(surfaceId)?.runId !== runId
		) {
			this.#surfaceIdsByRunId.delete(runId);
		}
	}

	/**
	 * Record a start's answer, unless the surface was released or bound to
	 * another run while the request ran. That answer belongs to a run that no
	 * longer owns the surface, so it is returned to its caller and not stored
	 * over the current run's state. Releasing a run makes the host drop any
	 * browser it still starts for it.
	 */
	#recordSurfaceIfStillBound(
		request: EnsureBrowserSurfaceRequest,
		runId: string,
		hostLease: HostSurfaceLeaseResponse | null,
	): BrowserSurface {
		const surface = this.#describeSurface(request, hostLease);
		if (!this.#isBound(request.surfaceId, runId)) {
			return surface;
		}
		this.#leasesBySurfaceId.set(request.surfaceId, {
			hostSurfaceId: hostLease?.surface_id ?? null,
			runId,
			surface,
		});
		this.#surfaceIdsByRunId.set(runId, request.surfaceId);
		return surface;
	}

	#describeSurface(
		request: EnsureBrowserSurfaceRequest,
		hostLease: HostSurfaceLeaseResponse | null,
	): BrowserSurface {
		const now = this.#now().toISOString();
		return {
			...(hostLease
				? { allocator_metadata: { host_surface_id: hostLease.surface_id } }
				: {}),
			backend: "neko",
			cdp_url: hostLease?.cdp_url ?? "",
			connector_id: request.connectorId,
			created_at: now,
			health: hostLease ? "ready" : "starting",
			last_used_at: now,
			profile_key: request.profileKey,
			// The host contract supplies CDP only. The legacy field is required by
			// the lease type, but an empty value prevents callers from mistaking CDP
			// for a browser-stream endpoint.
			stream_base_url: "",
			surface_id: request.surfaceId,
		};
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
		const record = surfaceId
			? this.#leasesBySurfaceId.get(surfaceId)
			: undefined;
		const pendingSurfaceId = [...this.#pendingRunIdsBySurfaceId].find(
			([, pendingRunId]) => pendingRunId === runId,
		)?.[0];
		await this.#requestNoContent("DELETE", this.#runUrl(runId));
		if (surfaceId) {
			this.#forgetLease(surfaceId, runId, record);
		}
		if (pendingSurfaceId) {
			this.#forgetBinding(pendingSurfaceId, runId);
		}
		this.#lastStartFailureByRunId.delete(runId);
	}

	async stopSurface(
		request: StopBrowserSurfaceRequest,
	): Promise<BrowserSurface | null> {
		const record = this.#leasesBySurfaceId.get(request.surfaceId);
		if (!record) {
			return null;
		}
		// An unanswered start has no host surface id. Releasing its run makes
		// the host tear down that browser when the start completes, and refuse
		// the run from then on.
		await this.#requestNoContent(
			"DELETE",
			record.hostSurfaceId === null
				? this.#runUrl(record.runId)
				: this.#leaseUrl(record.hostSurfaceId),
		);
		this.#forgetLease(request.surfaceId, record.runId, record);
		this.#forgetBinding(request.surfaceId, record.runId);
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

	#requestJson(
		method: "POST",
		url: string,
		body: Record<string, unknown>,
	): Promise<unknown> {
		return this.#request(method, url, JSON.stringify(body), async (response) => {
			try {
				return await response.json();
			} catch (error) {
				throw new HostBrowserSurfaceAllocatorError(
					"host_browser_surface_malformed_response",
					`host browser surface ${method} ${url} returned invalid JSON`,
					{ cause: error },
				);
			}
		});
	}

	async #requestNoContent(method: "DELETE", url: string): Promise<void> {
		// A 404 means the host no longer holds the lease (for example after a
		// host restart), so the release already happened. Treating it as an
		// error would leave the surface ready here and retry the DELETE forever.
		await this.#request(method, url, undefined, async () => undefined, {
			notFoundIsSuccess: true,
		});
	}

	/**
	 * Send one request and read its body within one deadline. Headers alone do
	 * not finish a request: a host that sends them and then stalls the body
	 * times out the same way as one that never answers.
	 */
	async #request<T>(
		method: "DELETE" | "POST",
		url: string,
		body: string | undefined,
		read: (response: FetchResponseLike) => Promise<T>,
		{ notFoundIsSuccess = false }: { notFoundIsSuccess?: boolean } = {},
	): Promise<T> {
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
			if (!response.ok && !(notFoundIsSuccess && response.status === 404)) {
				throw await beforeAbort(
					this.#buildHttpError(method, url, response),
					controller.signal,
				);
			}
			return await beforeAbort(read(response), controller.signal);
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

	async #buildHttpError(
		method: "DELETE" | "POST",
		url: string,
		response: FetchResponseLike,
	): Promise<HostBrowserSurfaceAllocatorError> {
		const baseMessage = `host browser surface ${method} ${url} returned HTTP ${response.status}`;
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_http_error",
				baseMessage,
			);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_http_error",
				baseMessage,
			);
		}
		const record = body as Record<string, unknown>;
		const hostError =
			typeof record.error === "string"
				? truncateHostErrorField(record.error)
				: undefined;
		const hostMessage =
			typeof record.message === "string"
				? truncateHostErrorField(record.message)
				: undefined;
		if (hostError === undefined && hostMessage === undefined) {
			return new HostBrowserSurfaceAllocatorError(
				"host_browser_surface_http_error",
				baseMessage,
			);
		}
		const detail = [hostError, hostMessage]
			.filter((part) => part !== undefined)
			.join(": ");
		return new HostBrowserSurfaceAllocatorError(
			"host_browser_surface_http_error",
			`${baseMessage}: ${detail}`,
			{
				...(hostError !== undefined ? { hostError } : {}),
				...(hostMessage !== undefined ? { hostMessage } : {}),
			},
		);
	}
}

function truncateHostErrorField(value: string): string {
	return value.length > MAX_HOST_ERROR_FIELD_LENGTH
		? value.slice(0, MAX_HOST_ERROR_FIELD_LENGTH)
		: value;
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
