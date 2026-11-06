// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };
import { connectorLookupKey } from "./connector-install-presentation.ts";
import { hasConnectorIcon, indexConnectorIcon, validatedConnectorIcon } from "./resolve-connector-icon.ts";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";
import { type DisplayMarkLayers, pickDisplayMark } from "./resolve-manifest-display-mark.ts";
import type { ConnectorManifest, OwnerConnectorTemplate } from "./rs-client.ts";

/** Icons indexed by the exact server-projected connector identity. */
export type ConnectorIconMap = Readonly<Record<string, ConnectorIconLike | null | undefined>>;

/**
 * A display projection; it never adds or changes a connector manifest. Each
 * source of marks fills one layer, and `pickDisplayMark` (the same function
 * `resolveManifestDisplayMark` uses) chooses per identity, so the map cannot
 * order marks differently from the setup pages.
 */
export async function buildConnectorIconMap(
  manifests: readonly ConnectorManifest[],
  templates: readonly OwnerConnectorTemplate[]
): Promise<ConnectorIconMap> {
  const layers = {
    bundled: new Map<string, ConnectorIconLike>(),
    generic: new Map<string, ConnectorIconLike>(),
    manifest: new Map<string, ConnectorIconLike>(),
    template: new Map<string, ConnectorIconLike>(),
  } satisfies Record<keyof DisplayMarkLayers, Map<string, ConnectorIconLike>>;
  for (const entry of iconCorpus.entries) {
    indexConnectorIcon(
      layers.bundled,
      [entry.connector_key, entry.connector_id],
      validatedConnectorIcon({
        backgroundColor: entry.background_color,
        kind: "inline_svg",
        svg: entry.svg,
      })
    );
  }
  // Manifest marks are already normalized (resolveManifestDisplayMark). Which
  // layer one belongs to follows the source it resolved from.
  for (const manifest of manifests) {
    const layer =
      manifest.resolvedIconSource === "bundled"
        ? layers.bundled
        : manifest.resolvedIconSource === "simple-icons"
          ? layers.generic
          : layers.manifest;
    indexConnectorIcon(layer, [manifest.connector_id, manifest.connector_key], validatedConnectorIcon(manifest.icon));
  }
  for (const template of templates) {
    indexConnectorIcon(
      layers.template,
      [template.connector_id, template.connector_key],
      validatedConnectorIcon(template.icon)
    );
  }
  // Resolve only identities no layer covers yet, so the fallback cannot
  // overwrite an approved mark through an alias.
  const covered = (ids: readonly (string | null | undefined)[]) =>
    Object.values(layers).some((layer) => hasConnectorIcon(layer, ids));
  const missing = templates.filter(
    (template) => template.connector_key && !covered([template.connector_id, template.connector_key])
  );
  const fallbacks = await Promise.all(
    missing.map(async (template) => ({
      identities: [template.connector_id, template.connector_key],
      icon: await resolveConnectorIconFromSimpleIcons(template.connector_key ?? ""),
    }))
  );
  for (const fallback of fallbacks) {
    indexConnectorIcon(layers.generic, fallback.identities, fallback.icon);
  }
  const icons = new Map<string, ConnectorIconLike>();
  for (const key of new Set(Object.values(layers).flatMap((layer) => [...layer.keys()]))) {
    const { icon } = pickDisplayMark({
      bundled: layers.bundled.get(key),
      generic: layers.generic.get(key),
      manifest: layers.manifest.get(key),
      template: layers.template.get(key),
    });
    if (icon) {
      icons.set(key, icon);
    }
  }
  return Object.fromEntries(icons);
}

/**
 * The mark for a catalog entry: the map's choice, else the mark the entry
 * already carries. A key the map does not index must not discard that mark.
 */
export function catalogEntryIcon(
  entry: { readonly connectorKey: string; readonly icon?: ConnectorIconLike | null },
  icons: ConnectorIconMap
): ConnectorIconLike | null {
  return icons[connectorLookupKey(entry.connectorKey)] ?? validatedConnectorIcon(entry.icon) ?? null;
}
