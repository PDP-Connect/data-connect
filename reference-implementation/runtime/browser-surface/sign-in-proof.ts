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

export const MAX_SIGN_IN_PATTERN_LENGTH = 512;
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
	const trimmed = typeof pattern === "string" ? pattern.trim() : "";
	return trimmed.length > 0 && trimmed.length <= MAX_SIGN_IN_PATTERN_LENGTH
		? trimmed
		: null;
}

/**
 * Anchored glob over the whole URL; `*` matches any run of characters and
 * everything else is literal. Segments are matched left to right with
 * `indexOf`, never a regular expression, so a hostile pattern cannot trigger
 * backtracking; both inputs are length-capped, which bounds the work.
 */
export function signInUrlMatchesPattern(pattern: string, url: string): boolean {
	if (
		pattern.length > MAX_SIGN_IN_PATTERN_LENGTH ||
		url.length > MAX_URL_LENGTH
	) {
		return false;
	}
	const parts = pattern.split("*");
	if (parts.length === 1) {
		return pattern === url;
	}
	const first = parts[0] ?? "";
	const last = parts.at(-1) ?? "";
	if (
		!(url.startsWith(first) && url.endsWith(last)) ||
		first.length + last.length > url.length
	) {
		return false;
	}
	const end = url.length - last.length;
	let position = first.length;
	for (const part of parts.slice(1, -1)) {
		if (part === "") {
			continue;
		}
		const found = url.indexOf(part, position);
		if (found < 0 || found + part.length > end) {
			return false;
		}
		position = found + part.length;
	}
	return true;
}

/**
 * Reads the run's top-level page URL from its own browser surface (DevTools
 * target list). It sends nothing to the provider. The list does not carry
 * navigation order or run ownership, so it fails closed: the URL is returned
 * only when exactly one page target has an http(s) URL. Several candidates
 * (another tab, a popup) make "the last navigation" unknowable, so no proof.
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
	const candidates = (
		targets as readonly { readonly type?: unknown; readonly url?: unknown }[]
	)
		.filter(
			(target) =>
				target?.type === "page" &&
				typeof target.url === "string" &&
				/^https?:/i.test(target.url),
		)
		.map((target) => target.url as string);
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
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
