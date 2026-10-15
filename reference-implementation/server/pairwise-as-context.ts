// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execDynamicSqlAcknowledged } from "../lib/db.ts";
import { getDb } from "./db.ts";
import {
	completePairwiseIdentityLegacyBackfill,
	initializePairwiseIdentityRootKey,
	lookupPairwiseInstanceMapping,
	type PairwiseGrant,
	type PairwiseGrantIdentityContext,
	PairwiseIdentityContextError,
	type PairwiseInstanceHandleLookupResult,
	recordTrustedClientSectorMembership,
	type ValidatedPairwiseInstanceBindings,
	validatePairwiseInstanceBindings,
} from "./pairwise-identity.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";

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
	/** Add a validated OAuth client to the immutable issuer-sector registry. */
	registerOAuthClient?(clientId: string): Promise<void>;
	/** Read-only lookup over retained instance and declaration facts. */
	resolveCanonicalSourceForInstance(
		internalInstanceId: string,
		internalSubjectId: string,
		declarationVersion?: string,
	):
		| PairwiseAsSourceAuthority
		| null
		| Promise<PairwiseAsSourceAuthority | null>;
}

export async function initializePairwiseAsContextAfterListen(
	context: { initializeFromStorage(issuer: string): Promise<void> },
	issuer: string,
	closeListener: () => Promise<void>,
): Promise<void> {
	try {
		await context.initializeFromStorage(issuer);
	} catch (error) {
		await closeListener().catch(() => undefined);
		throw error;
	}
}

export class PairwiseAsIdentityContextSlot
	implements PairwiseAsIdentityContext
{
	private current: PairwiseAsIdentityContext | null = null;
	private readonly sectors = new Map<string, string>();

	get issuer(): string {
		return this.requireCurrent().issuer;
	}

	resolveClientSector(clientId: string): string {
		this.requireCurrent();
		const sector = this.sectors.get(clientId);
		if (!sector) {
			throw new PairwiseIdentityContextError(
				"Client has no immutable trusted identity-sector membership",
			);
		}
		return sector;
	}

	resolveCanonicalSourceForInstance(
		internalInstanceId: string,
		internalSubjectId: string,
		declarationVersion?: string,
	): ReturnType<
		PairwiseAsIdentityContext["resolveCanonicalSourceForInstance"]
	> {
		return this.requireCurrent().resolveCanonicalSourceForInstance(
			internalInstanceId,
			internalSubjectId,
			declarationVersion,
		);
	}

	async initializeFromStorage(issuer: string): Promise<void> {
		const clientIds = new Set<string>(["@owner"]);
		if (isPostgresStorageBackend()) {
			const clients = await postgresQuery<{ client_id: string }>(
				"SELECT client_id FROM oauth_clients UNION SELECT client_id FROM pairwise_identity_handles WHERE issuer=$1",
				[issuer],
			);
			for (const row of clients.rows) clientIds.add(row.client_id);
		} else {
			const clients = getDb()
				.prepare(
					"SELECT client_id FROM oauth_clients UNION SELECT client_id FROM pairwise_identity_handles WHERE issuer=?",
				)
				.all<{ client_id: string }>(issuer);
			for (const row of clients) clientIds.add(row.client_id);
		}
		const existing = new Map<string, string>();
		if (isPostgresStorageBackend()) {
			const memberships = await postgresQuery<{
				client_id: string;
				client_sector: string;
			}>(
				"SELECT client_id,client_sector FROM pairwise_trusted_client_sectors WHERE issuer=$1",
				[issuer],
			);
			for (const row of memberships.rows)
				existing.set(row.client_id, row.client_sector);
		} else {
			const memberships = getDb()
				.prepare(
					"SELECT client_id,client_sector FROM pairwise_trusted_client_sectors WHERE issuer=?",
				)
				.all<{ client_id: string; client_sector: string }>(issuer);
			for (const row of memberships)
				existing.set(row.client_id, row.client_sector);
		}
		const clients = [...clientIds].map((clientId) => {
			const trustedExistingSector = existing.get(clientId);
			return {
				clientId,
				...(trustedExistingSector
					? { trustedExistingSector }
					: clientId === "@owner"
						? { trustedExistingSector: "owner-account:v1" }
						: {}),
			};
		});
		this.current = await bootstrapPairwiseAsIdentityContext({
			issuer,
			clients,
		});
		this.sectors.clear();
		for (const client of clients) {
			this.sectors.set(
				client.clientId,
				client.trustedExistingSector ?? `oauth-client:${client.clientId}`,
			);
		}
	}

	async registerOAuthClient(clientId: string): Promise<void> {
		const current = this.requireCurrent();
		requireString(clientId, "client ID");
		const sector = `oauth-client:${clientId}`;
		await recordTrustedClientSectorMembership({
			clientId,
			clientSector: sector,
			issuer: current.issuer,
		});
		this.sectors.set(clientId, sector);
	}

	private requireCurrent(): PairwiseAsIdentityContext {
		if (!this.current) {
			throw new PairwiseIdentityContextError(
				"AS pairwise identity bootstrap is not complete",
			);
		}
		return this.current;
	}
}

