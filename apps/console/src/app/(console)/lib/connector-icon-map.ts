// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };
import { hasConnectorIcon, indexConnectorIcon, validatedConnectorIcon } from "./resolve-connector-icon.ts";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";
import type { ConnectorManifest, OwnerConnectorTemplate } from "./rs-client.ts";

/** Icons indexed by the exact server-projected connector identity. */
export type ConnectorIconMap = Readonly<Record<string, ConnectorIconLike | null | undefined>>;

/** A display projection; it never adds or changes a connector manifest. */
export async function buildConnectorIconMap(
  manifests: readonly ConnectorManifest[],
  templates: readonly OwnerConnectorTemplate[]
): Promise<ConnectorIconMap> {
  const icons = new Map<string, ConnectorIconLike>();
  for (const entry of iconCorpus.entries) {
    indexConnectorIcon(
      icons,
      [entry.connector_key, entry.connector_id],
      validatedConnectorIcon({
        backgroundColor: entry.background_color,
        kind: "inline_svg",
        svg: entry.svg,
      })
    );
  }
  // Manifest marks are already normalized (resolveManifestDisplayMark), so the
  // map only indexes them; it never decides a backdrop or a precedence.
  for (const manifest of manifests) {
    indexConnectorIcon(icons, [manifest.connector_id, manifest.connector_key], validatedConnectorIcon(manifest.icon));
  }
  for (const template of templates) {
    const identities = [template.connector_id, template.connector_key];
    indexConnectorIcon(icons, identities, validatedConnectorIcon(template.icon));
  }
  // Resolve only missing marks. Applying explicit inline marks first keeps
  // this fallback from overwriting an approved mark through an alias.
  const missing = templates.filter(
    (template) => template.connector_key && !hasConnectorIcon(icons, [template.connector_id, template.connector_key])
  );
  const fallbacks = await Promise.all(
    missing.map(async (template) => ({
      identities: [template.connector_id, template.connector_key],
      icon: await resolveConnectorIconFromSimpleIcons(template.connector_key ?? ""),
    }))
  );
  for (const fallback of fallbacks) {
    indexConnectorIcon(icons, fallback.identities, fallback.icon);
  }
  return Object.fromEntries(icons);
}
