// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorIconLike } from "@pdpp/brand-react";
import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import {
  type ConnectorInstallLifecycle,
  connectorInstallRowModel,
  connectorLookupKey,
} from "../../lib/connector-install-presentation.ts";

/** One row of "Data source packages": a service whose package is on this computer. */
export interface PackageRow {
  readonly connectorId: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly icon: ConnectorIconLike | null | undefined;
  /** True only when no data source uses the package. */
  readonly canUninstall: boolean;
  /** The version an Update would move to; null when up to date or when it cannot be updated here. */
  readonly updateTo: string | null;
  readonly version: string | null;
}

export interface PackageRowsInput {
  readonly catalog: readonly ConnectorCatalogEntry[];
  readonly existingConnectionCounts: Readonly<Record<string, number>>;
  readonly lifecycleFor: (entry: ConnectorCatalogEntry) => ConnectorInstallLifecycle | null;
}

export function buildPackageRows(input: PackageRowsInput): PackageRow[] {
  const rows: PackageRow[] = [];
  const seen = new Set<string>();
  for (const entry of input.catalog) {
    const identity = connectorLookupKey(entry.connectorKey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const lifecycle = input.lifecycleFor(entry);
    if (!lifecycle?.installed) continue;
    const model = connectorInstallRowModel(entry, lifecycle);
    rows.push({
      canUninstall: (input.existingConnectionCounts[entry.connectorKey] ?? 0) === 0,
      connectorId: model.connectorId,
      connectorKey: entry.connectorKey,
      displayName: entry.displayName,
      icon: entry.icon,
      updateTo: model.action?.kind === "update" ? (model.action.version || model.targetVersion || "latest") : null,
      version: model.installedVersion,
    });
  }
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export const packagesCopy = {
  couldNot: "Couldn't complete this. Try again.",
  empty: "Every data source is up to date.",
  heading: "Data source updates",
  settingsLink: "Data source updates",
  uninstallConfirm: (service: string) => `Remove the piece for ${service}? You can only do this when no data source uses it.`,
} as const;
