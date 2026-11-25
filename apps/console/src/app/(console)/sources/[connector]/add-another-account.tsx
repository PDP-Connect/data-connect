// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { findCatalogEntry, readAddSourceCatalog } from "../add/add-source-catalog-read.ts";
import { addSourceHref, isConnectableEntry } from "../add/add-source-list-model.ts";

/** Use the same availability decision as an Added row, without delaying the source's own actions. */
export async function AddAnotherAccount({ connectorKey }: { connectorKey: string }) {
  const catalog = await readAddSourceCatalog({ withAccounts: false }).catch(() => null);
  if (!catalog) return null;
  const entry = findCatalogEntry(catalog, connectorKey);
  if (!entry || !isConnectableEntry(entry, catalog.lifecycleFor(entry), catalog.catalogTransientlyUnavailable)) return null;
  return (
    <Link className="inline-flex min-h-11 items-center text-sm text-primary hover:underline" href={addSourceHref(entry.connectorKey)}>
      Add another {entry.displayName} account
    </Link>
  );
}
