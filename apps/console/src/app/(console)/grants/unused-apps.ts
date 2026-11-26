// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess } from "./app-access.ts";
export function unusedApps(apps: readonly AppAccess[], now = Date.now()): AppAccess[] {
  return apps.filter(
    (app) => app.state === "reading" && Boolean(app.since) && Date.parse(app.since as string) < now - 30 * 86_400_000 && (!app.lastRead || Date.parse(app.lastRead) < now - 30 * 86_400_000)
  );
}
export async function removeUnusedApps(
  apps: readonly AppAccess[],
  remove: (input: {
    client_ids: string[];
  }) => Promise<{ ok: boolean; failedGrantIds?: string[]; message: string | null }>
) {
  const result = await remove({ client_ids: [...new Set(apps.flatMap((app) => app.clientIds))] });
  const failed = result.ok
    ? []
    : apps.filter((app) => !result.failedGrantIds || app.grantIds.some((id) => result.failedGrantIds?.includes(id)));
  return { ...result, failedNames: failed.map((app) => app.name) };
}

/** Count the actual data sources behind an all-accounts row. */
export function appSourceCount(app: AppAccess): number {
  return new Set(app.sourceAccess.filter(source=>source.in_force).flatMap(source=>source.connection_ids?.length ? source.connection_ids : [source.source.connection_id ?? JSON.stringify(source.source)])).size;
}
