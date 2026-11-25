// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { buildOwnerConnectorCatalog } from "../../lib/connection-catalog.ts";
import { buildConnectorIconMap, catalogEntryIcon } from "../../lib/connector-icon-map.ts";
import { buildConnectorInstallLifecycleByConnector, connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listConnectorManifests, listOwnerConnectorTemplates } from "../../lib/rs-client.ts";
import { getConnectorInstallSnapshot } from "../connector-updates-read.ts";
import { isDeterministicSourcesReadError } from "../read-error-classification.ts";
import { ADD_SOURCE_COPY, buildAddSourceList } from "./add-source-list-model.ts";
import { AddSourceList, AddSourceLoadFailed } from "./add-source-list.tsx";
import { readInstalledSourceCatalog } from "./installed-source-catalog.ts";
import { setupErrorCopy } from "./setup-error-copy.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  error?: string;
  source_q?: string;
}

function AddSourceHeader() {
  return (
    <PageHeader
      breadcrumbs={[
        { href: dashboardRoutes.section.overview, label: "Home" },
        { href: dashboardRoutes.section.records, label: "Data sources" },
        { label: ADD_SOURCE_COPY.heading },
      ]}
      description={ADD_SOURCE_COPY.lead}
      title={ADD_SOURCE_COPY.heading}
    />
  );
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let model: ReturnType<typeof buildAddSourceList>;
  try {
    // `null` means a reference server that predates the install routes.
    const [manifests, templates, installSnapshot] = await Promise.all([
      listConnectorManifests(),
      listOwnerConnectorTemplates(),
      getConnectorInstallSnapshot(),
    ]);
    const connectorIcons = await buildConnectorIconMap(manifests, templates);
    const catalog = buildOwnerConnectorCatalog(manifests, templates, installSnapshot?.catalog ?? []).map((entry) => ({
      ...entry,
      icon: catalogEntryIcon(entry, connectorIcons),
    }));
    const lifecycleByConnector = installSnapshot
      ? buildConnectorInstallLifecycleByConnector(installSnapshot.catalog, installSnapshot.status)
      : null;
    const existing = await readInstalledSourceCatalog(catalog.map((entry) => entry.connectorKey)).catch(() => null);
    const existingConnectionCounts = Object.fromEntries(
      Object.entries(existing?.byConnector ?? {}).map(([key, links]) => [key, links.length])
    );
    model = buildAddSourceList({
      catalog,
      catalogTransientlyUnavailable: installSnapshot?.catalogUnavailableReason === "transient_busy",
      existingConnectionCounts,
      lifecycleFor: (entry) =>
        lifecycleByConnector === null
          ? null
          : (lifecycleByConnector[connectorLookupKey(entry.connectorKey)] ?? { catalog: null, installed: null }),
    });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError || isDeterministicSourcesReadError(err)) {
      return (
        <RecordroomShellWithPalette>
          <AddSourceHeader />
          <AddSourceLoadFailed />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  const setupError = setupErrorCopy(typeof params.error === "string" ? params.error : undefined);
  return (
    <RecordroomShellWithPalette>
      <AddSourceHeader />
      {setupError ? <p className="pdpp-caption py-2 text-muted-foreground" role="alert">{setupError}</p> : null}
      <AddSourceList model={model} query={sourceQuery} />
    </RecordroomShellWithPalette>
  );
}
