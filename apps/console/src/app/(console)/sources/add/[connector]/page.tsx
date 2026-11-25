// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { redirect } from "next/navigation";
import { connectorInstallRowModel } from "../../../lib/connector-install-presentation.ts";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import { sourceSetupCardModel } from "../../../lib/source-setup-presentation.ts";
import { isDeterministicSourcesReadError } from "../../read-error-classification.ts";
import { findCatalogEntry, readAddSourceCatalog } from "../add-source-catalog-read.ts";
import { existingSourcesForConnector } from "../../../components/existing-sources-by-connector.ts";
import { existingSourceHref, isConnectableEntry } from "../add-source-list-model.ts";
import { AddSourceLoadFailed } from "../add-source-list.tsx";
import { CannotBeAddedHere, ConnectHeader, NewServiceNote } from "../connect-parts.tsx";
import { GettingReady } from "../getting-ready.tsx";
import { ProgramConnect } from "../program-connect.tsx";
import { connectPageHref, isProgramService } from "../service-setup-href.ts";

export const dynamic = "force-dynamic";

/**
 * "Connect <Name>" (design "Page 2"). A row on the list opens this page. If the
 * service is not on this computer yet, the page gets it ready by itself; once
 * it is ready, the form of its kind opens without a click.
 */
export default async function ConnectServicePage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector: rawKey } = await params;
  const connectorKey = decodeURIComponent(rawKey);
  let read: Awaited<ReturnType<typeof readAddSourceCatalog>>;
  try {
    read = await readAddSourceCatalog({ withAccounts: false });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError || isDeterministicSourcesReadError(err)) {
      return (
        <RecordroomShellWithPalette>
          <AddSourceLoadFailed />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
  const entry = findCatalogEntry(read, connectorKey);
  if (!entry) {
    return (
      <RecordroomShellWithPalette>
        <CannotBeAddedHere name={connectorKey} />
      </RecordroomShellWithPalette>
    );
  }
  const lifecycle = read.lifecycleFor(entry);
  if (!isConnectableEntry(entry, lifecycle, read.catalogTransientlyUnavailable)) {
    // Design "Page 1": a service the person already has never says "can't be added";
    // when a second account is not possible, its own page opens instead.
    const accounts = await existingSourcesForConnector(entry.connectorKey).catch(() => []);
    const first = accounts[0];
    if (first) redirect(existingSourceHref(entry.connectorKey, first.connectionId));
    const hostBlock = lifecycle ? connectorInstallRowModel(entry, lifecycle).hostBlockReason : null;
    return (
      <RecordroomShellWithPalette>
        <CannotBeAddedHere name={entry.displayName} reason={hostBlock} />
      </RecordroomShellWithPalette>
    );
  }
  const card = sourceSetupCardModel(entry, lifecycle, read.catalogTransientlyUnavailable);
  if (card.setupAction && !isProgramService(entry)) {
    redirect(connectPageHref(entry, card.setupAction.href));
  }
  const header = (
    <ConnectHeader connectorKey={entry.connectorKey} icon={entry.icon} name={entry.displayName} />
  );
  if (card.setupAction) {
    return (
      <RecordroomShellWithPalette>
        {header}
        <NewServiceNote name={entry.displayName} tier={entry.publicTier} />
        <ProgramConnect connectorKey={entry.connectorKey} name={entry.displayName} />
      </RecordroomShellWithPalette>
    );
  }
  const rowModel = lifecycle ? connectorInstallRowModel(entry, lifecycle) : null;
  const install =
    rowModel?.action?.kind === "install" ? { connectorId: rowModel.connectorId, digest: rowModel.action.digest } : null;
  return (
    <RecordroomShellWithPalette>
      {header}
      <GettingReady connectorKey={entry.connectorKey} install={install} name={entry.displayName} />
    </RecordroomShellWithPalette>
  );
}
