// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LEGACY_FIRST_PARTY_SOURCE_ENTRIES } from "./generated/connector-registry.generated.ts";

export const LEGACY_SOURCE_MAP_VERSION = 1;

const legacySourceIds: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(LEGACY_FIRST_PARTY_SOURCE_ENTRIES)
);

/** Return the reviewed historical source identity for a canonical key. */
export function legacyFirstPartySourceIdFor(connectorKey: string): string | undefined {
  return Object.hasOwn(legacySourceIds, connectorKey) ? legacySourceIds[connectorKey] : undefined;
}

export const LEGACY_FIRST_PARTY_KEYS: readonly string[] = Object.freeze(
  LEGACY_FIRST_PARTY_SOURCE_ENTRIES.map(([key]) => key)
);

export const LEGACY_FIRST_PARTY_ENTRIES: ReadonlyArray<readonly [string, string]> = Object.freeze(
  LEGACY_FIRST_PARTY_SOURCE_ENTRIES.map(([key, sourceId]) => Object.freeze([key, sourceId] as const))
);
