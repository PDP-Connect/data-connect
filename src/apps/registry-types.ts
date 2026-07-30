export type AppRequiredPlatform = {
  token: string
  label: string
}

export type BaseAppRegistryEntry = {
  id: string
  name: string
  icon: string
  iconUrl?: string
  builderName?: string
  builderUrl?: string
  description: string
  category: string
  dataRequired: AppRequiredPlatform[]
  scopes?: string[]
}

export type ExternalAppRegistryEntry = BaseAppRegistryEntry & {
  status: "live"
  externalUrl: string
  scopes: string[]
}

export type InternalAppRegistryEntry = BaseAppRegistryEntry & {
  status: "live"
  route: string
  externalUrl?: never
  scopes?: never
}

export type ComingSoonAppRegistryEntry = BaseAppRegistryEntry & {
  status: "coming-soon"
  externalUrl?: never
}

export type AppRegistryEntry =
  | ExternalAppRegistryEntry
  | InternalAppRegistryEntry
  | ComingSoonAppRegistryEntry

export function isExternalAppRegistryEntry(
  entry: AppRegistryEntry
): entry is ExternalAppRegistryEntry {
  return "externalUrl" in entry
}
