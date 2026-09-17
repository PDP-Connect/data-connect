// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "./connection-catalog.ts";

export const SHOW_DEVELOPMENT_CONNECTORS_STORAGE_KEY = "dataconnect_show_development_connectors";
export const DEVELOPER_MODE_STORAGE_KEY = "dataconnect_developer_mode";
const DEVELOPER_MODE_CHANGE_EVENT = "dataconnect_developer_mode_changed";

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

export function readDeveloperMode(storage: DevelopmentConnectorStorage): boolean {
  try {
    return storage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistDeveloperMode(storage: DevelopmentConnectorStorage, enabled: boolean): void {
  try {
    if (enabled) {
      storage.setItem(DEVELOPER_MODE_STORAGE_KEY, "true");
    } else {
      storage.removeItem(DEVELOPER_MODE_STORAGE_KEY);
    }
  } catch {
    // Storage is optional; the current session remains usable when unavailable.
  }
}

const developerModeListeners = new Set<() => void>();
let developerModeSnapshot: boolean | undefined;

function browserStorage(): DevelopmentConnectorStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function subscribeToDeveloperMode(onChange: () => void): () => void {
  developerModeListeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DEVELOPER_MODE_STORAGE_KEY) {
      developerModeSnapshot = undefined;
      onChange();
    }
  };
  const onLocalChange = () => {
    developerModeSnapshot = undefined;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(DEVELOPER_MODE_CHANGE_EVENT, onLocalChange);
  return () => {
    developerModeListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DEVELOPER_MODE_CHANGE_EVENT, onLocalChange);
  };
}

export function getDeveloperModeSnapshot(): boolean {
  if (developerModeSnapshot === undefined) {
    const storage = browserStorage();
    developerModeSnapshot = storage ? readDeveloperMode(storage) : false;
  }
  return developerModeSnapshot;
}

export function getDeveloperModeServerSnapshot(): boolean {
  return false;
}

export function setDeveloperMode(enabled: boolean): void {
  const storage = browserStorage();
  if (storage) {
    persistDeveloperMode(storage, enabled);
  }
  developerModeSnapshot = enabled;
  for (const listener of developerModeListeners) {
    listener();
  }
  window.dispatchEvent(new Event(DEVELOPER_MODE_CHANGE_EVENT));
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
