// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Traces — the Ink Carbon audit surface.
 *
 * Traces record who read what under which grant: provider-connect flows,
 * owner-device exchanges, and /v1 data reads all land here as protocol
 * artifacts. This is an honest audit log — every row is immutable record.
 *
 * Exemption: this page's own server-side data fetches (and every other
 * console page's) go through a separate, non-trace-logged /_ref owner-session
 * surface — browsing this console never appears in this log. Only /v1 reads
 * (an external client/agent reading data under a grant) and explicit
 * mutations (revoke, run, schedule change, connect, DCR) emit trace events.
 *
 * Layout: filter band → Table (status | subject | kinds | events | time)
 * with an optional Sheet peek panel on the right when ?peek= is set.
 *
 * Data path is unchanged: listTraces + getTraceTimeline via the owner-token
 * ref-client. All filter params and cursor pagination are preserved verbatim.
 */

import {
  buttonVariants,
  Body,
  Caption,
  Endorse,
  IcButton,
  IcInput,
  IcSelect,
  Sheet,
  SheetBody,
  SheetHead,
  SheetTitle,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
  TableRow,
  Tag,
  TypedSm,
} from "@pdpp/brand-react";
import { formatRelative } from "@pdpp/display";
import Link from "next/link";
import type { ReactNode } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  getTraceTimeline,
  type ListResponse,
  listTraces,
  type TimelineEnvelope,
  type TraceSummary,
} from "../lib/ref-client.ts";
import { traceEndorseStatus } from "./trace-endorse-status.ts";
import { traceAppName, traceEntryReadFacts, traceEntryTitle } from "./trace-entry-title.ts";
import { traceKindLabel } from "./trace-kind-label.ts";

export const dynamic = "force-dynamic";

