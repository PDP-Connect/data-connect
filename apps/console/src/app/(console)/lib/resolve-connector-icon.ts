// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };
import { sanitizeSvg } from "./sanitize-svg.ts";

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";
const TRAILING_SLASH = /\/$/u;

type CorpusEntry = (typeof iconCorpus.entries)[number];

/** Preserve the first-party registry/key aliases; unrelated URLs remain exact identities. */
export function connectorIconIdentityKeys(connectorId: string): readonly string[] {
  const value = connectorId.trim();
  if (!value) {
    return [];
  }
  const keys = new Set([value]);
  let localKey: string | null = value;
  if (value.startsWith(REGISTRY_PREFIX)) {
    localKey = value.slice(REGISTRY_PREFIX.length).replace(TRAILING_SLASH, "");
  } else if (URI_SCHEME.test(value)) {
    localKey = null;
  }
  if (localKey !== null) {
    const canonical = localKey.replaceAll("_", "-");
    keys.add(canonical);
    keys.add(canonical.replaceAll("-", "_"));
  }
  return [...keys];
}

/** Validate an SVG mark at the shared display boundary. */
export function validatedConnectorIcon(
  icon: ConnectorIconLike | null | undefined,
  declaredBackground?: string | null
): ConnectorIconLike | null {
  if (icon?.kind !== "inline_svg" || typeof icon.svg !== "string") {
    return null;
  }
  const svg = sanitizeSvg(icon.svg);
  if (!svg) {
    return null;
  }
  const color = typeof icon.color === "string" && HEX_COLOR.test(icon.color) ? icon.color : undefined;
  const candidateBackground = icon.backgroundColor ?? declaredBackground;
  const backgroundColor =
    typeof candidateBackground === "string" && HEX_COLOR.test(candidateBackground) ? candidateBackground : undefined;
  return { ...(color ? { color } : {}), ...(backgroundColor ? { backgroundColor } : {}), kind: "inline_svg", svg };
}

function corpusIcon(entry: CorpusEntry): ConnectorIconLike | null {
  return validatedConnectorIcon(
    { backgroundColor: entry.background_color, kind: "inline_svg", svg: entry.svg },
    entry.background_color
  );
}

const BUNDLED_ICONS_BY_IDENTITY = new Map<string, ConnectorIconLike>();
const BUNDLED_ICONS_BY_SOURCE = new Map<string, ConnectorIconLike | null>();
for (const entry of iconCorpus.entries) {
  const icon = corpusIcon(entry);
  if (!icon) {
    continue;
  }
  if (entry.source_id) {
    const previous = BUNDLED_ICONS_BY_SOURCE.get(entry.source_id);
    const conflicts =
      previous !== undefined &&
      (previous === null || previous.svg !== icon.svg || previous.backgroundColor !== icon.backgroundColor);
    BUNDLED_ICONS_BY_SOURCE.set(entry.source_id, conflicts ? null : icon);
  }
  for (const identity of [entry.connector_id, entry.connector_key]) {
    for (const key of connectorIconIdentityKeys(identity)) {
      BUNDLED_ICONS_BY_IDENTITY.set(key, icon);
    }
  }
}

/** Resolve an explicit safe icon first, then a bundled mark for the exact connector identity. */
export function resolveConnectorIcon(
  connectorId: string,
  icon?: ConnectorIconLike | null,
  declaredBackground?: string | null
): ConnectorIconLike | null {
  const supplied = validatedConnectorIcon(icon, declaredBackground);
  if (supplied) {
    return supplied;
  }
  for (const key of connectorIconIdentityKeys(connectorId)) {
    const bundled = BUNDLED_ICONS_BY_IDENTITY.get(key);
    if (bundled) {
      return bundled;
    }
  }
  return null;
}

/** Add a resolved mark under every accepted explicit connector spelling. */
export function indexConnectorIcon(
  icons: Map<string, ConnectorIconLike>,
  connectorIds: readonly (string | null | undefined)[],
  icon: ConnectorIconLike | null
): void {
  if (!icon) {
    return;
  }
  for (const connectorId of connectorIds) {
    if (connectorId) {
      for (const key of connectorIconIdentityKeys(connectorId)) {
        icons.set(key, icon);
      }
    }
  }
}

/** True when a map already contains a mark for one of these exact identities or spellings. */
export function hasConnectorIcon(
  icons: ReadonlyMap<string, ConnectorIconLike>,
  connectorIds: readonly (string | null | undefined)[]
): boolean {
  return connectorIds.some(
    (connectorId) => connectorId && connectorIconIdentityKeys(connectorId).some((key) => icons.has(key))
  );
}

/** Core source IDs stay separate from connector IDs. This display-only lookup
 * uses declared source provenance, plus exact legacy brand aliases. */
export function resolveSourceIcon(sourceId: string, icon?: ConnectorIconLike | null): ConnectorIconLike | null {
  const supplied = validatedConnectorIcon(icon);
  if (supplied) {
    return supplied;
  }
  if (BUNDLED_ICONS_BY_SOURCE.has(sourceId)) {
    return BUNDLED_ICONS_BY_SOURCE.get(sourceId) ?? null;
  }
  return BUNDLED_ICONS_BY_IDENTITY.get(sourceId) ?? null;
}
