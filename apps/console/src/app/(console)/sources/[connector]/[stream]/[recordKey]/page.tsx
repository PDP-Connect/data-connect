// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buildRecordPreview,
  classifyRecordKind,
  deriveDeclaredFieldTypes,
  deriveFieldSchemaTypes,
  humanizeFieldLabel,
} from "@pdpp/display";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordIdentity } from "@pdpp/operator-ui/components/record-identity";
import { buildBlobAffordance, buildPeekFields } from "@pdpp/operator-ui/components/views/explorer-utils";
import { declaredRolesFromCapabilities } from "@pdpp/operator-ui/explore/explore-data-assembler";
import { exploreRecordTime } from "../../../../explore/explore-presentation.ts";
import { notFound } from "next/navigation";
import { RecordInspector } from "@/app/(console)/components/record-inspector.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../../../components/server-unreachable.tsx";
import { WarningsBanner } from "../../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../../lib/owner-token.ts";
import { pickSemanticTimestamp } from "../../../../lib/record-timestamps.ts";
import {
  type ExpandCapability,
  type ConnectorManifest,
  getRecord,
  getStreamMetadata,
  listConnectorManifests,
  type StreamMetadata,
  type StreamRecord,
} from "../../../../lib/rs-client.ts";
import {
  connectorInstanceIdForConnection,
  resolveConnectionForRecordsRoute,
} from "../../../connection-route.ts";
import { connectionDisplayName } from "../../../../lib/connection-display-name.ts";
import {
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findManifestForConnectorId,
  findParentBackLink,
  mergeParentBackLinks,
  parentRelationsForChild,
  reverseChildListDedupKey,
  reverseChildListLinksFromManifest,
} from "../../../lib/relationships.ts";
import { recordCrumbLabel, recordTitlePreview } from "./record-title.ts";

