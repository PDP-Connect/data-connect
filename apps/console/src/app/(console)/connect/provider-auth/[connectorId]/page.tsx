// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { buildOwnerConnectorCatalog } from "../../../lib/connection-catalog.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { listConnectorManifests, listOwnerConnectorTemplates } from "../../../lib/rs-client.ts";
import { supportsProviderAuth } from "./provider-auth-support.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  error?: string;
}

export default async function ProviderAuthPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<PageSearchParams>;
}) {
  const [{ connectorId }, query, manifests, templates] = await Promise.all([
    params,
    searchParams,
    listConnectorManifests().catch(() => []),
    listOwnerConnectorTemplates(),
  ]);
  if (!supportsProviderAuth(buildOwnerConnectorCatalog(manifests, templates), connectorId)) {
    notFound();
  }
  const displayName = formatConnectorKeyForDisplay(connectorId);
  const connectorIcon = findManifestForConnectorId(manifests, connectorId)?.icon;
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        description={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={displayName} />
            <span>Allow DataConnect to read your {displayName} account.</span>
          </span>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={displayName} />
            Connect {displayName}
          </span>
        }
      />
      <section className="grid max-w-2xl gap-4">
        {query.error ? (
          <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive" role="alert">
            <p>Could not start access. Try again.</p>
            <details className="mt-2">
              <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
              <p className="mt-1">{query.error.replaceAll(/PDPP/giu, "DataConnect")}</p>
            </details>
          </div>
        ) : null}
        <form action={`/connect/provider-auth/${encodeURIComponent(connectorId)}/start`} method="post">
          <button className={buttonVariants({ className: "min-h-11", size: "sm", variant: "default" })} type="submit">
            Continue to {displayName}
          </button>
        </form>
        <Link className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })} href="/sources">
          Back to Data sources
        </Link>
        <details className="pdpp-caption text-muted-foreground">
          <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
          <p className="mt-2">Your sign-in stays with {displayName}. You can choose another data source from the add page.</p>
          <Link className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2" href="/sources/add">
            Choose another data source
          </Link>
        </details>
      </section>
    </RecordroomShellWithPalette>
  );
}
