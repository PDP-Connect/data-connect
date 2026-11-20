// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import { hexColorOrNull } from "@pdpp/brand-react/hex-color";
import { sanitizeSvg } from "@pdpp/brand-react/sanitize-svg";
import { connectorIconIdentityKeys } from "./connector-icon-identity.ts";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };

type CorpusEntry = (typeof iconCorpus.entries)[number];

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
  const color = hexColorOrNull(icon.color);
  const backgroundColor = hexColorOrNull(icon.backgroundColor ?? declaredBackground);
  return { ...(color ? { color } : {}), ...(backgroundColor ? { backgroundColor } : {}), kind: "inline_svg", svg };
}

function corpusIcon(entry: CorpusEntry): ConnectorIconLike | null {
  return validatedConnectorIcon({ backgroundColor: entry.background_color, kind: "inline_svg", svg: entry.svg });
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

/** A copy of the bundled corpus indexed by every accepted identity spelling, for callers that layer it. */
export function bundledIconIdentities(): Map<string, ConnectorIconLike> {
  return new Map(BUNDLED_ICONS_BY_IDENTITY);
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

const conflictedKeysByLayer = new WeakMap<Map<string, ConnectorIconLike>, Set<string>>();

function sameMark(left: ConnectorIconLike, right: ConnectorIconLike): boolean {
  return left.svg === right.svg && left.color === right.color && left.backgroundColor === right.backgroundColor;
}

/**
 * Add a resolved mark under every accepted explicit connector spelling.
 * Two different marks claiming one spelling in the same layer (for example
 * `foo_bar` and `foo-bar`) is ambiguous: neither wins, the spelling gets no
 * mark from this layer, and the collision is logged once.
 */
export function indexConnectorIcon(
  icons: Map<string, ConnectorIconLike>,
  connectorIds: readonly (string | null | undefined)[],
  icon: ConnectorIconLike | null
): void {
  if (!icon) {
    return;
  }
  let conflicted = conflictedKeysByLayer.get(icons);
  for (const connectorId of connectorIds) {
    if (!connectorId) {
      continue;
    }
    for (const key of connectorIconIdentityKeys(connectorId)) {
      const existing = icons.get(key);
      if (conflicted?.has(key)) {
        continue;
      }
      if (existing && !sameMark(existing, icon)) {
        conflicted ??= new Set();
        conflictedKeysByLayer.set(icons, conflicted);
        conflicted.add(key);
        icons.delete(key);
        console.warn(
          `Connector icon identity "${key}" is claimed by two different marks in one layer; showing neither.`
        );
        continue;
      }
      icons.set(key, icon);
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
 * uses declared source provenance first. Only when no corpus entry declares
 * the ID does it try an EXACT connector identity (key or canonical ID) for
 * records that carry the connector key as their source ID; it never matches
 * a partial or case-folded name. A source ID whose declarations conflict
 * resolves to no brand, and is deliberately not rescued by that fallback. */
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
