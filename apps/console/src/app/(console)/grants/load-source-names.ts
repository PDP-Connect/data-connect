// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listConnectorSummaries } from "../lib/ref-client.ts";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
/** Lightweight identity inventory, once per page, never a read per app or permission. */
export async function loadSourceNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const page = await listConnectorSummaries({ profile: "identity_inventory", limit: 100, cursor });
      for (const row of page.data)
        names.set(
          row.connection_id,
          connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id)
        );
      if (!page.has_more) return names;
      if (!page.next_cursor || seen.has(page.next_cursor)) return new Map();
      cursor = page.next_cursor;
      seen.add(cursor);
    } while (cursor);
  } catch {
    return new Map();
  }
  return names;
}
