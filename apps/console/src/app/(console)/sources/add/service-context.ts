// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { existingSourcesForConnector } from "../../components/existing-sources-by-connector.ts";
import { findCatalogEntry, readAddSourceCatalog } from "./add-source-catalog-read.ts";
import type { ExistingAccount } from "./connect-parts.tsx";

/** What every connect page needs to name the service and note what the person already has. */
export interface ServiceContext {
  readonly accounts: readonly ExistingAccount[];
  readonly displayName: string;
  readonly icon: ConnectorIconLike | null | undefined;
  readonly tier: string | null;
}

/**
 * Reads are best effort: a page that cannot learn the tier or the existing
 * accounts still shows its form; it just omits the notes that depend on them.
 */
export async function loadServiceContext(connectorKey: string, fallbackName?: string | null): Promise<ServiceContext> {
  const [read, accounts] = await Promise.all([
    readAddSourceCatalog({ withAccounts: false }).catch(() => null),
    existingSourcesForConnector(connectorKey).catch(() => []),
  ]);
  const entry = read ? findCatalogEntry(read, connectorKey) : null;
  return {
    accounts: accounts.map((account) => ({ connectionId: account.connectionId, displayName: account.displayName })),
    displayName: entry?.displayName ?? fallbackName ?? formatConnectorKeyForDisplay(connectorKey),
    icon: entry?.icon,
    tier: entry?.publicTier ?? null,
  };
}
