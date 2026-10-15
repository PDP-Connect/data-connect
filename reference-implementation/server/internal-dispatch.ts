// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

export interface DispatchInfo {
	active?: boolean;
	exp?: number | null;
	[key: string]: unknown;
}

export interface DispatchEntry {
	readonly info: Readonly<DispatchInfo>;
	readonly openedAt: number;
	readonly resource: string;
}

interface InjectResult {
	headers: Record<string, string | string[] | undefined>;
	payload: string;
	statusCode: number;
}

export interface DispatchApp {
	inject: (options: {
		headers: Record<string, string>;
		method: "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
		payload?: Buffer;
		url: string;
	}) => Promise<InjectResult>;
}

const registry = new Map<string, DispatchEntry>();
const requestSignals = new WeakMap<object, AbortSignal>();
const dispatchedTokenInfos = new WeakSet<object>();

export function setRequestAbortSignal(request: object, signal: AbortSignal): void {
	requestSignals.set(request, signal);
}

export function getRequestAbortSignal(request: object | undefined): AbortSignal | undefined {
	return request ? requestSignals.get(request) : undefined;
}

export function getDispatchRegistrySize(): number {
	return registry.size;
}

export function getDispatchEntry(nonce: string): DispatchEntry | undefined {
	return registry.get(nonce);
}

export function markDispatchedTokenInfo(info: object): void {
	dispatchedTokenInfos.add(info);
}

export function getEventTokenId(authorization: unknown, tokenInfo?: object | null): string | null {
	if (tokenInfo && dispatchedTokenInfos.has(tokenInfo)) {
		const grantId = (tokenInfo as { grant_id?: unknown }).grant_id;
		return typeof grantId === "string" ? grantId : null;
	}
	if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
		return null;
	}
	return authorization.slice(7);
}

function createInProcessFetch(app: DispatchApp, nonce: string): typeof globalThis.fetch {
	const dispatchFetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const headers: Record<string, string> = {};
		request.headers.forEach((value, name) => {
			if (name.toLowerCase() !== "authorization") {
				headers[name] = value;
			}
		});
		headers.authorization = `Bearer ${nonce}`;
		const body = ["GET", "HEAD"].includes(request.method)
			? undefined
			: Buffer.from(await request.arrayBuffer());
		const response = await app.inject({
			headers,
			method: request.method as
				| "DELETE"
				| "GET"
				| "HEAD"
				| "OPTIONS"
				| "PATCH"
				| "POST"
				| "PUT",
			...(body === undefined ? {} : { payload: body }),
			url: `${url.pathname}${url.search}`,
		});
		const responseBody = [204, 205, 304].includes(response.statusCode)
			? null
			: response.payload;
		const responseHeaders = new Headers();
		for (const [name, value] of Object.entries(response.headers)) {
			if (Array.isArray(value)) {
				for (const item of value) {
					responseHeaders.append(name, item);
				}
			} else if (value !== undefined) {
				responseHeaders.set(name, value);
			}
		}
		return new Response(responseBody, {
			headers: responseHeaders,
			status: response.statusCode,
		});
	};
	return dispatchFetch;
}

export async function runWithDispatchScope<Result>(
	info: DispatchInfo,
	resource: string,
	app: DispatchApp,
	fn: (fetch: typeof globalThis.fetch) => Promise<Result>,
	signal?: AbortSignal,
): Promise<Result> {
	if (signal?.aborted) {
		throw new DOMException("The operation was aborted", "AbortError");
	}
	const nonce = randomBytes(16).toString("hex");
	registry.set(nonce, {
		info: structuredClone(info),
		openedAt: Date.now(),
		resource,
	});
	const removeOnAbort = () => registry.delete(nonce);
	signal?.addEventListener("abort", removeOnAbort, { once: true });
	try {
		return await fn(createInProcessFetch(app, nonce));
	} finally {
		signal?.removeEventListener("abort", removeOnAbort);
		registry.delete(nonce);
	}
}
