// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import { resolveConnectorIcon, validatedConnectorIcon } from "./resolve-connector-icon.ts";
import { resolveConnectorIconFromManifestPath } from "./resolve-connector-icon-path.ts";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";
import type { ConnectorManifest } from "./rs-client.ts";

type DisplayMarkSource = NonNullable<ConnectorManifest["resolvedIconSource"]>;

/** Where a candidate display mark came from, strongest first. */
export interface DisplayMarkLayers {
  /** The mark the manifest itself owns: its inline `icon` or its `brand.icon` file. */
  readonly manifest?: ConnectorIconLike | null;
  /** The mark the server projected on the owner connector template. */
  readonly template?: ConnectorIconLike | null;
  /** The bundled mark for the connector identity (`sanitized-assets.json`). */
  readonly bundled?: ConnectorIconLike | null;
  /** The offline simple-icons mark for `connector_key`. */
  readonly generic?: ConnectorIconLike | null;
}

/**
 * The one precedence rule for a connector's display mark, first hit wins:
 *   1. `manifest`: a mark the manifest owns;
 *   2. `template`: the server-projected template mark, used when the console
 *      has no manifest mark of its own (the server copy is not normalized);
 *   3. `bundled`: the shipped mark for the connector identity;
 *   4. `generic`: the offline simple-icons mark;
 *   5. nothing, which renders the deterministic monogram.
 * Every surface reaches a mark through this function, so no two surfaces can
 * order the same layers differently.
 */
export function pickDisplayMark(layers: DisplayMarkLayers): {
  icon: ConnectorIconLike | null;
  layer: keyof DisplayMarkLayers | undefined;
} {
  for (const layer of ["manifest", "template", "bundled", "generic"] as const) {
    const icon = layers[layer];
    if (icon) {
      return { icon, layer };
    }
  }
  return { icon: null, layer: undefined };
}

/**
 * The one place a connector manifest becomes a display mark: sanitized SVG, a
 * validated backdrop, and where it came from. Every surface renders the result
 * (`ConnectorManifest.icon`) as is, so none of them re-derives a backdrop.
 * Layers are ordered by `pickDisplayMark`; a manifest alone has no template.
 * Marks from the manifest take their backdrop from the mark itself, else from
 * `brand.background_color`. Bundled and simple-icons marks carry their own.
 */
export async function resolveManifestDisplayMark(
  manifest: Pick<ConnectorManifest, "brand" | "connector_id" | "connector_key" | "icon">,
  manifestsDir: string
): Promise<{ icon: ConnectorIconLike | null; source: DisplayMarkSource | undefined }> {
  const declaredBackground = manifest.brand?.background_color;
  const inline = validatedConnectorIcon(manifest.icon, declaredBackground);
  const fromPath =
    !inline && manifest.brand?.icon
      ? validatedConnectorIcon(await resolveConnectorIconFromManifestPath(manifestsDir, manifest.brand.icon), declaredBackground)
      : null;
  const owned = inline ?? fromPath;
  const bundled =
    resolveConnectorIcon(manifest.connector_id) ??
    (manifest.connector_key ? resolveConnectorIcon(manifest.connector_key) : null);
  const generic =
    !owned && !bundled && manifest.connector_key ? await resolveConnectorIconFromSimpleIcons(manifest.connector_key) : null;
  const { icon, layer } = pickDisplayMark({ bundled, generic, manifest: owned });
  return { icon, source: layer === "generic" ? "simple-icons" : layer === "template" ? undefined : layer };
}
