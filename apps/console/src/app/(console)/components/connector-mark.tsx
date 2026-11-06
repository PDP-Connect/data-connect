// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorIcon, type ConnectorIconLike } from "@pdpp/brand-react";
import { createElement } from "react";
import { resolveConnectorIcon, resolveSourceIcon } from "../lib/resolve-connector-icon.ts";

const TEXT_SPACING_CLASSES = { after: "mr-2", around: "mx-1" } as const;

/** One connector identity mark for every console surface. */
export function ConnectorMark({
  spacing,
  connectorId,
  sourceId,
  icon,
  name,
}: {
  /** Space between this mark and adjacent inline text; geometry belongs to the renderer. */
  spacing?: keyof typeof TEXT_SPACING_CLASSES;
  icon?: ConnectorIconLike | null;
  name: string;
} & ({ connectorId: string; sourceId?: never } | { sourceId: string; connectorId?: never })) {
  return createElement(ConnectorIcon, {
    className: spacing ? TEXT_SPACING_CLASSES[spacing] : undefined,
    icon: sourceId === undefined ? resolveConnectorIcon(connectorId ?? "", icon) : resolveSourceIcon(sourceId, icon),
    name,
  });
}
