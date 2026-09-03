// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import "server-only"

import { getAsInternalUrl } from "./owner-token.ts"
import {
  sameOriginConnectorBrandIndex,
  type ConnectorBrandIconIndex,
} from "./connector-brand-icon-path.ts"

export type { ConnectorBrandIconIndex } from "./connector-brand-icon-path.ts"

const EMPTY_CONNECTOR_BRAND_INDEX: ConnectorBrandIconIndex = { brandIcons: {} }

/** The reference server is the console's one source for the generated connector index. */
export async function loadConnectorBrandIndex(): Promise<ConnectorBrandIconIndex> {
  try {
    const response = await fetch(`${getAsInternalUrl()}/connector-index.json`, {
      cache: "no-store",
    })
    if (!response.ok) {
      return EMPTY_CONNECTOR_BRAND_INDEX
    }
    return sameOriginConnectorBrandIndex(await response.json())
  } catch {
    return { brandIcons: {} }
  }
}