export interface PairwiseAsClientSectorInput {
	clientId: string;
	/** Host of an OIDC sector_identifier_uri verified at registration. */
	verifiedOidcSectorHost?: string;
	/** Previously persisted immutable membership loaded during AS startup. */
	trustedExistingSector?: string;
}

/**
 * Verify an OIDC sector document at registration. The caller must pass this
 * result to bootstrap; the sector host alone is never treated as proof.
 */
export async function verifyOidcSectorIdentifier(input: {
	redirectUris: readonly string[];
	sectorIdentifierUri: string;
	fetchDocument: (uri: string) => Promise<unknown>;
}): Promise<string> {
	let sectorUrl: URL;
	try {
		sectorUrl = new URL(input.sectorIdentifierUri);
	} catch {
		throw new PairwiseIdentityContextError(
			"Invalid OIDC sector identifier URI",
		);
	}
	if (
		sectorUrl.protocol !== "https:" ||
		sectorUrl.username ||
		sectorUrl.password
	) {
		throw new PairwiseIdentityContextError(
			"OIDC sector identifier URI must use HTTPS",
		);
	}
	const document = await input.fetchDocument(sectorUrl.href);
	if (
		!Array.isArray(document) ||
		document.some((entry) => typeof entry !== "string") ||
		input.redirectUris.some((uri) => !document.includes(uri))
	) {
		throw new PairwiseIdentityContextError(
			"OIDC sector document must list every registered redirect URI",
		);
	}
	return sectorUrl.hostname.toLowerCase();
}

/** Initialize immutable identity membership and key state before AS issuance. */
export async function bootstrapPairwiseAsIdentityContext(input: {
	clients: readonly PairwiseAsClientSectorInput[];
	issuer: string;
}): Promise<PairwiseAsIdentityContext> {
	await initializePairwiseIdentityRootKey(input.issuer);
	const sectors = new Map<string, string>();
	for (const client of input.clients) {
		requireString(client.clientId, "client ID");
		const sector =
			client.trustedExistingSector ??
			(client.verifiedOidcSectorHost
				? `oidc-sector:${client.verifiedOidcSectorHost.toLowerCase()}`
				: `oauth-client:${client.clientId}`);
		await recordTrustedClientSectorMembership({
			clientId: client.clientId,
			clientSector: sector,
			issuer: input.issuer,
		});
		sectors.set(client.clientId, sector);
	}
	await completePairwiseIdentityLegacyBackfill(input.issuer);
	return {
		issuer: input.issuer,
		resolveClientSector(clientId) {
			const sector = sectors.get(clientId);
			if (!sector) {
				throw new PairwiseIdentityContextError(
					"Client has no immutable trusted identity-sector membership",
				);
			}
			return sector;
		},
		resolveCanonicalSourceForInstance: (
			internalInstanceId,
			internalSubjectId,
			declarationVersion,
		) =>
			readPairwiseAsInstanceAuthority(
				internalInstanceId,
				internalSubjectId,
				declarationVersion,
			),
	};
}

