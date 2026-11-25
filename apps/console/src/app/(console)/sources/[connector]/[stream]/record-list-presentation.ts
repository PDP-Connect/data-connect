// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { deriveSourceDisplayNameFallback, formatConnectorNameForDisplay, isFallbackConnectionLabel } from "@pdpp/display";
import type { CanonicalReadWarning } from "../../../lib/read-envelope.ts";

export function partialReadSentence(warnings: readonly CanonicalReadWarning[]): string | null {
  return warnings.some((warning) => warning.code === "partial_results") ? "Some records could not be read." : null;
}

/**
 * The data source's display name, by the same rule Explore uses for a
 * connection: the owner's label when it means something, else the connector's
 * presentation name. Never the lowercase connector key.
 */
export function sourceDisplayName(summary: {
  connector_display_name?: string | null;
  connector_id: string;
  display_name?: string | null;
}): string {
  const input = {
    connectorId: summary.connector_id,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  };
  return isFallbackConnectionLabel(input) ? deriveSourceDisplayNameFallback(input) : formatConnectorNameForDisplay(input);
}
