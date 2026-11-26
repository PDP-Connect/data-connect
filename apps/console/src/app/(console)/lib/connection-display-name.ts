// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { formatConnectionDisplayName, isFallbackConnectionLabel } from "@pdpp/display";

/**
 * Resolve the name shown for a connection when the saved value may be its connector key.
 * The rule lives in `@pdpp/display` so the console and the vendored Explore assembler share it.
 */
export function connectionDisplayName(
  connectionName: string | null | undefined,
  connectorName: string | null | undefined,
  connectorId: string | null | undefined,
  disambiguator?: string | null
): string {
  const base = formatConnectionDisplayName(connectionName, connectorName, connectorId);
  return disambiguator ? `${base} · ${disambiguator}` : base;
}
export interface ConnectionNameRow {
  connection_id: string;
  connector_display_name?: string | null;
  connector_id: string;
  display_name: string | null;
}
/** Ordinals follow the same inventory order as the source list, including unnamed accounts. */
export function connectionNameDisambiguators(rows: readonly ConnectionNameRow[]): Map<string, string> {
  const fallback = (row: ConnectionNameRow) =>
    isFallbackConnectionLabel({
      connectorId: row.connector_id,
      displayName: row.display_name,
      name: row.connector_display_name,
    });
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (fallback(row)) {
      counts.set(row.connector_id, (counts.get(row.connector_id) ?? 0) + 1);
    }
  }
  const ordinals = new Map<string, number>();
  const result = new Map<string, string>();
  for (const row of rows) {
    if ((counts.get(row.connector_id) ?? 0) > 1 && fallback(row)) {
      const ordinal = (ordinals.get(row.connector_id) ?? 0) + 1;
      ordinals.set(row.connector_id, ordinal);
      result.set(row.connection_id, `account ${ordinal}`);
    }
  }
  return result;
}
