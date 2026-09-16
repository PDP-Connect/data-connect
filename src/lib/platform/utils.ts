// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Platform } from "@/types"
import { PLATFORM_REGISTRY, type PlatformRegistryEntry } from "./registry"

const normalizeToken = (value: string) => value.trim().toLowerCase()

const entryMatchesToken = (entry: PlatformRegistryEntry, token: string) => {
  if (normalizeToken(entry.id) === token) return true
  if (normalizeToken(entry.displayName) === token) return true
  if (entry.platformIds?.some(id => normalizeToken(id) === token)) return true
  if (entry.aliases?.some(alias => normalizeToken(alias) === token)) return true
  return false
}

// Connectors installed at runtime (from the catalog) are not in the generated
// registry, which is built from the lock at build time. The platform loader
// registers an entry for each installed Collection Profile the registry does
// not already cover, so they get a source route and a place on Home.
let RUNTIME_REGISTRY: PlatformRegistryEntry[] = []

const slugFor = (platform: Platform) => {
  const fromUri = platform.id.match(/\/connectors\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1]
  const base = fromUri ?? platform.filename ?? platform.name ?? platform.id
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export const registerRuntimePlatformEntries = (platforms: Platform[]) => {
  const runtimePlatforms = new Map<string, Platform>()
  for (const platform of platforms) {
    if (platform.runtime !== "pdpp-network") continue
    const token = normalizeToken(platform.id)
    if (PLATFORM_REGISTRY.some(entry => entryMatchesToken(entry, token)))
      continue
    runtimePlatforms.set(token, platform)
  }

  const routeBases = new Map<string, number>()
  for (const platform of runtimePlatforms.values()) {
    const base = slugFor(platform)
    routeBases.set(base, (routeBases.get(base) ?? 0) + 1)
  }

  RUNTIME_REGISTRY = [...runtimePlatforms.values()].map(platform => {
    const base = slugFor(platform)
    const id =
      routeBases.get(base) === 1
        ? base
        : `${base}-${encodeURIComponent(normalizeToken(platform.id))}`
    return {
      id,
      displayName: platform.name,
      platformIds: [platform.id],
      availability: "requiresConnector",
      showInConnectList: true,
    }
  })
}

const findRegistryEntryByToken = (token: string) =>
  PLATFORM_REGISTRY.find(entry => entryMatchesToken(entry, token)) ??
  RUNTIME_REGISTRY.find(entry => entryMatchesToken(entry, token)) ??
  null

export const getPlatformRegistryEntryById = (platformId: string) =>
  findRegistryEntryByToken(normalizeToken(platformId))

export const getPlatformRegistryEntryByName = (name: string) =>
  findRegistryEntryByToken(normalizeToken(name))

export const getPlatformRegistryEntry = (platform: {
  id?: string
  name?: string
  company?: string
}) => {
  if (platform.id) {
    const byId = getPlatformRegistryEntryById(platform.id)
    if (byId) return byId
  }
  if (platform.name) {
    const byName = getPlatformRegistryEntryByName(platform.name)
    if (byName) return byName
  }
  if (platform.company) {
    const byCompany = getPlatformRegistryEntryByName(platform.company)
    if (byCompany) return byCompany
  }
  return null
}

export const getPlatformIngestScope = (platformId: string) =>
  getPlatformRegistryEntryById(platformId)?.ingestScope ?? null

export const getAllAvailableScopes = (platforms?: Platform[]): string[] => {
  if (platforms && platforms.length > 0) {
    const scopes = platforms.flatMap(p => p.scopes ?? [])
    if (scopes.length > 0) return [...new Set(scopes)]
  }
  return PLATFORM_REGISTRY
    .map(entry => entry.ingestScope)
    .filter((scope): scope is string => Boolean(scope))
}

export const resolvePlatformForEntry = (
  platforms: Platform[],
  entry: PlatformRegistryEntry
) => {
  const entryPlatformIds = entry.platformIds?.map(normalizeToken) ?? []
  const entryTokens = [entry.id, ...(entry.aliases ?? [])].map(normalizeToken)
  const matchingPlatformById = platforms.filter(platform =>
    entryPlatformIds.includes(normalizeToken(platform.id))
  )
  return (
    matchingPlatformById.find(platform => platform.runtime === "pdpp-network") ??
    matchingPlatformById[0] ??
    platforms.find(platform =>
      entryTokens.some(token =>
        [platform.id, platform.name, platform.company]
          .filter(Boolean)
          .map(value => normalizeToken(value))
          .includes(token)
      )
    ) ??
    null
  )
}
