// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { exploreHrefFromEnvelope } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { TimelineView } from "@pdpp/operator-ui/components/timeline-view";
import { formatRelative, humanizeFieldLabel } from "@pdpp/display";
import { buttonVariants } from "@pdpp/operator-ui/ui/button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  getRunStatus,
  getRunTimeline,
  listRunRecordRejectionReceipts,
  getStaticSecretSetup,
  type RunStatusEnvelope,
  type SpineEvent,
  type TimelineEnvelope,
} from "../../lib/ref-client.ts";
import { listConnectorManifests } from "../../lib/rs-client.ts";
import { findManifestForConnectorId } from "../../sources/lib/relationships.ts";
import {
  type CurrentRunAssistance,
  getCurrentRunAssistance,
  hasAvailableBrowserSurfaceAttachment,
  requiresBrowserSurfaceAssistance,
} from "../../lib/run-assistance.ts";
import {
  classifyKnownGaps,
  extractTerminalKnownGaps,
  formatGapReason,
  formatRecoveryHint,
  type KnownGap,
  type KnownGapSummary,
  recoveryHintLabel,
  type SkippedStreamSummary,
  summarizeSkippedStreams,
} from "../../lib/run-gaps.ts";
import { loadRunRejectionView } from "../../lib/run-rejections.ts";
import { getCollectedKinds, getCollectionTerminalEvent } from "./collected-kinds.ts";
import { CancelRunControl } from "./cancel-run-control.tsx";
import { SignInDetailsSurface } from "./stream/sign-in-parts.tsx";
import { RunInteractionForm } from "./interaction-form.tsx";
import { RejectedRecordsSection } from "./rejected-records-section.tsx";
import { projectCredentialInteraction } from "./credential-interaction.ts";
import {
  describeAssistanceOwnerAction,
  describeAssistanceProgressPosture,
  describeAssistanceResponseContract,
  describeCheckpointStatLabel,
  describeInteractionStatLabel,
  describeProgressStatLabel,
  resolveRunConnectionId,
} from "./run-detail-labels.ts";
import { RunDetailPoller } from "./run-detail-poller.tsx";
import {
  isRunActive,
  isRunHandleActive,
  mapRunHandleStatusToDisplay,
  resolveDisplayTerminalStatus,
  type TerminalRunStatus,
} from "./run-terminal-status.ts";

import { flowPreview, flowPreviewState, previewBrowserMessage } from "../../connect/flow-preview.ts";

export const dynamic = "force-dynamic";

interface LatestProgress {
  count: number | null;
  message: string;
  percentLabel: string | null;
  stream: string | null;
  total: number | null;
}

