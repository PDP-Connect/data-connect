// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	type PairwiseInstanceBinding,
	resolveInternalInstanceId,
	type ValidatedPairwiseInstanceBindings,
	validatePairwiseInstanceBindings,
} from "./pairwise-identity.ts";

type IdentityError = Error & { code: string; param?: string };

function identityError(
	code: string,
	message: string,
	param?: string,
): IdentityError {
	return Object.assign(new Error(message), {
		code,
		...(param ? { param } : {}),
	});
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export interface PairwiseReadToken {
	readonly client_id?: unknown;
	readonly grant?: {
		readonly source?: { readonly id?: unknown } | null;
		readonly streams?:
			| readonly {
					readonly instance_ids?: readonly unknown[] | null;
					readonly name?: unknown;
			  }[]
			| null;
	} | null;
	readonly pdpp_instance_bindings?: unknown;
	readonly subject_id?: unknown;
}

export interface PairwiseReadMap {
	readonly bindings: readonly PairwiseInstanceBinding[];
	readonly byHandle: ReadonlyMap<string, string>;
	readonly byInternalId: ReadonlyMap<string, string>;
	readonly sourceId: string;
	readonly stream: string;
}

export interface PairwiseClientReadContext {
	readonly bindings: readonly PairwiseInstanceBinding[];
	readonly byHandle: ReadonlyMap<string, string>;
	readonly byInternalId: ReadonlyMap<string, string>;
	readonly handlesByStream: ReadonlyMap<string, ReadonlySet<string>>;
	readonly sourceId: string;
}

/** Validate every authenticated client stream before selecting a request instance. */
export function pairwiseClientReadContext(
	token: PairwiseReadToken,
	sourceId: string,
): PairwiseClientReadContext {
	const grant = token?.grant;
	if (
		!nonEmpty(token?.client_id) ||
		!nonEmpty(token.subject_id) ||
		!grant ||
		!Array.isArray(grant.streams) ||
		!nonEmpty(grant.source?.id) ||
		grant.source.id !== sourceId
	) {
		throw identityError(
			"grant_invalid",
			"Authenticated client grant context is invalid",
		);
	}

	const streamNames = new Set<string>();
	const expected = new Set<string>();
	for (const stream of grant.streams) {
		if (
			!stream ||
			!nonEmpty(stream.name) ||
			streamNames.has(stream.name) ||
			!Array.isArray(stream.instance_ids) ||
			stream.instance_ids.length === 0
		) {
			throw identityError(
				"grant_invalid",
				"Authenticated client grant streams are invalid",
			);
		}
		streamNames.add(stream.name);
		const handles = new Set<string>();
		for (const handle of stream.instance_ids) {
			if (!nonEmpty(handle) || handles.has(handle)) {
				throw identityError(
					"grant_invalid",
					"Authenticated client instance handles are invalid",
				);
			}
			handles.add(handle);
			expected.add(JSON.stringify([sourceId, stream.name, handle]));
		}
	}
	let bindings: ValidatedPairwiseInstanceBindings;
	try {
		if (!Array.isArray(token.pdpp_instance_bindings))
			throw new Error("missing bindings");
		bindings = validatePairwiseInstanceBindings(
			token.pdpp_instance_bindings as PairwiseInstanceBinding[],
		);
	} catch {
		throw identityError(
			"grant_invalid",
			"Authenticated client instance bindings are invalid",
		);
	}
	if (
		bindings.length !== expected.size ||
		bindings.some(
			(binding) =>
				Object.hasOwn(binding, "grant_id") ||
				!binding.stream ||
				!expected.has(
					JSON.stringify([
						binding.source_id,
						binding.stream,
						binding.instance_id,
					]),
				),
		)
	) {
		throw identityError(
			"grant_invalid",
			"Authenticated client bindings do not exactly cover the grant",
		);
	}

	const handlesByStream = new Map<string, ReadonlySet<string>>();
	const byHandle = new Map<string, string>();
	const byInternalId = new Map<string, string>();
	for (const stream of grant.streams) {
		const handles = new Set<string>();
		for (const handle of stream.instance_ids as readonly string[]) {
			const internalId = resolveInternalInstanceId(
				handle,
				bindings,
				sourceId,
				stream.name,
			);
			handles.add(handle);
			byHandle.set(handle, internalId);
			byInternalId.set(internalId, handle);
		}
		handlesByStream.set(stream.name as string, handles);
	}
	return { bindings, byHandle, byInternalId, handlesByStream, sourceId };
}

/** Keep the detail/window view scoped to its existing target stream. */
export function pairwiseClientReadMap(
	token: PairwiseReadToken,
	sourceId: string,
	streamName: string,
): PairwiseReadMap {
	const context = pairwiseClientReadContext(token, sourceId);
	const handles = context.handlesByStream.get(streamName);
	if (!handles) {
		throw identityError(
			"grant_invalid",
			"Requested stream is outside the authenticated grant",
		);
	}
	const byHandle = new Map(
		[...handles].map((handle) => [
			handle,
			context.byHandle.get(handle) as string,
		]),
	);
	const byInternalId = new Map(
		[...byHandle].map(([handle, internalId]) => [internalId, handle]),
	);
	return {
		bindings: context.bindings,
		byHandle,
		byInternalId,
		sourceId,
		stream: streamName,
	};
}

const OWNER_KEYS = "instance_id,rs_instance,source_id";

/** Validate the full authenticated owner binding set; unbound stored instances stay outside this map. */
export function pairwiseOwnerReadMap(
	token: PairwiseReadToken,
): PairwiseReadMap {
	let bindings: ValidatedPairwiseInstanceBindings;
	try {
		const raw = token?.pdpp_instance_bindings;
		if (!Array.isArray(raw)) throw new Error("missing owner bindings");
		for (const candidate of raw) {
			if (
				!candidate ||
				typeof candidate !== "object" ||
				Array.isArray(candidate) ||
				Object.keys(candidate).sort().join(",") !== OWNER_KEYS
			) {
				throw new Error("invalid owner binding shape");
			}
		}
		bindings = validatePairwiseInstanceBindings(
			raw as PairwiseInstanceBinding[],
		);
	} catch {
		throw identityError(
			"grant_invalid",
			"Authenticated owner instance bindings are invalid",
		);
	}
	const byHandle = new Map<string, string>();
	const byInternalId = new Map<string, string>();
	for (const binding of bindings) {
		byHandle.set(binding.instance_id, binding.rs_instance);
		byInternalId.set(binding.rs_instance, binding.instance_id);
	}
	return { bindings, byHandle, byInternalId, sourceId: "*", stream: "*" };
}

/** Narrow an already validated owner map to one authenticated source. */
export function pairwiseOwnerReadMapForSource(
	readMap: PairwiseReadMap,
	sourceId: string,
): PairwiseReadMap {
	const bindings = readMap.bindings.filter(
		(binding) => binding.source_id === sourceId,
	);
	return {
		bindings,
		byHandle: new Map(
			bindings.map((binding) => [binding.instance_id, binding.rs_instance]),
		),
		byInternalId: new Map(
			bindings.map((binding) => [binding.rs_instance, binding.instance_id]),
		),
		sourceId,
		stream: readMap.stream,
	};
}

/** Validate selector syntax without using authenticated identity state. */
export function parsePairwiseReadSelectorSyntax(
	query: Readonly<Record<string, unknown>>,
): string | null {
	const values: string[] = [];
	for (const key of ["instance_id", "connection_id"]) {
		if (!Object.hasOwn(query, key)) continue;
		const value = query[key];
		if (typeof value !== "string" || !value.trim()) {
			throw identityError(
				"invalid_request",
				"Instance selector must be supplied once as a non-empty string",
				key,
			);
		}
		values.push(value);
	}
	if (Object.hasOwn(query, "connector_instance_id")) {
		throw identityError(
			"invalid_request",
			"Use instance_id to select a record instance",
			"instance_id",
		);
	}
	if (values.length > 1 && values.some((value) => value !== values[0])) {
		throw identityError(
			"invalid_request",
			"Instance selectors must use the same public handle",
			"instance_id",
		);
	}
	return values[0] ?? null;
}

/** Parse the public selector pair. Equal aliases are accepted; duplicate or malformed values fail closed. */
export function parsePairwiseReadSelector(
	query: Readonly<Record<string, unknown>>,
	readMap: PairwiseReadMap,
	options: { readonly requireSelector?: boolean } = {},
): { readonly handle: string; readonly internalId: string } {
	const handle = parsePairwiseReadSelectorSyntax(query);
	if (handle === null) {
		if (options.requireSelector) {
			throw identityError(
				"invalid_request",
				"instance_id is required for blob reads",
				"instance_id",
			);
		}
		if (readMap.byHandle.size === 1) {
			const [handle, internalId] = readMap.byHandle.entries().next().value as [
				string,
				string,
			];
			return { handle, internalId };
		}
		if (readMap.byHandle.size === 0) {
			throw identityError(
				"not_found",
				"Instance is not available under this authorization",
				"instance_id",
			);
		}
		throw identityError(
			"invalid_request",
			"instance_id is required when more than one record instance is available",
			"instance_id",
		);
	}
	const internalId = readMap.byHandle.get(handle);
	if (!internalId) {
		if (readMap.bindings.some((binding) => binding.rs_instance === handle)) {
			throw identityError(
				"invalid_request",
				"Use the public instance_id handle",
				"instance_id",
			);
		}
		throw identityError(
			"not_found",
			"Instance is not available under this authorization",
			"instance_id",
		);
	}
	return { handle, internalId };
}

/** Keep translated storage identifiers and backend messages out of HTTP errors. */
export function safePairwiseDetailError(value: unknown): Error & {
	code: string;
	param?: string;
} {
	const source = value as { code?: unknown; param?: unknown } | null;
	const code = typeof source?.code === "string" ? source.code : "";
	const param =
		code === "invalid_request" &&
		typeof source?.param === "string" &&
		/^[a-z_]{1,64}$/.test(source.param)
			? source.param
			: undefined;
	if (code === "invalid_request") {
		return Object.assign(new Error("The record detail request is invalid"), {
			code,
			...(param ? { param } : {}),
		});
	}
	if (code === "stream_not_declared" || code === "invalid_expand") {
		const message = code === "stream_not_declared"
			? "The requested stream is not declared"
			: "The record expansion request is invalid";
		return Object.assign(new Error(message), { code });
	}
	if (code === "grant_invalid") {
		return Object.assign(
			new Error("Authenticated instance bindings are invalid"),
			{
				code,
			},
		);
	}
	if (code === "grant_stream_not_allowed") {
		return Object.assign(new Error("The requested stream is not available"), {
			code,
		});
	}
	if (
		code === "not_found" ||
		code === "connection_not_found" ||
		code === "connector_instance_not_found"
	) {
		return Object.assign(new Error("Record or source not found"), {
			code: "not_found",
		});
	}
	if (code === "field_not_found" || code === "field_not_granted") {
		return Object.assign(
			new Error("The requested record field is not available"),
			{
				code,
			},
		);
	}
	return Object.assign(new Error("Record detail request failed"), {
		code: "api_error",
	});
}

/** Keep blob selector and visibility codes while dropping private backend details. */
export function safePairwiseBlobError(value: unknown): Error & {
	code: string;
	param?: string;
} {
	const source = value as { code?: unknown; param?: unknown } | null;
	const code = typeof source?.code === "string" ? source.code : "";
	if (code === "invalid_request") {
		const param =
			typeof source?.param === "string" &&
			["instance_id", "connection_id", "connector_id"].includes(source.param)
				? source.param
				: undefined;
		return Object.assign(new Error("The blob request is invalid"), {
			code,
			...(param ? { param } : {}),
		});
	}
	if (code === "grant_invalid") {
		return Object.assign(
			new Error("Authenticated instance bindings are invalid"),
			{
				code,
			},
		);
	}
	if (code === "not_found") {
		return Object.assign(
			new Error("Instance is not available under this authorization"),
			{ code },
		);
	}
	if (code === "blob_not_found") {
		return Object.assign(
			new Error("Blob is not available under this authorization"),
			{
				code,
			},
		);
	}
	return Object.assign(new Error("Blob request failed"), { code: "api_error" });
}

/** Keep field-window status codes while replacing backend text with fixed copy. */
export function safePairwiseFieldWindowError(value: unknown): Error & {
	code: string;
	param?: string;
} {
	const source = value as { code?: unknown; param?: unknown } | null;
	const code = typeof source?.code === "string" ? source.code : "";
	const publicErrors: Record<string, { message: string; param?: boolean }> = {
		field_not_found: { message: "The requested field is not available" },
		field_not_granted: { message: "The requested field is not available" },
		field_not_text: { message: "The requested field is not readable as text" },
		grant_invalid: { message: "Authenticated instance bindings are invalid" },
		grant_stream_not_allowed: { message: "The requested stream is not available" },
		invalid_field_path: { message: "The field-window field path is invalid", param: true },
		invalid_request: { message: "The field-window request is invalid", param: true },
		invalid_stream: { message: "The requested stream is invalid" },
		stream_not_declared: { message: "The requested stream is not declared" },
		invalid_window: { message: "The field-window bounds are invalid", param: true },
		not_found: { message: "The requested record or source is not available" },
		query_not_found: { message: "No matching text was found in the field" },
	};
	const publicParams = new Set([
		"after_chars",
		"before_chars",
		"connection_id",
		"connector_id",
		"connector_instance_id",
		"field",
		"instance_id",
		"limit_chars",
		"offset_chars",
	]);
	const safeError = Object.hasOwn(publicErrors, code) ? publicErrors[code] : undefined;
	if (!safeError) {
		return Object.assign(new Error("Field-window request failed"), {
			code: "api_error",
		});
	}
	const param =
		safeError.param &&
		typeof source?.param === "string" &&
		publicParams.has(source.param)
			? source.param
			: undefined;
	return Object.assign(new Error(safeError.message), {
		code,
		...(param ? { param } : {}),
	});
}

/** Retain the field-window's public clamp warning and drop untrusted warning fields. */
export function safePairwiseFieldWindowWarnings(value: unknown): Record<string, string>[] {
	if (!Array.isArray(value)) return [];
	const warnings: Record<string, string>[] = [];
	for (const warning of value) {
		if (!warning || typeof warning !== "object" || Array.isArray(warning)) continue;
		const candidate = warning as Record<string, unknown>;
		if (
			candidate.code === "limit_clamped" &&
			candidate.param === "limit_chars" &&
			typeof candidate.message === "string" &&
			/^limit_chars clamped to \d+$/.test(candidate.message)
		) {
			warnings.push({
				code: "limit_clamped",
				message: candidate.message,
				param: "limit_chars",
			});
		}
	}
	return warnings;
}

const INTERNAL_SELECTOR_KEYS = [
	"connection_id",
	"connector_instance_id",
] as const;

/** Project record envelopes and expanded children without changing application data. */
export function projectPairwiseDetailRecord(
	value: unknown,
	readMap: PairwiseReadMap,
	inheritedInternalId: string | null = null,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw identityError("grant_invalid", "Stored record envelope is invalid");
	}
	const record = value as Record<string, unknown>;
	const selectors = INTERNAL_SELECTOR_KEYS.map((key) => record[key]).filter(
		(selector) => selector !== undefined && selector !== null,
	);
	if (
		selectors.some(
			(selector) => typeof selector !== "string" || selector !== selectors[0],
		)
	) {
		throw identityError(
			"grant_invalid",
			"Stored record envelope has inconsistent instance identity",
		);
	}
	const internalId =
		(selectors[0] as string | undefined) ?? inheritedInternalId;
	if (
		!internalId ||
		(inheritedInternalId && internalId !== inheritedInternalId)
	) {
		throw identityError(
			"grant_invalid",
			"Stored record envelope is outside its selected instance",
		);
	}
	const handle = readMap.byInternalId.get(internalId);
	if (!handle)
		throw identityError(
			"grant_invalid",
			"Stored record is outside the authenticated instance set",
		);
	const projected: Record<string, unknown> = { ...record, instance_id: handle };
	if (
		record.data &&
		typeof record.data === "object" &&
		!Array.isArray(record.data)
	) {
		const data = record.data as Record<string, unknown>;
		const blobRef = data.blob_ref;
		if (
			blobRef &&
			typeof blobRef === "object" &&
			!Array.isArray(blobRef) &&
			typeof (blobRef as Record<string, unknown>).blob_id === "string"
		) {
			projected.data = {
				...data,
				blob_ref: {
					...(blobRef as Record<string, unknown>),
					fetch_url: `/v1/blobs/${encodeURIComponent(
						(blobRef as Record<string, unknown>).blob_id as string,
					)}?instance_id=${encodeURIComponent(handle)}`,
				},
			};
		}
	}
	for (const key of INTERNAL_SELECTOR_KEYS) delete projected[key];
	if (
		record.expanded &&
		typeof record.expanded === "object" &&
		!Array.isArray(record.expanded)
	) {
		projected.expanded = Object.fromEntries(
			Object.entries(record.expanded as Record<string, unknown>).map(
				([name, expanded]) => {
					if (expanded === null) return [name, null];
					if (
						expanded &&
						typeof expanded === "object" &&
						Array.isArray((expanded as Record<string, unknown>).data)
					) {
						const list = expanded as Record<string, unknown>;
						return [
							name,
							{
								...list,
								data: (list.data as unknown[]).map((child) =>
									projectPairwiseDetailRecord(child, readMap, internalId),
								),
							},
						];
					}
					return [
						name,
						projectPairwiseDetailRecord(expanded, readMap, internalId),
					];
				},
			),
		);
	}
	return projected;
}

export function clientGrantForPairwiseDetail(
	grant: Record<string, unknown>,
	streamName: string,
	internalId: string,
): Record<string, unknown> {
	const streams = grant.streams;
	if (!Array.isArray(streams))
		throw identityError(
			"grant_invalid",
			"Authenticated grant streams are invalid",
		);
	return {
		...grant,
		streams: streams.map((stream) => {
			if (
				!stream ||
				typeof stream !== "object" ||
				(stream as Record<string, unknown>).name !== streamName
			)
				return stream;
			return {
				...(stream as Record<string, unknown>),
				instance_ids: [internalId],
			};
		}),
	};
}