interface Params {
  client_id?: string;
  cursor?: string;
  peek?: string;
  provider_id?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/audit/technical?${qs}` : "/audit/technical";
}

function traceListFilters(params: Params) {
  return {
    client_id: params.client_id,
    cursor: params.cursor,
    limit: 50,
    provider_id: params.provider_id,
    q: params.q,
    status: params.status,
  };
}

function traceWhatRead(trace: TraceSummary): string {
  const kind = traceKindLabel(trace.kinds);
  if (kind === "Data read") {
    return "Read records";
  }
  if (RAW_EVENT_KIND_RE.test(kind)) {
    return "Activity";
  }
  return kind;
}

const RAW_EVENT_KIND_RE = /^[a-z][a-z0-9_.-]+$/;

function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return "Time not available";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, Date.now());
}

function hasActiveFilters(params: Params): boolean {
  return Boolean(params.status || params.q || params.client_id || params.provider_id);
}

export default async function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = traceListFilters(params);

  let result: ListResponse<TraceSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listTraces(filters);
    if (params.peek) {
      peekEnvelope = await getTraceTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <TracesHeader />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  const hasFilters = hasActiveFilters(params);
  const peekTraceId = params.peek && peekEnvelope ? params.peek : null;
  const isPeeking = Boolean(peekTraceId);

  return (
    <RecordroomShellWithPalette>
      <TracesHeader />

      <TraceFilterBand hasFilters={hasFilters} params={params} />
      {hasFilters ? <ActiveFilterChips params={params} /> : null}

      <div
        className="rr-traces-split xl:grid xl:items-start xl:gap-6"
        style={{
          gridTemplateColumns: isPeeking ? "minmax(0, 1.4fr) minmax(0, 1fr)" : "1fr",
        }}
      >
        <div>
          <TracesResults hasFilters={hasFilters} params={params} traces={result.data} />
          <TracePagination params={params} result={result} />
        </div>

        <TracePeekSlot envelope={peekEnvelope} isPeeking={isPeeking} params={params} traceId={peekTraceId} />
      </div>
    </RecordroomShellWithPalette>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TracesHeader() {
  return (
    <header style={{ marginBottom: 24, maxWidth: 640 }}>
      <h1 className="pdpp-heading text-foreground" style={{ margin: "0 0 4px" }}>
        Activity
      </h1>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontFamily: "var(--font-sans)",
          fontSize: 16,
          margin: 0,
        }}
      >
        What apps read and when.
      </p>
    </header>
  );
}

function ActiveFilterChips({ params }: { params: Params }) {
  return (
    <details className="mb-4 text-sm">
      <summary className="cursor-pointer">Filters applied</summary>
      <ul aria-label="Active filters" className="mt-2 grid gap-1">
      {params.status ? (
        <li>
          Status: <Tag>{params.status}</Tag>
        </li>
      ) : null}
      {params.q ? (
        <li>
          Search: <code>{params.q}</code>
        </li>
      ) : null}
      {params.client_id ? (
        <li>
          App: <code>{params.client_id}</code>
        </li>
      ) : null}
      {params.provider_id ? (
        <li>
          Data source: <code>{params.provider_id}</code>
        </li>
      ) : null}
      </ul>
    </details>
  );
}

function TraceFilterBand({ params, hasFilters }: { params: Params; hasFilters: boolean }) {
  return (
    <form action="/audit/technical" method="get" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
      <FilterPopover label={params.q ? "Search set" : "Search"}>
        <IcInput aria-label="Search activity id" defaultValue={params.q ?? ""} name="q" placeholder="Activity ID" type="search" />
      </FilterPopover>
      <FilterPopover label={params.status ? `Status: ${params.status}` : "Status"}>
        <IcSelect
          aria-label="Filter by status"
          defaultValue={params.status ?? ""}
          name="status"
          options={[
            { label: "All statuses", value: "" },
            { label: "Succeeded", value: "succeeded" },
            { label: "Failed", value: "failed" },
            { label: "Rejected", value: "rejected" },
            { label: "Started", value: "started" },
          ]}
        />
      </FilterPopover>
      <FilterPopover label={params.client_id ? "App set" : "App"}>
        <IcInput aria-label="Filter by app id" defaultValue={params.client_id ?? ""} name="client_id" placeholder="App id" />
      </FilterPopover>
      <FilterPopover label={params.provider_id ? "Data source set" : "Data source"}>
        <IcInput aria-label="Filter by data source" defaultValue={params.provider_id ?? ""} name="provider_id" placeholder="Data source" />
      </FilterPopover>
      <IcButton size="sm" type="submit" variant="ghost">
        Apply
      </IcButton>
      {hasFilters ? (
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/audit/technical">
          Reset
        </a>
      ) : null}
    </form>
  );
}

function FilterPopover({ children, label }: { children: ReactNode; label: string }) {
  return (
    <details className="relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-md border border-border px-3 py-1 text-foreground text-sm focus-visible:outline-2 focus-visible:outline-primary">
        {label}
      </summary>
      <div className="absolute left-0 z-20 mt-1 min-w-48 rounded-md border border-border bg-background p-3 shadow-md">
        {children}
      </div>
    </details>
  );
}

function TracesResults({
  traces,
  params,
  hasFilters,
}: {
  traces: TraceSummary[];
  params: Params;
  hasFilters: boolean;
}) {
  if (traces.length === 0) {
    return <TracesEmptyState hasFilters={hasFilters} />;
  }

  return (
    <>
      <TracesDesktopTable params={params} traces={traces} />
      <TracesMobileCards traces={traces} />
    </>
  );
}

function TracesDesktopTable({ traces, params }: { traces: TraceSummary[]; params: Params }) {
  return (
    <div className="rr-traces-table-wrap hidden sm:block">
      <Table cols="minmax(0,1fr) minmax(0,1fr) 128px 90px">
        <TableHeaderRow>
          <TableHeader>App</TableHeader>
          <TableHeader>What it read</TableHeader>
          <TableHeader>When</TableHeader>
          <TableHeader>Details</TableHeader>
        </TableHeaderRow>
        {traces.map((trace) => {
          const peeked = params.peek === trace.trace_id;
          const peekHref = listHref(params, { cursor: undefined, peek: peeked ? undefined : trace.trace_id });
          const label = traceAppName(trace);
          const kinds = trace.kinds.slice(0, 3).join(", ");
          return (
            <TableRow className={peeked ? "pdpp-table__row--active" : undefined} key={trace.trace_id}>
              <TableCell>
                <TraceSubjectLink href={`/audit/${encodeURIComponent(trace.trace_id)}`} label={label} />
              </TableCell>
              <TableCell>
                <TypedSm>{traceWhatRead(trace)}</TypedSm>
              </TableCell>
              <TableCell numeric>
                {relativeTime(trace.last_at)}
              </TableCell>
              <TableCell>
                <details>
                  <summary className="cursor-pointer">Details</summary>
                  <TypedSm>{trace.status} · {traceKindLabel(trace.kinds)} · {trace.event_count} events</TypedSm>
                  {kinds ? <TypedSm>{kinds}</TypedSm> : null}
                  <code>{trace.trace_id}</code>
                </details>
                <Link className="hidden xl:inline-block" href={peekHref} scroll={false}>Peek</Link>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
    </div>
  );
}

function TraceSubjectLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} scroll={false} style={{ display: "block", textDecoration: "none" }}>
      <span
        style={{
          color: "var(--foreground)",
          display: "block",
          fontFamily: "var(--font-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </Link>
  );
}

function TracesMobileCards({ traces }: { traces: TraceSummary[] }) {
  return (
    <ul className="rr-traces-cards sm:hidden" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {traces.map((trace) => {
        const detailHref = `/audit/${encodeURIComponent(trace.trace_id)}`;
        const label = traceAppName(trace);
        const kinds = trace.kinds.slice(0, 3).join(", ");
        return (
          <TraceMobileCard detailHref={detailHref} key={trace.trace_id} kinds={kinds} label={label} trace={trace} />
        );
      })}
    </ul>
  );
}

function TraceMobileCard({
  detailHref,
  kinds,
  label,
  trace,
}: {
  detailHref: string;
  kinds: string;
  label: string;
  trace: TraceSummary;
}) {
  return (
    <li
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "10px 0",
      }}
    >
      <Link href={detailHref} style={{ display: "block", textDecoration: "none" }}>
        <span
          style={{
            color: "var(--foreground)",
            display: "block",
            fontFamily: "var(--font-sans)",
            fontSize: "0.875rem",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <TypedSm
          style={{
            color: "var(--muted-foreground)",
            display: "block",
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {traceWhatRead(trace)}
        </TypedSm>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: "5px 10px",
            marginTop: 6,
          }}
        >
          {relativeTime(trace.last_at)}
        </div>
      </Link>
      <details className="pdpp-caption mt-1">
        <summary className="cursor-pointer">Details</summary>
        <code>{trace.trace_id}</code> · <Endorse label={trace.status} status={traceEndorseStatus(trace.status)} /> · <Tag>{traceKindLabel(trace.kinds)}</Tag>
        {kinds ? <TypedSm>{kinds}</TypedSm> : null}<TypedSm>{trace.event_count} events</TypedSm>
      </details>
    </li>
  );
}

function TracePagination({ result, params }: { result: ListResponse<TraceSummary>; params: Params }) {
  if (!(result.has_more || params.cursor)) {
    return null;
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 16,
        paddingTop: 12,
      }}
    >
      {params.cursor ? (
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href={listHref(params, { cursor: undefined })}>
          ← First page
        </a>
      ) : null}
      {result.has_more && result.next_cursor ? (
        <a
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={listHref(params, { cursor: result.next_cursor })}
        >
          Next →
        </a>
      ) : null}
    </div>
  );
}

function TracePeekSlot({
  envelope,
  isPeeking,
  params,
  traceId,
}: {
  envelope: TimelineEnvelope | null;
  isPeeking: boolean;
  params: Params;
  traceId: string | null;
}) {
  if (!(isPeeking && envelope && traceId)) {
    return null;
  }

  return (
    <div className="hidden xl:block">
      <TracesPeekPanel
        envelope={envelope}
        listParams={params}
        traceId={traceId}
      />
    </div>
  );
}

function TracesEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        borderTop: "1px solid var(--border-strong)",
        padding: "40px 0",
        textAlign: "center",
      }}
    >
      <p
        style={{
          color: "var(--foreground)",
          fontFamily: "var(--font-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          margin: "0 0 6px",
        }}
      >
        {hasFilters ? "Nothing matches these filters" : "Nothing has happened yet"}
      </p>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontFamily: "var(--font-sans)",
          fontSize: 16,
          margin: 0,
        }}
      >
        {hasFilters
          ? "Change a filter or clear them."
          : "App activity appears here after an app reads your data."}
      </p>
    </div>
  );
}

interface PeekPanelProps {
  envelope: TimelineEnvelope;
  listParams: Params;
  traceId: string;
}

function TracesPeekPanel({ traceId, envelope, listParams }: PeekPanelProps) {
  const [firstEvent] = envelope.events;
  const closeHref = listHref(listParams, { peek: undefined });
  const detailHref = `/audit/${encodeURIComponent(traceId)}`;
  const { actor, kind } = traceEntryTitle(firstEvent ?? null);
  const what = kind === "Data read" ? traceEntryReadFacts(envelope.events, !envelope.truncated) ?? "Data read" : kind;

  return (
    <Sheet>
      <SheetHead>
        <div style={{ alignItems: "flex-start", display: "flex", gap: 8, justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <SheetTitle as="h2">Activity</SheetTitle>
          </div>
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={closeHref} scroll={false}>
            ✕
          </Link>
        </div>
      </SheetHead>
      <SheetBody>
        <dl className="grid gap-3 text-sm">
          {actor ? <FactRow label="Who" value={actor} /> : null}
          <FactRow label="What" value={what} />
          <FactRow label="When" value={firstEvent ? relativeTime(firstEvent.occurred_at) : "Time not available"} />
        </dl>
        <div className="mt-4">
          <Link className={buttonVariants({ size: "sm" })} href={detailHref}>
            Full entry →
          </Link>
        </div>
      </SheetBody>
    </Sheet>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Caption as="dt" className="text-muted-foreground">{label}</Caption>
      <Body as="dd" className="text-foreground">{value}</Body>
    </div>
  );
}
