// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { buildOwnerConnectorCatalog } from "../../../lib/connection-catalog.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { listConnectorManifests, listOwnerConnectorTemplates } from "../../../lib/rs-client.ts";
import { loadServiceContext } from "../../../sources/add/service-context.ts";
import { supportsProviderAuth } from "./provider-auth-support.ts";

import { flowPreview, flowPreviewState } from "../../flow-preview.ts";
import { ProviderAuthBody } from "./provider-auth-body.tsx";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  error?: string;
  _preview?: string;
  _state?: string;
}

export default async function ProviderAuthPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<PageSearchParams>;
}) {
  const previewQuery = await searchParams;
  const preview = flowPreviewState("provider", previewQuery);
  if (preview) return <RecordroomShellWithPalette><ProviderAuthBody connectorId={flowPreview.connector.connectorId} displayName={flowPreview.connector.displayName} error={preview === "could-not-start" ? flowPreview.startError : undefined} accounts={preview === "already-have-one" ? [{ connectionId: flowPreview.connectionId, displayName: "Northwind, home" }] : []} /></RecordroomShellWithPalette>;
  const [{ connectorId }, query, manifests, templates] = await Promise.all([
    params,
    searchParams,
    listConnectorManifests().catch(() => []),
    listOwnerConnectorTemplates(),
  ]);
  if (!supportsProviderAuth(buildOwnerConnectorCatalog(manifests, templates), connectorId)) {
    notFound();
  }
  const context = await loadServiceContext(connectorId);
  const displayName = context.displayName;
  const connectorIcon = findManifestForConnectorId(manifests, connectorId)?.icon;
  return (
    <RecordroomShellWithPalette>
      <ProviderAuthBody connectorId={connectorId} connectorIcon={connectorIcon} displayName={displayName} error={query.error} accounts={context.accounts} tier={context.tier} kinds={findManifestForConnectorId(manifests, connectorId)?.streams?.map((stream) => stream.name) ?? []} />
    </RecordroomShellWithPalette>
  );
}
