// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { isBrowserBoundConnector } from "../../../../lib/connection-modality.ts";
import { findManifestForConnectorId } from "../../../../sources/lib/relationships.ts";
import { listConnectorManifests } from "../../../../lib/rs-client.ts";
import { BrowserSessionLaunchPanel } from "./launch-panel.tsx";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BrowserSessionLaunchPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  if (!isBrowserBoundConnector(connectorId)) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const connectionId = firstValue(resolvedSearchParams.connection_id)?.trim();
  const draft = firstValue(resolvedSearchParams.draft) === "1";

  if (!connectionId) {
    notFound();
  }

  const displayName = formatConnectorKeyForDisplay(connectorId);
  const connectorIcon = findManifestForConnectorId(await listConnectorManifests().catch(() => []), connectorId)?.icon;

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Back to Sources
          </Link>
        }
        breadcrumbs={[
          { href: "/sources", label: "Sources" },
          {
            href: `/connect/browser-session/${encodeURIComponent(connectorId)}`,
            label: `Connect ${displayName}`,
          },
          { label: "Starting browser" },
        ]}
        description={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark className="size-5 shrink-0" icon={connectorIcon} name={displayName} />
            <span>PDPP is starting a secure browser session for {displayName}.</span>
          </span>
        }
        title="Starting secure browser"
      />

      <div className="mx-auto max-w-lg px-4 py-8">
        <BrowserSessionLaunchPanel connectionId={connectionId} connectorId={connectorId} draft={draft} />
      </div>
    </RecordroomShellWithPalette>
  );
}
