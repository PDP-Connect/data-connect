// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type AppAccess, type AppAccessSourceIdentity, sameAppAccessSource } from "./app-access.ts";

export interface RemoveAppAccessInput {
  client_ids: string[];
  source?: AppAccessSourceIdentity;
}

export interface RemoveAppAccessResult {
  object: "app_access_remove_result";
  ended_count: number;
  failed_count: number;
  ended_grant_ids: string[];
  failed_grant_ids: string[];
}

export class AppAccessRemovalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface RemovalDependencies {
  list: () => Promise<AppAccess[]>;
  revokeGrant: (id: string) => Promise<unknown>;
  revokePackage: (id: string) => Promise<unknown>;
}

/** Authorize every registration before the first write; derive counts from persisted results, including partial cascades. */
export async function removeAppAccess(
  input: RemoveAppAccessInput,
  deps: RemovalDependencies,
): Promise<RemoveAppAccessResult> {
  const apps = await deps.list();
  const selected = [...new Set(input.client_ids)].map((id) => {
    const app = apps.find((entry) => entry.client_id === id);
    if (!app) {
      throw new AppAccessRemovalError("Registration has no permissions for this owner", 403);
    }
    return app;
  });
  const targets = new Set<string>();
  const packageIds = new Set<string>();
  for (const app of selected) {
    const sources = app.sources.filter(
      (entry) => !input.source || sameAppAccessSource(entry.source, input.source),
    );
    for (const source of sources) {
      for (const id of source.active_grant_ids) {
        targets.add(id);
      }
      if (!input.source && source.active_grant_ids.length) {
        for (const id of source.package_ids) {
          packageIds.add(id);
        }
      }
    }
    if (
      input.source &&
      app.sources.some(
        (entry) =>
          !sameAppAccessSource(entry.source, input.source as AppAccessSourceIdentity) &&
          entry.active_grant_ids.some((id) => targets.has(id)),
      )
    ) {
      throw new AppAccessRemovalError(
        "A permission covers other connections; remove the app's complete access instead",
      );
    }
  }
  // The package cascade owns its tokens and member rows. Scoped removal must never call it.
  for (const id of packageIds) {
    try {
      await deps.revokePackage(id);
    } catch {
      /* inspect persisted state below; other registrations can still be ended */
    }
  }
  const remainingAfterPackages = new Set(
    (await deps.list()).flatMap((app) => app.sources.flatMap((source) => source.active_grant_ids)),
  );
  for (const id of targets) {
    if (!remainingAfterPackages.has(id)) {
      continue;
    }
    try {
      await deps.revokeGrant(id);
    } catch {
      /* counted from the persisted state below */
    }
  }
  const remaining = new Set(
    (await deps.list()).flatMap((app) => app.sources.flatMap((source) => source.active_grant_ids)),
  );
  const ended = [...targets].filter((id) => !remaining.has(id));
  const failed = [...targets].filter((id) => remaining.has(id));
  return {
    object: "app_access_remove_result",
    ended_count: ended.length,
    failed_count: failed.length,
    ended_grant_ids: ended,
    failed_grant_ids: failed,
  };
}
