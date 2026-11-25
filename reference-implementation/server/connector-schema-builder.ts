// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector schema and discovery projection.
 *
 * Scope: owns connector schema items, connector discovery items, stream
 * metadata entries, and connector-aware freshness. It does not own route
 * mounting, token interpretation, record querying, or connector-run evidence
 * lookup internals.
 *
 * Invariant: no import from index.js; imports run evidence from
 * connector-run-evidence.js, yielding an acyclic B -> A edge.
 */

import { listGrantedConnectionsForStream } from "./connection-identity.ts";
import {
  getLatestConnectorRunSummary,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from "./connector-run-evidence.ts";
import { deriveReferenceFreshness } from "./freshness.ts";
import { listStreamsByResolvedBindings, resolveReadRequestBindings } from "./records.ts";
import {
  buildExpandCapabilities,
  buildFieldCapabilities,
  buildStreamDiscoveryCapabilities,
} from "./schema-capabilities.ts";

export interface StorageBinding {
  connector_id?: string | null;
  connector_instance_id?: string | null;
  [key: string]: unknown;
}

export type ConnectorFreshnessEvidence = Awaited<ReturnType<typeof getConnectorFreshnessEvidence>>;

type CapabilityManifestStream = Parameters<typeof buildFieldCapabilities>[0];
type CapabilityStreamGrant = Parameters<typeof buildFieldCapabilities>[1];
// Manifest streams reach these builders as validated but untyped JSON.
function asCapabilityStream(stream: Record<string, unknown>): CapabilityManifestStream {
  return stream as unknown as CapabilityManifestStream;
}

function normalizePrimaryKey(primaryKey: unknown): string[] {
  if (Array.isArray(primaryKey)) {
    return primaryKey as string[];
  }
  if (typeof primaryKey === "string" && primaryKey.trim()) {
    return [primaryKey];
  }
  return [];
}

function buildFreshness(lastUpdated: string | null = null) {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

export async function getConnectorFreshnessEvidence({
  storageBinding,
  manifest,
}: {
  storageBinding: StorageBinding;
  manifest: Record<string, unknown> | null | undefined;
}) {
  const connectorId = storageBinding.connector_id ?? null;
  const refreshPolicy = getManifestRefreshPolicy(manifest);
  const [lastRun, lastSuccessfulRun] = await Promise.all([
    getLatestConnectorRunSummary(connectorId),
    getLatestConnectorRunSummary(connectorId, "succeeded"),
  ]);
  return {
    lastRun,
    lastSuccessfulRun,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
  };
}

export function buildConnectorAwareFreshness(
  evidence:
    | {
        lastRun?: { last_at?: string | null; status?: string | null } | null;
        lastSuccessfulRun?: { last_at?: string | null } | null;
        maximumStalenessSeconds?: number | null;
      }
    | null
    | undefined,
  recordLastUpdatedAt: string | null = null
) {
  return deriveReferenceFreshness({
    lastAttemptedAt: evidence?.lastRun?.last_at ?? null,
    lastAttemptStatus: evidence?.lastRun?.status ?? null,
    lastSuccessfulRunAt: evidence?.lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds: evidence?.maximumStalenessSeconds ?? null,
    recordLastUpdatedAt,
  });
}

export function buildStreamMetadataEntry({
  manifestStream,
  streamGrant = null,
  grantStreams = [] as Record<string, unknown>[],
  freshness = null as ReturnType<typeof buildFreshness> | null,
  grantedConnections = null as unknown[] | null,
  manifestStreamNames = null as Set<string> | null,
}: {
  manifestStream: Record<string, unknown>;
  streamGrant?: Record<string, unknown> | null;
  grantStreams?: Record<string, unknown>[];
  freshness?: ReturnType<typeof buildFreshness> | null;
  grantedConnections?: unknown[] | null;
  manifestStreamNames?: Set<string> | null;
}) {
  const projectedManifestStream = streamGrant ? projectManifestStreamForGrant(streamGrant) : manifestStream;
  const expandStreamGrant = streamGrant ? { ...streamGrant, grantStreams } : null;
  const entry: Record<string, unknown> = {
    consent_time_field: projectedManifestStream.consent_time_field,
    cursor_field: projectedManifestStream.cursor_field,
    expand_capabilities: buildExpandCapabilities(
      asCapabilityStream(projectedManifestStream),
      expandStreamGrant as CapabilityStreamGrant,
      manifestStreamNames
    ),
    field_capabilities: buildFieldCapabilities(
      asCapabilityStream(projectedManifestStream),
      streamGrant as CapabilityStreamGrant
    ),
    freshness: freshness ?? buildFreshness(null),
    name: projectedManifestStream.name,
    object: "stream_metadata",
    primary_key: normalizePrimaryKey(projectedManifestStream.primary_key),
    query: projectedManifestStream.query || {},
    relationships: projectedManifestStream.relationships || [],
    schema: projectedManifestStream.schema,
    selection: projectedManifestStream.selection,
    semantics: projectedManifestStream.semantics,
    views: projectedManifestStream.views || [],
  };
  if (streamGrant) {
    entry.instance_ids = Array.isArray(streamGrant.instance_ids) ? [...streamGrant.instance_ids] : [];
    if (Array.isArray(streamGrant.resources)) {
      entry.resources = [...streamGrant.resources];
    }
    if (streamGrant.time_constraint && typeof streamGrant.time_constraint === "object") {
      entry.time_constraint = structuredClone(streamGrant.time_constraint);
    }
  }
  if (Array.isArray(grantedConnections)) {
    entry.granted_connections = grantedConnections;
  }
  return entry;
}

function projectManifestStreamForGrant(streamGrant: Record<string, unknown>): Record<string, unknown> {
  // Resolved grants retain authorization facts, not live schema definitions.
  // Do not copy property schemas, requiredness, $defs, query affordances, or
  // relationships from the current declaration into a client projection.
  // A future grant shape can retain a typed schema snapshot explicitly; until
  // then, empty field schemas are the only honest projection.
  const fields = Array.isArray(streamGrant.fields)
    ? (streamGrant.fields as unknown[]).filter((field): field is string => typeof field === "string")
    : [];
  const grantedFields = new Set(fields);
  const schema: Record<string, unknown> = {
    additionalProperties: false,
    properties: Object.fromEntries([...grantedFields].map((field) => [field, {}])),
    type: "object",
  };
  const timeConstraint =
    streamGrant.time_constraint && typeof streamGrant.time_constraint === "object"
      ? (streamGrant.time_constraint as Record<string, unknown>)
      : null;
  const frozenTimeField = typeof timeConstraint?.field === "string" ? timeConstraint.field : undefined;
  return {
    name: streamGrant.name,
    schema,
    ...(frozenTimeField ? { consent_time_field: frozenTimeField } : {}),
  };
}

function buildStreamDiscoverySummary({
  connectorId = null as string | null,
  stream,
  summary = null as Record<string, unknown> | null,
  freshnessEvidence = null as Parameters<typeof buildConnectorAwareFreshness>[0],
}: {
  connectorId?: string | null;
  stream: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  freshnessEvidence?: Parameters<typeof buildConnectorAwareFreshness>[0];
}) {
  const lastUpdated = (summary?.last_updated as string | null | undefined) || null;
  return {
    capabilities: buildStreamDiscoveryCapabilities({ connectorId, stream: asCapabilityStream(stream) }),
    freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
    last_updated: lastUpdated,
    name: stream.name,
    object: "stream",
    record_count: summary?.record_count || 0,
  };
}

function mergeStreamSummary(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  const currentUpdated = typeof current?.last_updated === "string" ? current.last_updated : null;
  const nextUpdated = typeof next.last_updated === "string" ? next.last_updated : null;
  return {
    last_updated: !currentUpdated || (nextUpdated && nextUpdated > currentUpdated) ? nextUpdated : currentUpdated,
    name: next.name,
    object: "stream",
    record_count: Number(current?.record_count || 0) + Number(next.record_count || 0),
  };
}

export async function listSubjectVisibleStreamSummaries({
  storageBinding,
  manifest,
  grant,
  ownerSubjectId,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant: Record<string, unknown> | null;
  ownerSubjectId: string | null;
}): Promise<Record<string, unknown>[]> {
  const manifestStreams = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const effectiveGrant = grant ?? {
    streams: manifestStreams.flatMap((stream) =>
      typeof stream.name === "string" && stream.name ? [{ name: stream.name }] : []
    ),
  };
  const grantStreams = Array.isArray(effectiveGrant.streams)
    ? (effectiveGrant.streams as Record<string, unknown>[])
    : [];
  const typedGrant = {
    ...effectiveGrant,
    streams: grantStreams.filter((streamGrant) => typeof streamGrant.name === "string" && streamGrant.name),
  } as unknown as Parameters<typeof listStreamsByResolvedBindings>[0];
  const rows = await listStreamsByResolvedBindings(
    typedGrant,
    manifest as Parameters<typeof listStreamsByResolvedBindings>[1],
    async (streamGrant) => {
      try {
        const resolved = await resolveReadRequestBindings({
          grant: typedGrant,
          ownerRead: grant === null,
          ...(ownerSubjectId ? { ownerSubjectId } : {}),
          requestParams: {},
          storageBinding: storageBinding as unknown as NonNullable<
            Parameters<typeof resolveReadRequestBindings>[0]["storageBinding"]
          >,
          streamName: streamGrant.name,
        });
        return resolved.bindings;
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === "connection_not_found") {
          return [];
        }
        throw error;
      }
    }
  );
  const summaries = new Map<string, Record<string, unknown>>();
  for (const summary of rows) {
    summaries.set(summary.name, mergeStreamSummary(summaries.get(summary.name), { ...summary }));
  }
  return [...summaries.values()];
}

export async function buildConnectorSchemaItem({
  source,
  storageBinding,
  manifest,
  grant = null as Record<string, unknown> | null,
  ownerSubjectId = null as string | null,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant?: Record<string, unknown> | null;
  ownerSubjectId?: string | null;
}) {
  const connectorId = (storageBinding.connector_id as string | null | undefined) ?? null;
  const rawStreamSummaries = await listSubjectVisibleStreamSummaries({
    grant,
    manifest,
    ownerSubjectId,
    source,
    storageBinding,
  });
  const streamSummaries = rawStreamSummaries as Record<string, unknown>[];
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name as string, summary]));
  const grantStreamsArr = Array.isArray(grant?.streams) ? (grant?.streams as Record<string, unknown>[]) : [];
  const grantStreamByName = grant
    ? new Map(grantStreamsArr.map((streamGrant) => [streamGrant.name as string, streamGrant]))
    : null;
  const manifestStreamsArr = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const visibleStreams: Record<string, unknown>[] = grant
    ? (grantStreamsArr
        .map((streamGrant) => manifestStreamsArr.find((stream) => stream.name === streamGrant.name))
        .filter(Boolean) as Record<string, unknown>[])
    : manifestStreamsArr;
  const grantStreams = grantStreamsArr;
  // Streams the loaded manifest declares — lets the expand-capabilities builder
  // distinguish "target stream not granted" from "target stream unknown".
  const manifestStreamNames = new Set(manifestStreamsArr.map((stream) => stream.name as string));
  const freshnessEvidence = await getConnectorFreshnessEvidence({
    manifest,
    storageBinding,
  });

  const streams = await Promise.all(
    visibleStreams.map(async (manifestStream) => {
      const streamName = manifestStream.name as string;
      const summary = summaryByName.get(streamName);
      const lastUpdated = (summary?.last_updated as string | null | undefined) || null;
      const streamGrant = grantStreamByName ? grantStreamByName.get(streamName) || null : null;
      let grantedConnections: unknown[] | null = null;
      if (connectorId && ownerSubjectId) {
        const authorizedInstanceIds = Array.isArray(streamGrant?.instance_ids)
          ? (streamGrant.instance_ids as string[])
          : [];
        grantedConnections = await listGrantedConnectionsForStream({
          authorizedInstanceIds: grant ? authorizedInstanceIds : null,
          connectorId,
          ownerSubjectId,
        });
      }
      return buildStreamMetadataEntry({
        freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
        grantedConnections,
        grantStreams,
        manifestStream,
        manifestStreamNames,
        streamGrant,
      });
    })
  );

  const item: Record<string, unknown> = {
    object: "connector",
    source,
    stream_count: streams.length,
    streams,
  };
  if (connectorId) {
    item.connector_key = connectorId;
    item.connector_id = connectorId;
  }
  return item;
}

