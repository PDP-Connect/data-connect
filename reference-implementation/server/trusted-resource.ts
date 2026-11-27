// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isIPv4 } from "node:net";

/**
 * Canonical resource bases come from valid configured URLs or a valid loopback
 * runtime URL. HTTP is accepted only for exact loopback hosts. Non-loopback HTTP
 * configurations, including private LAN and IPv4-mapped IPv6, return null on
 * exposed listeners. Published URLs must use lowercase `http://` or `https://`
 * syntax with no userinfo, backslash, whitespace, query, or fragment. A null
 * result means callers must reject tokens.
 */

export interface ResolveTrustedResourceBaseOptions {
	readonly configuredPublicUrl?: unknown;
	readonly runtimeRsUrl?: string | null;
	readonly listenHost?: unknown;
}

function normalizePublishedUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}

	try {
		const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
		if (!match || /[\s\p{Cc}\\]/u.test(value)) {
			return null;
		}

		const [, scheme, authority] = match;
		if (!scheme || !authority || authority.includes("@")) {
			return null;
		}

		const url = new URL(value);
		const authorityUrl = new URL(`${scheme}://${authority}/`);
		const reconstructedOrigin = `${scheme}://${authorityUrl.host}`;
		if (
			url.origin !== reconstructedOrigin ||
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && isLoopbackListenHost(url.hostname))) ||
			url.username !== "" ||
			url.password !== ""
		) {
			return null;
		}

		const path = url.pathname.replace(/\/+$/, "");
		return `${url.origin}${path}`;
	} catch {
		return null;
	}
}

export function isLoopbackListenHost(host: unknown): boolean {
	if (typeof host !== "string") {
		return false;
	}

	const normalized = host.toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]"
	) {
		return true;
	}
	return isIPv4(host) && Number(host.slice(0, host.indexOf("."))) === 127;
}

/**
 * Nullish options return null. An absent public URL allows a loopback-only
 * runtime fallback; a present but invalid URL fails closed instead.
 */
export function resolveTrustedResourceBase(
	options?: ResolveTrustedResourceBaseOptions | null,
): string | null {
	if (!options || typeof options !== "object") {
		return null;
	}

	const { configuredPublicUrl, runtimeRsUrl, listenHost } = options;
	const configurationIsAbsent =
		configuredPublicUrl === null ||
		configuredPublicUrl === undefined ||
		(typeof configuredPublicUrl === "string" && !configuredPublicUrl.trim());
	if (!configurationIsAbsent) {
		return normalizePublishedUrl(configuredPublicUrl);
	}

	if (!isLoopbackListenHost(listenHost)) {
		return null;
	}

	const runtimeBase = normalizePublishedUrl(runtimeRsUrl);
	if (!runtimeBase) {
		return null;
	}

	const runtimeHostname = new URL(runtimeBase).hostname;
	return isLoopbackListenHost(runtimeHostname) ? runtimeBase : null;
}

export function trustedRsResource(base: string): string {
	return base;
}

export function trustedMcpResource(base: string): string {
	return `${base}/mcp`;
}
