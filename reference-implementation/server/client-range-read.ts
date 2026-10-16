// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
	type ClientRangeFilter,
	clientFilterSetKey,
	compileClientRangeFilters,
	type FrozenFilterSet,
	type FrozenStream,
	parseFrozenFilterSet,
} from "./client-range-filters.ts";
import { isPostgresStorageBackend } from "./postgres-storage.ts";
import { invalidQueryError } from "./record-filters.ts";

// The compiled client range filters of one list read ride on the request
// parameters under a symbol key. Query-string parsing cannot produce a symbol
// key, so a client cannot forge one, and key enumeration (unsupported-parameter
// checks, cache keys) never sees it. Object spread still copies it, which keeps
// it attached through the per-binding parameter copies of fan-in reads.
const READ = Symbol.for("pdpp.client_range_filters.read");

export interface ClientRangeRead {
	// Digest of the unordered decoded (field, operator, value) triples
	// (Section 6.7). Cursors and sync tokens carry it, never the values.
	binding: string;
	filters: ClientRangeFilter[];
}

export function attachClientRangeRead(
	params: Record<string | symbol, unknown>,
	filters: ClientRangeFilter[],
): void {
	if (filters.length === 0) {
		return;
	}
	const read: ClientRangeRead = {
		binding: createHash("sha256")
			.update(clientFilterSetKey(filters))
			.digest("hex")
			.slice(0, 32),
		filters,
	};
	params[READ] = read;
}

export function clientRangeReadOf(
	params: Record<string | symbol, unknown>,
): ClientRangeRead | undefined {
	return params[READ] as ClientRangeRead | undefined;
}

// ---------------------------------------------------------------------------
// Resource-server glue (spec-client-range-filters.md Sections 4.4, 6, 7).
// The pure core lives in client-range-filters.ts; this file decides when it
// applies and turns its outcomes into the errors the read routes emit.
// ---------------------------------------------------------------------------

export interface ClientRangeFiltersPolicy {
	/** Whether this deployment serves the experimental profile at all. */
	enabled: () => boolean;
	/**
	 * Whether this deployment can evaluate one frozen filter right now. A false
	 * answer fails a request that supplies the filter with 403 grant_invalid
	 * (Section 6.9) and never changes the grant's frozen metadata (Section 7).
	 */
	evaluable: (input: { field: string; stream: string }) => boolean;
}

export const CLIENT_RANGE_FILTERS_DISABLED: ClientRangeFiltersPolicy = {
	enabled: () => false,
	evaluable: () => false,
};

interface GrantWithExtensions {
	extensions?: unknown;
	streams?: Array<{ name: string; fields?: string[] | null }>;
}

function readFrozenFilterSet(grant: unknown): FrozenFilterSet {
	const typed = (grant ?? {}) as GrantWithExtensions;
	return parseFrozenFilterSet(
		typed.extensions,
		Array.isArray(typed.streams) ? typed.streams : [],
	);
}

/**
 * True when the grant carries a frozen set the RS must refuse to serve under
 * (Section 4.4). The RS never repairs the member. Only a client token under a
 * deployment that serves the profile is checked: otherwise Core ignores an
 * unknown extension member.
 */
export function grantFrozenSetIsMalformed(
	policy: ClientRangeFiltersPolicy,
	tokenKind: string | null | undefined,
	grant: unknown,
): boolean {
	return (
		policy.enabled() &&
		tokenKind === "client" &&
		readFrozenFilterSet(grant).kind === "malformed"
	);
}

/** The frozen set of one stream, or undefined when the grant freezes none. */
export function frozenStreamOf(
	policy: ClientRangeFiltersPolicy,
	tokenKind: string | null | undefined,
	grant: unknown,
	stream: string,
): FrozenStream | undefined {
	if (!policy.enabled() || tokenKind !== "client") {
		return;
	}
	const frozen = readFrozenFilterSet(grant);
	return frozen.kind === "ok" ? frozen.streams.get(stream) : undefined;
}