export async function buildConnectorDiscoveryItem({
  source,
  storageBinding,
  manifest,
  grant = null as Record<string, unknown> | null,
  ownerSubjectId = null as string | null,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant?: Record<string, unknown> | null;
  ownerSubjectId?: string | null;
}) {
  const connectorId = (storageBinding.connector_id as string | null | undefined) ?? null;
  const rawSummaries = await listSubjectVisibleStreamSummaries({
    grant,
    manifest,
    ownerSubjectId,
    source,
    storageBinding,
  });
  const streamSummaries = rawSummaries as Record<string, unknown>[];
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name as string, summary]));
  const manifestStreamsArr = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const grantStreamsArr = Array.isArray(grant?.streams) ? (grant?.streams as Record<string, unknown>[]) : [];
  const visibleStreams: Record<string, unknown>[] = grant
    ? (grantStreamsArr
        .map((streamGrant) => manifestStreamsArr.find((stream) => stream.name === streamGrant.name))
        .filter(Boolean) as Record<string, unknown>[])
    : manifestStreamsArr;
  const freshnessEvidence = await getConnectorFreshnessEvidence({
    manifest,
    storageBinding,
  });

  const item: Record<string, unknown> = {
    object: "connector",
    source,
    stream_count: visibleStreams.length,
    streams: visibleStreams.map((stream) =>
      buildStreamDiscoverySummary({
        connectorId,
        freshnessEvidence,
        stream,
        summary: summaryByName.get(stream.name as string) || null,
      })
    ),
  };

  if (connectorId) {
    item.connector_key = connectorId;
    item.connector_id = connectorId;
  }

  return item;
}
