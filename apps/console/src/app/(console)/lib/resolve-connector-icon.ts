// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";

/**
 * Resolve the one icon shape shared by manifests, owner templates, and view
 * models. Invalid or absent marks intentionally return null so the shared
 * ConnectorMark can render the design-system monogram fallback.
 *
 * Manifests declare their brand glyph as a relative path string
 * (`brand.icon`, e.g. "icons/amazon.svg"), not inline markup. This
 * validator only ever sees the `inline_svg` shape because
 * resolve-connector-icon-path.ts (server-only) resolves that path to
 * sanitized SVG content in listConnectorManifests(), before the manifest
 * reaches this file — which is imported by connector-mark.tsx, a "use
 * client" component, and so must never itself touch the filesystem.
 */
export function resolveConnectorIcon(icon: ConnectorIconLike | null | undefined): ConnectorIconLike | null {
  if (icon?.kind !== "inline_svg" || typeof icon.svg !== "string" || icon.svg.trim().length === 0) {
    return null;
  }
  return { ...icon, svg: icon.svg.trim() };
}
