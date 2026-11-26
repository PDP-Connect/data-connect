// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DeploymentDiagnosticsView,
  isDeploymentIndexing,
} from "@pdpp/operator-ui/components/views/deployment-diagnostics-view"
import { retainedBytesFromDatasetSummary } from "@pdpp/operator-ui/lib/storage-footprint"
import Link from "next/link"
import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { loadConnectorSummaryPage } from "../../components/connector-summary-page.tsx"
import { extractReadinessInputs } from "../../components/deployment-readiness-rows.ts"
import { LivePoller } from "../../components/live-poller.tsx"
import { ServerUnreachable } from "../../components/server-unreachable.tsx"
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts"
import {
  type DatasetSummaryProjectionMetadata,
  type DeploymentDiagnostics,
  getDatasetSize,
  getDatasetSummary,
  getDatasetTop,
  getDeploymentDiagnostics,
  listConnectorSummaries,
  type RefConnectorSummary,
  type RefRetainedSizeRow,
  type RefRetainedSizeTopRow,
} from "../../lib/ref-client.ts"
import { rebuildDatasetSummaryAction } from "../actions.ts"
import { WebPushSettings } from "../../components/web-push-settings.tsx"
import {
  getWebPushConfig,
  listWebPushSubscriptions,
} from "../../lib/ref-client.ts"
import { ServerChecks } from "../server-checks.tsx"

export const dynamic = "force-dynamic"

interface DeploymentPageParams {
  error?: string
  notice?: string
}

