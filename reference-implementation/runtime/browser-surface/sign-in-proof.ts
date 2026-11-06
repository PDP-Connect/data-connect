// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProviderInvalidationProof } from "./repair-decision.ts";

/**
 * Runtime-side provider-invalidation proof.
 *
 * A proof exists only when the run FAILED and the runtime's own observation of
 * the run's browser (its last top-level page URL) matched the sign-in URL
 * pattern the connector manifest declares. A visit to the sign-in page on a
 * healthy run is not proof, and nothing here reads connector-reported gaps or
 * message text.
 */

const MAX_PATTERN_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

/** Declared at `runtime_requirements.bindings.browser.sign_in_url_pattern`. */
export function signInUrlPatternFromManifest(manifest: {
	readonly runtime_requirements?: {
		readonly bindings?: Record<string, unknown>;
	};
}): string | null {
	const browser = manifest.runtime_requirements?.bindings?.browser;
	if (
		browser === null ||
		typeof browser !== "object" ||
		Array.isArray(browser)
	) {
		return null;
	}
	const pattern = (browser as { readonly sign_in_url_pattern?: unknown })
		.sign_in_url_pattern;
	return typeof pattern === "string" &&
		pattern.trim().length > 0 &&
		pattern.length <= MAX_PATTERN_LENGTH
		? pattern.trim()
		: null;
}

/** Anchored glob over the whole URL; `*` matches any run of characters, everything else is literal. */
export function signInUrlMatchesPattern(pattern: string, url: string): boolean {
	if (pattern.length > MAX_PATTERN_LENGTH || url.length > MAX_URL_LENGTH) {
		return false;
	}
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(url);
}

/**
 * Reads the most recent top-level page URL from the run's own browser surface
 * (DevTools target list on the surface the runtime leased). It sends nothing
 * to the provider.
 */
export async function observeLastTopLevelUrl(
	cdpUrl: string,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	timeoutMs = 3000,
): Promise<string | null> {
	const signal = AbortSignal.timeout(timeoutMs);
	const response = await fetchImpl(new URL("/json/list", cdpUrl), { signal });
	if (!response.ok) {
		return null;
	}
	const targets: unknown = await response.json();
	if (!Array.isArray(targets)) {
		return null;
	}
	for (const target of targets as readonly {
		readonly type?: unknown;
		readonly url?: unknown;
	}[]) {
		if (
			target?.type === "page" &&
			typeof target.url === "string" &&
			/^https?:/i.test(target.url)
		) {
			return target.url;
		}
	}
	return null;
}

export interface SignInProofInput {
	readonly connectionId: string;
	readonly lastTopLevelUrl: string | null;
	readonly observedAt: string;
	readonly pattern: string | null;
	readonly provider: string;
	readonly runFailed: boolean;
	readonly runId: string;
}

/** Pure rule: failed run AND last top-level URL matches the declared pattern. */
export function deriveSignInProof(
	input: SignInProofInput,
): ProviderInvalidationProof | null {
	if (!(input.runFailed && input.pattern && input.lastTopLevelUrl)) {
		return null;
	}
	if (!signInUrlMatchesPattern(input.pattern, input.lastTopLevelUrl)) {
		return null;
	}
	return {
		connection_id: input.connectionId,
		evidence_id: input.runId,
		kind: "provider_invalidation_proof",
		observed_at: input.observedAt,
		provider: input.provider,
		verified: true,
	};
}