function isFilterParameterName(name: string): boolean {
	return name === "filter" || name.startsWith("filter[");
}

/**
 * Section 6.1: where the profile applies, a client filter on any endpoint other
 * than list-records fails with 400 invalid_request. Returns the first filter
 * parameter name in the raw query, or undefined.
 */
export function clientFilterParameterOutsideList(
	policy: ClientRangeFiltersPolicy,
	tokenKind: string | null | undefined,
	rawQuery: string,
): string | undefined {
	if (!policy.enabled() || tokenKind !== "client") {
		return undefined;
	}
	for (const [name] of new URLSearchParams(rawQuery)) {
		if (isFilterParameterName(name)) {
			return name;
		}
	}
	return undefined;
}

/**
 * Compile the client range filters of one list-records read and attach them to
 * the request parameters. Throws the typed errors of Section 6: 400
 * invalid_request for a filter the frozen set does not allow or whose value is
 * invalid, 403 grant_invalid for a filter this deployment cannot evaluate.
 *
 * When the profile does not apply (disabled, owner token, no frozen set for the
 * stream) the parameters are left untouched, so Core's rejection of
 * client-token filters still fires downstream (Section 6.1).
 */
export function prepareClientRangeListRead(input: {
	grant: unknown;
	policy: ClientRangeFiltersPolicy;
	rawQuery: string;
	requestParams: Record<string | symbol, unknown>;
	stream: string;
	tokenKind: string | null | undefined;
}): void {
	const frozenStream = frozenStreamOf(
		input.policy,
		input.tokenKind,
		input.grant,
		input.stream,
	);
	if (!frozenStream) {
		return;
	}
	const pairs = [...new URLSearchParams(input.rawQuery)];
	const compiled = compileClientRangeFilters(pairs, frozenStream);
	if (!compiled.ok) {
		const error = invalidQueryError(
			compiled.error.message,
			compiled.error.code,
		);
		Object.assign(error, { param: compiled.error.param });
		throw error;
	}
	for (const filter of compiled.filters) {
		if (
			!input.policy.evaluable({ field: filter.field, stream: input.stream })
		) {
			throw invalidQueryError(
				"A client range filter in this request cannot be evaluated by this server",
				"grant_invalid",
			);
		}
	}
	for (const key of Object.keys(input.requestParams)) {
		if (isFilterParameterName(key)) {
			Reflect.deleteProperty(input.requestParams, key);
		}
	}
	attachClientRangeRead(input.requestParams, compiled.filters);
}

export type ClientRangeFiltersOption =
	| boolean
	| {
			enabled?: boolean;
			evaluable?: ClientRangeFiltersPolicy["evaluable"];
	  };

/** Environment switch for deployments that cannot pass the server option. */
export const CLIENT_RANGE_FILTERS_ENV =
	"PDPP_EXPERIMENTAL_CLIENT_RANGE_FILTERS";

/**
 * Resolve the deployment policy. The profile is off unless an operator opts in
 * (option or environment), and it is never offered on the Postgres backend:
 * exact decimal and leap-second comparison runs in the server, over the
 * stored record text, not in SQL pushdown. Without that, every supplied
 * filter would be unevaluable, so the deployment must not advertise support.
 */
export function resolveClientRangeFiltersPolicy(
	opts:
		| { clientRangeFilters?: ClientRangeFiltersOption | undefined }
		| null
		| undefined,
	environment: NodeJS.ProcessEnv = process.env,
): ClientRangeFiltersPolicy {
	const option = opts?.clientRangeFilters;
	const requested =
		option === undefined
			? environment[CLIENT_RANGE_FILTERS_ENV] === "1"
			: option === true || (option !== false && option.enabled === true);
	const evaluable =
		typeof option === "object" && option !== null
			? option.evaluable
			: undefined;
	return {
		enabled: () => requested && !isPostgresStorageBackend(),
		evaluable: (input) => evaluable?.(input) ?? true,
	};
}