// Operator-facing diagnostics for the reference deployment. Not a PDPP
// protocol surface — this page consumes /_ref/deployment and renders the
// report the RS already redacted. The goal is "why isn't retrieval working"
// answered in one glance, without the operator reading logs or SSHing in.
//
// Spec: openspec/changes/make-semantic-retrieval-operational/
//       specs/reference-implementation-architecture/spec.md
export default async function DeploymentPage({
  searchParams,
}: {
  searchParams: Promise<DeploymentPageParams>
}) {
  const params = await searchParams
  let report: DeploymentDiagnostics | null = null
  let unreachable = false
  try {
    report = await getDeploymentDiagnostics()
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true
    } else {
      throw err
    }
  }

  // The logical retained payload is rendered beside the physical footprint as
  // a labeled comparison. It is a best-effort fetch — a failed summary read
  // hides the comparison line rather than failing the deployment page, which
  // is primarily a retrieval-diagnostics surface.
  //
  // `retainedBytesFromDatasetSummary` gates on the global projection's
  // convergence state — the same fabrication class the per-connection read
  // model already guards against (`connector-summary-read-model.ts`,
  // `retained_bytes_state`): an unconverged projection must render as
  // unknown, never as "0 B".
  //
  // `projection` (the full metadata, not just the derived byte count) is
  // threaded through separately so the storage section can say WHY the
  // number is missing and offer a recovery action, rather than a bare "—".
  let retainedBytes: number | null
  let projection: DatasetSummaryProjectionMetadata | null
  try {
    const summary = await getDatasetSummary()
    retainedBytes = retainedBytesFromDatasetSummary(summary)
    projection = summary.projection ?? null
  } catch {
    retainedBytes = null
    projection = null
  }

  // Per-source retained payload. The `database` block answers "how big is the
  // database" and "which tables" but never "which source"; the connector
  // summaries already carry `total_retained_bytes`, `total_records` +
  // `total_records_state`, and the `retained_bytes` breakdown, so this needs
  // no new endpoint or query.
  //
  // ONE bounded page, via the shared primitive — never the unscoped fan-out
  // (`ref-client-pagination.test.ts` route invariant). A failed read leaves the
  // table off rather than failing the page, matching the best-effort summary
  // fetch above.
  //
  // `has_more` is threaded through, NOT discarded: one page may not hold every
  // configured source, and a truncated list rendered as if it were the whole
  // fleet is the same class of defect as fabricating a `0` — it implies a
  // completeness the read does not have. The view states the bound instead.
  const sourcePage = await loadConnectorSummaryPage(
    { cursor: undefined },
    opts => listConnectorSummaries(opts)
  )
  const sources: readonly RefConnectorSummary[] =
    sourcePage.kind === "ok" ? sourcePage.items : []
  const sourcesTruncated = sourcePage.kind === "ok" && sourcePage.hasMore

  // Stream-grain and record/blob top-N retained bytes. Both are already
  // computed by the retained-size projection and already exposed over HTTP
  // (`GET /_ref/dataset/size?grain=stream`, `GET /_ref/dataset/top`) — this
  // is the first console page to read them. `top` responses are already
  // bounded server-side (`MAX_TOP_LIMIT = 25`); rendered as-is, no further
  // pagination or fan-out. Best-effort, in parallel, same posture as the
  // summary/source fetches above: a failed read hides its section rather
  // than failing the page.
  const [streamSizesResult, topRecordsResult, topBlobsResult] =
    await Promise.allSettled([
      getDatasetSize("stream"),
      getDatasetTop("record", "total_retained_bytes"),
      getDatasetTop("blob", "blob_bytes"),
    ])
  const streamSizes: readonly RefRetainedSizeRow[] =
    streamSizesResult.status === "fulfilled" ? streamSizesResult.value.rows : []
  const topRecords: readonly RefRetainedSizeTopRow[] =
    topRecordsResult.status === "fulfilled" ? topRecordsResult.value.rows : []
  const topBlobs: readonly RefRetainedSizeTopRow[] =
    topBlobsResult.status === "fulfilled" ? topBlobsResult.value.rows : []

  if (unreachable || !report) {
    return (
      <RecordroomShellWithPalette>
        <ServerUnreachable />
      </RecordroomShellWithPalette>
    )
  }

  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={isDeploymentIndexing(report)} />
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title="Technical details" />
        <NotificationDiagnostics />
        <ServerChecks technical inputs={extractReadinessInputs(report)} />
        <nav
          aria-label="Server settings"
          className="grid border-y border-border/70 sm:grid-cols-2"
        >
          <Link
            className="flex min-h-11 items-center border-b border-border/70 py-3 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:border-b-0 sm:border-r sm:pr-4"
            href="/deployment/provider-apps"
          >
            Sign-in apps for data sources
          </Link>
          <Link
            className="flex min-h-11 items-center py-3 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pl-4"
            href="/deployment/tokens"
          >
            Tokens for scripts and tools
          </Link>
        </nav>
        {/* "Recompute now" lives in here and redirects back with ?notice= or
            ?error=; open the fold then, or its result is hidden. */}
        <details
          className="border-t border-border/70 pt-3"
          open={
            Boolean(params.error) || params.notice === "dataset_summary_rebuilt"
          }
        >
          <summary className="min-h-11 cursor-pointer text-[13px] font-medium text-muted-foreground">
            Details
          </summary>
          <DeploymentDiagnosticsView
            breadcrumbs={[{ href: "/", label: "Home" }, { label: "Server" }]}
            description="Full server checks and storage details."
            projection={projection}
            projectionActionError={params.error ?? null}
            projectionActionNotice={
              params.notice === "dataset_summary_rebuilt"
                ? "Dataset summary rebuilt."
                : null
            }
            rebuildDatasetSummaryAction={rebuildDatasetSummaryAction}
            report={report}
            retainedBytes={retainedBytes}
            sources={sources}
            sourcesTruncated={sourcesTruncated}
            streamSizes={streamSizes}
            title="Details"
            topBlobs={topBlobs}
            topRecords={topRecords}
          />
        </details>
      </main>
    </RecordroomShellWithPalette>
  )
}

async function NotificationDiagnostics() {
  let state;
  try {
    state = await Promise.all([getWebPushConfig(), listWebPushSubscriptions()]);
  } catch {
    return <p>Notification diagnostics could not be loaded.</p>;
  }
  return <WebPushSettings config={state[0]} subscriptions={state[1].data} />;
}
