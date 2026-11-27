// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcTimestamp } from "@pdpp/brand-react";
import {
  buildRecordPreview,
  classifyRecordKind,
  type DeclaredFieldTypes,
  deriveDeclaredFieldTypes,
  deriveFieldSchemaTypes,
  formatRecordFieldValue,
  formatStructuredCell,
  humanizeFieldLabel,
  parseTimestampValue,
} from "@pdpp/display";
import { formatStreamPageCount } from "./stream-page-count.ts";
import { DataList, PageHeader, Pager, Section } from "@pdpp/operator-ui/components/primitives";
import type { ExplorerFieldCapability } from "@pdpp/operator-ui/components/views/explorer-utils";
import { declaredRolesFromCapabilities } from "@pdpp/operator-ui/explore/explore-data-assembler";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { ServerUnreachable } from "../../../components/server-unreachable.tsx";
import { WarningsBanner } from "../../../components/warnings-banner.tsx";
import { exploreRecordRow } from "../../../explore/explore-presentation.ts";
import { formatStreamCollectionFacts, type StreamCollectionFacts } from "../../../lib/collection-report.ts";
import { connectorRunSummaryId } from "../../../lib/connector-run-summary-status.ts";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../lib/owner-token.ts";
import { pickSemanticTimestamp, primaryTimestamp } from "../../../lib/record-timestamps.ts";
import type { RefCollectionReportEntry, RefConnectorRunSummary } from "../../../lib/ref-client.ts";
import {
  computeDefaultColumns,
  type ConnectorManifest,
  deriveAllColumns,
  getStreamMetadata,
  listConnectorManifests,
  queryRecords,
  type RecordsPage,
  resolveSelectedColumns,
  type StreamManifest,
  type StreamMetadata,
  type StreamRecord,
  stringifyCell,
  truncate,
} from "../../../lib/rs-client.ts";
import {
  connectorInstanceIdForConnection,
  resolveConnectionForRecordsRoute,
} from "../../connection-route.ts";
import { findManifestForConnectorId } from "../../lib/relationships.ts";
import { ColumnsMenu } from "./columns-menu.tsx";
import { partialReadSentence, sourceDisplayName } from "./record-list-presentation.ts";
import { RecordOrderSelect } from "./record-order-select.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const TH = "pdpp-eyebrow border-border/70 border-b px-3 py-2 text-left text-muted-foreground";
const TD = "pdpp-caption border-border/70 border-b px-3 py-2";

const FILTER_PARAM_RE = /^filter\[(.+)\]$/;
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

function isDateValue(value: unknown): value is string {
  return typeof value === "string" && DATE_PREFIX_RE.test(value) && parseTimestampValue(value) !== null;
}

function exactCountFromPage(page: RecordsPage): number | null {
  const count = page.meta?.count;
  return count?.kind === "exact" && typeof count.value === "number" && Number.isFinite(count.value)
    ? Math.max(0, Math.floor(count.value))
    : null;
}

function hasExactFilters(filters: Record<string, string>): boolean {
  return Object.keys(filters).length > 0;
}

function countModeForFilters(filtered: boolean): "exact" | "none" {
  return filtered ? "exact" : "none";
}

function filterParamForQuery(filtered: boolean, filters: Record<string, string>): Record<string, string> | undefined {
  return filtered ? filters : undefined;
}

function matchingCountForHeader(filtered: boolean, page: RecordsPage): number | null {
  return filtered ? exactCountFromPage(page) : null;
}

function readRecordOrder(value: string | string[] | undefined): "asc" | "desc" | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

function collectionFactsForStream(
  report: readonly RefCollectionReportEntry[] | null | undefined,
  streamName: string
): StreamCollectionFacts | null {
  const entry = (report ?? []).find((row) => row.stream === streamName) ?? null;
  return entry ? formatStreamCollectionFacts(entry) : null;
}

