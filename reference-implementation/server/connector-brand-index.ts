// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests"

export interface ConnectorBrandIcon {
  readonly backgroundColor?: string
  readonly darkUrl?: string
  readonly url: string
}

export interface ConnectorBrandIndex {
  readonly brandIcons: Readonly<Record<string, ConnectorBrandIcon>>
  readonly indexVersion: "2.0"
}

interface ConnectorBrandManifest {
  readonly brand?: {
    readonly background_color?: unknown
    readonly dark_icon?: unknown
    readonly icon?: unknown
  }
  readonly connector_id?: unknown
  readonly connector_key?: unknown
}

const CONNECTOR_KEY_RE = /^[a-z0-9_-]+$/

export function connectorBrandIconPath(
  connectorKey: string,
  dark = false
): string {
  return `/connector-brand-icons/${connectorKey}${dark ? ".dark" : ""}.svg`
}

function connectorBrandManifest(
  rawManifest: unknown
): ConnectorBrandManifest | null {
  if (!rawManifest || typeof rawManifest !== "object") {
    return null
  }
  return rawManifest as ConnectorBrandManifest
}

/**
 * The reference-owned projection of the connector index's brandIcons field.
 * It is derived from the vendored manifest declarations, so connector identity
 * remains declared once in data-connectors rather than copied into the console.
 */
export function loadConnectorBrandIndex(): ConnectorBrandIndex {
  const brandIcons: Record<string, ConnectorBrandIcon> = {}
  for (const { manifest: rawManifest } of readPolyfillManifests()) {
    const manifest = connectorBrandManifest(rawManifest)
    const connectorId =
      typeof manifest?.connector_id === "string" ? manifest.connector_id : null
    const connectorKey =
      typeof manifest?.connector_key === "string"
        ? manifest.connector_key
        : null
    const brand = manifest?.brand
    if (
      !connectorId ||
      !connectorKey ||
      !CONNECTOR_KEY_RE.test(connectorKey) ||
      !brand ||
      typeof brand.icon !== "string"
    ) {
      continue
    }
    brandIcons[connectorId] = {
      ...(typeof brand.background_color === "string"
        ? { backgroundColor: brand.background_color }
        : {}),
      ...(typeof brand.dark_icon === "string"
        ? { darkUrl: connectorBrandIconPath(connectorKey, true) }
        : {}),
      url: connectorBrandIconPath(connectorKey),
    }
  }
  return {
    brandIcons,
    indexVersion: "2.0",
  }
}
