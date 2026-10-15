// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	lookupPairwiseInstanceMapping,
	type PairwiseGrant,
	type PairwiseGrantIdentityContext,
	PairwiseIdentityContextError,
	type PairwiseInstanceHandleLookupResult,
	type ValidatedPairwiseInstanceBindings,
	validatePairwiseInstanceBindings,
} from "./pairwise-identity.ts";

export interface PairwiseAsResolvedInstance {
	source_id: string;
	stream: string;
	rs_instance: string;
}

export interface PairwiseAsSourceAuthority {
	canonicalSourceId: string;
	declarationVersion: string;
	acceptedLegacySourceAliases: readonly string[];
}

export interface PairwiseAsIdentityContext
	extends PairwiseGrantIdentityContext {
	/** Read-only lookup over retained instance and declaration facts. */
	resolveCanonicalSourceForInstance(
		internalInstanceId: string,
	):
		| PairwiseAsSourceAuthority
		| null
		| Promise<PairwiseAsSourceAuthority | null>;
}

export interface PairwiseAsGrantProjection {
	grant: PairwiseGrant & { grant_id: string };
	resolvedInstances: readonly PairwiseAsResolvedInstance[];
}

export type PairwiseInstanceBindingTarget =
	| {
			kind: "core";
			grant: PairwiseGrant & { grant_id: string };
			resolvedInstances: readonly PairwiseAsResolvedInstance[];
	  }
	| {
			kind: "package";
			children: readonly PairwiseAsGrantProjection[];
	  };

export interface BuildPairwiseInstanceBindingsInput {
	context: PairwiseAsIdentityContext;
	internalSubjectId: string;
	clientId: string;
	target: PairwiseInstanceBindingTarget;
}

/**
 * Produces RS-only bindings for the exact stream/handle pairs already approved
 * in the target grants. Callers supply verified historical mappings, including
 * retired instances. A lost persisted mapping is omitted so the RS fails closed;
 * this function does not discover, filter, or reconstruct mappings.
 */
export async function buildPairwiseInstanceBindings(
	input: BuildPairwiseInstanceBindingsInput,
): Promise<ValidatedPairwiseInstanceBindings> {
	if (!input || typeof input !== "object") {
		throw new PairwiseIdentityContextError("Invalid binding producer input");
	}
	requireString(input.internalSubjectId, "internal subject ID");
	requireString(input.clientId, "client ID");
	if (
		!input.context ||
		typeof input.context.resolveClientSector !== "function" ||
		typeof input.context.resolveCanonicalSourceForInstance !== "function"
	) {
		throw new PairwiseIdentityContextError("Invalid trusted identity context");
	}
	const clientSector = input.context.resolveClientSector(input.clientId);
	requireString(clientSector, "trusted client sector");
	const grants = projectedGrants(input.target);

	const bindings = [];
	const mappingByHandle = new Map<
		string,
		PairwiseInstanceHandleLookupResult | null
	>();
	const lookupHandle = async (
		instanceHandle: string,
	): Promise<PairwiseInstanceHandleLookupResult | null> => {
		if (mappingByHandle.has(instanceHandle)) {
			return mappingByHandle.get(instanceHandle) ?? null;
		}
		const mapping = await lookupPairwiseInstanceMapping({
			clientId: input.clientId,
			clientSector,
			instanceHandle,
			issuer: input.context.issuer,
			subjectId: input.internalSubjectId,
		});
		mappingByHandle.set(instanceHandle, mapping);
		return mapping;
	};

	for (const projection of grants) {
		const grant = projection.grant;
		if (grant.client?.client_id !== input.clientId) {
			throw new PairwiseIdentityContextError("Projected grant client mismatch");
		}
		requireString(grant.source?.id, "canonical source ID");
		if (!Array.isArray(grant.streams) || grant.streams.length === 0) {
			throw new PairwiseIdentityContextError("Projected grant has no streams");
		}
		const grantId = grant.grant_id;
		requireString(grantId, "grant ID");
		const tuples = projection.resolvedInstances;
		if (!Array.isArray(tuples) || tuples.length === 0) {
			throw new PairwiseIdentityContextError(
				"Missing resolved instance tuples",
			);
		}

		const expected = new Map<string, string[]>();
		const seenStreams = new Set<string>();
		for (const stream of grant.streams) {
			requireString(stream?.name, "stream");
			if (seenStreams.has(stream.name)) {
				throw new PairwiseIdentityContextError(
					"Duplicate projected grant stream",
				);
			}
			seenStreams.add(stream.name);
			if (
				!Array.isArray(stream.instance_ids) ||
				stream.instance_ids.length === 0
			) {
				throw new PairwiseIdentityContextError(
					"Projected grant stream has no resolved instance handles",
				);
			}
			const streamHandles: string[] = [];
			for (const instanceId of stream.instance_ids) {
				requireString(instanceId, "instance handle");
				if (streamHandles.includes(instanceId)) {
					throw new PairwiseIdentityContextError(
						"Duplicate projected grant instance",
					);
				}
				streamHandles.push(instanceId);
			}
			expected.set(stream.name, streamHandles);
		}

		const resolvedPairs = new Set<string>();
		for (const tuple of tuples) {
			if (!tuple || tuple.source_id !== grant.source.id) {
				throw new PairwiseIdentityContextError(
					"Resolved source must match the canonical projected grant source",
				);
			}
			requireString(tuple.stream, "stream");
			requireString(tuple.rs_instance, "resolved RS instance");
			const streamHandles = expected.get(tuple.stream);
			if (!streamHandles) {
				throw new PairwiseIdentityContextError(
					"Resolved tuple stream is not authorized by the projected grant",
				);
			}
			const mappedHandles: string[] = [];
			let hasPersistedMapping = false;
			let hasMissingMapping = false;
			for (const instanceId of streamHandles) {
				const mapping = await lookupHandle(instanceId);
				if (mapping !== null) hasPersistedMapping = true;
				else hasMissingMapping = true;
				if (mapping?.internalId === tuple.rs_instance) {
					mappedHandles.push(instanceId);
				}
			}
			if (mappedHandles.length > 1) {
				throw new PairwiseIdentityContextError(
					"Resolved tuple matches multiple projected grant handles",
				);
			}
			if (mappedHandles.length === 0) {
				if (hasPersistedMapping && !hasMissingMapping) {
					throw new PairwiseIdentityContextError(
						"Resolved tuple conflicts with a persisted grant mapping",
					);
				}
				continue;
			}
			const instanceId = mappedHandles[0] as string;
			const mapping = mappingByHandle.get(instanceId);
			if (!mapping) {
				throw new PairwiseIdentityContextError(
					"Resolved tuple has no persisted instance mapping",
				);
			}
			await assertTrustedSourceAuthority(
				input.context,
				mapping,
				grant.source.id,
			);
			const key = pairKey(tuple.stream, tuple.rs_instance);
			if (resolvedPairs.has(key)) {
				throw new PairwiseIdentityContextError(
					"Duplicate resolved instance tuple",
				);
			}
			resolvedPairs.add(key);
			bindings.push({
				...(input.target.kind === "package" ? { grant_id: grantId } : {}),
				instance_id: instanceId,
				rs_instance: tuple.rs_instance,
				source_id: tuple.source_id,
				stream: tuple.stream,
			});
		}
		for (const [stream, streamHandles] of expected) {
			for (const instanceId of streamHandles) {
				const mapping = await lookupHandle(instanceId);
				if (
					mapping !== null &&
					!resolvedPairs.has(pairKey(stream, mapping.internalId))
				) {
					throw new PairwiseIdentityContextError(
						"Projected grant instance has no resolved RS mapping",
					);
				}
			}
		}
	}
	return validatePairwiseInstanceBindings(bindings);
}

