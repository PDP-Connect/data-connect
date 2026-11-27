// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { UpdateResult, UpdatesReadyKind } from "./updates-ready-model.ts";

export async function runUpdatesSequentially(
  kinds: readonly UpdatesReadyKind[],
  update: (connectorId: string) => Promise<{ ok: boolean }>
): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  for (const kind of kinds) {
    try {
      const result = await update(kind.connectorId);
      results.push({ ok: result.ok, sourceNames: kind.sourceNames });
    } catch {
      results.push({ ok: false, sourceNames: kind.sourceNames });
    }
  }
  return results;
}
