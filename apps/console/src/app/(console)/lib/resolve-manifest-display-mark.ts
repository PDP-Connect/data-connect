// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import { resolveConnectorIcon, validatedConnectorIcon } from "./resolve-connector-icon.ts";
import { resolveConnectorIconFromManifestPath } from "./resolve-connector-icon-path.ts";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";
import type { ConnectorManifest } from "./rs-client.ts";

type DisplayMarkSource = NonNullable<ConnectorManifest["resolvedIconSource"]>;

/**
 * The one place a connector manifest becomes a display mark: sanitized SVG, a
 * validated backdrop, and where it came from. Every surface renders the result
 * (`ConnectorManifest.icon`) as is, so none of them re-derives a backdrop.
 *
 * Precedence, first hit wins:
 *   1. the manifest's own inline `icon`;
 *   2. the file named by `brand.icon`, relative to `manifestsDir`;
 *   3. the bundled mark for the connector identity (`sanitized-assets.json`);
 *   4. the offline simple-icons mark for `connector_key`;
 *   5. nothing, which renders the deterministic monogram.
 * Marks 1 and 2 take their backdrop from the mark itself, else from
 * `brand.background_color`. Marks 3 and 4 carry their own.
 */
export async function resolveManifestDisplayMark(
  manifest: Pick<ConnectorManifest, "brand" | "connector_id" | "connector_key" | "icon">,
  manifestsDir: string
): Promise<{ icon: ConnectorIconLike | null; source: DisplayMarkSource | undefined }> {
  const declaredBackground = manifest.brand?.background_color;
  const inline = validatedConnectorIcon(manifest.icon, declaredBackground);
  if (inline) {
    return { icon: inline, source: "manifest" };
  }
  const fromPath = manifest.brand?.icon
    ? validatedConnectorIcon(await resolveConnectorIconFromManifestPath(manifestsDir, manifest.brand.icon), declaredBackground)
    : null;
  if (fromPath) {
    return { icon: fromPath, source: "manifest" };
  }
  const bundled =
    resolveConnectorIcon(manifest.connector_id) ??
    (manifest.connector_key ? resolveConnectorIcon(manifest.connector_key) : null);
  if (bundled) {
    return { icon: bundled, source: "bundled" };
  }
  const generic = manifest.connector_key ? await resolveConnectorIconFromSimpleIcons(manifest.connector_key) : null;
  return generic ? { icon: generic, source: "simple-icons" } : { icon: null, source: undefined };
}
