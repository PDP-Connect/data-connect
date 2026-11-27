// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { connectionDisplayName, NO_NAME_FALLBACK } from "../../../lib/connection-display-name.ts";

interface NamedSource {
  readonly connectionId: string;
  readonly displayName: string;
}

/**
 * The name this page shows. The status read carries only the saved name, and a
 * deployment without local manifests has no service name to fall back on, so a
 * connection saved under its bare key lost its name. The Data sources read
 * carries the service's own name; ask it only when nothing else named the source.
 */
export async function setupStatusName(
  status: { connection_id: string; connector_id: string; display_name: string | null },
  manifestName: string | null | undefined,
  sourcesFor: (connectorId: string) => Promise<readonly NamedSource[]>,
): Promise<string> {
  const name = connectionDisplayName(status.display_name, manifestName, status.connector_id);
  if (name !== NO_NAME_FALLBACK) return name;
  const sources = await sourcesFor(status.connector_id).catch(() => []);
  return sources.find((source) => source.connectionId === status.connection_id)?.displayName ?? name;
}
