// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { FileConnectBody } from "../../../sources/add/connect-bodies.tsx";
import { NewServiceNote } from "../../../sources/add/connect-parts.tsx";
import { loadServiceContext } from "../../../sources/add/service-context.ts";
import { existingSourcesForConnector as fetchExistingSourcesForConnector } from "../../../components/existing-sources-by-connector.ts";
import { getManualUploadSetup, RefNotFoundError } from "../../../lib/ref-client.ts";
import { exportInstructions } from "./manual-upload-steps.ts";
import { formatTotalRecordsLabel } from "../../../lib/total-records-label.ts";
import { ManualUploadForm } from "./manual-upload-form.tsx";
import { isMissingManualUploadSetup } from "./manual-upload-setup-read.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

/**
 * EXACT per-connector existing-sources lookup (`existing-sources-by-connector.ts`
 * — one `GET /_ref/connections?connector_id=` call, plus a scoped
 * per-connection `listConnectorSummaries` backfill for record counts /
 * latest-import facts). Replaces the rejected one-arbitrary-fleet-page
 * stopgap: this connector's existing sources are exact by construction,
 * never a partial slice that happens to look complete because it landed on
 * the global final page.
 */
async function existingSourcesForManualUpload(connectorId: string) {
  const links = await fetchExistingSourcesForConnector(connectorId);
  return links.map((link) => ({
    connection_id: link.connectionId,
    detail: `${formatTotalRecordsLabel(link.totalRecords, link.totalRecordsState, "records")}${
      link.latestImportStatus ? ` · ${link.latestImportStatus}` : ""
    }`,
    display_name: link.displayName,
  }));
}

export default async function ManualUploadConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);
  const resolvedSearchParams = await searchParams;
  const setup = await getManualUploadSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError || isMissingManualUploadSetup(err)) {
      notFound();
    }
    throw err;
  });
  const targetConnectionId = Array.isArray(resolvedSearchParams.connection_id)
    ? (resolvedSearchParams.connection_id[0] ?? null)
    : (resolvedSearchParams.connection_id ?? null);
  const context = await loadServiceContext(setup.connector_id, setup.display_name);
  const name = context.displayName;

  // EXACT per-connector lookup (existing-sources-by-connector.ts) — never a
  // fleet page filtered client-side. No incompleteness signal to surface:
  // this connector's existing sources are exact by construction.
  const existingSources = targetConnectionId ? [] : await existingSourcesForManualUpload(setup.connector_id);
  const instructions = exportInstructions(setup.acquisition_methods);

  return (
    <RecordroomShellWithPalette>
      <FileConnectBody
        form={
          <ManualUploadForm
            existingSources={existingSources}
            name={name}
            note={<NewServiceNote name={name} tier={context.tier} />}
            setup={setup}
            targetConnectionId={targetConnectionId}
          />
        }
        instructions={instructions}
        service={{ accounts: context.accounts, connectorKey: setup.connector_id, icon: context.icon, name, tier: context.tier }}
        title={targetConnectionId ? `Import another ${name} file` : undefined}
      />
    </RecordroomShellWithPalette>
  );
}
