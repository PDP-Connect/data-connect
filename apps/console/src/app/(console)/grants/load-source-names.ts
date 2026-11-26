// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { connectionDisplayName, connectionNameDisambiguators } from "../lib/connection-display-name.ts";
import type { ConnectionNameRow } from "../lib/connection-display-name.ts";
import { listConnectorSummaries } from "../lib/ref-client.ts";
/** Lightweight identity inventory, once per page, never a read per app or permission. */
export async function loadSourceNames(): Promise<Map<string, string>> {
  const rows: ConnectionNameRow[] = [];
  const finish = () => {
    const disambiguators = connectionNameDisambiguators(rows);
    return new Map(
      rows.map((row) => [
        row.connection_id,
        connectionDisplayName(
          row.display_name,
          row.connector_display_name,
          row.connector_id,
          disambiguators.get(row.connection_id)
        ),
      ])
    );
  };
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const page = await listConnectorSummaries({ profile: "identity_inventory", limit: 100, cursor });
      rows.push(...page.data);
      if (!page.has_more) {
        return finish();
      }
      if (!page.next_cursor || seen.has(page.next_cursor)) {
        return new Map();
      }
      cursor = page.next_cursor;
      seen.add(cursor);
    } while (cursor);
  } catch {
    return new Map();
  }
  return finish();
}