type TimelineSearchParams = Promise<{ cursor?: string | string[]; _preview?: string; _state?: string; return_to?: string }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function runTimelineHref(runId: string, cursor: string): string {
  return `/syncs/${encodeURIComponent(runId)}/technical?${new URLSearchParams({ cursor }).toString()}`;
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);
  const query = await searchParams;
  const preview = flowPreviewState("details", query);
  if (preview) return <SignInDetailsSurface connector={flowPreview.connector} fields={flowPreview.fields.map(field => ({ ...field, autocomplete: null }))} interactionId="sample-step" message={previewBrowserMessage("needs-details")} preview previewError={preview === "rejected" ? flowPreview.detailsRejected : undefined} runId={runId} />;
  const cursor = getCursor(query);

  let envelope: TimelineEnvelope | null;
  let runStatus: RunStatusEnvelope | null;
  try {
    [envelope, runStatus] = await Promise.all([getRunTimeline(runId, { cursor }), getRunStatus(runId)]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <section className="rounded-lg border border-destructive/30 p-6">
            <h1 className="pdpp-heading text-foreground">Can't reach DataConnect right now.</h1>
            <p className="mt-3 text-muted-foreground text-sm leading-6">
              Check server settings if it still does not work.
            </p>
            <div className="mt-5 flex flex-wrap gap-4 text-sm">
              <Link className={buttonVariants({ className: "min-h-11", size: "sm", variant: "outline" })} href={`/syncs/${encodeURIComponent(runId)}`}>
                Try again
              </Link>
              <Link className="text-primary underline-offset-2 hover:underline" href="/deployment">
                Server settings
              </Link>
            </div>
          </section>
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const { events } = envelope;
  const connectionId = resolveRunConnectionId(runStatus, events);
  const sourceHref = connectionId ? `/sources/${encodeURIComponent(connectionId)}` : null;
  const connectorId = events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;
  const connectorManifests = await listConnectorManifests().catch(() => []);
  const connectorManifest = connectorId ? findManifestForConnectorId(connectorManifests, connectorId) : null;
  const connectorName = connectorManifest?.display_name ?? "Data source";

  const checkpoints = summarizeCheckpoints(events);
  const progress = summarizeProgress(events);
  const interactions = summarizeInteractions(events);
  // Authoritative liveness comes from the window-independent envelope
  // `terminal_status`, NOT from scanning a single page of events. The
  // terminal event is emitted last, so for a run longer than the page the
  // page-only scan never sees it and would treat the run as active forever
  // (wrong badge, never-disabled poller, wrongly-rendered Cancel control).
  const envelopeTerminal = envelope.terminal_status ?? null;
  const active = runStatus ? isRunHandleActive(runStatus.status) : isRunActive(envelopeTerminal);
  // In-page scan retained ONLY for the detail nuances it can read off the
  // event object (failed-vs-cancelled reason, succeeded-with-gaps). It is
  // never the source of the active/terminal decision and may be null when
  // the terminal event is not on this page.
  const inPageTerminalStatus = getTerminalRunStatus(events);
  const currentAssistance = active ? getCurrentRunAssistance(events) : null;
  const credentialSetup =
    currentAssistance?.kind === "credentials" && connectorId
      ? await getStaticSecretSetup(connectorId).catch(() => null)
      : null;
  const latestProgress = getLatestProgress(events);
  // One timeline page holds only part of a long run, so the rejected total
  // comes from the run status first, like liveness above, and `active` is that
  // same liveness. The page's events state a count only where they can prove
  // it. Receipts are read when the count is positive or unknown; a failed read
  // or a run with no known connection renders as an unavailable list.
  const { receipts: rejectionReceipts, summary: rejections } = await loadRunRejectionView({
    connectionId,
    events,
    inputs: {
      active,
      statusTotal: runStatus?.records_permanently_rejected ?? null,
      timelineComplete: cursor === null && !envelope.truncated,
    },
    readReceipts: listRunRecordRejectionReceipts,
    runId,
  });
  const failure = events.find((e) => e.event_type === "run.failed");
  const terminalKnownGaps = extractTerminalKnownGaps(events);
  const gapClassification = classifyKnownGaps(terminalKnownGaps.gaps);
  // The displayed terminal class is anchored to the envelope. Where the
  // terminal event IS on this page, prefer the in-page scan's more-specific
  // reading (it distinguishes owner-cancelled crashes via the failure
  // reason and succeeded-with-gaps); otherwise fall back to the envelope's
  // raw class mapped to the page's display type.
  const displayTerminalStatus =
    resolveDisplayTerminalStatus({
      coverageGapCount: gapClassification.coverageGaps.length,
      envelopeTerminal,
      inPageTerminalStatus,
    }) ?? mapRunHandleStatusToDisplay(runStatus?.status ?? null);
  const failureRows = summarizeFailure(failure, runStatus);

  const detailsContent = (
    <>
      {active ? <CancelRunControl runId={runId} /> : null}
      {currentAssistance ? <AssistanceDetails active={active} assistance={currentAssistance} /> : null}
      <LatestProgressSection active={active} latestProgress={latestProgress} terminalStatus={displayTerminalStatus} />
      <StatsGrid
        checkpoints={checkpoints}
        failure={failure}
        failureRows={failureRows}
        interactions={interactions}
        progress={progress}
      />
      <KnownGapsSection
        coverageGaps={gapClassification.coverageGaps}
        informationalGaps={gapClassification.informationalGaps}
        protocolViolationCount={gapClassification.protocolViolationGaps.length}
        skipped={summarizeSkippedStreams(events)}
        summary={terminalKnownGaps.summary ?? gapClassification.summary}
      />
      <RejectedRecordsSection receipts={rejectionReceipts} summary={rejections} />
      <ViolationDiagnosis failure={failure} />
      <ConnectorStderrTailSection failure={failure} />
      <ConnectorDiagnosticLinesSection
        event={events.find((e) => e.event_type === "run.connector_diagnostics_recorded")}
      />
    </>
  );
  const startedAt = runStatus?.started_at ?? events.find((event) => event.event_type === "run.started")?.occurred_at ?? null;
  const stateSentence = describeRunState(active, currentAssistance, displayTerminalStatus);
  const cliCommand = `pdpp ref run timeline ${runId}`;
  const noInstallCommand = `npx -y @pdpp/cli ${cliCommand.slice("pdpp ".length)}`;
  const exploreHref = exploreHrefFromEnvelope(dashboardRoutes, envelope);
  const pivotLinks = getRunPivotLinks(events);

  return (
    <RecordroomShellWithPalette>
      <RunDetailPoller enabled={active} />
      <PageHeader
        breadcrumbs={[
          { href: dashboardRoutes.section.runs, label: "Sync history" },
          ...(sourceHref ? [{ href: sourceHref, label: connectorName }] : []),
          { href: `/syncs/${encodeURIComponent(runId)}`, label: `${connectorName} sync` },
          { label: "Technical details" },
        ]}
        description={
          <>
            {stateSentence} Started {startedAt ? formatRelative(new Date(startedAt), Date.now()) : "at an unknown time"}.
          </>
        }
        title={
          <span className="inline-flex items-center gap-2">
            {connectorId ? (
              <ConnectorMark connectorId={connectorId} icon={connectorManifest?.icon} name={connectorName} />
            ) : null}
            <span>Technical details for this sync</span>
          </span>
        }
      />
      <CurrentAssistanceSection
        serviceName={connectorName}
        returnHref={query.return_to === "status" && runStatus?.connector_instance_id ? `/connect/status/${encodeURIComponent(runStatus.connector_instance_id)}?run_id=${encodeURIComponent(runId)}` : `/syncs/${encodeURIComponent(runId)}/stream`}
        active={active}
        credentialSetup={credentialSetup}
        currentAssistance={currentAssistance}
        runId={runId}
      />
      <CollectedKindsSection events={events} />
      <details className="mb-8 pt-4" data-testid="sync-details">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">Details</summary>
        <div className="pt-5">
          {detailsContent}
          <Section title="Related pages">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {pivotLinks.map(({ href, id, label }) => (
                <Link className="text-primary underline-offset-2 hover:underline" href={href} key={`${label}:${id}`}>
                  {label} {id} →
                </Link>
              ))}
              {exploreHref ? (
                <Link className="text-primary underline-offset-2 hover:underline" href={exploreHref}>
                  View records in Explore →
                </Link>
              ) : null}
            </div>
          </Section>
          <Section title="Timeline">
            <dl className="pdpp-caption mb-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">events in this page</dt>
              <dd className="tabular-nums">{events.length}</dd>
            </dl>
            <TimelineView
              events={events}
              loadMoreHref={envelope.truncated && envelope.next_cursor ? runTimelineHref(runId, envelope.next_cursor) : null}
            />
          </Section>
          <Section title="Reference CLI">
            <pre className="pdpp-caption overflow-x-auto rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
              {cliCommand}
            </pre>
            <pre className="pdpp-caption mt-2 overflow-x-auto rounded-md border border-border/80 bg-muted/20 p-3 font-mono">
              {noInstallCommand}
            </pre>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              The top form requires{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://www.npmjs.com/package/@pdpp/cli"
                rel="noreferrer"
                target="_blank"
              >
                @pdpp/cli
              </a>{" "}
              on PATH (or pnpm exec in this monorepo). The bottom form runs without an install via npx. Set
              PDPP_OWNER_SESSION_COOKIE when owner sign-in is enabled.
            </p>
          </Section>
        </div>
      </details>
    </RecordroomShellWithPalette>
  );
}

function CurrentAssistanceSection({
  serviceName,
  returnHref,
  active,
  credentialSetup,
  currentAssistance,
  runId,
}: {
  serviceName: string;
  returnHref: string;
  active: boolean;
  credentialSetup: Awaited<ReturnType<typeof getStaticSecretSetup>> | null;
  currentAssistance: CurrentRunAssistance | null;
  runId: string;
}) {
  if (
    !currentAssistance ||
    !active ||
    currentAssistance.responseContract !== "response_required" ||
    currentAssistance.ownerAction === "act_elsewhere" ||
    currentAssistance.ownerAction === "none"
  ) {
    return null;
  }
  // A credentials request with no fields keeps the server's own message; the
  // projected "Enter the requested details" would ask for fields that are not drawn.
  const credentialView =
    currentAssistance.kind === "credentials" && currentAssistance.fields.length > 0
      ? projectCredentialInteraction(currentAssistance.fields, credentialSetup)
      : null;
  const supportsStreaming =
    active &&
    requiresBrowserSurfaceAssistance(currentAssistance) &&
    hasAvailableBrowserSurfaceAttachment(currentAssistance);
  const supportsSubmit =
    active &&
    currentAssistance.progressPosture === "blocked" &&
    currentAssistance.responseContract === "response_required" &&
    (currentAssistance.ownerAction === "provide_value" ||
      (currentAssistance.ownerAction === "operate_attachment" &&
        (!requiresBrowserSurfaceAssistance(currentAssistance) || supportsStreaming)));
  const interactionKind = interactionFormKind(currentAssistance);

  return (
    <Callout
      className="mb-6 border border-[color:var(--warning)] bg-[color:var(--warning-wash)] shadow-[inset_3px_0_0_0_var(--warning)]"
      description={
        supportsStreaming || requiresBrowserSurfaceAssistance(currentAssistance)
          ? credentialView?.message ?? currentAssistance.message
          : "Your response is needed to continue."
      }
      surface="human"
      title={currentAssistance.kind === "credentials" ? `${serviceName} needs your sign-in details` : "Waiting for your input"}
    >
      {requiresBrowserSurfaceAssistance(currentAssistance) ? (
        <Link
          className={buttonVariants({ className: "min-h-11", size: "sm", variant: "outline" })}
          href={`/syncs/${encodeURIComponent(runId)}/stream`}
        >
          Open the browser
        </Link>
      ) : null}
      {!requiresBrowserSurfaceAssistance(currentAssistance) && supportsSubmit ? (
        <RunInteractionForm
          serviceName={undefined}
          returnHref={returnHref}
          fields={credentialView?.fields ?? currentAssistance.fields}
          interactionId={currentAssistance.id}
          key={currentAssistance.id}
          kind={interactionKind}
          message={currentAssistance.message}
          runId={runId}
          submitLabel={credentialView?.submitLabel}
        />
      ) : null}
    </Callout>
  );
}

function interactionFormKind(assistance: CurrentRunAssistance): string {
  if (assistance.kind === "otp" || assistance.fields.length > 0) {
    return assistance.kind;
  }
  return "manual_action";
}

function CollectedKindsSection({ events }: { events: SpineEvent[] }) {
  const terminalEvent = getCollectionTerminalEvent(events);
  const collectedKinds = getCollectedKinds(terminalEvent);
  if (!terminalEvent || collectedKinds === null) {
    return null;
  }
  const visibleKinds = collectedKinds.filter(({ count }) => count > 0);
  const stopped = terminalEvent.event_type !== "run.completed" || terminalEvent.status === "cancelled";

  return (
    <Section title={stopped ? "Collected before it stopped" : "What it collected"}>
      {visibleKinds.length === 0 ? (
        <p>Nothing was collected.</p>
      ) : (
        <dl className="divide-y divide-border">
          {visibleKinds.map(({ count, kind }) => (
            <div className="flex items-center justify-between gap-4 py-2" key={kind}>
              <dt>{humanizeFieldLabel(kind)}</dt>
              <dd className="tabular-nums">
                {count.toLocaleString()} {count === 1 ? "record" : "records"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

function AssistanceDetails({ active, assistance }: { active: boolean; assistance: CurrentRunAssistance }) {
  return (
    <Section title="Request details">
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">message</dt>
        <dd>{assistance.message}</dd>
        <dt className="text-muted-foreground">state</dt>
        <dd>
          {active ? describeAssistanceProgressPosture(assistance.progressPosture) : "ended"} ·{" "}
          {describeAssistanceOwnerAction(assistance.ownerAction)} · {describeAssistanceResponseContract(assistance.responseContract)}
        </dd>
        <dt className="text-muted-foreground">kind</dt>
        <dd>{assistance.kind}</dd>
        {assistance.attachments.length > 0 ? (
          <>
            <dt className="text-muted-foreground">attachments</dt>
            <dd>{formatAssistanceAttachments(assistance)}</dd>
          </>
        ) : null}
        {assistance.timeoutLabel ? (
          <>
            <dt className="text-muted-foreground">timeout</dt>
            <dd>{assistance.timeoutLabel}</dd>
          </>
        ) : null}
      </dl>
    </Section>
  );
}

function describeRunState(
  active: boolean,
  assistance: CurrentRunAssistance | null,
  status: TerminalRunStatus,
): string {
  if (!active) {
    if (status === "cancelled") return "This sync was cancelled.";
    if (status === "failed") return "This sync did not finish.";
    if (status === "deferred") return "This sync could not start.";
    return "This sync finished.";
  }
  if (assistance?.ownerAction === "act_elsewhere") {
    return "Waiting for you to approve the request.";
  }
  if (assistance?.progressPosture === "blocked") {
    return requiresBrowserSurfaceAssistance(assistance) ? "Waiting for you to use the browser." : "Waiting for your response.";
  }
  if (assistance?.progressPosture === "waiting_retry") {
    return "Trying again on its own.";
  }
  return "Syncing now.";
}

function getRunPivotLinks(events: SpineEvent[]): { href: string; id: string; label: string }[] {
  const pivots = new Map<string, { href: string; id: string; label: string }>();
  for (const event of events) {
    for (const [key, label, route] of [
      ["trace_id", "Trace", dashboardRoutes.trace],
      ["grant_id", "Access", dashboardRoutes.grant],
    ] as const) {
      const id = event[key];
      if (id && !pivots.has(`${label}:${id}`)) {
        pivots.set(`${label}:${id}`, { href: route(id), id, label });
      }
    }
  }
  return [...pivots.values()];
}

function formatAssistanceAttachments(assistance: CurrentRunAssistance): string {
  return assistance.attachments
    .map((attachment) => {
      if (attachment.kind !== "browser_surface") {
        return attachment.kind;
      }
      if (hasAvailableBrowserSurfaceAttachment(assistance)) {
        return "Secure browser ready";
      }
      return "Waiting for the secure browser";
    })
    .join(", ");
}

function LatestProgressSection({
  active,
  latestProgress,
  terminalStatus,
}: {
  active: boolean;
  latestProgress: LatestProgress | null;
  terminalStatus: TerminalRunStatus;
}) {
  if (!latestProgress) {
    return null;
  }

  return (
    <Callout
      action={<StatusBadge inline status={active ? "started" : (terminalStatus ?? "started")} />}
      className="mb-6"
      description="Most connectors only report phases; percent appears only when a connector emits both count and total."
      surface="protocol"
      title="Latest progress"
    >
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">message</dt>
        <dd>{latestProgress.message}</dd>
        {latestProgress.stream ? (
          <>
            <dt className="text-muted-foreground">stream</dt>
            <dd>{latestProgress.stream}</dd>
          </>
        ) : null}
        {latestProgress.count === null ? null : (
          <>
            <dt className="text-muted-foreground">count</dt>
            <dd>{String(latestProgress.count)}</dd>
          </>
        )}
        {latestProgress.total === null ? null : (
          <>
            <dt className="text-muted-foreground">total</dt>
            <dd>{String(latestProgress.total)}</dd>
          </>
        )}
        {latestProgress.percentLabel ? (
          <>
            <dt className="text-muted-foreground">completion</dt>
            <dd>{latestProgress.percentLabel}</dd>
          </>
        ) : null}
      </dl>
    </Callout>
  );
}

function StatsGrid({
  checkpoints,
  failure,
  failureRows,
  interactions,
  progress,
}: {
  checkpoints: [string, string][];
  failure: SpineEvent | undefined;
  failureRows: [string, string][];
  interactions: [string, string][];
  progress: [string, string][];
}) {
  return (
    <div className="mb-8 divide-y divide-border border-y border-border">
      <Stat rows={checkpoints} title="Checkpoints in this page" />
      <Stat rows={progress} title="Progress in this page" />
      <Stat rows={interactions} title="Interactions in this page" />
      <Stat emphasis={Boolean(failure)} rows={failureRows} title="Failure" />
    </div>
  );
}

function KnownGapsSection({
  coverageGaps,
  informationalGaps,
  protocolViolationCount,
  skipped,
  summary,
}: {
  coverageGaps: KnownGap[];
  informationalGaps: KnownGap[];
  protocolViolationCount: number;
  skipped: SkippedStreamSummary;
  summary: KnownGapSummary | null;
}) {
  if (
    coverageGaps.length === 0 &&
    informationalGaps.length === 0 &&
    protocolViolationCount === 0 &&
    skipped.count === 0
  ) {
    return null;
  }

  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 bg-[color:var(--warning-wash)]/45 px-4 py-3 shadow-[inset_3px_0_0_0_var(--warning)]">
      <header className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h3 className="pdpp-eyebrow">Known source gaps</h3>
          {/* Explain partial coverage only when there IS partial coverage.
              Rendering the explanation unconditionally put it directly above
              "No partial source-coverage gaps were reported", so the section
              defined a problem and denied it in the same breath. */}
          {coverageGaps.length > 0 ? (
            <p className="pdpp-caption text-muted-foreground">
              This run collected some of what was asked for. The records it did flush are still usable.
            </p>
          ) : null}
        </div>
        {summary?.count ? (
          <span className="pdpp-caption text-muted-foreground">
            {summary.count} gap{summary.count === 1 ? "" : "s"}
            {summary.truncated ? " · truncated" : ""}
          </span>
        ) : null}
      </header>

      {coverageGaps.length > 0 ? (
        <ul className="space-y-2">
          {coverageGaps.map((gap) => (
            <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={knownGapKey(gap)}>
              <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-foreground">{formatGapReason(gap.kind)}</span>
                <span className="text-muted-foreground">reason</span>
                <code>{formatGapReason(gap.reason)}</code>
                {gap.stream ? (
                  <>
                    <span className="text-muted-foreground">stream</span>
                    <code>{gap.stream}</code>
                  </>
                ) : null}
              </div>
              <GapRecoveryLine gap={gap} />
              <GapDiagnosticsPanel diagnostics={gap.diagnostics} />
            </li>
          ))}
        </ul>
      ) : (
        <NoMissingSourcesClaim skipped={skipped} />
      )}

      {informationalGaps.length > 0 ? (
        <div className="mt-3">
          <p className="pdpp-caption mb-2 text-muted-foreground">
            Informational limitations reported by the connector:
          </p>
          <ul className="space-y-2">
            {informationalGaps.map((gap) => (
              <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={knownGapKey(gap)}>
                <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium text-foreground">{formatGapReason(gap.kind)}</span>
                  <span className="text-muted-foreground">reason</span>
                  <code>{formatGapReason(gap.reason)}</code>
                  {gap.stream ? (
                    <>
                      <span className="text-muted-foreground">stream</span>
                      <code>{gap.stream}</code>
                    </>
                  ) : null}
                </div>
                <div className="pdpp-caption mt-1 text-muted-foreground">
                  {gap.message ? gap.message : "This limitation does not mean selected data was lost."}
                </div>
                <GapDiagnosticsPanel diagnostics={gap.diagnostics} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {protocolViolationCount > 0 ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          {protocolViolationCount} protocol-violation gap
          {protocolViolationCount === 1 ? "" : "s"} omitted here; see Failure diagnosis.
        </p>
      ) : null}
      {/* Skips with no gap record are the ONLY thing this section has to say
          when coverageGaps is empty — so say it plainly instead of footnoting
          it under a denial. Report the reason the connector recorded; claim
          nothing was recorded only for the skips that genuinely carry none. */}
      {skipped.count > 0 && coverageGaps.length === 0 ? <SkippedWithoutGapRecord skipped={skipped} /> : null}
    </section>
  );
}

/**
 * Only claim "nothing missing" when nothing else in this section contradicts
 * it. With skips that produced no gap record the honest answer is "unknown",
 * which the skip line below states instead.
 */
function NoMissingSourcesClaim({ skipped }: { skipped: SkippedStreamSummary }) {
  if (skipped.count === 0) {
    return (
      <p className="pdpp-caption text-muted-foreground">
        This run reported no missing sources. Anything below is a separate protocol failure.
      </p>
    );
  }
  return null;
}

/**
 * Skips that produced no entry in the terminal `known_gaps` list. Previously
 * this rendered "{n} streams were skipped without saying why", which was wrong
 * twice: the connector records its reason on each skip event, and the count is
 * of skipped items, not streams. Say the reason, and count in the right unit.
 */
function SkippedWithoutGapRecord({ skipped }: { skipped: SkippedStreamSummary }) {
  const items = `${skipped.count} record${skipped.count === 1 ? "" : "s"}`;
  const where =
    skipped.streams.length > 0
      ? ` in ${skipped.streams.length === 1 ? "stream" : `${skipped.streams.length} streams`} ${skipped.streams.map((stream) => `\`${stream}\``).join(", ")}`
      : "";
  return (
    <div className="mt-3">
      <p className="pdpp-caption text-muted-foreground">
        {items}
        {where} {skipped.count === 1 ? "was" : "were"} skipped without a terminal gap entry.
      </p>
      {skipped.reasons.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {skipped.reasons.map((entry) => (
            <li className="pdpp-caption text-muted-foreground" key={entry.reason}>
              <code>{formatGapReason(entry.reason)}</code> · {entry.count} record{entry.count === 1 ? "" : "s"}
              {entry.diagnostics ? (
                <>
                  {" · first failing field "}
                  <code>{entry.diagnostics.path}</code>
                  {`: ${entry.diagnostics.message}`}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.unexplainedCount > 0 ? (
        <p className="pdpp-caption mt-1.5 text-muted-foreground">
          {skipped.unexplainedCount} of these recorded no reason, so DataConnect cannot tell you whether anything is missing for{" "}
          {skipped.unexplainedCount === 1 ? "it" : "them"}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Bounded connector-authored diagnostics from SKIP_RESULT.diagnostics.
 * Rendered collapsed by default — owner-only evidence, labeled as connector-authored,
 * never as the authoritative runtime failure classification.
 * See openspec/changes/propagate-skip-result-diagnostics.
 */
function GapDiagnosticsPanel({ diagnostics }: { diagnostics?: Record<string, unknown> | null }) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    return null;
  }
  const isSentinel = diagnostics.truncated === true && typeof diagnostics.reason === "string";
  return (
    <details className="mt-2">
      <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">
        connector diagnostics
        {isSentinel ? (
          <span className="ml-2 text-muted-foreground/70">(truncated · {String(diagnostics.reason)})</span>
        ) : null}
      </summary>
      <p className="pdpp-caption mt-1.5 text-muted-foreground/80">
        Connector-authored evidence. Bounded and redacted by the runtime, not a verified PDPP error classification.
      </p>
      <pre className="pdpp-caption mt-1.5 overflow-x-auto rounded border border-border/70 bg-background p-2 font-mono">
        {JSON.stringify(diagnostics, null, 2)}
      </pre>
    </details>
  );
}

/**
 * A gap's recovery hint and message. A connector's hint reads as its
 * suggestion, not an instruction; see `recoveryHintLabel`.
 */
function GapRecoveryLine({ gap }: { gap: KnownGap }) {
  const label = recoveryHintLabel(gap);
  if (!(label || gap.message)) {
    return null;
  }
  return (
    <div className="pdpp-caption mt-1 text-muted-foreground">
      {label ? (
        <>
          {label}: <span className="text-foreground">{formatRecoveryHint(gap)}</span>
        </>
      ) : null}
      {gap.message ? `${label ? " · " : ""}${gap.message}` : ""}
    </div>
  );
}

function knownGapKey(gap: KnownGap): string {
  return [gap.kind, gap.reason, gap.stream ?? "run", gap.message ?? "", formatRecoveryHint(gap)].join(":");
}

/**
 * Runtime-authored structured diagnosis of a protocol violation.
 * Additive: when run.failed carries a `data.violation`, render a structured
 * panel. When absent, render nothing — the existing opaque Failure stat
 * block already shows the top-level reason unchanged.
 *
 * Vertical slice: today only `progress_for_undeclared_stream` populates
 * the full field set. Other subtypes (see tmp/opaque-violation-diagnosis-memo.md)
 * will render with the common header + last-valid-event block only.
 */
interface ViolationShape {
  expected?: unknown;
  last_valid_event_id?: unknown;
  last_valid_event_type?: unknown;
  message_type?: unknown;
  received?: unknown;
  stream?: unknown;
  subtype: string;
  truncated?: unknown;
}

function extractViolation(failure: SpineEvent | undefined): ViolationShape | null {
  const raw = (failure?.data as { violation?: unknown } | undefined)?.violation;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { subtype } = raw as { subtype?: unknown };
  if (typeof subtype !== "string" || subtype.length === 0) {
    return null;
  }
  return raw as ViolationShape;
}

function violationStringField(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function violationStringListField(v: unknown): string[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const items = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return items.length > 0 ? items : null;
}

function ViolationDiagnosis({ failure }: { failure: SpineEvent | undefined }) {
  const violation = extractViolation(failure);
  if (!violation) {
    return null;
  }
  const messageType = violationStringField(violation.message_type);
  const stream = violationStringField(violation.stream);
  const received = violationStringField(violation.received);
  const expected = violationStringListField(violation.expected);
  const lastValidEventId = violationStringField(violation.last_valid_event_id);
  const lastValidEventType = violationStringField(violation.last_valid_event_type);
  const truncated = violation.truncated === true;

  return (
    <section className="mb-8 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]">
      <header className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="pdpp-eyebrow">Failure diagnosis</h3>
        <span className="pdpp-caption text-muted-foreground">Runtime message</span>
      </header>
      <dl className="pdpp-caption grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">subtype</dt>
        <dd className="break-all font-mono">{violation.subtype}</dd>
        {messageType ? (
          <>
            <dt className="text-muted-foreground">message</dt>
            <dd className="break-all font-mono">{messageType}</dd>
          </>
        ) : null}
        {stream ? (
          <>
            <dt className="text-muted-foreground">stream</dt>
            <dd className="break-all">
              <span className="font-mono">{stream}</span>
              {received && received !== stream ? null : (
                <span className="ml-2 text-muted-foreground">(not in scope)</span>
              )}
            </dd>
          </>
        ) : null}
        {expected ? (
          <>
            <dt className="text-muted-foreground">expected</dt>
            <dd className="break-all font-mono">
              {expected.join(" · ")}
              {truncated ? <span className="ml-2 text-muted-foreground">(truncated)</span> : null}
            </dd>
          </>
        ) : null}
        {lastValidEventId ? (
          <>
            <dt className="text-muted-foreground">after</dt>
            <dd className="break-all">
              {lastValidEventType ? (
                <span className="font-mono">{lastValidEventType}</span>
              ) : (
                <span className="text-muted-foreground">event</span>
              )}
              <a className="ml-2 text-primary underline-offset-2 hover:underline" href={`#${lastValidEventId}`}>
                {lastValidEventId} →
              </a>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * Connector-authored stderr tail diagnostic.
 *
 * Owner-only evidence rendered as a collapsed `<details>` panel by
 * default. The text is connector-authored (not runtime-verified) and
 * therefore must be visibly labelled as such — the runtime-authored
 * `failure_message` already surfaces in the Failure stat.
 *
 * See openspec/changes/persist-connector-failure-diagnostics.
 */
interface StderrTailDiagnostic {
  bytes_captured: number;
  bytes_observed: number;
  encoding?: string;
  object?: string;
  redacted: boolean;
  text: string;
  truncated: boolean;
}

function extractStderrTail(failure: SpineEvent | undefined): StderrTailDiagnostic | null {
  const diagnostics = (failure?.data as { connector_diagnostics?: unknown } | undefined)?.connector_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") {
    return null;
  }
  const raw = (diagnostics as { stderr_tail?: unknown }).stderr_tail;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const text = typeof candidate.text === "string" ? candidate.text : null;
  if (text === null) {
    return null;
  }
  return {
    bytes_captured: typeof candidate.bytes_captured === "number" ? candidate.bytes_captured : text.length,
    bytes_observed: typeof candidate.bytes_observed === "number" ? candidate.bytes_observed : text.length,
    encoding: typeof candidate.encoding === "string" ? candidate.encoding : undefined,
    object: typeof candidate.object === "string" ? candidate.object : undefined,
    redacted: candidate.redacted === true,
    text,
    truncated: candidate.truncated === true,
  };
}

/**
 * Connector diagnostic lines (`[<source>-diagnostic] <event> {...}`) the
 * runtime kept for this run, whatever its outcome. Owner-local and
 * connector-authored, so labelled as untrusted like the stderr tail.
 */
interface ConnectorDiagnosticLinesData {
  lines: string[];
  linesObserved: number;
  redacted: boolean;
  truncated: boolean;
}

function extractDiagnosticLines(event: SpineEvent | undefined): ConnectorDiagnosticLinesData | null {
  const data = event?.data as Record<string, unknown> | undefined;
  if (!(data && Array.isArray(data.lines))) {
    return null;
  }
  const lines = data.lines.filter((line): line is string => typeof line === "string");
  if (lines.length === 0) {
    return null;
  }
  return {
    lines,
    linesObserved: typeof data.lines_observed === "number" ? data.lines_observed : lines.length,
    redacted: data.redacted === true,
    truncated: data.truncated === true,
  };
}

function ConnectorDiagnosticLinesSection({ event }: { event: SpineEvent | undefined }) {
  const diagnostics = extractDiagnosticLines(event);
  if (!diagnostics) {
    return null;
  }
  const notes = [`${diagnostics.lines.length.toLocaleString()} of ${diagnostics.linesObserved.toLocaleString()} lines`];
  if (diagnostics.truncated) {
    notes.push("truncated");
  }
  if (diagnostics.redacted) {
    notes.push("redacted");
  }
  return (
    <section className="mb-8 rounded-md border border-border/70 bg-muted/20 px-4 py-3">
      <details>
        <summary className="cursor-pointer list-none">
          <span className="pdpp-eyebrow mr-3">Connector diagnostics</span>
          <span className="pdpp-caption text-muted-foreground">{notes.join(" · ")} · click to expand</span>
        </summary>
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Technical detail the connector wrote during this run. It is connector-authored and kept on this deployment
          only. Use it to debug the connector, not as a verified PDPP result.
        </p>
        <pre className="pdpp-caption mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-background/70 p-3 font-mono text-foreground/90">
          {diagnostics.lines.join("\n")}
        </pre>
      </details>
    </section>
  );
}

function ConnectorStderrTailSection({ failure }: { failure: SpineEvent | undefined }) {
  const tail = extractStderrTail(failure);
  if (!tail) {
    return null;
  }
  const metaPills: { label: string; value: string }[] = [
    { label: "bytes captured", value: tail.bytes_captured.toLocaleString() },
    { label: "bytes observed", value: tail.bytes_observed.toLocaleString() },
  ];
  if (tail.truncated) {
    metaPills.push({ label: "truncated", value: "yes" });
  }
  if (tail.redacted) {
    metaPills.push({ label: "redacted", value: "yes" });
  }
  // <summary> may contain only phrasing content per the HTML spec, so the
  // descriptive paragraph, meta list, and stderr <pre> live in the
  // details body. The summary keeps an inline title plus compact
  // metadata, and the body re-states the untrusted-evidence label so it
  // is visible whenever the panel is expanded.
  return (
    <section className="mb-8 rounded-md border border-border/70 bg-muted/20 px-4 py-3">
      <details>
        <summary className="cursor-pointer list-none">
          <span className="pdpp-eyebrow mr-3">Connector stderr (diagnostic)</span>
          <span className="pdpp-caption text-muted-foreground">
            {metaPills.map((pill, index) => (
              <span key={pill.label}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <span>{pill.label}: </span>
                <span className="text-foreground tabular-nums">{pill.value}</span>
              </span>
            ))}
            <span aria-hidden="true"> · </span>
            <span>click to expand</span>
          </span>
        </summary>
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Connector-authored output captured before exit. This is untrusted evidence, not a verified PDPP error. Use it
          as a hint for what the connector was doing, not as the authoritative failure reason.
        </p>
        <dl className="pdpp-caption mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {metaPills.map((pill) => (
            <Fragment key={pill.label}>
              <dt className="text-muted-foreground">{pill.label}</dt>
              <dd className="tabular-nums">{pill.value}</dd>
            </Fragment>
          ))}
        </dl>
        <pre className="pdpp-caption mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-background/70 p-3 font-mono text-foreground/90">
          {tail.text}
        </pre>
        {tail.truncated ? (
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Showing the last {tail.bytes_captured.toLocaleString()} bytes of {tail.bytes_observed.toLocaleString()}{" "}
            bytes the connector wrote.
          </p>
        ) : null}
      </details>
    </section>
  );
}

function Stat({ title, rows, emphasis }: { title: string; rows: [string, string][]; emphasis?: boolean }) {
  return (
    <section className={`py-3 ${emphasis ? "border-l-2 border-destructive pl-3" : ""}`}>
      <h3 className="pdpp-eyebrow mb-2 text-muted-foreground">{title}</h3>
      <dl className="pdpp-caption grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-all tabular-nums">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function summarizeCheckpoints(events: SpineEvent[]): [string, string][] {
  const staged = events.filter((e) => e.event_type === "run.state_staged").length;
  const advanced = events.filter((e) => e.event_type === "run.state_advanced").length;
  const commitFailed = events.filter((e) => e.event_type === "run.state_commit_failed").length;
  return [
    [describeCheckpointStatLabel("staged"), String(staged)],
    [describeCheckpointStatLabel("advanced"), String(advanced)],
    [describeCheckpointStatLabel("commit_failed"), String(commitFailed)],
  ];
}

function summarizeProgress(events: SpineEvent[]): [string, string][] {
  const progressEvents = events.filter((e) => e.event_type === "run.progress_reported" && isUserFacingProgressEvent(e));
  const skipped = events.filter((e) => e.event_type === "run.stream_skipped").length;
  const last = progressEvents.at(-1);
  return [
    [describeProgressStatLabel("reports"), String(progressEvents.length)],
    [describeProgressStatLabel("last_message"), String(last?.data?.message ?? "—")],
    [describeProgressStatLabel("last_count"), String(last?.data?.count ?? "—")],
    [describeProgressStatLabel("last_total"), String(last?.data?.total ?? "—")],
    [describeProgressStatLabel("skipped"), String(skipped)],
  ];
}

function summarizeInteractions(events: SpineEvent[]): [string, string][] {
  const required = events.filter((e) => e.event_type === "run.interaction_required").length;
  const completed = events.filter((e) => e.event_type === "run.interaction_completed").length;
  return [
    [describeInteractionStatLabel("required"), String(required)],
    [describeInteractionStatLabel("completed"), String(completed)],
  ];
}

function summarizeFailure(failure: SpineEvent | undefined, runStatus: RunStatusEnvelope | null): [string, string][] {
  if (!failure) {
    if (runStatus?.status === "deferred") {
      return [
        ["status", "browser deferred"],
        ["reason", runStatus.terminal_reason ?? "browser slot unavailable"],
      ];
    }
    if (runStatus?.failure) {
      return [
        ["reason", runStatus.failure.reason ?? runStatus.terminal_reason ?? "—"],
        ["origin", runStatus.failure.origin ?? "—"],
        ...(runStatus.failure.message ? [["message", runStatus.failure.message] as [string, string]] : []),
        ...(runStatus.failure.connector_error_message
          ? [["connector", runStatus.failure.connector_error_message] as [string, string]]
          : []),
      ];
    }
    return [["status", "no failure"]];
  }
  const failureOrigin = typeof failure.data.failure_origin === "string" ? failure.data.failure_origin : null;
  const failureMessage = typeof failure.data.failure_message === "string" ? failure.data.failure_message : null;
  // The connector's own error text always stays visible (Collection Profile
  // 0.2.0, Section 5.11).
  const connectorMessage =
    typeof failure.data.connector_error_message === "string" ? failure.data.connector_error_message : null;
  return [
    ["reason", String(failure.data.reason ?? failure.data.failure_reason ?? "—")],
    ["retryable", String(failure.data.connector_error_retryable ?? "—")],
    ...(failureOrigin ? [["origin", failureOrigin] as [string, string]] : []),
    ...(failureMessage ? [["message", failureMessage] as [string, string]] : []),
    ...(connectorMessage ? [["connector", connectorMessage] as [string, string]] : []),
  ];
}

function getTerminalRunStatus(events: SpineEvent[]): TerminalRunStatus {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (event.event_type === "run.failed") {
      const reason = String(event.data?.reason ?? event.data?.failure_reason ?? "").toLowerCase();
      return reason === "cancelled" ? "cancelled" : "failed";
    }
    if (event.event_type === "run.completed") {
      return event.status === "cancelled" ? "cancelled" : "succeeded";
    }
  }
  return null;
}

function getLatestProgress(events: SpineEvent[]): LatestProgress | null {
  const latest = [...events]
    .reverse()
    .find((event) => event.event_type === "run.progress_reported" && isUserFacingProgressEvent(event));
  if (!latest) {
    return null;
  }

  const count = typeof latest.data?.count === "number" ? latest.data.count : null;
  const total = typeof latest.data?.total === "number" ? latest.data.total : null;
  const percentLabel =
    count !== null && total !== null && total > 0
      ? `${Math.max(0, Math.min(100, Math.round((count / total) * 100)))}%`
      : null;

  return {
    count,
    message: String(latest.data?.message ?? "—"),
    percentLabel,
    stream: typeof latest.stream_id === "string" && latest.stream_id ? latest.stream_id : null,
    total,
  };
}

function isUserFacingProgressEvent(event: SpineEvent): boolean {
  const message = typeof event.data.message === "string" ? event.data.message : "";
  return !(
    message.startsWith("tracing enabled;") ||
    message.startsWith("trace written to ") ||
    message.startsWith("failed to write trace:")
  );
}
