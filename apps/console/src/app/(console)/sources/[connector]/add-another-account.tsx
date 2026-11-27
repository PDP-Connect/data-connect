// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import { findCatalogEntry, readAddSourceCatalog } from "../add/add-source-catalog-read.ts";
import { addSourceHref, isConnectableEntry } from "../add/add-source-list-model.ts";
import { UPDATES_READ_DEADLINE_MS, withinDeadline } from "../connector-updates-read.ts";

/** Use the same availability decision as an Added row, without delaying the source's own actions. */
export async function AddAnotherAccount({
  connectorKey,
  deadlineMs = UPDATES_READ_DEADLINE_MS,
}: {
  connectorKey: string;
  deadlineMs?: number;
}) {
  const catalog = await withinDeadline(readAddSourceCatalog({ withAccounts: false }), deadlineMs).catch(() => null);
  if (!catalog) {
    return null;
  }
  const entry = findCatalogEntry(catalog, connectorKey);
  if (!(entry && isConnectableEntry(entry, catalog.lifecycleFor(entry), catalog.catalogTransientlyUnavailable))) {
    return null;
  }
  return (
    <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <p className="pdpp-body text-muted-foreground">Connect a second {entry.displayName} sign-in. This one stays as it is.</p>
      <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={addSourceHref(entry.connectorKey)}>
        Add another {entry.displayName} account
      </Link>
    </div>
  );
}
