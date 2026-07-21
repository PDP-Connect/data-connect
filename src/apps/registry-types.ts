// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export type AppRequiredPlatform = {
  token: string
  label: string
}

export type AppDataAccess =
  | {
      protocol: "pdpp"
      capabilities: ["personal-data-read"]
    }
  | {
      protocol: "vana-grant-session"
      capabilities: ["grant-session"]
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
  dataAccess: AppDataAccess
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

export function getAppDataAccessLabel(dataAccess: AppDataAccess): string {
  return dataAccess.protocol === "pdpp" ? "Uses PDPP" : "Vana grant/session"
}
