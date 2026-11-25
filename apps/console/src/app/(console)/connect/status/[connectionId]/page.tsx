// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { LivePoller } from "../../../components/live-poller.tsx";
import { connectionDisplayName } from "../../../lib/connection-display-name.ts";
import {
  getConnectionSetupStatus,
  getConnectorSchedule,
  getRunTimeline,
  RefNotFoundError,
} from "../../../lib/ref-client.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { getCollectedKinds, getCollectionTerminalEvent } from "../../../syncs/[runId]/collected-kinds.ts";
import { FirstSyncBody } from "./first-sync-body.tsx";
import { type FirstSyncFacts, firstSyncOutcome } from "./first-sync-outcome.ts";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readFacts(
  status: Awaited<ReturnType<typeof getConnectionSetupStatus>>
): Promise<FirstSyncFacts> {
  const runId = status.run?.run_id;
  const [timeline, schedule] = await Promise.all([
    runId ? getRunTimeline(runId).catch(() => null) : Promise.resolve(null),
    getConnectorSchedule(status.connector_id, { connectorInstanceId: status.connection_id }).catch(() => null),
  ]);
  const kinds = timeline ? getCollectedKinds(getCollectionTerminalEvent(timeline.events)) : null;
  return { kinds, schedule };
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
  const runId = firstValue((await searchParams).run_id);

  const status = await getConnectionSetupStatus(connectionId, runId ?? null).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });

  const manifest = findManifestForConnectorId(await listConnectorManifests().catch(() => []), status.connector_id);
  const name = connectionDisplayName(status.display_name, manifest?.display_name, status.connector_id);
  const outcome = firstSyncOutcome(status, name, await readFacts(status));
  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={status.pending} />
      <FirstSyncBody connectorId={status.connector_id} icon={manifest?.icon} name={name} outcome={outcome} />
      <div className="mt-6">
        <Link className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })} href="/sources">
          Back to Data sources
        </Link>
      </div>
    </RecordroomShellWithPalette>
  );
}
