// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalReadWarning } from "../../../lib/read-envelope.ts";
import { connectionDisplayName } from "../../../lib/connection-display-name.ts";

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
  return connectionDisplayName(summary.display_name, summary.connector_display_name, summary.connector_id);
}
