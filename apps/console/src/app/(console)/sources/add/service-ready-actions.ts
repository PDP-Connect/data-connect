"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { sourceSetupCardModel } from "../../lib/source-setup-presentation.ts";
import { findCatalogEntry, readAddSourceCatalog } from "./add-source-catalog-read.ts";
import type { ReadinessCheck } from "./getting-ready.ts";
import { connectPageHref } from "./service-setup-href.ts";

/**
 * Re-reads the server and says whether the service can be connected now. The
 * connect page calls it while it waits for the server to register a service it
 * just got.
 */
export async function serviceReadinessAction(connectorKey: string): Promise<ReadinessCheck> {
  await requireDashboardAccess("/sources/add");
  const read = await readAddSourceCatalog();
  const entry = findCatalogEntry(read, connectorKey);
  // A catalog read that failed for now lists no packages, so a service known only
  // from its package is missing: nothing shows it is underway, so ask for a retry.
  if (!entry) return read.catalogTransientlyUnavailable ? { state: "retry" } : { state: "waiting" };
  const card = sourceSetupCardModel(entry, read.lifecycleFor(entry), read.catalogTransientlyUnavailable);
  if (card.packageAvailabilityUnknown) return { state: "retry" };
  if (!card.setupAction) return { state: "waiting" };
  return { href: connectPageHref(entry, card.setupAction.href), state: "ready" };
}