export async function recordPairwiseAsInstanceAuthority(input: {
	acceptedLegacySourceAliases?: readonly string[];
	canonicalSourceId: string;
	declarationVersion: string;
	internalInstanceId: string;
	subjectId: string;
}): Promise<void> {
	requireString(input.canonicalSourceId, "canonical source ID");
	requireString(input.declarationVersion, "source declaration version");
	requireString(input.internalInstanceId, "internal instance ID");
	requireString(input.subjectId, "internal subject ID");
	const aliases = input.acceptedLegacySourceAliases ?? [];
	if (
		!Array.isArray(aliases) ||
		aliases.some((alias) => typeof alias !== "string" || !alias)
	) {
		throw new PairwiseIdentityContextError(
			"Invalid accepted source alias authority",
		);
	}
	const aliasesJson = JSON.stringify([...new Set(aliases)].sort());
	const retained = await readPairwiseAsInstanceAuthority(
		input.internalInstanceId,
		input.subjectId,
	);
	if (retained && retained.canonicalSourceId !== input.canonicalSourceId) {
		throw new PairwiseIdentityContextError(
			"Retained instance source authority conflicts with accepted declaration",
		);
	}
	if (isPostgresStorageBackend()) {
		await postgresQuery(
			`INSERT INTO pairwise_as_instance_authority(
			   subject_id, internal_instance_id, canonical_source_id, declaration_version,
			   accepted_legacy_source_aliases_json
			 ) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(subject_id,internal_instance_id) DO NOTHING`,
			[
				input.subjectId,
				input.internalInstanceId,
				input.canonicalSourceId,
				input.declarationVersion,
				aliasesJson,
			],
		);
	} else {
		execDynamicSqlAcknowledged(
			`INSERT INTO pairwise_as_instance_authority(
			   subject_id, internal_instance_id, canonical_source_id, declaration_version,
			   accepted_legacy_source_aliases_json
			 ) VALUES(?,?,?,?,?) ON CONFLICT(subject_id,internal_instance_id) DO NOTHING`,
			[
				input.subjectId,
				input.internalInstanceId,
				input.canonicalSourceId,
				input.declarationVersion,
				aliasesJson,
			],
		);
	}
	const retainedAfterInsert = await readPairwiseAsInstanceAuthority(
		input.internalInstanceId,
		input.subjectId,
	);
	if (
		!retainedAfterInsert ||
		retainedAfterInsert.canonicalSourceId !== input.canonicalSourceId
	) {
		throw new PairwiseIdentityContextError(
			"Retained instance source authority conflicts with accepted declaration",
		);
	}
	if (
		retainedAfterInsert.declarationVersion === input.declarationVersion &&
		JSON.stringify(
			[...retainedAfterInsert.acceptedLegacySourceAliases].sort(),
		) !== aliasesJson
	) {
		throw new PairwiseIdentityContextError(
			"Retained instance source authority conflicts with accepted declaration",
		);
	}
	if (isPostgresStorageBackend()) {
		await postgresQuery(
			`INSERT INTO pairwise_as_instance_authority_versions(
			   subject_id, internal_instance_id, canonical_source_id, declaration_version,
			   accepted_legacy_source_aliases_json
			 ) VALUES($1,$2,$3,$4,$5::jsonb)
			 ON CONFLICT(subject_id,internal_instance_id,declaration_version) DO NOTHING`,
			[
				input.subjectId,
				input.internalInstanceId,
				input.canonicalSourceId,
				input.declarationVersion,
				aliasesJson,
			],
		);
	} else {
		execDynamicSqlAcknowledged(
			`INSERT INTO pairwise_as_instance_authority_versions(
			   subject_id, internal_instance_id, canonical_source_id, declaration_version,
			   accepted_legacy_source_aliases_json
			 ) VALUES(?,?,?,?,?)
			 ON CONFLICT(subject_id,internal_instance_id,declaration_version) DO NOTHING`,
			[
				input.subjectId,
				input.internalInstanceId,
				input.canonicalSourceId,
				input.declarationVersion,
				aliasesJson,
			],
		);
	}
	const authority = await readPairwiseAsInstanceAuthority(
		input.internalInstanceId,
		input.subjectId,
		input.declarationVersion,
	);
	if (
		!authority ||
		authority.canonicalSourceId !== input.canonicalSourceId ||
		JSON.stringify([...authority.acceptedLegacySourceAliases].sort()) !==
			aliasesJson
	) {
		throw new PairwiseIdentityContextError(
			"Retained instance source authority conflicts with accepted declaration",
		);
	}
}

