// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "../../../lib/connection-catalog.ts";

/**
 * Whether the owner catalog offers provider authorization for this connector.
 * The Add page links to this page from the same catalog entry (by its
 * disposition), so every connector the Add page sends here passes.
 */
export function supportsProviderAuth(catalog: readonly ConnectorCatalogEntry[], connectorId: string): boolean {
  const entry = catalog.find((candidate) => candidate.connectorKey === connectorId);
  return entry?.disposition === "provider_auth_connect" && entry.nextStepKind === "open_provider_auth";
}
