// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";

/**
 * Resolve the one icon shape shared by manifests, owner templates, and view
 * models. Invalid or absent marks intentionally return null so the shared
 * ConnectorMark can render the design-system monogram fallback.
 */
export function resolveConnectorIcon(icon: ConnectorIconLike | null | undefined): ConnectorIconLike | null {
  if (icon?.kind !== "inline_svg" || typeof icon.svg !== "string" || icon.svg.trim().length === 0) {
    return null;
  }
  return { ...icon, svg: icon.svg.trim() };
}