export async function readPairwiseAsInstanceAuthority(
	internalInstanceId: string,
	subjectId: string,
	declarationVersion?: string,
): Promise<PairwiseAsSourceAuthority | null> {
	type AuthorityRow = {
		accepted_legacy_source_aliases_json: string[] | string;
		canonical_source_id: string;
		declaration_version: string;
	};
	const readRow = async (
		table:
			| "pairwise_as_instance_authority"
			| "pairwise_as_instance_authority_versions",
	) => {
		if (isPostgresStorageBackend()) {
			const versionClause = table.endsWith("_versions")
				? " AND declaration_version=$3"
				: "";
			const params = table.endsWith("_versions")
				? [subjectId, internalInstanceId, declarationVersion]
				: [subjectId, internalInstanceId];
			return (
				await postgresQuery<AuthorityRow>(
					`SELECT canonical_source_id, declaration_version,
				        accepted_legacy_source_aliases_json::text AS accepted_legacy_source_aliases_json
				   FROM ${table}
				  WHERE subject_id=$1 AND internal_instance_id=$2${versionClause}`,
					params,
				)
			).rows[0];
		}
		const versionClause = table.endsWith("_versions")
			? " AND declaration_version=?"
			: "";
		const params = table.endsWith("_versions")
			? [subjectId, internalInstanceId, declarationVersion]
			: [subjectId, internalInstanceId];
		return getDb()
			.prepare(
				`SELECT canonical_source_id, declaration_version, accepted_legacy_source_aliases_json
				   FROM ${table}
				  WHERE subject_id=? AND internal_instance_id=?${versionClause}`,
			)
			.get<AuthorityRow>(...params);
	};
	let row = declarationVersion
		? await readRow("pairwise_as_instance_authority_versions")
		: undefined;
	if (!row) {
		row = await readRow("pairwise_as_instance_authority");
		if (declarationVersion && row?.declaration_version !== declarationVersion)
			return null;
	}
	if (!row) return null;
	let aliases: unknown;
	try {
		aliases =
			typeof row.accepted_legacy_source_aliases_json === "string"
				? JSON.parse(row.accepted_legacy_source_aliases_json)
				: row.accepted_legacy_source_aliases_json;
	} catch {
		throw new PairwiseIdentityContextError(
			"Retained source alias authority is malformed",
		);
	}
	if (
		!Array.isArray(aliases) ||
		aliases.some((alias) => typeof alias !== "string" || !alias)
	) {
		throw new PairwiseIdentityContextError(
			"Retained source alias authority is malformed",
		);
	}
	return {
		acceptedLegacySourceAliases: aliases,
		canonicalSourceId: row.canonical_source_id,
		declarationVersion: row.declaration_version,
	};
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
		const declarationVersion = (
			grant as typeof grant & {
				source_declaration?: { version?: unknown };
			}
		).source_declaration?.version;
		requireString(declarationVersion, "source declaration version");
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
				input.internalSubjectId,
				grant.source.id,
				declarationVersion,
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
	internalSubjectId: string,
	grantSourceId: string,
	grantDeclarationVersion: string,
): Promise<void> {
	const authority = await context.resolveCanonicalSourceForInstance(
		mapping.internalId,
		internalSubjectId,
		grantDeclarationVersion,
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
	if (authority.declarationVersion !== grantDeclarationVersion) {
		throw new PairwiseIdentityContextError(
			"Persisted instance declaration version does not match the projected grant",
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
