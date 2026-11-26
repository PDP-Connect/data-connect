// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { buttonVariants } from "@pdpp/brand-react";
import { findCatalogEntry, readAddSourceCatalog } from "../add/add-source-catalog-read.ts";
import { addSourceHref, isConnectableEntry } from "../add/add-source-list-model.ts";

/** Use the same availability decision as an Added row, without delaying the source's own actions. */
export async function AddAnotherAccount({ connectorKey }: { connectorKey: string }) {
  const catalog = await readAddSourceCatalog({ withAccounts: false }).catch(() => null);
  if (!catalog) return null;
  const entry = findCatalogEntry(catalog, connectorKey);
  if (!entry || !isConnectableEntry(entry, catalog.lifecycleFor(entry), catalog.catalogTransientlyUnavailable)) return null;
  return (
    <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <p className="pdpp-body">Add another {entry.displayName} account</p>
      <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={addSourceHref(entry.connectorKey)}>
      Add another {entry.displayName} account
    </Link>
    </div>
  );
}
