// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { existingSourcesForConnector as fetchExistingSourcesForConnector } from "../../../components/existing-sources-by-connector.ts";
import { getManualUploadSetup, RefNotFoundError } from "../../../lib/ref-client.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
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

interface AcquisitionMethod {
  detail: string | null;
  help_url: string | null;
  label: string;
  platform: string | null;
  posture: string | null;
}

function MethodCard({ method }: { method: AcquisitionMethod }) {
  return (
    <div className="border-b border-border py-3">
      <div className="grid gap-1">
        <span className="font-medium text-foreground text-sm">{method.label.replaceAll(/PDPP/giu, "DataConnect")}</span>
        {method.platform ? (
          <span className="pdpp-caption text-muted-foreground">{method.platform.replaceAll(/PDPP/giu, "DataConnect")}</span>
        ) : null}
      </div>
      {method.detail ? (
        <details className="pdpp-caption text-muted-foreground">
          <summary className="inline-flex min-h-11 cursor-pointer items-center">Instructions</summary>
          <p className="mt-1">{method.detail.replaceAll(/PDPP/giu, "DataConnect")}</p>
        </details>
      ) : null}
      {method.help_url ? (
        <OpenExternalLink
          className="pdpp-caption mt-1 inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4"
          href={method.help_url}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open instructions in a new tab
        </OpenExternalLink>
      ) : null}
    </div>
  );
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
  const connectorIcon = findManifestForConnectorId(await listConnectorManifests().catch(() => []), setup.connector_id)?.icon;

  // EXACT per-connector lookup (existing-sources-by-connector.ts) — never a
  // fleet page filtered client-side. No incompleteness signal to surface:
  // this connector's existing sources are exact by construction.
  const existingSources = targetConnectionId ? [] : await existingSourcesForManualUpload(setup.connector_id);

  // Primary acquisition methods lead; advanced/secondary paths sit behind one
  // disclosure so the recommended path is obvious and the page stays low-noise.
  const primaryMethods = setup.acquisition_methods.filter((method) => method.posture === "primary");
  const advancedMethods = setup.acquisition_methods.filter((method) => method.posture !== "primary");

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })} href="/sources">
            Back to Data sources
          </Link>
        }
        description={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={setup.connector_id} icon={connectorIcon} name={setup.display_name} />
            <span>Upload the export file from {setup.display_name}.</span>
          </span>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={setup.connector_id} icon={connectorIcon} name={setup.display_name} />
            {targetConnectionId ? `Import another ${setup.display_name} file` : `Connect ${setup.display_name}`}
          </span>
        }
      />

      <ol className="mb-5 grid max-w-2xl list-decimal gap-1 pl-5 pdpp-body text-muted-foreground">
        <li>Export your data from {setup.display_name}.</li>
        <li>Choose the export file.</li>
        <li>Import the file into DataConnect.</li>
      </ol>

      <Section title={setup.label}>
        {primaryMethods.length > 0 ? (
          <div className="mb-4 grid max-w-2xl">
            {primaryMethods.map((method) => (
              <MethodCard key={method.label} method={method} />
            ))}
          </div>
        ) : null}
        {advancedMethods.length > 0 ? (
          <details className="mb-4 max-w-2xl">
            <summary className="pdpp-caption inline-flex min-h-11 cursor-pointer items-center list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
              Other ways to export this data
            </summary>
            <div className="mt-2 grid gap-2">
              {advancedMethods.map((method) => (
                <MethodCard key={method.label} method={method} />
              ))}
            </div>
          </details>
        ) : null}
        <ManualUploadForm existingSources={existingSources} setup={setup} targetConnectionId={targetConnectionId} />
      </Section>

      <details className="mt-5 pdpp-caption text-muted-foreground">
        <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
        <p className="mt-2">
          {(
            setup.description ??
            "The uploaded file is stored for this source and is not exposed to connected apps or clients."
          ).replaceAll(/PDPP/giu, "DataConnect")}
        </p>
        {setup.large_file_fallback ? (
          <p className="mt-2">{setup.large_file_fallback.replaceAll(/PDPP/giu, "DataConnect")}</p>
        ) : null}
        <Callout
          className="mt-3"
          description="After the first import, revisit the source status page to import another export into the same source. Use Add source again only for a different account, profile, device, or source identity."
          surface="human"
          title="This is a file import"
        >
          <p className="pdpp-caption text-muted-foreground">
            You are importing data you already exported. There is no provider sign-in or server change.
          </p>
        </Callout>
      </details>
    </RecordroomShellWithPalette>
  );
}
