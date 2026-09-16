// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "./connection-catalog.ts";

export const SHOW_DEVELOPMENT_CONNECTORS_STORAGE_KEY = "dataconnect_show_development_connectors";

export interface DevelopmentConnectorStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

export function readShowDevelopmentConnectors(storage: DevelopmentConnectorStorage): boolean {
  try {
    return storage.getItem(SHOW_DEVELOPMENT_CONNECTORS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistShowDevelopmentConnectors(storage: DevelopmentConnectorStorage, show: boolean): void {
  try {
    if (show) {
      storage.setItem(SHOW_DEVELOPMENT_CONNECTORS_STORAGE_KEY, "true");
    } else {
      storage.removeItem(SHOW_DEVELOPMENT_CONNECTORS_STORAGE_KEY);
    }
  } catch {
    // Storage is optional; the current session remains usable when unavailable.
  }
}

export function filterCatalogForDevelopmentVisibility<T extends Pick<ConnectorCatalogEntry, "publicTier">>(
  catalog: readonly T[],
  showDevelopmentConnectors: boolean
): T[] {
  if (showDevelopmentConnectors) {
    return [...catalog];
  }
  return catalog.filter((entry) => entry.publicTier !== "development");
}
