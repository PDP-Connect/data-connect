// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { LivePoller } from "../../../components/live-poller.tsx";
import { existingSourcesForConnector } from "../../../components/existing-sources-by-connector.ts";
import {
  getConnectionSetupStatus,
  getConnectorSchedule,
  getRunTimeline,
  getRunStatus,
  RefNotFoundError,
} from "../../../lib/ref-client.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import { resumeConnectionAction } from "../../../sources/[connector]/actions.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { getCollectedKinds, getCollectionTerminalEvent } from "../../../syncs/[runId]/collected-kinds.ts";
import { extractKnownGapsFromEventData, extractTerminalKnownGaps } from "../../../lib/run-gaps.ts";
import { hasResolvedBrowserSurfaceAssistance } from "../../../lib/run-assistance.ts";
import { FirstSyncBody } from "./first-sync-body.tsx";
import { setupStatusName } from "./setup-status-name.ts";
import { type FirstSyncFacts, firstSyncOutcome } from "./first-sync-outcome.ts";

import { flowPreview, flowPreviewState, previewStatus, previewFacts } from "../../flow-preview.ts";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readFacts(
  status: Awaited<ReturnType<typeof getConnectionSetupStatus>>
): Promise<FirstSyncFacts> {
  const runId = status.run?.run_id;
  // Same read the data source's own page makes. A failed read stays unknown
  // (undefined); the server having no schedule is null, which the list calls "Manual".
  const [timeline, schedule, runStatus] = await Promise.all([
    runId ? getRunTimeline(runId).catch(() => null) : Promise.resolve(null),
    getConnectorSchedule(status.connector_id, { connectorInstanceId: status.connection_id }).catch(() => undefined),
    runId ? getRunStatus(runId).catch(() => null) : Promise.resolve(null),
  ]);
  const kinds = timeline ? getCollectedKinds(getCollectionTerminalEvent(timeline.events)) : null;
  return { kinds, schedule, gaps: runStatus ? extractKnownGapsFromEventData(runStatus).gaps : timeline ? extractTerminalKnownGaps(timeline.events).gaps : [], failureReason: runStatus?.terminal_reason ?? runStatus?.failure?.reason, runStatus: runStatus?.status, signedIn: timeline ? hasResolvedBrowserSurfaceAssistance(timeline.events) : false };
}

export default async function ConnectionSetupStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectionId: rawConnectionId } = await params;
  const connectionId = decodeURIComponent(rawConnectionId);
  const query = await searchParams;
  const runId = firstValue(query.run_id);
  const preview = flowPreviewState("status", { _preview: firstValue(query._preview), _state: firstValue(query._state) });
  if (preview) return <RecordroomShellWithPalette><FirstSyncBody connectionId={flowPreview.connectionId} connectorId={flowPreview.connector.connectorId} name={flowPreview.connector.displayName} outcome={firstSyncOutcome(previewStatus(preview), flowPreview.connector.displayName, previewFacts(preview))} preview resumeAction={resumeConnectionAction} /></RecordroomShellWithPalette>;

  const status = await getConnectionSetupStatus(connectionId, runId ?? null).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });

  const manifest = findManifestForConnectorId(await listConnectorManifests().catch(() => []), status.connector_id);
  const name = await setupStatusName(status, manifest?.display_name, existingSourcesForConnector);
  const outcome = firstSyncOutcome(status, name, await readFacts(status));
  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={status.pending || status.running || outcome.kind === "running" || outcome.kind === "needs-you"} />
      <FirstSyncBody
        connectionId={status.connection_id}
        connectorId={status.connector_id}
        icon={manifest?.icon}
        name={name}
        outcome={outcome}
        resumeAction={resumeConnectionAction}
      />
    </RecordroomShellWithPalette>
  );
}
