// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProviderInvalidationProofStore } from "../../server/stores/provider-invalidation-proof-store.ts";
import {
	deriveSignInProof,
	observeLastTopLevelUrl,
	signInUrlPatternFromManifest,
} from "./sign-in-proof.ts";

export interface RecordSignInProofInput {
	/** The leased surface's DevTools base URL, or null when the run had no leased surface. */
	readonly cdpUrl: string | null;
	readonly connectionId: string;
	readonly connectorId: string;
	/**
	 * Re-checked after the DevTools read and before the write; false means the
	 * run was superseded while the read was in flight, so nothing is written.
	 */
	readonly isCurrent?: () => boolean;
	readonly manifest: Parameters<typeof signInUrlPatternFromManifest>[0];
	readonly nowIso: string;
	readonly runId: string;
	/** The run's terminal status from the runtime result. */
	readonly status: string | null | undefined;
}

export interface RecordSignInProofDeps {
	readonly fetchImpl?: typeof fetch;
	readonly store: ProviderInvalidationProofStore;
}

/**
 * Run-completion writer. A failed run on a connector that declares a sign-in
 * pattern records a proof when the run's last top-level URL matches it. A
 * succeeded run marks earlier proofs repaired so they cannot prompt again.
 * Connectors without a pattern, and every other status, change nothing.
 */
export async function recordSignInProofAfterRun(
	deps: RecordSignInProofDeps,
	input: RecordSignInProofInput,
): Promise<"recorded" | "repaired" | "none"> {
	// Repair first: a success must clear earlier proofs even when the manifest
	// no longer declares a pattern.
	if (input.status === "succeeded") {
		await deps.store.markRepaired(input.connectionId, input.nowIso);
		return "repaired";
	}
	const pattern = signInUrlPatternFromManifest(input.manifest);
	if (!pattern) {
		return "none";
	}
	if (input.status !== "failed" || !input.cdpUrl) {
		return "none";
	}
	const lastTopLevelUrl = await observeLastTopLevelUrl(
		input.cdpUrl,
		deps.fetchImpl,
	).catch(() => null);
	const proof = deriveSignInProof({
		connectionId: input.connectionId,
		lastTopLevelUrl,
		observedAt: input.nowIso,
		pattern,
		provider: input.connectorId,
		runFailed: true,
		runId: input.runId,
	});
	if (!proof || input.isCurrent?.() === false) {
		return "none";
	}
	await deps.store.record(proof);
	return "recorded";
}
