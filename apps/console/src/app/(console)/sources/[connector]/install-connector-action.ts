"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { updateConnector } from "../../lib/connector-install-client.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";

export type InstallConnectorForSourceResult = { ok: true } | { ok: false; message: string };

/**
 * Install the catalog's latest signed artifact for a source whose connector is
 * not installed (`POST /v1/owner/connector-install/update`), then revalidate
 * the Sources list and this source so its install state re-reads. Owner
 * initiated only: nothing calls this without a click. Never throws; the
 * prompt renders the failure in place.
 */
export async function installConnectorForSourceAction(
  connectorKey: string,
  routeId: string
): Promise<InstallConnectorForSourceResult> {
  await requireDashboardAccess(`/sources/${encodeURIComponent(routeId)}`);
  const key = connectorKey.trim();
  if (!key) {
    return { message: "The connector to install is missing. Reload the page and try again.", ok: false };
  }
  try {
    await updateConnector(key);
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
  revalidatePath("/sources");
  revalidatePath(`/sources/${encodeURIComponent(routeId)}`);
  return { ok: true };
}