// Extract `filter[field]=value` pairs from the raw search params. Relationship
// navigation links a parent record to its children via
// `?filter[<child_parent_key_field>]=<parent key>`; this is the receiving end.
function readExactFilters(searchParams: Record<string, string | string[] | undefined>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    const match = FILTER_PARAM_RE.exec(key);
    if (!match) {
      continue;
    }
    const [_, field] = match;
    const raw = Array.isArray(value) ? value[0] : value;
    if (field && typeof raw === "string" && raw.length > 0) {
      filters[field] = raw;
    }
  }
  return filters;
}

export default async function StreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ columns?: string; cursors?: string; view?: string } & Record<string, string | string[] | undefined>>;
}) {
  const { connector, stream } = await params;
  const resolvedSearchParams = await searchParams;
  const { columns: columnsParam, cursors: cursorsParam } = resolvedSearchParams;
  const viewParam = typeof resolvedSearchParams.view === "string" ? resolvedSearchParams.view : undefined;
  const tableView = viewParam === "table";
  const exactFilters = readExactFilters(resolvedSearchParams);
  const filtered = hasExactFilters(exactFilters);
  const order = readRecordOrder(resolvedSearchParams.order);
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(",").filter(Boolean) : [];
  let connectorId = routeId;
  let connectionId = routeId;
  let sourceLabel = routeId;
  let connectorInstanceId: string | null = null;

  let page: RecordsPage;
  let streamManifest: StreamManifest | null = null;
  let streamRecordTotal: number | null = null;
  let latestSourceRun: RefConnectorRunSummary | null = null;
  let streamCollectionFacts: StreamCollectionFacts | null = null;
  let declaredFieldTypes: DeclaredFieldTypes = {};
  let fieldSchemaTypes: Readonly<Record<string, string>> = {};
  // Declared field roles drive the row's honest title and money preview.
  let fieldCapabilities: ExplorerFieldCapability[] = [];
  let listStreamMetadata: ListStreamMetadata = null;
  let connectorIcon: ConnectorManifest["icon"] = null;
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectorId = connection.connector_id;
    connectionId = connection.connection_id;
    sourceLabel = sourceDisplayName(connection);
    connectorInstanceId = connectorInstanceIdForConnection(connection);
    latestSourceRun = connection.last_run;
    streamCollectionFacts = collectionFactsForStream(connection.collection_report, streamName);
    const sourceStreamRecordTotal =
      connection.stream_records?.find((row) => row.stream === streamName)?.record_count ?? null;
    const manifestsPromise = listConnectorManifests().catch(
      () => [] as Awaited<ReturnType<typeof listConnectorManifests>>
    );
    const [pageResult, manifests, streamMetadata] = await Promise.all([
      queryRecords(connectorId, streamName, {
        connectionId,
        connectorInstanceId,
        count: countModeForFilters(filtered),
        cursor: trail.at(-1),
        filter: filterParamForQuery(filtered, exactFilters),
        limit: PAGE_SIZE,
        order,
      }),
      manifestsPromise,
      // Declared presentation types for THIS stream's fields, so currency
      // minor-unit cells render as money (chase `amount` → `$30.00`). Soft:
      // a metadata read failure leaves cells on plain stringification.
      getStreamMetadata(connectorId, streamName, { connectionId, connectorInstanceId }).catch(() => null),
    ]);
    page = pageResult;
    declaredFieldTypes = deriveDeclaredFieldTypes(streamMetadata);
    fieldSchemaTypes = deriveFieldSchemaTypes(streamMetadata);
    fieldCapabilities = Object.entries(streamMetadata?.field_capabilities ?? {}).map(([name, capability]) => ({
      granted: capability.granted !== false,
      name,
      role: typeof capability.role === "string" ? capability.role : undefined,
      type: typeof capability.type === "string" ? capability.type : undefined,
    }));
    listStreamMetadata = listStreamMetadataFrom(streamMetadata);
    const connectorManifest = findManifestForConnectorId(manifests, connectorId);
    connectorIcon = connectorManifest?.icon ?? null;
    const maybeStream = connectorManifest?.streams?.find((s) => s.name === streamName);
    streamManifest = (maybeStream ?? null) as StreamManifest | null;
    streamRecordTotal =
      typeof streamMetadata?.record_count === "number" && Number.isFinite(streamMetadata.record_count)
        ? Math.max(0, Math.floor(streamMetadata.record_count))
        : sourceStreamRecordTotal;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Data sources" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      // Stream is not (or no longer) advertised by this connector's manifest.
      // Owner-mode stream visibility is manifest-derived; once a stream is
      // dropped from the manifest, records-read returns 404. Render a bounded
      // honest state instead of crashing to the segment error boundary.
      return (
        <RecordroomShellWithPalette>
          <PageHeader
            breadcrumbs={[
              { href: "/sources", label: "Data sources" },
              { href: `/sources/${encodeURIComponent(connectionId)}`, label: sourceLabel },
              { label: humanizeFieldLabel(streamName) },
            ]}
            title={humanizeFieldLabel(streamName)}
          />
          <div className="border-border/70 border-y py-4">
            <p className="pdpp-caption text-foreground">
              This kind of record is not available for {sourceLabel}.
            </p>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              The data source no longer provides {humanizeFieldLabel(streamName)}. Open{" "}
              <Link className="underline underline-offset-2" href={`/sources/${encodeURIComponent(connectionId)}`}>
                the data source
              </Link>{" "}
              to see what it has now.
            </p>
          </div>
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  const allColumns = deriveAllColumns(page.data);
  const defaultColumns = computeDefaultColumns(page.data, streamManifest).filter((column) => column !== "id");
  const { columns, mode } = resolveSelectedColumns(columnsParam, allColumns, defaultColumns);
  const streamPath = `/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(streamName)}`;
  const hrefState = { columnsParam, exactFilters, order, view: tableView ? "table" as const : undefined };
  const prevHref = trail.length ? hrefFor(streamPath, trail.slice(0, -1), hrefState) : null;
  const nextHref = page.next_cursor ? hrefFor(streamPath, [...trail, page.next_cursor], hrefState) : null;
  const recordHref = (id: string) => `${streamPath}/${encodeURIComponent(id)}`;
  const pageCount = formatStreamPageCount({
    filtered,
    hasMore: page.has_more,
    matchingCount: matchingCountForHeader(filtered, page),
    pageNumber: trail.length + 1,
    shown: page.data.length,
    totalHeld: streamRecordTotal,
  });

  // Format a non-linked cell: declared-currency formatting (chase `amount` ->
  // `$30.00`) first, then a readable array/object rendering (a `cc` array of
  // `{name,email}` reads as names, not raw JSON) before falling back to plain
  // stringification. Returns "" for absent values, matching `stringifyCell` so
  // the existing empty-cell handling holds.
  const cellText = (record: StreamRecord, column: string): string => {
    const value = record.data?.[column];
    const formatted = formatRecordFieldValue(value, column, declaredFieldTypes[column], fieldSchemaTypes[column]);
    if (formatted) {
      return formatted.text;
    }
    const structured = formatStructuredCell(value);
    return structured ? structured.text : stringifyCell(value);
  };

  // Declared roles keep title and amount previews tied to the stream's metadata.
  const declaredRoles = declaredRolesFromCapabilities(fieldCapabilities);
  const recordPreviewFor = (record: StreamRecord) => {
    const data = record.data ?? {};
    const { kind } = classifyRecordKind(streamName, data, declaredFieldTypes, undefined, declaredRoles);
    return buildRecordPreview(kind, data, declaredFieldTypes, declaredRoles);
  };

  const partialReadMessage = partialReadSentence(page.warnings);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={`${streamPath}/health`}>
            What arrived →
          </Link>
        }
        breadcrumbs={[
          { href: "/sources", label: "Data sources" },
          { href: `/sources/${encodeURIComponent(connectionId)}`, label: sourceLabel },
          { label: humanizeFieldLabel(streamName) },
        ]}
        description={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={sourceLabel} />
            <span>
              {streamRecordTotal === null
                ? "Record count unavailable"
                : `${streamRecordTotal.toLocaleString()} record${streamRecordTotal === 1 ? "" : "s"}`}{" "}
              · <span className="text-foreground">{sourceLabel}</span>
            </span>
          </span>
        }
        title={humanizeFieldLabel(streamName)}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        {pageCount ? <p className="pdpp-caption text-muted-foreground">{pageCount}</p> : <span />}
        <div className="flex flex-wrap items-center gap-2">
          {tableView ? (
            <Link
              className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })}
              href={hrefFor(streamPath, trail, { columnsParam, exactFilters, order })}
            >
              Show as rows
            </Link>
          ) : (
            <Link
              className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })}
              href={hrefFor(streamPath, trail, { columnsParam, exactFilters, order, view: "table" })}
            >
              Show as table
            </Link>
          )}
          {tableView && allColumns.length > 0 && (
            <ColumnsMenu
              allColumns={allColumns}
              defaultColumns={defaultColumns}
              mode={mode}
              selectedColumns={columns}
            />
          )}
          <RecordOrderSelect currentOrder={order ?? "desc"} pathname={streamPath} />
        </div>
      </div>

      <details className="mb-6 border-border/70 border-y py-3">
        <summary className="pdpp-caption cursor-pointer font-medium text-foreground">Details</summary>
        <div className="pt-3">
          <WarningsBanner warnings={page.warnings} />
          <StreamEvidenceSection
            filtered={filtered}
            filters={exactFilters}
            hasMore={page.has_more}
            latestSourceRun={latestSourceRun}
            pageNumber={trail.length + 1}
            shown={page.data.length}
            streamCollectionFacts={streamCollectionFacts}
            syncsHref={`/syncs?connection_id=${encodeURIComponent(connectionId)}`}
            totalHeld={streamRecordTotal}
          />
        </div>
      </details>

      {partialReadMessage ? <p className="pdpp-caption mb-3 text-muted-foreground">{partialReadMessage}</p> : null}
      {page.data.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No records.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {page.data.map((r) => {
            const preview = recordPreviewFor(r);
            const timestamp = primaryTimestamp(pickSemanticTimestamp(listStreamMetadata, r.data), r.emitted_at);
            const row = exploreRecordRow({
              connectionDisplayName: sourceLabel,
              displayAt: timestamp.value,
              preview: preview ?? undefined,
              stream: streamName,
            });
            return (
              <li className="py-2" key={r.id}>
                <Link
                  aria-label={`Open ${row.title} · ${row.kind} · ${row.source}`}
                  className="rr-x-row"
                  href={recordHref(r.id)}
                >
                  <span aria-hidden="true" className="rr-x-record-logo">
                    <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={sourceLabel} />
                  </span>
                  <span className="rr-x-row__body">
                    <span className="rr-x-row__title text-[15px]">{row.title}</span>
                    <span className="rr-x-row__meta truncate text-[13px] text-muted-foreground">
                      {row.source}
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-4">
                    {row.time ? <span className="rr-x-row__time text-[13px]">{row.time}</span> : null}
                    {preview?.amount ? (
                      <span className="text-[13px] tabular-nums text-foreground">{preview.amount}</span>
                    ) : null}
                  </span>
                </Link>

                {tableView ? (
                  <div className="px-3 pb-2 pt-3">
                    <div className="sm:hidden">
                      <RecordCard
                        columns={columns}
                        declaredFieldTypes={declaredFieldTypes}
                        fieldSchemaTypes={fieldSchemaTypes}
                        record={r}
                      />
                    </div>

                    <div className="hidden overflow-x-auto sm:block">
                      <table className="min-w-full">
                        <thead className="bg-muted/40">
                          <tr>
                            {columns.map((c) => (
                              <th className={TH} key={c}>
                                {c === "id" ? "Record id" : humanizeFieldLabel(c)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="transition-colors hover:bg-muted/30">
                            {columns.map((c) => {
                              const display = cellText(r, c);
                              const rawValue = r.data?.[c];
                              const dateValue = isDateValue(rawValue) ? rawValue : null;
                              return (
                                <td className={`${TD} align-top`} key={c}>
                                  <Link
                                    aria-label={display ? undefined : `Open record, ${humanizeFieldLabel(c)} not set`}
                                    className="block"
                                    href={recordHref(r.id)}
                                  >
                                    <span className="block max-w-[24rem] truncate">
                                      {dateValue ? <IcTimestamp value={dateValue} /> : display}
                                    </span>
                                  </Link>
                                </td>
                              );
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Pager next={nextHref} prev={prevHref} />
    </RecordroomShellWithPalette>
  );
}

function StreamEvidenceSection({
  filtered,
  filters,
  hasMore,
  latestSourceRun,
  pageNumber,
  shown,
  streamCollectionFacts,
  syncsHref,
  totalHeld,
}: {
  filtered: boolean;
  filters: Record<string, string>;
  hasMore: boolean;
  latestSourceRun: RefConnectorRunSummary | null;
  pageNumber: number;
  shown: number;
  streamCollectionFacts: StreamCollectionFacts | null;
  syncsHref: string;
  totalHeld: number | null;
}) {
  const latestStreamRun = latestStreamRunEvidence(streamCollectionFacts, latestSourceRun);
  return (
    <Section
      description="The page and collection information used to show these records."
      title="Record details"
    >
      <DataList ariaLabel="Record details">
        <StreamEvidenceRow
          detail={streamTotalEvidenceLabel(totalHeld)}
          label="Record total"
          value={totalHeld === null ? "not counted yet" : `${totalHeld.toLocaleString()} saved`}
        />
        <StreamEvidenceRow
          detail={`${shown.toLocaleString()} record${shown === 1 ? "" : "s"} shown on page ${pageNumber}${hasMore ? " · more pages available" : ""}`}
          label="Current page"
          value={`page ${pageNumber}`}
        />
        <StreamEvidenceRow
          detail={latestStreamRun.detail}
          href={latestStreamRun.href}
          label="Latest collection"
          value={latestStreamRun.value}
        />
        <StreamEvidenceRow
          detail={filtered ? exactFilterEvidenceLabel(filters) : "Showing every record in this stream."}
          label="Filters"
          value={filtered ? `${Object.keys(filters).length.toLocaleString()} exact` : "none"}
        />
        <StreamEvidenceRow
          detail="Scoped to this exact source, not every source of the same connector type."
          href={syncsHref}
          label="Sync history"
          value="Open sync history"
        />
      </DataList>
    </Section>
  );
}

function latestStreamRunEvidence(
  facts: StreamCollectionFacts | null,
  latestRun: RefConnectorRunSummary | null
): { detail: string; href: string | null; value: string } {
  const runId = connectorRunSummaryId(latestRun?.run_id);
  const href = runId ? `/syncs/${encodeURIComponent(runId)}` : null;
  if (!facts) {
    return {
      detail: latestRun
        ? "The latest source run reported facts for other streams only."
        : "This dashboard is still waiting on its first attributed source run.",
      href,
      value: latestRun ? "stream report unavailable" : "not seen yet",
    };
  }
  const detailParts = [
    runId ? `run ${runId}` : null,
    `coverage ${facts.coverage.value}`,
    facts.disposition ? `next run: ${facts.disposition.label}` : null,
    facts.pendingDetailGapsLabel,
    facts.skipLabel,
  ].filter((part): part is string => part !== null);
  return {
    detail: detailParts.join(" · "),
    href,
    value: facts.countsLabel ?? facts.coverage.label,
  };
}

function StreamEvidenceRow({
  detail,
  href,
  label,
  value,
}: {
  detail: string;
  href?: string | null;
  label: string;
  value: string;
}) {
  return (
    <li className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="pdpp-caption text-muted-foreground">{label}</p>
        {href ? (
          <Link
            className="pdpp-body font-medium text-foreground underline underline-offset-2 hover:no-underline"
            href={href}
          >
            {value}
          </Link>
        ) : (
          <p className="pdpp-body font-medium text-foreground">{value}</p>
        )}
      </div>
      <p className="pdpp-caption max-w-xl break-words text-muted-foreground sm:text-right">{detail}</p>
    </li>
  );
}

function streamTotalEvidenceLabel(totalHeld: number | null): string {
  if (totalHeld === null) {
    return "The retained total is still unknown; the records below are what this page received.";
  }
  return "The records DataConnect holds for this data.";
}

function exactFilterEvidenceLabel(filters: Record<string, string>): string {
  return Object.entries(filters)
    .map(([key, value]) => `${key}=${truncate(value, 48)}`)
    .join(" · ");
}

type ListStreamMetadata = { consent_time_field?: string | null; cursor_field?: string | null } | null;

/**
 * StreamMetadata has `[k: string]: unknown`, so narrow the manifest-declared
 * consent_time_field / cursor_field to `string | null` for the timestamp helper.
 */
function listStreamMetadataFrom(metadata: StreamMetadata | null | undefined): ListStreamMetadata {
  if (!metadata) {
    return null;
  }
  return {
    consent_time_field: typeof metadata.consent_time_field === "string" ? metadata.consent_time_field : null,
    cursor_field: typeof metadata.cursor_field === "string" ? metadata.cursor_field : null,
  };
}

function RecordCard({
  record,
  columns,
  declaredFieldTypes,
  fieldSchemaTypes,
}: {
  record: StreamRecord;
  columns: string[];
  declaredFieldTypes: DeclaredFieldTypes;
  fieldSchemaTypes: Readonly<Record<string, string>>;
}) {
  return (
    <div>
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {columns.map((c) => {
          const raw = record.data?.[c];
          const formatted = formatRecordFieldValue(raw, c, declaredFieldTypes[c], fieldSchemaTypes[c]);
          const structured = formatted ? null : formatStructuredCell(raw);
          const dateValue = isDateValue(raw) ? raw : null;
          let v: string;
          if (formatted) {
            v = formatted.text;
          } else if (structured) {
            v = structured.text;
          } else {
            v = stringifyCell(raw);
          }
          if (!v) {
            return null;
          }
          return (
            <Fragment key={c}>
              <dt className="truncate text-muted-foreground">{c === "id" ? "Record id" : humanizeFieldLabel(c)}</dt>
              <dd className="break-words" title={structured?.detail}>
                {dateValue ? <IcTimestamp value={dateValue} /> : truncate(v, 120)}
              </dd>
            </Fragment>
          );
        })}
      </dl>
    </div>
  );
}

function hrefFor(
  base: string,
  trail: string[],
  state: {
    columnsParam?: string;
    exactFilters?: Record<string, string>;
    order?: "asc" | "desc";
    view?: "table";
  } = {}
): string {
  const parts: string[] = [];
  if (trail.length) {
    parts.push(`cursors=${trail.join(",")}`);
  }
  if (state.columnsParam) {
    parts.push(`columns=${encodeURIComponent(state.columnsParam)}`);
  }
  for (const [field, value] of Object.entries(state.exactFilters ?? {})) {
    parts.push(`filter[${encodeURIComponent(field)}]=${encodeURIComponent(value)}`);
  }
  if (state.order) {
    parts.push(`order=${state.order}`);
  }
  if (state.view === "table") {
    parts.push("view=table");
  }
  return parts.length ? `${base}?${parts.join("&")}` : base;
}
