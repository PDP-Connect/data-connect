// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess } from "./app-access.ts";
export function unusedApps(apps: readonly AppAccess[], now = Date.now()): AppAccess[] {
  return apps.filter(
    (app) => app.state === "reading" && (!app.lastRead || Date.parse(app.lastRead) < now - 30 * 86_400_000)
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
