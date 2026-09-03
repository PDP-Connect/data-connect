// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

const CONNECTOR_SOURCE_COMMIT = "a39f33e6bbd3ba6c73af9e5512fc945beb3cc1d2";
const CONNECTOR_SOURCE_ROOT = `https://raw.githubusercontent.com/PDP-Connect/data-connectors/${CONNECTOR_SOURCE_COMMIT}/packages/polyfill-connectors/manifests/`;

export interface ConnectorBrandIcon {
  readonly backgroundColor?: string;
  readonly darkUrl?: string;
  readonly url: string;
}

export interface ConnectorBrandIndex {
  readonly brandIcons: Readonly<Record<string, ConnectorBrandIcon>>;
  readonly indexVersion: "2.0";
  readonly sourceRepo: "https://github.com/PDP-Connect/data-connectors";
}

/**
 * The reference-owned projection of the connector index's brandIcons field.
 * It is derived from the vendored manifest declarations, so connector identity
 * remains declared once in data-connectors rather than copied into the console.
 */
export function loadConnectorBrandIndex(): ConnectorBrandIndex {
  const brandIcons: Record<string, ConnectorBrandIcon> = {};
  for (const { manifest: rawManifest } of readPolyfillManifests()) {
    const manifest = rawManifest as Record<string, unknown>;
    const connectorId = typeof manifest.connector_id === "string" ? manifest.connector_id : null;
    const brand = manifest.brand as
      | { background_color?: unknown; dark_icon?: unknown; icon?: unknown }
      | undefined;
    if (!connectorId || !brand || typeof brand.icon !== "string") {
      continue;
    }
    brandIcons[connectorId] = {
      ...(typeof brand.background_color === "string" ? { backgroundColor: brand.background_color } : {}),
      ...(typeof brand.dark_icon === "string" ? { darkUrl: new URL(brand.dark_icon, CONNECTOR_SOURCE_ROOT).toString() } : {}),
      url: new URL(brand.icon, CONNECTOR_SOURCE_ROOT).toString(),
    };
  }
  return {
    brandIcons,
    indexVersion: "2.0",
    sourceRepo: "https://github.com/PDP-Connect/data-connectors",
  };
}
