// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ConnectorBrandIcon {
  readonly backgroundColor?: string
  readonly darkUrl?: string
  readonly url: string
}

export interface ConnectorBrandIconIndex {
  readonly brandIcons: Readonly<Record<string, ConnectorBrandIcon>>
}

const BRAND_ICON_PATH_RE =
  /^\/connector-brand-icons\/[a-z0-9_-]+(?:\.dark)?\.svg$/

function isBrandIconPath(value: unknown): value is string {
  return typeof value === "string" && BRAND_ICON_PATH_RE.test(value)
}

/** Drops external or malformed icon URLs before server data reaches the browser. */
export function sameOriginConnectorBrandIndex(
  value: unknown
): ConnectorBrandIconIndex {
  if (
    !value ||
    typeof value !== "object" ||
    !("brandIcons" in value) ||
    !value.brandIcons ||
    typeof value.brandIcons !== "object"
  ) {
    return { brandIcons: {} }
  }
  const brandIcons: Record<string, ConnectorBrandIcon> = {}
  for (const [connectorId, icon] of Object.entries(value.brandIcons)) {
    if (
      !icon ||
      typeof icon !== "object" ||
      !("url" in icon) ||
      !isBrandIconPath(icon.url)
    ) {
      continue
    }
    brandIcons[connectorId] = {
      ...("backgroundColor" in icon && typeof icon.backgroundColor === "string"
        ? { backgroundColor: icon.backgroundColor }
        : {}),
      ...("darkUrl" in icon && isBrandIconPath(icon.darkUrl)
        ? { darkUrl: icon.darkUrl }
        : {}),
      url: icon.url,
    }
  }
  return { brandIcons }
}