export const dynamic = "force-dynamic";

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ connector: string; stream: string; recordKey: string }>;
}) {
  const { connector, stream, recordKey } = await params;
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);
  const recordId = decodeURIComponent(recordKey);

  let record: StreamRecord;
  let connectionId = routeId;
  let connectorId = routeId;
  let sourceLabel = routeId;
  let recordMetadata: StreamMetadata | null = null;
  let expandCapabilities: ExpandCapability[] = [];
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  interface ManifestStream {
    name: string;
    query?: { expand?: Array<{ name: string }> };
    relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
  }
  let childManifestStream: ManifestStream | undefined;
  // All streams in this connector's manifest — used to enumerate child streams
  // whose declared `has_one` points back at the displayed (parent) stream, for
  // reverse parent → filtered-child-list links.
  let connectorStreams: ManifestStream[] = [];
  let connectorIcon: ConnectorManifest["icon"] = null;
  try {
    const connection = await resolveRecordsConnection(routeId);
    connectionId = connection.connection_id;
    connectorId = connection.connector_id;
    sourceLabel = connectionDisplayName(
      connection.display_name,
      connection.connector_display_name,
      connection.connector_id
    );
    const connectorInstanceId = connectorInstanceIdForConnection(connection);
    // Fetch the record, this stream's metadata (for parent → child relations),
    // and the connector manifest together. The manifest is used only to prune
    // parent metadata reads; child → parent link semantics come from live
    // `expand_capabilities`, not fabricated manifest fields.
    const [recordResult, metadataResult, manifests] = await Promise.all([
      getRecord(connection.connector_id, streamName, recordId, { connectionId, connectorInstanceId }),
      getStreamMetadata(connection.connector_id, streamName, { connectionId, connectorInstanceId }).catch(() => null),
      listConnectorManifests().catch(() => []),
    ]);
    record = recordResult;
    recordMetadata = metadataResult;
    expandCapabilities = Array.isArray(metadataResult?.expand_capabilities) ? metadataResult.expand_capabilities : [];
    const connectorManifest = findManifestForConnectorId(manifests, connection.connector_id);
    connectorIcon = connectorManifest?.icon ?? null;
    connectorStreams = (connectorManifest?.streams ?? []) as ManifestStream[];
    childManifestStream = connectorStreams.find((s) => s.name === streamName);
    const parentMetadata = await Promise.all(
      candidateParentStreamsForChild(connectorManifest?.streams, streamName).map(async (parentStream) => {
        const metadata = await getStreamMetadata(connection.connector_id, parentStream, {
          connectionId,
          connectorInstanceId,
        }).catch(() => null);
        return {
          expandCapabilities: Array.isArray(metadata?.expand_capabilities) ? metadata.expand_capabilities : [],
          parentStream,
        };
      })
    );
    parentRelations = parentRelationsForChild(parentMetadata, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Data sources" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    // A 404/410 from the resource server is an expected end-state for a record
    // route: the record was deleted, or its stream was retired/renamed in a
    // newer manifest and `getRecord` can no longer resolve it (owner-mode
    // visibility is manifest-derived). The reference returns "Record not found"
    // for both, so this surfaces as the standard not-found page. Branch on the
    // typed `ResourceServerHttpError.status` — authoritative and 410-aware —
    // rather than substring-matching the wrapped message.
    notFoundIfRecordGone(err);
    throw err;
  }

  const connectorHref = `/sources/${encodeURIComponent(connectionId)}`;
  const streamHref = `${connectorHref}/${encodeURIComponent(streamName)}`;
  const recordReadUrl = `/v1/streams/${encodeURIComponent(streamName)}/records/${encodeURIComponent(record.id)}?${new URLSearchParams(
    {
      connection_id: connectionId,
      connector_id: connectorId,
    }
  ).toString()}`;
  const fieldCapabilities = Object.entries(recordMetadata?.field_capabilities ?? {}).map(([name, capability]) => ({
    granted: capability.granted !== false,
    name,
    // Carry the declared presentation ROLE too (not just the type) so the detail
    // page can derive the same honest display title the feed row uses — otherwise
    // the H1 falls back to the raw record key (the live "snake_case/uuid as H1" defect).
    role: typeof capability.role === "string" ? capability.role : undefined,
    type: typeof capability.type === "string" ? capability.type : undefined,
  }));
  // StreamMetadata uses [k: string]: unknown, so narrow consent_time_field /
  // cursor_field to the typed shape pickSemanticTimestamp expects. Drives both
  // the page header (below) and the inspector's authored-date row.
  const tsMetadata = recordMetadata
    ? {
        consent_time_field:
          typeof recordMetadata.consent_time_field === "string" ? recordMetadata.consent_time_field : null,
        cursor_field: typeof recordMetadata.cursor_field === "string" ? recordMetadata.cursor_field : null,
      }
    : null;
  const semanticTs = pickSemanticTimestamp(tsMetadata, record.data);
  const sourceUpdatedAt = semanticTs ? exploreRecordTime(semanticTs.value) : "";
  const updatedAt = sourceUpdatedAt || exploreRecordTime(record.emitted_at);
  const inspectorRecord = {
    bodyJson: JSON.stringify(record.data, null, 2),
    connectionDisplayName: sourceLabel,
    connectionId,
    connectorId,
    emittedAt: record.emitted_at,
    error: null,
    fields: buildPeekFields(record.data, fieldCapabilities),
    readUrl: recordReadUrl,
    recordId: record.id,
    recordSizeBytes: typeof record.record_json_bytes === "number" ? record.record_json_bytes : null,
    // Honest: the authored date is shown only when a semantic field is declared;
    // the inspector keeps its raw value under Details.
    semanticTimestamp: semanticTs
      ? { label: semanticTs.field, value: semanticTs.value }
      : null,
    stream: streamName,
  };

  // Honest display TITLE for the H1 — built from the SAME canonical RecordPreview the
  // feed/peek/stream-table use, then rendered through the ONE shared RecordIdentity cell
  // below (NOT a second inline copy of the view logic). The cell leads with the declared
  // title when present, else the first honest generic field, else the record key rendered
  // quiet/derived — never a raw uuid styled as an authored title.
  const declaredRoles = declaredRolesFromCapabilities(fieldCapabilities);
  const declaredTypes = deriveDeclaredFieldTypes({ field_capabilities: recordMetadata?.field_capabilities });
  const detailKind = classifyRecordKind(streamName, record.data, declaredTypes, undefined, declaredRoles).kind;
  const detailPreview = recordTitlePreview(
    buildRecordPreview(detailKind, record.data, declaredTypes, declaredRoles),
    detailKind,
    streamName
  );
  const recordCrumb = recordCrumbLabel(detailPreview, streamName);
  // The reliable, server-declared image signal (declared blob field with a usable
  // fetch_url) — the SAME signal the inspector resolves; passed to the cell so the H1
  // shows the image mark from a reliable signal, never a preview sniff.
  const detailHasImage = buildBlobAffordance(record.data, fieldCapabilities)?.state === "available";

  // Parent → child relations declared on THIS (parent) stream.
  const relatedLinks = buildRelatedLinks(expandCapabilities, { connectionId, parentRecordKey: record.id });
  // Reverse parent → filtered-child-list links: for each child stream that
  // declares a `has_one` back to THIS (parent) stream, link to that child's
  // list filtered by the parent key. Deduplicated against any forward
  // `has_many` link that already resolves to the same `(child stream, filter
  // field)` filtered list (D6 in the OpenSpec design).
  const forwardChildListKeys = new Set(
    relatedLinks
      .filter((link) => link.navigable && link.cardinality === "has_many" && link.childParentKeyField)
      .map((link) => reverseChildListDedupKey(link.targetStream, link.childParentKeyField as string))
  );
  const reverseChildListLinks = reverseChildListLinksFromManifest(
    connectorStreams,
    { connectionId, parentRecordKey: record.id, parentStream: streamName },
    forwardChildListKeys
  );
  // Child → parent back-links from two sources:
  //   1. Parent streams' expand_capabilities (server metadata, covers parent-declared has_many/has_one)
  //   2. Child's own manifest has_one relationships (covers child-declared has_one like Chase transactions→account)
  const parentBackLinkFromMeta = findParentBackLink(streamName, record.data, parentRelations, { connectionId });
  const childHasOneLinks = childHasOneBackLinksFromManifest(childManifestStream, record.data, { connectionId });
  // Merge the two manifest sources, preferring the metadata-derived link, and
  // deduplicate by (parentStream, child parent-key field) — NOT parentStream
  // alone. Two declared has_one edges to the same parent stream via different
  // fields (e.g. a YNAB transaction's account_id and transfer_account_id, both →
  // accounts) point at different parent records, so both must render.
  const allParentBackLinks = mergeParentBackLinks(parentBackLinkFromMeta, childHasOneLinks);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { href: "/sources", label: "Data sources" },
          { href: connectorHref, label: sourceLabel },
          { href: streamHref, label: humanizeFieldLabel(streamName) },
          ...(recordCrumb ? [{ label: recordCrumb }] : []),
        ]}
        description={
          <>
            <span className="mr-2 inline-flex items-center gap-2">
              <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={sourceLabel} />
              <span>{sourceLabel}</span>
            </span>
            Updated {updatedAt}
          </>
        }
        title={
          <RecordIdentity hasImage={detailHasImage} preview={detailPreview} recordKey={recordId} showGlyph={false} variant="header" />
        }
      />

      {record.warnings.length > 0 ? (
        <details className="mb-6 border-border/70 border-y py-3">
          <summary className="pdpp-caption cursor-pointer font-medium text-foreground">Details</summary>
          <div className="pt-3">
            <WarningsBanner warnings={record.warnings} />
          </div>
        </details>
      ) : null}

      <RecordInspector
        fieldSchemaTypes={deriveFieldSchemaTypes(recordMetadata)}
        hiddenBodyFields={semanticTs ? [semanticTs.field] : undefined}
        record={inspectorRecord}
        relationships={{
          parentBackLinks: allParentBackLinks,
          relatedLinks,
          reverseChildListLinks,
        }}
        streamRecordsHref={streamHref}
      />
    </RecordroomShellWithPalette>
  );
}

async function resolveRecordsConnection(routeId: string) {
  const connection = await resolveConnectionForRecordsRoute(routeId);
  if (!connection) {
    notFound();
  }
  return connection;
}

function notFoundIfRecordGone(err: unknown): void {
  if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
    notFound();
  }
}
