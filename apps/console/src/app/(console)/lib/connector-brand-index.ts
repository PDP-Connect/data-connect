// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import "server-only";

import { getAsInternalUrl } from "./owner-token.ts";

export interface ConnectorBrandIconIndex {
  readonly brandIcons: Readonly<Record<string, { readonly backgroundColor?: string; readonly darkUrl?: string; readonly url: string }>>;
}

const EMPTY_CONNECTOR_BRAND_INDEX: ConnectorBrandIconIndex = { brandIcons: {} };

/** The reference server is the console's one source for the generated connector index. */
export async function loadConnectorBrandIndex(): Promise<ConnectorBrandIconIndex> {
  try {
    const response = await fetch(`${getAsInternalUrl()}/connector-index.json`, { cache: "no-store" });
    if (!response.ok) {
      return EMPTY_CONNECTOR_BRAND_INDEX;
    }
    const index = (await response.json()) as Partial<ConnectorBrandIconIndex>;
    return index.brandIcons && typeof index.brandIcons === "object" ? { brandIcons: index.brandIcons } : EMPTY_CONNECTOR_BRAND_INDEX;
  } catch {
    return EMPTY_CONNECTOR_BRAND_INDEX;
  }
}
