// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { loadBrowserConnectSupport } from "../../../../lib/load-browser-connect-support.ts";
import { findManifestForConnectorId } from "../../../../sources/lib/relationships.ts";
import { listConnectorManifests } from "../../../../lib/rs-client.ts";
import { BrowserSessionLaunchPanel } from "./launch-panel.tsx";

import { flowPreview, flowPreviewState } from "../../../flow-preview.ts";

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

  const previewQuery = await searchParams;
  const preview = flowPreviewState("launch", { _preview: firstValue(previewQuery._preview), _state: firstValue(previewQuery._state) });
  if (preview) return <RecordroomShellWithPalette><BrowserSessionLaunchPanel connectionId={flowPreview.connectionId} connectorId={flowPreview.connector.connectorId} displayName={flowPreview.connector.displayName} draft={false} previewState={preview} /></RecordroomShellWithPalette>;

  const browserConnect = await loadBrowserConnectSupport(connectorId);
  if (!browserConnect.browserBound) {
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
        <BrowserSessionLaunchPanel
          connectionId={connectionId}
          connectorId={connectorId}
          displayName={displayName}
          draft={draft}
          icon={connectorIcon}
        />
    </RecordroomShellWithPalette>
  );
}
