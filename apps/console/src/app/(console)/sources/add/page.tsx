// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { ConnectorIconLike } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { type ExistingSourceSetupLink, type SourceSummaryReadResult, SourceSetupCatalog } from "../../components/source-setup-catalog.tsx";
import { buildOwnerConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { buildConnectorIconMap, catalogEntryIcon } from "../../lib/connector-icon-map.ts";
import type { ConnectorInstallSnapshot } from "../../lib/connector-install-contract.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";
import { buildConnectorInstallLifecycleByConnector } from "../../lib/connector-install-presentation.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listConnectorManifests, listOwnerConnectorTemplates } from "../../lib/rs-client.ts";
import { existingSourcesByConnectorCatalog, getConnectorInstallSnapshot } from "../connector-updates-read.ts";
import { isDeterministicSourcesReadError } from "../read-error-classification.ts";
import { LocalConnectorSourcesPanel } from "./local-connector-sources-panel.tsx";
import { setupErrorCopy } from "./setup-error-copy.ts";
import { buildUpdatesReadyModel, type UpdatesReadyModel } from "../updates-ready-model.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  demo?: string;
  error?: string;
  source_q?: string;
}

function AddSourceHeader() {
  return (
    <PageHeader
      breadcrumbs={[
        { href: dashboardRoutes.section.overview, label: "Home" },
        { href: dashboardRoutes.section.records, label: "Data sources" },
        { label: "Add a data source" },
      ]}
      title="Add a data source"
    />
  );
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let catalog: ConnectorCatalogEntry[];
  let existingSourcesByConnector: Record<string, readonly ExistingSourceSetupLink[]> | undefined;
  let existingSourcesRead: Promise<SourceSummaryReadResult> | undefined;
  let updatesReady: Promise<UpdatesReadyModel | null> | undefined;
  let installLifecycleByConnector: Readonly<Record<string, ConnectorInstallLifecycle>> | null = null;
  let installCatalogBusySnapshotId: string | null = null;
  let installCatalogTransientlyUnavailable = false;
  let installSkippedEntries = 0;
  let localSources: NonNullable<ConnectorInstallSnapshot["localSources"]> = [];
  let connectorIcons: Readonly<Record<string, ConnectorIconLike | null | undefined>> = {};
  if (process.env.NODE_ENV !== "production" && params.demo === "atlas") {
    const demo = await import("./add-source-demo-data.ts");
    ({ catalog, existingSourcesByConnector } = demo.buildAddSourceDemoCatalog());
  } else {
    try {
      // `null` means a reference server that predates the install routes
      // (during the RI rollout): no lifecycle claim is shown. Other failures
      // remain visible to the existing page error path.
      const [manifests, templates, installSnapshot] = await Promise.all([
        listConnectorManifests(),
        listOwnerConnectorTemplates(),
        getConnectorInstallSnapshot(),
      ]);
      connectorIcons = await buildConnectorIconMap(manifests, templates);
      catalog = buildOwnerConnectorCatalog(manifests, templates, installSnapshot?.catalog ?? []).map((entry) => ({
        ...entry,
        icon: catalogEntryIcon(entry, connectorIcons),
      }));
      installLifecycleByConnector = installSnapshot
        ? buildConnectorInstallLifecycleByConnector(installSnapshot.catalog, installSnapshot.status)
        : null;
      installCatalogTransientlyUnavailable = installSnapshot?.catalogUnavailableReason === "transient_busy";
      installSkippedEntries = installSnapshot?.skippedEntries ?? 0;
      installCatalogBusySnapshotId = installCatalogTransientlyUnavailable ? randomUUID() : null;
      localSources = installSnapshot?.localSources ? [...installSnapshot.localSources] : [];
      // Start the slower owner summary read after the catalog is ready. Both the
      // account links and the shared update line consume this same result.
      const sourceRead = existingSourcesByConnectorCatalog(catalog.map((entry) => entry.connectorKey));
      existingSourcesRead = sourceRead.then(
        (value): SourceSummaryReadResult => ({ ok: true, value }),
        (): SourceSummaryReadResult => ({ ok: false }),
      );
      updatesReady = existingSourcesRead.then((result) =>
        result.ok && !result.value.truncated
          ? buildUpdatesReadyModel(installSnapshot, result.value.byConnector)
          : null,
      );
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette>
            <AddSourceHeader />
            <p className="pdpp-caption py-3 text-muted-foreground" role="alert">
              Couldn't load data sources. <Link className="underline underline-offset-2" href="/sources/add">Try again</Link>.
            </p>
            <Link className="pdpp-caption underline underline-offset-2" href="/deployment">Deployment settings</Link>
          </RecordroomShellWithPalette>
        );
      }
      // Both the authorization-server and resource-server clients throw
      // status-bearing errors, but they intentionally use different classes.
      // Classify their shared HTTP contract here so a known 4xx is rendered
      // before Next can redact the server-side message and erase `status`.
      if (isDeterministicSourcesReadError(err)) {
        return (
          <RecordroomShellWithPalette>
            <AddSourceHeader />
            <div className="rr-s-toast mt-3" data-tone="error" role="alert">
              <p>Couldn't load data sources. <Link className="underline underline-offset-2" href="/sources/add">Try again</Link>.</p>
              <details>
                <summary className="cursor-pointer underline underline-offset-2">Details</summary>
                <p>If the console and server versions do not match, update them together. Check the service logs if they do.</p>
              </details>
              <Link className="underline underline-offset-2 hover:text-foreground" href="/deployment">
                Deployment readiness
              </Link>
            </div>
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }

  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  const setupError = setupErrorCopy(typeof params.error === "string" ? params.error : undefined);
  return (
    <RecordroomShellWithPalette>
      <AddSourceHeader />
      {setupError ? <p className="pdpp-caption py-2 text-muted-foreground" role="alert">{setupError}</p> : null}
      <SourceSetupCatalog
        catalog={catalog}
        existingSourcesByConnector={existingSourcesByConnector}
        existingSourcesRead={existingSourcesRead}
        installCatalogBusySnapshotId={installCatalogBusySnapshotId}
        installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
        installLifecycleByConnector={installLifecycleByConnector}
        installSkippedEntries={installSkippedEntries}
        query={sourceQuery}
        updatesReady={updatesReady}
      />
      <LocalConnectorSourcesPanel connectorIcons={connectorIcons} sources={localSources} />
    </RecordroomShellWithPalette>
  );
}