async function assertTrustedSourceAuthority(
	context: PairwiseAsIdentityContext,
	mapping: PairwiseInstanceHandleLookupResult,
	grantSourceId: string,
): Promise<void> {
	const authority = await context.resolveCanonicalSourceForInstance(
		mapping.internalId,
	);
	if (!authority || typeof authority !== "object") {
		throw new PairwiseIdentityContextError(
			"Trusted source authority is missing for projected instance",
		);
	}
	requireString(authority.canonicalSourceId, "trusted canonical source ID");
	requireString(authority.declarationVersion, "source declaration version");
	if (!Array.isArray(authority.acceptedLegacySourceAliases)) {
		throw new PairwiseIdentityContextError(
			"Invalid accepted source alias authority",
		);
	}
	for (const alias of authority.acceptedLegacySourceAliases) {
		requireString(alias, "accepted legacy source alias");
	}
	if (
		mapping.retainedSourceId !== "" &&
		mapping.retainedSourceId !== authority.canonicalSourceId &&
		!authority.acceptedLegacySourceAliases.includes(mapping.retainedSourceId)
	) {
		throw new PairwiseIdentityContextError(
			"Retained source alias is not accepted by the source declaration",
		);
	}
	if (authority.canonicalSourceId !== grantSourceId) {
		throw new PairwiseIdentityContextError(
			"Persisted instance source does not match the projected grant source",
		);
	}
}

function projectedGrants(
	target: PairwiseInstanceBindingTarget,
): readonly PairwiseAsGrantProjection[] {
	if (!target || typeof target !== "object") {
		throw new PairwiseIdentityContextError("Invalid binding target");
	}
	if (target.kind === "core") {
		if ("children" in target || "grants" in target || !target.grant) {
			throw new PairwiseIdentityContextError("Invalid Core binding target");
		}
		return [
			{
				grant: target.grant,
				resolvedInstances: target.resolvedInstances,
			},
		];
	}
	if (target.kind === "package") {
		if (
			"grant" in target ||
			"resolvedInstances" in target ||
			"grants" in target ||
			!Array.isArray(target.children) ||
			target.children.length === 0
		) {
			throw new PairwiseIdentityContextError("Invalid package binding target");
		}
		const grantIds = new Set<string>();
		for (const child of target.children) {
			if (!child || typeof child !== "object" || !child.grant) {
				throw new PairwiseIdentityContextError("Invalid package child grant");
			}
			requireString(child.grant.grant_id, "grant ID");
			if (grantIds.has(child.grant.grant_id)) {
				throw new PairwiseIdentityContextError(
					"Duplicate package child grant ID",
				);
			}
			grantIds.add(child.grant.grant_id);
		}
		return target.children;
	}
	throw new PairwiseIdentityContextError("Unknown binding target kind");
}

function requireString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PairwiseIdentityContextError(`Invalid ${name}`);
	}
}

function pairKey(stream: string, internalId: string): string {
	return JSON.stringify([stream, internalId]);
}
