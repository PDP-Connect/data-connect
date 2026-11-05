// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export type LegacySourceBinding = readonly [connectorKey: string, sourceId: string];

export const LEGACY_SOURCE_BINDINGS_PIN = "7e8f726725b7a14705571339c84a52d8f05888ffc0996b77cce3d4ae13dae9e6";
const LEGACY_BINDING_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate and order the exact historical mapping approved for generation. */
export function validateLegacySourceBindings(bindings: readonly LegacySourceBinding[]): LegacySourceBinding[] {
  for (const [key, sourceId] of bindings) {
    if (!LEGACY_BINDING_KEY.test(key)) {
      throw new Error(`Invalid pinned connector_key: ${key}`);
    }
    if (!URL.canParse(sourceId)) {
      throw new Error(`Invalid pinned legacy connector_id for ${key}`);
    }
  }

  if (
    new Set(bindings.map(([key]) => key)).size !== bindings.length ||
    new Set(bindings.map(([, sourceId]) => sourceId)).size !== bindings.length
  ) {
    throw new Error("Pinned historical source bindings contain duplicate keys or source IDs");
  }

  const ordered = [...bindings].sort(([a], [b]) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
  const pin = createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
  if (pin !== LEGACY_SOURCE_BINDINGS_PIN) {
    throw new Error(`Pinned historical source mapping changed: sha256:${pin}`);
  }
  return ordered;
}
